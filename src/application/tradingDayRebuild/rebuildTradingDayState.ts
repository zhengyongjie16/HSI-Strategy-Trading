import type { RiskChecker } from '../../types/riskCheck.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MonitorConfig } from '../../types/config.js';
import type { MonitorSymbolNames } from '../../types/monitor.js';

/**
 * 交易日状态重建模块
 *
 * 核心职责：
 * - 在开盘重建阶段，基于最新的行情和订单数据重建唯一监控标的运行时状态
 *
 * 重建流程（按顺序执行）：
 * 1. 以 SymbolRegistry 为席位真相，根据行情数据刷新 MonitorContext 的标的名称缓存
 * 2. 重建订单记录（从全量订单 API 数据中恢复）
 * 3. 预热交易日历快照（基于仍持仓订单需求窗口）
 * 4. 重建牛熊证风险缓存（收回价等关键风控数据）
 * 5. 重建浮亏缓存（结合当日已实现亏损偏移量）
 * 6. 将完成重建的席位激活为 ACTIVE
 * 7. 基于激活后的 SymbolRegistry 再次刷新标的名称缓存
 * 8. 恢复订单追踪状态
 * 9. 展示账户和持仓信息
 *
 * 错误处理：
 * - 任一步骤失败即整体抛出，由生命周期管理器负责重试
 */
import { commitRebuiltSeatActivation } from '../seatActivation/rebuiltSeats.js';
import type { WarrantRiskRefresh } from '../riskRefresh/types.js';
import { hasSeatSymbol } from '../../domain/seat/seatPolicy.js';
import type { Quote } from '../../types/quote.js';
import type { OrderFact } from '../../types/trade.js';
import type { DailyLossTracker } from '../../types/risk.js';
import { resolveMonitorContextSymbolNames } from '../../domain/seat/seatSnapshot.js';
import type {
  RebuildTradingDayStateDeps,
  RebuildTradingDayStateParams,
  RebuildTradingDayStateResult,
  TradingDayRuntimeInvalidationResult,
} from './types.js';
import {
  clearSeatActivationCarryover,
  resolveSeatActivationCarryover,
} from './seatActivationCarryover.js';
import { prewarmTradingCalendarSnapshotForRebuild } from './tradingCalendarPrewarmer.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { exactCompare } from '../../utils/numeric/exact.js';

/**
 * 在交易日状态重建开始时刷新单个 MonitorContext 的标的名称缓存。
 * 名称根据当前 SymbolRegistry 席位真相与行情数据派生。
 *
 * @param monitorContext 待同步的监控上下文
 * @param quotesMap 标的 -> 行情 Map
 * @returns 无返回值
 */
function syncMonitorContextSymbolNames(
  monitorContext: MonitorSymbolNames & {
    readonly config: MonitorConfig;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: OrderRecorder;
    readonly riskChecker: RiskChecker;
  },
  quotesMap: ReadonlyMap<string, Quote | null>,
): void {
  const symbolNames = resolveMonitorContextSymbolNames({
    symbolRegistry: monitorContext.symbolRegistry,
    monitorSymbol: monitorContext.config.monitorSymbol,
    quotesMap,
  });
  monitorContext.longSymbolName = symbolNames.longSymbolName;
  monitorContext.shortSymbolName = symbolNames.shortSymbolName;
  monitorContext.monitorSymbolName = symbolNames.monitorSymbolName;
}

/**
 * 从全量订单数据中重建唯一监控标的已绑定席位的订单记录。
 */
function rebuildOrderRecords(
  monitorContext: MonitorSymbolNames & {
    readonly config: MonitorConfig;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: OrderRecorder;
    readonly riskChecker: RiskChecker;
  },
  allOrders: ReadonlyArray<OrderFact>,
  targets: Parameters<OrderRecorder['commitRebuildSnapshot']>[0],
  isCurrent: () => boolean,
): boolean {
  const symbols = new Set<string>();
  for (const target of targets) {
    if (symbols.has(target.symbol)) {
      throw new Error(`[Lifecycle] LONG/SHORT 重建目标归属冲突: ${target.symbol}`);
    }

    symbols.add(target.symbol);
    monitorContext.orderRecorder.validateRebuildSnapshot(target.symbol, allOrders);
  }

  // 所有方向先预检；O owner 在同一同步事务内再次裁决整个 batch，基线模式不登记 stale。
  return (
    monitorContext.orderRecorder.commitRebuildSnapshot(targets, allOrders, isCurrent, 'REBUILD')
      .status === 'COMMITTED'
  );
}

