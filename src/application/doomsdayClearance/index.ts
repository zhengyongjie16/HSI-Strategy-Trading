/**
 * DoomsdayClearanceWorkflow 末日业务用例
 *
 * 功能：
 * - 收盘前的风险控制
 * - 买入截止窗口内拒绝买入新订单并撤销未成交买入订单
 * - 清仓接管窗口内对当前监控席位可归属且行情可执行的持仓发起自动清仓
 * - 若发现非当前席位仍有正持仓，则直接抛错暴露席位归属不变量破坏
 *
 * 时间规则：
 * - 窗口长度由 `src/constants/index.ts` 中的 `DOOMSDAY` 常量统一定义
 * - 半日市按 12:00 收盘计算，正常交易日按 16:00 收盘计算
 *
 * 控制开关：
 * - DOOMSDAY_PROTECTION 环境变量（默认 true）
 */
import { ORDER_QUOTE_RETRY, TRADING } from '../../constants/index.js';
import { resolveNextQuoteRetry } from '../quoteRetry.js';
import { resolveQuoteReadinessForRequirement } from '../../domain/order/quoteReadiness.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { DoomsdayClearanceCommand, SellSignalAction } from '../../types/signal.js';
import type { PendingOrder } from '../../types/orderReadMetadata.js';
import type {
  DoomsdayClearanceWorkflow,
  DoomsdayClearanceWorkflowDeps,
  DoomsdayEvaluationContext,
  DoomsdayMonitorContext,
  DoomsdayClearanceContext,
  DoomsdayClearanceResult,
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
  ClearanceSignalParams,
  PositionClearanceParams,
} from './types.js';
import {
  resolveDoomsdayRetryAtMs,
  getDoomsdayBuyCutoffWindowRangeLabel,
  getDoomsdayClearanceTakeoverWindowRangeLabel,
  isWithinDoomsdayBuyCutoffWindow,
  isWithinDoomsdayClearanceTakeoverWindow,
} from '../../domain/liquidation/doomsday/index.js';
import type { DoomsdayExecutionState } from '../../domain/liquidation/doomsday/types.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { getHKDateKey } from '../../utils/time/index.js';
import { isInContinuousHKSession } from '../../domain/tradingSession/index.js';
import { formatDecimal } from '../../utils/numeric/exact.js';
import { isCancelAcceptedOrTerminalNonFilledClose } from '../../domain/order/cancelOutcomePolicy.js';

function formatPendingOrderPrice(order: PendingOrder): string {
  if (order.submittedPrice !== null) {
    return formatDecimal(order.submittedPrice, 3, 'unsigned');
  }

  return order.orderType === 'MO' ? '无委托价（市价单）' : '无委托价';
}

/**
 * 创建单个清仓信号（清仓接管窗口使用）。
 * 直接构造清仓信号对象，避免跨链路共享可变池化对象。
 *
 * @param params 清仓信号参数（标的、名称、动作、席位版本）
 * @returns 填充后的卖出信号
 */
function createClearanceSignal(params: ClearanceSignalParams): DoomsdayClearanceCommand {
  const { symbol, symbolName, action, triggerTime, seatVersion } = params;

  return {
    symbol,
    symbolName,
    action,
    triggerTime,
    seatVersion,
  };
}

/**
 * 解析末日清仓可安全归属的席位事实。
 * ACTIVE 席位始终可归属；SWITCHING 席位只有仍被权威 pending switch 状态机持有时，才允许把其当前
 * symbol 作为末日清仓目标。ACTIVATING 已经绑定新标的，不得把旧标的持仓静默归属给它。
 *
 * @param context 监控上下文
 * @param direction 多空方向（LONG/SHORT）
 * @param logger 注入日志能力
 * @returns 已证明归属的 symbol 与当前 seatVersion；无法证明时返回 null
 */
