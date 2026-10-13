/**
 * ProtectiveLiquidationWorkflow
 *
 * 职责：消费方向级最新行情，复核 settlement readiness、epoch、席位和 position 授权，
 * 同步准备/发布浮亏风险后沿既有保护性执行入口提交。只返回未提交工作的调度结论；
 * 订单 progress、最终 completion 事务和业务 ready 仍由 tracking/settlement 独占。
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../domain/liquidation/doomsday/index.js';
import { exactCompare, sumSafeQuantities } from '../../utils/numeric/exact.js';
import {
  isExternalApiRequestError,
  isUnconfirmedOrderSubmissionError,
} from '../../utils/apiFailure/index.js';
import { formatError } from '../../utils/error/index.js';
import { isSettlementReadinessAbortError } from '../postTradeSettlement/readinessGate.js';
import type { SettlementReadinessReceipt } from '../../types/settlement.js';
import type {
  ProtectiveLiquidationAttempt,
  ProtectiveLiquidationAttemptResult,
  ProtectiveLiquidationRoute,
  ProtectiveLiquidationWorkflow,
  ProtectiveLiquidationWorkflowDeps,
} from './types.js';

/** 创建真正的保护性清仓业务 owner；runtime 不重复执行 readiness 或风险发布判断。 */
export function createProtectiveLiquidationWorkflow(
  deps: ProtectiveLiquidationWorkflowDeps,
): ProtectiveLiquidationWorkflow {
  /** 仅消费当前 ACTIVE 席位身份，不把 runtime 的路由缓存当最终授权。 */
  function isRouteCurrent(route: ProtectiveLiquidationRoute): boolean {
    const seat = deps.symbolRegistry.getSeatState(route.direction);
    return (
      seat.status === 'ACTIVE' &&
      seat.symbol === route.tradingSymbol &&
      deps.symbolRegistry.getSeatVersion(route.direction) === route.seatVersion
    );
  }

  function isBaselineReady(): boolean {
    const status = deps.postTradeConsistencyRuntime.getStatus();
    return status.started && status.currentVersion === status.staleVersion;
  }

  /** 保留生命周期、连续交易时段及末日清仓接管门禁，不因开盘保护额外阻断风险链路。 */
  function isExecutionGateOpen(isExecutionActive: () => boolean): boolean {
    if (
      !isExecutionActive() ||
      deps.termination.isTerminated() ||
      !deps.lastState.isTradingEnabled ||
      deps.lastState.canTrade !== true
    ) {
      return false;
    }

    return (
      !deps.doomsdayProtectionEnabled ||
      !isWithinDoomsdayClearanceTakeoverWindow(deps.now(), deps.lastState.isHalfDay ?? false)
    );
  }

  /** 固定 freshness 前的交易日与身份，返回后使用原队列最新事件，不更换旧任务授权 epoch。 */
  async function executeAttempt({
    trigger,
    getLatestTrigger,
    isExecutionActive,
    onFreshnessBlocked,
  }: ProtectiveLiquidationAttempt): Promise<ProtectiveLiquidationAttemptResult> {
    if (
      trigger.dayEpoch !== deps.snapshot.getView().token.dayEpoch ||
      !isExecutionGateOpen(isExecutionActive)
    ) {
      return 'COMPLETE';
    }

    if (!isBaselineReady()) {
      onFreshnessBlocked();
      return 'WAIT_FOR_FRESHNESS';
    }

    if (!isRouteCurrent(trigger.route)) return 'COMPLETE';

    let receipt: SettlementReadinessReceipt;
    try {
      receipt = await deps.postTradeConsistencyRuntime.waitForFresh();
    } catch (error) {
      if (isSettlementReadinessAbortError(error, 'STOP_AND_DRAIN')) return 'COMPLETE';

      throw error;
    }

    if (
      !isExecutionGateOpen(isExecutionActive) ||
      deps.snapshot.getView().token.dayEpoch !== trigger.dayEpoch ||
      !isRouteCurrent(trigger.route)
    ) {
      return 'COMPLETE';
    }

    const latest = getLatestTrigger();
    if (
      latest?.dayEpoch !== trigger.dayEpoch ||
      !isRouteCurrent(latest.route) ||
      latest.event.symbol !== latest.route.tradingSymbol ||
      exactCompare(latest.event.quote.price, '0') <= 0
    ) {
      return 'COMPLETE';
    }

    const isIdentityCurrent = (): boolean =>
      isExecutionGateOpen(isExecutionActive) &&
      deps.snapshot.getView().token.dayEpoch === trigger.dayEpoch &&
      isRouteCurrent(latest.route);
    const view = deps.snapshot.getView();
    const isCurrent = (): boolean =>
      isIdentityCurrent() &&
      isBaselineReady() &&
      deps.postTradeConsistencyRuntime.isCurrent(receipt) &&
      deps.snapshot.isCurrent(view.token, { account: false, positions: true });
    if (!isIdentityCurrent()) return 'COMPLETE';

    // receipt 与当前消费 view 独立复核；普通 commit 不登记第二个 settlement stale。
    if (!isCurrent()) return 'RETRY_LATEST';

    const quantity = sumSafeQuantities(
      view.positions
        .filter((position) => position.symbol === latest.route.tradingSymbol)
        .map((position) => String(position.quantity)),
    );
    if (quantity === 0) return 'COMPLETE';

    const { riskChecker, orderRecorder, dailyLossTracker, unrealizedLossMonitor } =
      deps.monitorContext;
    const prepared = riskChecker.prepareUnrealizedLossData(
      orderRecorder,
      latest.route.tradingSymbol,
      latest.route.direction === 'LONG',
      dailyLossTracker.getLossOffset(latest.route.direction),
    );
    // prepare 不发布；最终身份/ready/position guard 与 publish 之间不得插入 await。
    if (!isIdentityCurrent()) return 'COMPLETE';

    if (!isCurrent()) return 'RETRY_LATEST';

    riskChecker.publishUnrealizedLossData(prepared);
    const accepted = await unrealizedLossMonitor.monitorDirectionalUnrealizedLoss({
      symbol: latest.route.tradingSymbol,
      isLong: latest.route.direction === 'LONG',
      seatVersion: latest.route.seatVersion,
      quote: latest.event.quote,
      riskChecker,
      orderRecorder,
      dailyLossTracker,
      trader: deps.trader,
      isCurrent,
    });
    if (!isCurrent() && !accepted && isIdentityCurrent()) {
      return 'RETRY_LATEST';
    }

    // 已确认 orderId 不因凭据随后失效而重提；这里只收口本次 trigger，不判定 episode 完成。
    return 'COMPLETE';
  }

  return {
    captureTrigger: (route, event) => {
      if (exactCompare(event.quote.price, '0') <= 0 || route === null) return null;

      return { route, event, dayEpoch: deps.snapshot.getView().token.dayEpoch };
    },
    execute: async (attempt) => {
      try {
        return await executeAttempt(attempt);
      } catch (error) {
        deps.logger.error('[ProtectiveLiquidationWorkflow] 风险事件处理失败', formatError(error));
        // 明确外部失败由原 quote owner 等待下次事件；UNKNOWN submit 与内部错误仍 fatal。
        if (!isExternalApiRequestError(error) || isUnconfirmedOrderSubmissionError(error)) {
          throw error;
        }

        return 'COMPLETE';
      }
    },
  };
}