/**
 * 刷新单个席位的牛熊证风险信息（收回价等）。
 * 优先使用席位缓存的 callPrice，否则从 API 重新拉取。
 */
async function refreshSeatWarrantInfo(
  warrantRiskRefresh: WarrantRiskRefresh,
  monitorContext: MonitorSymbolNames & {
    readonly config: MonitorConfig;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: OrderRecorder;
    readonly riskChecker: RiskChecker;
  },
  symbol: string | null,
  quote: Quote | null,
  isLongSymbol: boolean,
  callPriceFromSeat: string | null,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!symbol) {
    return true;
  }

  const symbolName = quote?.name ?? null;
  if (callPriceFromSeat !== null && exactCompare(callPriceFromSeat, '0') > 0) {
    const result = monitorContext.riskChecker.setWarrantInfoFromCallPrice(
      symbol,
      callPriceFromSeat,
      isLongSymbol,
      symbolName,
    );
    if (result.status === 'error') {
      throw new Error(result.reason);
    }

    return true;
  }

  const result = await warrantRiskRefresh.refreshWarrantInfoForSymbol(
    symbol,
    isLongSymbol,
    isCurrent,
    symbolName,
  );
  if (result.status === 'INVALIDATED') return false;

  if (result.status === 'error' || result.status === 'skipped') {
    const reason = result.status === 'error' ? result.reason : '未提供行情客户端';
    throw new Error(reason);
  }

  return true;
}

/**
 * 重建唯一监控标的已绑定席位的牛熊证风险缓存（收回价等关键风控数据）。
 */
async function rebuildWarrantRiskCache(
  warrantRiskRefresh: WarrantRiskRefresh,
  monitorContext: MonitorSymbolNames & {
    readonly config: MonitorConfig;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: OrderRecorder;
    readonly riskChecker: RiskChecker;
  },
  quotesMap: ReadonlyMap<string, Quote | null>,
  isCurrent: () => boolean,
): Promise<boolean> {
  const longSeatState = monitorContext.symbolRegistry.getSeatState('LONG');
  const shortSeatState = monitorContext.symbolRegistry.getSeatState('SHORT');
  const longRefreshed = await refreshSeatWarrantInfo(
    warrantRiskRefresh,
    monitorContext,
    hasSeatSymbol(longSeatState) ? longSeatState.symbol : null,
    hasSeatSymbol(longSeatState) ? (quotesMap.get(longSeatState.symbol) ?? null) : null,
    true,
    hasSeatSymbol(longSeatState) ? (longSeatState.callPrice ?? null) : null,
    isCurrent,
  );

  if (!longRefreshed || !isCurrent()) return false;

  const shortRefreshed = await refreshSeatWarrantInfo(
    warrantRiskRefresh,
    monitorContext,
    hasSeatSymbol(shortSeatState) ? shortSeatState.symbol : null,
    hasSeatSymbol(shortSeatState) ? (quotesMap.get(shortSeatState.symbol) ?? null) : null,
    false,
    hasSeatSymbol(shortSeatState) ? (shortSeatState.callPrice ?? null) : null,
    isCurrent,
  );
  return shortRefreshed && isCurrent();
}

/**
 * 重建唯一监控标的已绑定席位的浮亏缓存，结合当日已实现亏损偏移量计算。
 */