function resolveDoomsdaySeatOwnership(
  context: DoomsdayMonitorContext,
  direction: 'LONG' | 'SHORT',
  logger: DoomsdayClearanceWorkflowDeps['logger'],
): { readonly symbol: string; readonly seatVersion: number } | null {
  const seatState = context.symbolRegistry.getSeatState(direction);
  if (seatState.status === 'ACTIVE') {
    return {
      symbol: seatState.symbol,
      seatVersion: context.symbolRegistry.getSeatVersion(direction),
    };
  }

  if (seatState.status === 'SWITCHING' && context.seatSwitch.hasPendingSwitch(direction)) {
    return {
      symbol: seatState.symbol,
      seatVersion: context.symbolRegistry.getSeatVersion(direction),
    };
  }

  logger.debug(
    `[末日保护程序] 席位不具备可证明清仓归属，跳过: ${context.config.monitorSymbol} ${direction} status=${seatState.status}`,
  );
  return null;
}

/**
 * 解析当前监控上下文的多空席位交易标的。
 * 供清仓流程获取做多/做空标的，用于匹配持仓与拉取行情。
 *
 * @param monitorContext 单一监控上下文
 * @param logger 注入日志能力
 * @returns 当前监控下的 longSymbol 与 shortSymbol（未就绪时为 null）
 */
function resolveMonitorSymbols(
  monitorContext: DoomsdayMonitorContext,
  logger: DoomsdayClearanceWorkflowDeps['logger'],
): {
  readonly longSymbol: string | null;
  readonly shortSymbol: string | null;
  readonly longSeatVersion: number | null;
  readonly shortSeatVersion: number | null;
} {
  const longOwnership = resolveDoomsdaySeatOwnership(monitorContext, 'LONG', logger);
  const shortOwnership = resolveDoomsdaySeatOwnership(monitorContext, 'SHORT', logger);

  return {
    longSymbol: longOwnership?.symbol ?? null,
    shortSymbol: shortOwnership?.symbol ?? null,
    longSeatVersion: longOwnership?.seatVersion ?? null,
    shortSeatVersion: shortOwnership?.seatVersion ?? null,
  };
}

function hasPositiveAvailableQuantity(position: Position): boolean {
  const availableQty = position.availableQuantity || 0;
  return (
    typeof position.symbol === 'string' &&
    position.symbol.length > 0 &&
    Number.isFinite(availableQty) &&
    availableQty > 0
  );
}

/**
 * 处理单个持仓，生成一条清仓信号。
 * 仅当持仓属于当前监控配置（longSymbol/shortSymbol）且数量有效时生成信号；直接构造清仓信号。
 *
 * @param params 当前持仓、两侧席位事实、已验证行情与统一触发时间
 * @param logger 注入日志能力
 * @returns 一条清仓卖出信号（SELLCALL/SELLPUT），或不属于本监控/无效持仓时 null
 */
function processPositionForClearance(
  params: PositionClearanceParams,
  logger: DoomsdayClearanceWorkflowDeps['logger'],
): DoomsdayClearanceCommand | null {
  const {
    position,
    longSymbol,
    shortSymbol,
    longSeatVersion,
    shortSeatVersion,
    longQuote,
    shortQuote,
    triggerTime,
  } = params;

  // 验证持仓对象有效性
  if (position.symbol.length === 0) {
    return null;
  }

  const availableQty = position.availableQuantity || 0;
  if (!Number.isFinite(availableQty) || availableQty <= 0) {
    return null;
  }

  // 只处理属于当前监控配置的持仓
  if (position.symbol !== longSymbol && position.symbol !== shortSymbol) {
    return null;
  }

  const isShortPos = position.symbol === shortSymbol;
  const seatVersion = isShortPos ? shortSeatVersion : longSeatVersion;
  if (seatVersion === null) {
    return null;
  }

  // 行情在调用方已按 PRICE 口径校验；命令只保留身份，不能携带可能过期的执行价格或手数。
  let symbolName: string | null = position.symbolName || null;
  if (position.symbol === longSymbol && longQuote) {
    symbolName = symbolName ?? longQuote.name ?? null;
  } else if (position.symbol === shortSymbol && shortQuote) {
    symbolName = symbolName ?? shortQuote.name ?? null;
  } else {
    return null;
  }

  // 清仓接管窗口清仓
  const action: SellSignalAction = isShortPos ? 'SELLPUT' : 'SELLCALL';
  const signal = createClearanceSignal({
    symbol: position.symbol,
    symbolName,
    action,
    triggerTime,
    seatVersion,
  });
  const positionLabel = isShortPos ? '做空标的' : '做多标的';
  logger.debug(
    `[末日保护程序] 生成清仓信号：${positionLabel} ${position.symbol} 数量=${availableQty} 操作=${action}`,
  );

  return signal;
}

/**
 * 创建唯一末日业务用例。
 * 保留撤买→清仓的既有顺序、窗口内等待及 all-success/live 副作用，复用原订单执行与追踪事实。
 * @param deps app 注入的时钟、日志与原行情重试配置
 * @returns 持有当日撤单与窗口内等待状态的末日 workflow
 */
export function createDoomsdayClearanceWorkflow(
  deps: DoomsdayClearanceWorkflowDeps,
): DoomsdayClearanceWorkflow {
  const { now, logger } = deps;
  const quoteRetryIntervalMs = deps.quoteRetryIntervalMs ?? ORDER_QUOTE_RETRY.INTERVAL_MS;
  const quoteRetryMaxAttempts = deps.quoteRetryMaxAttempts ?? ORDER_QUOTE_RETRY.MAX_ATTEMPTS;
  const state: DoomsdayExecutionState = {
    cancelCheckExecutedDate: null,
    lastClearanceNoticeKey: null,
    clearanceRetryAttempts: 0,
    clearanceRetrySymbols: null,
    clearanceRetryDueAtMs: null,
    clearanceReevaluationSymbols: null,
    clearanceRetryExhaustedSymbols: new Set(),
  };

  const clearClearanceRetry = (): void => {
    state.clearanceRetryAttempts = 0;
    state.clearanceRetrySymbols = null;
    state.clearanceRetryDueAtMs = null;
  };

  const abortClearanceForClosedLiveGate = (
    executedOrderCount: number = 0,
  ): DoomsdayClearanceResult => {
    clearClearanceRetry();
    state.clearanceReevaluationSymbols = null;
    state.clearanceRetryExhaustedSymbols.clear();
    return {
      executed: executedOrderCount > 0,
      nextRetryAtMs: null,
    };
  };

  const logClearanceNotice = (key: string, message: string): void => {
    if (state.lastClearanceNoticeKey === key) {
      return;
    }

    state.lastClearanceNoticeKey = key;
    logger.info(message);
  };

  /**
   * 执行清仓接管窗口的自动清仓。
   *
   * 关键约束：
   * - 生命周期交易门禁关闭时必须直接跳过，不允许执行清仓或继续窗口重评估；
   * - 仅在清仓接管窗口且持仓非空时继续后续流程。
   */
  async function executeClearance(
    context: DoomsdayClearanceContext,
  ): Promise<DoomsdayClearanceResult> {
    const {
      currentTime,
      isHalfDay,
      positions,
      monitorContext,
      orderExecutor,
      marketDataClient,
      lifecycleState,
      snapshot,
      isLive,
    } = context;
    const todayKey = getHKDateKey(currentTime);
    const dayEpoch = snapshot.getView().token.dayEpoch;

    if (!isLive()) {
      return abortClearanceForClosedLiveGate();
    }

    if (!lifecycleState.isTradingEnabled) {
      clearClearanceRetry();
      state.clearanceReevaluationSymbols = null;
      state.clearanceRetryExhaustedSymbols.clear();
      logClearanceNotice(
        `gate-closed:${todayKey}`,
        '[末日保护程序] 清仓跳过：生命周期交易门禁关闭',
      );
      return { executed: false, nextRetryAtMs: null };
    }

    if (!isWithinDoomsdayClearanceTakeoverWindow(currentTime, isHalfDay)) {
      clearClearanceRetry();
      state.clearanceReevaluationSymbols = null;
      state.clearanceRetryExhaustedSymbols.clear();
      const clearanceWindowRange = getDoomsdayClearanceTakeoverWindowRangeLabel(isHalfDay);
      logClearanceNotice(
        `outside-window:${todayKey}`,
        `[末日保护程序] 清仓跳过：当前不在清仓接管窗口（${clearanceWindowRange}）`,
      );
      return { executed: false, nextRetryAtMs: null };
    }

    const retrySymbols =
      state.clearanceReevaluationSymbols === null
        ? state.clearanceRetrySymbols
        : new Set([...state.clearanceReevaluationSymbols, ...(state.clearanceRetrySymbols ?? [])]);
    state.clearanceReevaluationSymbols = null;
    const retryPendingPositions =
      retrySymbols === null
        ? positions
        : positions.filter((position) => retrySymbols.has(position.symbol));
    const processingPositions = retryPendingPositions.filter(
      (position) => !state.clearanceRetryExhaustedSymbols.has(position.symbol),
    );
    if (processingPositions.length === 0) {
      clearClearanceRetry();
      state.clearanceReevaluationSymbols = null;
      logClearanceNotice(`no-positions:${todayKey}`, '[末日保护程序] 清仓跳过：无可处理持仓');
      return { executed: false, nextRetryAtMs: null };
    }

    const allTradingSymbols = new Set<string>();
    const { longSymbol, shortSymbol, longSeatVersion, shortSeatVersion } = resolveMonitorSymbols(
      monitorContext,
      logger,
    );
    if (longSymbol) {
      allTradingSymbols.add(longSymbol);
    }

    if (shortSymbol) {
      allTradingSymbols.add(shortSymbol);
    }

    const unmatchedPositions = positions.filter(
      (position) =>
        hasPositiveAvailableQuantity(position) && !allTradingSymbols.has(position.symbol),
    );
    if (unmatchedPositions.length > 0) {
      const unmatchedSummary = unmatchedPositions
        .map((position) => `${position.symbol}:${position.availableQuantity || 0}`)
        .join(',');
      throw new Error(
        `[末日保护程序] 清仓接管窗口发现非当前席位持仓，无法安全自动清仓: symbols=${unmatchedSummary} currentLong=${longSymbol ?? 'null'} currentShort=${shortSymbol ?? 'null'}`,
      );
    }

    const quoteMap =
      allTradingSymbols.size === 0
        ? new Map<string, Quote | null>()
        : await marketDataClient.getQuotes(allTradingSymbols);
    if (!isLive()) {
      return abortClearanceForClosedLiveGate();
    }

    const allClearanceSignals: DoomsdayClearanceCommand[] = [];
    const unresolvedSymbols = new Set<string>();

    const longQuote = longSymbol ? (quoteMap.get(longSymbol) ?? null) : null;
    const shortQuote = shortSymbol ? (quoteMap.get(shortSymbol) ?? null) : null;
    const clearanceSignalTime = now();

    for (const pos of processingPositions) {
      if (pos.symbol === longSymbol) {
        const quoteReadiness = resolveQuoteReadinessForRequirement({
          quote: longQuote,
          requirement: 'PRICE',
        });
        if (quoteReadiness !== 'READY') {
          if (quoteReadiness === 'MISSING') {
            unresolvedSymbols.add(pos.symbol);
          } else {
            logger.warn(
              `[末日保护程序] 清仓行情无效，跳过本轮清仓信号: symbol=${pos.symbol} readiness=${quoteReadiness}`,
            );
          }

          continue;
        }
      }

      if (pos.symbol === shortSymbol) {
        const quoteReadiness = resolveQuoteReadinessForRequirement({
          quote: shortQuote,
          requirement: 'PRICE',
        });
        if (quoteReadiness !== 'READY') {
          if (quoteReadiness === 'MISSING') {
            unresolvedSymbols.add(pos.symbol);
          } else {
            logger.warn(
              `[末日保护程序] 清仓行情无效，跳过本轮清仓信号: symbol=${pos.symbol} readiness=${quoteReadiness}`,
            );
          }

          continue;
        }
      }

      const signal = processPositionForClearance(
        {
          position: pos,
          longSymbol,
          shortSymbol,
          longSeatVersion,
          shortSeatVersion,
          longQuote,
          shortQuote,
          triggerTime: clearanceSignalTime,
        },
        logger,
      );
      if (signal) {
        allClearanceSignals.push(signal);
      }
    }

    const uniqueSignalsMap = new Map<string, DoomsdayClearanceCommand>();
    for (const signal of allClearanceSignals) {
      const key = `${signal.action}_${signal.symbol}`;
      if (!uniqueSignalsMap.has(key)) {
        uniqueSignalsMap.set(key, signal);
      }
    }

    const uniqueClearanceSignals = [...uniqueSignalsMap.values()];
    let executedOrderCount = 0;
    if (uniqueClearanceSignals.length > 0) {
      logger.info(`[末日保护程序] 生成 ${uniqueClearanceSignals.length} 个清仓信号，准备执行`);
      if (!isLive()) {
        return abortClearanceForClosedLiveGate();
      }

      const executionResult = await orderExecutor.executeDoomsdayClearanceSignals(
        uniqueClearanceSignals,
        isLive,
      );
      executedOrderCount = executionResult.executedOrderIds.length;
      if (!isLive()) {
        return abortClearanceForClosedLiveGate(executedOrderCount);
      }

      if (executionResult.reevaluationSymbols.length > 0) {
        state.clearanceReevaluationSymbols = new Set(executionResult.reevaluationSymbols);
        logger.warn(
          `[末日保护程序] 可卖量计划失效或卖单跟进交接中，安排系统级重评估: symbols=${executionResult.reevaluationSymbols.join(',')}`,
        );
      }

      for (const symbol of executionResult.unresolvedQuoteSymbols) {
        unresolvedSymbols.add(symbol);
      }

      if (executedOrderCount === uniqueClearanceSignals.length) {
        if (!isLive()) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }

        if (
          !context.lifecycleState.isTradingEnabled ||
          snapshot.getView().token.dayEpoch !== dayEpoch
        ) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }

        // 全部 accepted 只证明提交成功，不证明持仓已平；不虚裁 positions 或登记 settlement stale。
        // owner 原接口无 epoch 入参：先同步核对 captured epoch，再失效账户，无 await 间隙。
        snapshot.invalidateAccount();
        if (!isLive()) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }
      } else {
        logger.warn(
          `[末日保护程序] 清仓信号仅执行 ${executedOrderCount}/${uniqueClearanceSignals.length} 个，保留 canonical 事实与订单记录等待后续刷新`,
        );
      }
    } else {
      const availablePositions = processingPositions.filter(hasPositiveAvailableQuantity);
      logClearanceNotice(
        `no-signals:${todayKey}:${positions.length}:${availablePositions.length}`,
        `[末日保护程序] 清仓跳过：未生成清仓信号（处理持仓=${processingPositions.length}, 可用持仓=${availablePositions.length}）`,
      );
    }

    // 可卖计划重评估与缺行情预算独立；二者同时存在时仅投影最早的下一次系统唤醒。
    const reevaluationTime = now();
    const reevaluationRetryAtMs =
      state.clearanceReevaluationSymbols === null
        ? null
        : resolveDoomsdayRetryAtMs(
            reevaluationTime,
            isHalfDay,
            reevaluationTime.getTime() + quoteRetryIntervalMs,
          );

    if (unresolvedSymbols.size > 0) {
      if (!isLive()) {
        return abortClearanceForClosedLiveGate(executedOrderCount);
      }

      state.clearanceRetrySymbols = new Set(unresolvedSymbols);
      const retryDecisionTime = now();
      const currentMs = retryDecisionTime.getTime();
      if (state.clearanceRetryDueAtMs !== null && currentMs < state.clearanceRetryDueAtMs) {
        const nextRetryAtMs = resolveDoomsdayRetryAtMs(
          retryDecisionTime,
          isHalfDay,
          state.clearanceRetryDueAtMs,
        );
        if (nextRetryAtMs !== null) {
          return {
            executed: executedOrderCount > 0,
            nextRetryAtMs: Math.min(nextRetryAtMs, reevaluationRetryAtMs ?? nextRetryAtMs),
          };
        }

        clearClearanceRetry();
      }

      const nextRetry = resolveNextQuoteRetry({
        attempts: state.clearanceRetryAttempts,
        nowMs: currentMs,
        intervalMs: quoteRetryIntervalMs,
        maxAttempts: quoteRetryMaxAttempts,
      });
      if (nextRetry.exhausted) {
        clearClearanceRetry();
        for (const symbol of unresolvedSymbols) {
          state.clearanceRetryExhaustedSymbols.add(symbol);
        }

        logger.warn(
          `[末日保护程序] 清仓行情重试耗尽，放弃本窗口重试: symbols=${[...unresolvedSymbols].join(',')}`,
        );
        return {
          executed: executedOrderCount > 0,
          nextRetryAtMs: reevaluationRetryAtMs,
        };
      }

      const nextRetryAtMs = resolveDoomsdayRetryAtMs(
        retryDecisionTime,
        isHalfDay,
        nextRetry.nextRetryAt,
      );
      if (nextRetryAtMs === null) {
        clearClearanceRetry();
        return {
          executed: executedOrderCount > 0,
          nextRetryAtMs: reevaluationRetryAtMs,
        };
      }

      state.clearanceRetryAttempts = nextRetry.nextAttempts;
      state.clearanceRetryDueAtMs = nextRetryAtMs;
      return {
        executed: executedOrderCount > 0,
        nextRetryAtMs: Math.min(nextRetryAtMs, reevaluationRetryAtMs ?? nextRetryAtMs),
      };
    }

    clearClearanceRetry();
    return {
      executed: executedOrderCount > 0,
      nextRetryAtMs: reevaluationRetryAtMs,
    };
  }

  /**
   * 按当日一次检查规则撤销买单；原实时授权在每个 await 后及 broker permit 内复核。
   * cancel accepted 只完成本次检查，权威终态仍由既有 tracking 推进。
   */
  async function cancelPendingBuyOrders(
    context: CancelPendingBuyOrdersContext,
  ): Promise<CancelPendingBuyOrdersResult> {
    const { currentTime, isHalfDay, isLive, monitorContext, cacheManager, orderMonitor } = context;

    if (!isLive()) {
      return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
    }

    // 检查是否处于买入截止窗口
    if (!isWithinDoomsdayBuyCutoffWindow(currentTime, isHalfDay)) {
      // 不在买入截止窗口内，直接返回。
      // 当天执行标记由日期键自然隔离，无需额外重置 state.cancelCheckExecutedDate。
      return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
    }

    // 检查当天是否已完成撤单检查
    // 逻辑：处于买入截止窗口内时执行检查；仅在确认无需继续处理后才标记当天完成
    // 原因：末日保护期间已拒绝新买入，但若仍有撤单未确认成功，后续仍需继续复查
    //       已接受的撤单请求终态由 WebSocket 监控，无需额外轮询单笔订单状态
    const todayDateString = getHKDateKey(currentTime);
    if (state.cancelCheckExecutedDate === todayDateString) {
      // 当天已执行过，直接返回
      return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
    }

    // 收集所有唯一的交易标的
    const allTradingSymbols = new Set<string>();
    const { longSymbol, shortSymbol } = resolveMonitorSymbols(monitorContext, logger);
    if (longSymbol) {
      allTradingSymbols.add(longSymbol);
    }

    if (shortSymbol) {
      allTradingSymbols.add(shortSymbol);
    }

    if (allTradingSymbols.size === 0) {
      return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
    }

    const symbolsArray = [...allTradingSymbols];

    // 在买入截止窗口内查询未成交订单。
    // 若仍有撤单未确认成功，后续会继续调用 Trade API 复查。
    const closeTimeRange = getDoomsdayBuyCutoffWindowRangeLabel(isHalfDay);
    logger.info(`[末日保护程序] 买入截止窗口（${closeTimeRange}）内检查未成交买入订单`);
    const pendingOrders = await cacheManager.getPendingOrders(symbolsArray, true);
    if (!isLive()) {
      return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
    }

    // 过滤出买入订单
    const pendingBuyOrders = pendingOrders.filter((order) => order.side === 'BUY');
    if (pendingBuyOrders.length === 0) {
      if (!isLive()) {
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      state.cancelCheckExecutedDate = todayDateString;
      logger.info('[末日保护程序] 无未成交买入订单，无需撤单');
      return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
    }

    logger.info(`[末日保护程序] 发现 ${pendingBuyOrders.length} 个未成交买入订单，准备撤单`);

    // 撤销所有买入订单
    let cancelRequestAcceptedCount = 0;
    let cancelRetryRequired = false;
    for (const order of pendingBuyOrders) {
      if (!isLive()) {
        return {
          executed: cancelRequestAcceptedCount > 0,
          cancelRequestAcceptedCount,
          nextRetryAtMs: null,
        };
      }

      const cancelOutcome = await orderMonitor.cancelDoomsdayOrder(order.orderId, {
        kind: 'DOOMSDAY_WINDOW',
        beforeBrokerCancel: isLive,
      });
      if (cancelOutcome.kind === 'CANCEL_NOT_STARTED') {
        return {
          executed: cancelRequestAcceptedCount > 0,
          cancelRequestAcceptedCount,
          nextRetryAtMs: null,
        };
      }

      if (isCancelAcceptedOrTerminalNonFilledClose(cancelOutcome)) {
        cancelRequestAcceptedCount++;
        if (!isLive()) {
          return {
            executed: true,
            cancelRequestAcceptedCount,
            nextRetryAtMs: null,
          };
        }

        logger.debug(
          `[末日保护程序] 买入订单撤单请求已接受：${order.symbol} 订单ID=${order.orderId} 数量=${order.quantity} 价格=${formatPendingOrderPrice(order)}，终态以后续 WS 为准`,
        );
        continue;
      }

      if (cancelOutcome.kind === 'ALREADY_CLOSED' && cancelOutcome.closedReason === 'FILLED') {
        if (!isLive()) {
          return {
            executed: cancelRequestAcceptedCount > 0,
            cancelRequestAcceptedCount,
            nextRetryAtMs: null,
          };
        }

        logger.debug(`[末日保护程序] 买入订单已成交，无需撤单：${order.orderId}`);
        continue;
      }

      if (!isLive()) {
        return {
          executed: cancelRequestAcceptedCount > 0,
          cancelRequestAcceptedCount,
          nextRetryAtMs: null,
        };
      }

      cancelRetryRequired = true;
      logger.warn(
        `[末日保护程序] 撤销买入订单未确认成功：${order.orderId} kind=${cancelOutcome.kind}`,
      );
    }

    if (cancelRequestAcceptedCount > 0) {
      logger.info(
        `[末日保护程序] 已提交撤单请求 ${cancelRequestAcceptedCount}/${pendingBuyOrders.length} 个买入订单，终态以后续 WS 为准`,
      );
    }

    if (!isLive()) {
      return {
        executed: cancelRequestAcceptedCount > 0,
        cancelRequestAcceptedCount,
        nextRetryAtMs: null,
      };
    }

    if (cancelRetryRequired) {
      const retryDecisionTime = now();
      return {
        executed: true,
        cancelRequestAcceptedCount,
        nextRetryAtMs: resolveDoomsdayRetryAtMs(
          retryDecisionTime,
          isHalfDay,
          retryDecisionTime.getTime() + quoteRetryIntervalMs,
        ),
      };
    }

    if (!isLive()) {
      return {
        executed: cancelRequestAcceptedCount > 0,
        cancelRequestAcceptedCount,
        nextRetryAtMs: null,
      };
    }

    state.cancelCheckExecutedDate = todayDateString;
    return { executed: true, cancelRequestAcceptedCount, nextRetryAtMs: null };
  }

  /**
   * 承接时间控制平面的末日触发，统一持有顺序、origin epoch 授权及失败策略。
   * UNKNOWN 必须原错上抛到顶层 fatal/正常 cleanup；其余明确外部失败保留原系统级重评估。
   */
  async function evaluate(context: DoomsdayEvaluationContext): Promise<DoomsdayClearanceResult> {
    const {
      currentTime,
      isHalfDay,
      dayEpoch,
      monitorContext,
      cacheManager,
      orderMonitor,
      snapshot,
      lifecycleState,
    } = context;
    const isLive = (): boolean => {
      const liveTime = now();
      return (
        snapshot.getView().token.dayEpoch === dayEpoch &&
        lifecycleState.isTradingEnabled &&
        isInContinuousHKSession(liveTime, isHalfDay) &&
        (isWithinDoomsdayBuyCutoffWindow(liveTime, isHalfDay) ||
          isWithinDoomsdayClearanceTakeoverWindow(liveTime, isHalfDay))
      );
    };
    let nextRetryAtMs: number | null = null;
    try {
      const cancelResult = await cancelPendingBuyOrders({
        currentTime,
        isHalfDay,
        isLive,
        monitorContext,
        cacheManager,
        orderMonitor,
      });
      nextRetryAtMs = cancelResult.nextRetryAtMs;
      if (cancelResult.executed && cancelResult.cancelRequestAcceptedCount > 0) {
        logger.info(
          `[末日保护程序] 买入截止窗口已提交撤单请求，共 ${cancelResult.cancelRequestAcceptedCount} 个买入订单，终态以后续 WS 为准`,
        );
      }

      if (!isLive()) return { executed: false, nextRetryAtMs };

      const clearanceView = snapshot.getView();
      if (clearanceView.token.dayEpoch !== dayEpoch) return { executed: false, nextRetryAtMs };

      const clearanceResult = await executeClearance({
        ...context,
        isLive,
        positions: clearanceView.positions,
      });
      if (
        clearanceResult.nextRetryAtMs !== null &&
        (nextRetryAtMs === null || clearanceResult.nextRetryAtMs < nextRetryAtMs)
      ) {
        nextRetryAtMs = clearanceResult.nextRetryAtMs;
      }

      return { executed: clearanceResult.executed, nextRetryAtMs };
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      logger.warn(
        '[DoomsdayClearance] 末日保护 API 请求失败，等待下一次系统级重评估',
        error.message,
      );
      const apiRetryAtMs = currentTime.getTime() + TRADING.INTERVAL_MS;
      return {
        executed: false,
        nextRetryAtMs:
          nextRetryAtMs === null ? apiRetryAtMs : Math.min(nextRetryAtMs, apiRetryAtMs),
      };
    }
  }

  return { evaluate, executeClearance, cancelPendingBuyOrders };
}