function rebuildUnrealizedLossCache(
  monitorContext: MonitorSymbolNames & {
    readonly config: MonitorConfig;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly orderRecorder: OrderRecorder;
    readonly riskChecker: RiskChecker;
  },
  dailyLossTracker: DailyLossTracker,
  targets: Parameters<OrderRecorder['commitRebuildSnapshot']>[0],
  isCurrent: () => boolean,
): boolean {
  const preparedStates = targets.map((target) =>
    monitorContext.riskChecker.prepareUnrealizedLossData(
      monitorContext.orderRecorder,
      target.symbol,
      target.isLongSymbol,
      dailyLossTracker.getLossOffset(target.isLongSymbol ? 'LONG' : 'SHORT'),
    ),
  );

  // 两方向都只准备候选；原 token 和全部席位身份最终复核后，同步发布，无 await 间隙。
  if (!isCurrent()) return false;

  for (const prepared of preparedStates) {
    monitorContext.riskChecker.publishUnrealizedLossData(prepared);
  }

  return true;
}

/**
 * 创建交易日状态重建函数（工厂）。
 * 注入依赖后返回 rebuildTradingDayState，在开盘重建阶段以 SymbolRegistry 为席位真相，刷新名称缓存、重建订单与风控缓存并展示账户持仓。
 *
 * @param deps 依赖注入（marketDataClient、trader、lastState、symbolRegistry、monitorContext、dailyLossTracker、displayAccountAndPositions）
 * @returns 显式区分 COMMITTED/SUPERSEDED/ABORTED；金融与内部失败仍抛原错，外部请求失败保留原重试归属
 */
export function createRebuildTradingDayState(
  deps: RebuildTradingDayStateDeps,
): (params: RebuildTradingDayStateParams) => Promise<RebuildTradingDayStateResult> {
  const {
    marketDataClient,
    warrantRiskRefresh,
    termination,
    orderMonitor,
    lifecycleState,
    tradingCalendarState,
    snapshot,
    symbolRegistry,
    monitorContext,
    dailyLossTracker,
    displayAccountAndPositions,
  } = deps;

  /**
   * 重建交易日运行时状态：刷新标的名称缓存 → 重建订单记录 → 预热交易日历
   * → 重建风险缓存 → 重建浮亏缓存 → 激活重建席位
   * → 基于激活后的 SymbolRegistry 再刷新标的名称缓存 → 恢复订单追踪 → 展示账户持仓。
   * 授权失效返回公开业务结果；不捕获财经/归属错误并猜测为 supersession。
   */
  return async function rebuildTradingDayState(
    params: RebuildTradingDayStateParams,
  ): Promise<RebuildTradingDayStateResult> {
    const { allOrders, quotesMap, now } = params;
    const capturedTokenInput: unknown = params.snapshotToken;
    if (typeof capturedTokenInput !== 'object' || capturedTokenInput === null) {
      throw new TypeError('[Lifecycle] 重建必须携带原 captured snapshotToken');
    }

    for (const component of [
      'dayEpoch',
      'snapshotGeneration',
      'commitRevision',
      'accountRevision',
      'positionRevision',
      'pairedRevision',
    ] as const) {
      const revision = params.snapshotToken[component];
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError(`[Lifecycle] captured snapshotToken.${component} 必须是非负安全整数`);
      }
    }

    const snapshotToken = { ...params.snapshotToken };
    const seats = (['LONG', 'SHORT'] as const).map((direction) => ({
      direction,
      seatState: { ...monitorContext.symbolRegistry.getSeatState(direction) },
      seatVersion: monitorContext.symbolRegistry.getSeatVersion(direction),
    }));
    const targets: Parameters<OrderRecorder['commitRebuildSnapshot']>[0] = seats.flatMap(
      ({ direction, seatState }) =>
        hasSeatSymbol(seatState)
          ? [
              {
                symbol: seatState.symbol,
                isLongSymbol: direction === 'LONG',
                quote: quotesMap.get(seatState.symbol) ?? null,
              },
            ]
          : [],
    );
    const isCurrent = (): boolean => {
      if (termination.isTerminated() || snapshot.getStatus().admission === 'CLOSED') return false;

      const currentToken = snapshot.getView().token;
      return (
        currentToken.dayEpoch === snapshotToken.dayEpoch &&
        currentToken.snapshotGeneration === snapshotToken.snapshotGeneration &&
        currentToken.commitRevision === snapshotToken.commitRevision &&
        currentToken.accountRevision === snapshotToken.accountRevision &&
        currentToken.positionRevision === snapshotToken.positionRevision &&
        currentToken.pairedRevision === snapshotToken.pairedRevision &&
        snapshot.isCurrent(snapshotToken, { account: true, positions: true, paired: true }) &&
        seats.every(({ direction, seatState, seatVersion }) => {
          const currentSeat = monitorContext.symbolRegistry.getSeatState(direction);
          return (
            monitorContext.symbolRegistry.getSeatVersion(direction) === seatVersion &&
            currentSeat.symbol === seatState.symbol &&
            currentSeat.status === seatState.status
          );
        })
      );
    };

    const resolveInvalidation = (): TradingDayRuntimeInvalidationResult | null => {
      if (
        termination.isTerminated() ||
        snapshot.getView().token.dayEpoch !== snapshotToken.dayEpoch ||
        snapshot.getStatus().admission === 'CLOSED'
      ) {
        return { status: 'ABORTED' };
      }

      return isCurrent() ? null : { status: 'SUPERSEDED' };
    };

    try {
      let invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      if (!rebuildOrderRecords(monitorContext, allOrders, targets, isCurrent)) {
        invalidation = resolveInvalidation();
        if (invalidation !== null) return invalidation;

        throw new Error('[Lifecycle] O REBUILD 无授权失效却返回 ABORTED');
      }

      invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      syncMonitorContextSymbolNames(monitorContext, quotesMap);

      await prewarmTradingCalendarSnapshotForRebuild({
        marketDataClient,
        tradingCalendarState,
        monitorContext,
        now,
      });

      invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      if (
        !(await rebuildWarrantRiskCache(warrantRiskRefresh, monitorContext, quotesMap, isCurrent))
      ) {
        invalidation = resolveInvalidation();
        if (invalidation !== null) return invalidation;

        throw new Error('[Lifecycle] warrant 刷新无授权失效却返回 INVALIDATED');
      }

      invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      rebuildUnrealizedLossCache(monitorContext, dailyLossTracker, targets, isCurrent);
      invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      const activationCommitted = commitRebuiltSeatActivation(
        {
          symbolRegistry,
          snapshot,
          getIsTradingEnabled: () => lifecycleState.isTradingEnabled,
          isTerminated: termination.isTerminated,
        },
        {
          snapshotToken,
          seats: seats.flatMap(({ direction, seatState, seatVersion }) =>
            hasSeatSymbol(seatState)
              ? [
                  {
                    direction,
                    symbol: seatState.symbol,
                    status: seatState.status,
                    seatVersion,
                    lastSeatActivatedAt:
                      resolveSeatActivationCarryover({
                        symbolRegistry,
                        direction,
                        symbol: seatState.symbol,
                      }) ?? now.getTime(),
                  },
                ]
              : [],
          ),
        },
      );
      if (!activationCommitted) {
        invalidation = resolveInvalidation();
        if (invalidation !== null) return invalidation;

        throw new Error('[Lifecycle] 重建激活无授权失效却未提交');
      }

      for (const { seatState } of seats) {
        if (hasSeatSymbol(seatState)) seatState.status = 'ACTIVE';
      }

      invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      syncMonitorContextSymbolNames(monitorContext, quotesMap);
      await orderMonitor.recoverOrderTrackingFromSnapshot(allOrders);
      invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      displayAccountAndPositions({ snapshot, quotesMap });
      invalidation = resolveInvalidation();
      if (invalidation !== null) return invalidation;

      clearSeatActivationCarryover(symbolRegistry);
      return { status: 'COMMITTED', snapshotToken: params.snapshotToken };
    } catch (err) {
      if (!isExternalApiRequestError(err)) {
        termination.reportFatalError(err);
      }

      throw err;
    }
  };
}
