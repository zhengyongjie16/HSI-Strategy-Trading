/**
 * 末日保护模块
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
import { OrderSide, OrderType } from 'longbridge';
import { logger } from '../../utils/logger/index.js';
import { ORDER_QUOTE_RETRY, TIME } from '../../constants/index.js';
import {
  resolveNextQuoteRetry,
  resolveQuoteReadinessForRequirement,
} from '../../utils/quoteRetry/index.js';
import type { MonitorContext } from '../../types/state.js';
import type { Position } from '../../types/account.js';
import type { DoomsdayClearanceCommand, SellSignalAction } from '../../types/signal.js';
import type { PendingOrder } from '../../types/services.js';
import type {
  DoomsdayProtection,
  DoomsdayClearanceContext,
  DoomsdayClearanceResult,
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
  ClearanceSignalParams,
  PositionClearanceParams,
} from './types.js';
import {
  batchGetQuotes,
  getDoomsdayBuyCutoffWindowRangeLabel,
  getDoomsdayClearanceTakeoverWindowRangeLabel,
  isWithinDoomsdayBuyCutoffWindow,
  isWithinDoomsdayClearanceTakeoverWindow,
} from './utils.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { getHKDateKey, resolveHKDayStartUtcMs } from '../../utils/time/index.js';
import { isCancelAcceptedOrTerminalNonFilledClose } from '../../utils/trading/orderStatus.js';

function formatPendingOrderPrice(order: PendingOrder): string {
  if (order.submittedPrice !== null) {
    return order.submittedPrice.toFixed(3);
  }

  return order.orderType === OrderType.MO ? '无委托价（市价单）' : '无委托价';
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
 * @returns 已证明归属的 symbol 与当前 seatVersion；无法证明时返回 null
 */
function resolveDoomsdaySeatOwnership(
  context: MonitorContext,
  direction: 'LONG' | 'SHORT',
): { readonly symbol: string; readonly seatVersion: number } | null {
  const seatState = context.symbolRegistry.getSeatState(direction);
  if (seatState.status === 'ACTIVE') {
    return {
      symbol: seatState.symbol,
      seatVersion: context.symbolRegistry.getSeatVersion(direction),
    };
  }

  if (seatState.status === 'SWITCHING' && context.autoSymbolManager.hasPendingSwitch(direction)) {
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
 * @returns 当前监控下的 longSymbol 与 shortSymbol（未就绪时为 null）
 */
function resolveMonitorSymbols(monitorContext: MonitorContext): {
  longSymbol: string | null;
  shortSymbol: string | null;
  longSeatVersion: number | null;
  shortSeatVersion: number | null;
} {
  const longOwnership = resolveDoomsdaySeatOwnership(monitorContext, 'LONG');
  const shortOwnership = resolveDoomsdaySeatOwnership(monitorContext, 'SHORT');

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
 * 计算当前末日保护决定允许使用的下一次系统级重评估时刻。
 * 重评估只能留在当前末日清仓窗口内，不能把等待、行情缺失或撤单未知状态带到收盘后。
 *
 * @param currentTime 当前 retry owner 的决策时间
 * @param isHalfDay 是否为半日市
 * @param candidateRetryAtMs 本次 retry owner 计算出的候选重评估时刻
 * @returns 窗口内的下一次重评估时刻；越过收盘边界时返回 null
 */
function resolveDoomsdayRetryAtMs(
  currentTime: Date,
  isHalfDay: boolean,
  candidateRetryAtMs: number | null,
): number | null {
  const currentMs = currentTime.getTime();
  if (
    !Number.isFinite(currentMs) ||
    candidateRetryAtMs === null ||
    !Number.isFinite(candidateRetryAtMs) ||
    candidateRetryAtMs <= currentMs
  ) {
    return null;
  }

  const dayKey = getHKDateKey(currentTime);
  if (dayKey === null) {
    return null;
  }

  const dayStartMs = resolveHKDayStartUtcMs(dayKey);
  if (dayStartMs === null) {
    return null;
  }

  const closeMinuteOfDay = isHalfDay ? 12 * 60 : 16 * 60;
  const closeMs = dayStartMs + closeMinuteOfDay * TIME.MILLISECONDS_PER_MINUTE;
  return candidateRetryAtMs < closeMs ? candidateRetryAtMs : null;
}

/**
 * 处理单个持仓，生成一条清仓信号。
 * 仅当持仓属于当前监控配置（longSymbol/shortSymbol）且数量有效时生成信号；直接构造清仓信号。
 *
 * @param params 当前持仓、两侧席位事实、已验证行情与统一触发时间
 * @returns 一条清仓卖出信号（SELLCALL/SELLPUT），或不属于本监控/无效持仓时 null
 */
function processPositionForClearance(
  params: PositionClearanceParams,
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
 * 创建末日保护程序（生命周期/风控：买入截止与自动清仓）
 * 买入截止窗口内拒绝买入并撤销未成交买入单，清仓接管窗口内对当前监控席位可归属且行情可执行的持仓发起自动清仓。
 * 若存在无法归属到当前席位的正持仓，则直接抛错而不是按正常“无信号”跳过。
 * @returns DoomsdayProtection 接口实例（isBuyCutoffWindowActive、executeClearance、cancelPendingBuyOrders）
 */
export function createDoomsdayProtection(deps: {
  readonly now: () => Date;
  readonly quoteRetryIntervalMs?: number;
  readonly quoteRetryMaxAttempts?: number;
}): DoomsdayProtection {
  // 状态：记录当天是否已执行过买入截止窗口的撤单检查
  // 格式为日期字符串（YYYY-MM-DD），用于跨天自动重置
  let cancelCheckExecutedDate: string | null = null;
  let lastClearanceNoticeKey: string | null = null;
  const { now } = deps;
  const quoteRetryIntervalMs = deps.quoteRetryIntervalMs ?? ORDER_QUOTE_RETRY.INTERVAL_MS;
  const quoteRetryMaxAttempts = deps.quoteRetryMaxAttempts ?? ORDER_QUOTE_RETRY.MAX_ATTEMPTS;
  let clearanceRetryAttempts = 0;
  let clearanceRetrySymbols: ReadonlySet<string> | null = null;
  let clearanceRetryDueAtMs: number | null = null;
  let clearanceAwaitingTerminalSymbols: ReadonlySet<string> | null = null;
  const clearanceRetryExhaustedSymbols = new Set<string>();

  const clearClearanceRetry = (): void => {
    clearanceRetryAttempts = 0;
    clearanceRetrySymbols = null;
    clearanceRetryDueAtMs = null;
  };

  const abortClearanceForClosedLiveGate = (
    executedOrderCount: number = 0,
  ): DoomsdayClearanceResult => {
    clearClearanceRetry();
    clearanceAwaitingTerminalSymbols = null;
    clearanceRetryExhaustedSymbols.clear();
    return {
      executed: executedOrderCount > 0,
      nextRetryAtMs: null,
    };
  };

  const logClearanceNotice = (key: string, message: string): void => {
    if (lastClearanceNoticeKey === key) {
      return;
    }

    lastClearanceNoticeKey = key;
    logger.info(message);
  };

  /**
   * 执行清仓接管窗口的自动清仓。
   *
   * 关键约束：
   * - 生命周期交易门禁关闭时必须直接跳过，不允许执行清仓或继续 retry 恢复；
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
      trader,
      marketDataClient,
      lastState,
      onPositionsCommitted,
      isLive,
    } = context;
    const todayKey = getHKDateKey(currentTime);

    if (!isLive()) {
      return abortClearanceForClosedLiveGate();
    }

    if (!lastState.isTradingEnabled) {
      clearClearanceRetry();
      clearanceAwaitingTerminalSymbols = null;
      clearanceRetryExhaustedSymbols.clear();
      logClearanceNotice(
        `gate-closed:${todayKey}`,
        '[末日保护程序] 清仓跳过：生命周期交易门禁关闭',
      );
      return { executed: false, nextRetryAtMs: null };
    }

    if (!isWithinDoomsdayClearanceTakeoverWindow(currentTime, isHalfDay)) {
      clearClearanceRetry();
      clearanceAwaitingTerminalSymbols = null;
      clearanceRetryExhaustedSymbols.clear();
      const clearanceWindowRange = getDoomsdayClearanceTakeoverWindowRangeLabel(isHalfDay);
      logClearanceNotice(
        `outside-window:${todayKey}`,
        `[末日保护程序] 清仓跳过：当前不在清仓接管窗口（${clearanceWindowRange}）`,
      );
      return { executed: false, nextRetryAtMs: null };
    }

    const retrySymbols = clearanceAwaitingTerminalSymbols ?? clearanceRetrySymbols;
    const retryPendingPositions =
      retrySymbols === null
        ? positions
        : positions.filter((position) => retrySymbols.has(position.symbol));
    const processingPositions = retryPendingPositions.filter(
      (position) => !clearanceRetryExhaustedSymbols.has(position.symbol),
    );
    if (processingPositions.length === 0) {
      clearClearanceRetry();
      clearanceAwaitingTerminalSymbols = null;
      logClearanceNotice(`no-positions:${todayKey}`, '[末日保护程序] 清仓跳过：无可处理持仓');
      return { executed: false, nextRetryAtMs: null };
    }

    const allTradingSymbols = new Set<string>();
    const { longSymbol, shortSymbol, longSeatVersion, shortSeatVersion } =
      resolveMonitorSymbols(monitorContext);
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

    const quoteMap = await batchGetQuotes(marketDataClient, allTradingSymbols);
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

      const signal = processPositionForClearance({
        position: pos,
        longSymbol,
        shortSymbol,
        longSeatVersion,
        shortSeatVersion,
        longQuote,
        shortQuote,
        triggerTime: clearanceSignalTime,
      });
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
      const submittedSymbols = new Set(uniqueClearanceSignals.map((signal) => signal.symbol));
      if (!isLive()) {
        return abortClearanceForClosedLiveGate();
      }

      const executionResult = await trader.executeDoomsdayClearanceSignals(uniqueClearanceSignals);
      executedOrderCount = executionResult.executedOrderIds.length;
      if (!isLive()) {
        return abortClearanceForClosedLiveGate(executedOrderCount);
      }

      const awaitingTerminalSymbols = new Set(executionResult.awaitingAuthoritativeTerminalSymbols);
      for (const symbol of executionResult.unresolvedQuoteSymbols) {
        unresolvedSymbols.add(symbol);
      }

      if (awaitingTerminalSymbols.size > 0) {
        clearanceAwaitingTerminalSymbols = new Set([
          ...awaitingTerminalSymbols,
          ...unresolvedSymbols,
        ]);
        const nextRetryAtMs = resolveDoomsdayRetryAtMs(
          currentTime,
          isHalfDay,
          currentTime.getTime() + quoteRetryIntervalMs,
        );
        logger.warn(
          `[末日保护程序] 清仓撤单等待权威终态，安排系统级重评估: symbols=${[...awaitingTerminalSymbols].join(',')} nextRetryAtMs=${String(nextRetryAtMs)}`,
        );
        return {
          executed: executedOrderCount > 0,
          nextRetryAtMs,
        };
      }

      clearanceAwaitingTerminalSymbols = null;

      if (executedOrderCount === uniqueClearanceSignals.length) {
        if (!isLive()) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }

        lastState.cachedAccount = null;
        if (!isLive()) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }

        lastState.cachedPositions = lastState.cachedPositions.filter(
          (position) => !submittedSymbols.has(position.symbol),
        );

        if (!isLive()) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }

        lastState.positionCache.update(lastState.cachedPositions);
        if (!isLive()) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }

        await onPositionsCommitted?.();
        if (!isLive()) {
          return abortClearanceForClosedLiveGate(executedOrderCount);
        }

        const { orderRecorder } = monitorContext;
        if (longSymbol && submittedSymbols.has(longSymbol)) {
          if (!isLive()) {
            return abortClearanceForClosedLiveGate(executedOrderCount);
          }

          orderRecorder.clearBuyOrders(longSymbol, true, longQuote);
        }

        if (shortSymbol && submittedSymbols.has(shortSymbol)) {
          if (!isLive()) {
            return abortClearanceForClosedLiveGate(executedOrderCount);
          }

          orderRecorder.clearBuyOrders(shortSymbol, false, shortQuote);
        }
      } else {
        logger.warn(
          `[末日保护程序] 清仓信号仅执行 ${executedOrderCount}/${uniqueClearanceSignals.length} 个，保留缓存与订单记录等待后续刷新`,
        );
      }
    } else {
      const availablePositions = processingPositions.filter(hasPositiveAvailableQuantity);
      logClearanceNotice(
        `no-signals:${todayKey}:${positions.length}:${availablePositions.length}`,
        `[末日保护程序] 清仓跳过：未生成清仓信号（处理持仓=${processingPositions.length}, 可用持仓=${availablePositions.length}）`,
      );
    }

    if (unresolvedSymbols.size > 0) {
      if (!isLive()) {
        return abortClearanceForClosedLiveGate(executedOrderCount);
      }

      clearanceRetrySymbols = new Set(unresolvedSymbols);
      const retryDecisionTime = now();
      const currentMs = retryDecisionTime.getTime();
      if (clearanceRetryDueAtMs !== null && currentMs < clearanceRetryDueAtMs) {
        const nextRetryAtMs = resolveDoomsdayRetryAtMs(
          retryDecisionTime,
          isHalfDay,
          clearanceRetryDueAtMs,
        );
        if (nextRetryAtMs !== null) {
          return {
            executed: executedOrderCount > 0,
            nextRetryAtMs,
          };
        }

        clearClearanceRetry();
      }

      const nextRetry = resolveNextQuoteRetry({
        attempts: clearanceRetryAttempts,
        nowMs: currentMs,
        intervalMs: quoteRetryIntervalMs,
        maxAttempts: quoteRetryMaxAttempts,
      });
      if (nextRetry.exhausted) {
        clearClearanceRetry();
        for (const symbol of unresolvedSymbols) {
          clearanceRetryExhaustedSymbols.add(symbol);
        }

        logger.warn(
          `[末日保护程序] 清仓行情重试耗尽，放弃本窗口重试: symbols=${[...unresolvedSymbols].join(',')}`,
        );
        return {
          executed: executedOrderCount > 0,
          nextRetryAtMs: null,
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
          nextRetryAtMs: null,
        };
      }

      clearanceRetryAttempts = nextRetry.nextAttempts;
      clearanceRetryDueAtMs = nextRetryAtMs;
      return {
        executed: executedOrderCount > 0,
        nextRetryAtMs,
      };
    }

    clearClearanceRetry();
    return {
      executed: executedOrderCount > 0,
      nextRetryAtMs: null,
    };
  }

  return {
    isBuyCutoffWindowActive(currentTime: Date, isHalfDay: boolean): boolean {
      return isWithinDoomsdayBuyCutoffWindow(currentTime, isHalfDay);
    },
    executeClearance,
    async cancelPendingBuyOrders(
      context: CancelPendingBuyOrdersContext,
    ): Promise<CancelPendingBuyOrdersResult> {
      const { currentTime, isHalfDay, isLive, monitorContext, trader } = context;

      if (!isLive()) {
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      // 检查是否处于买入截止窗口
      if (!isWithinDoomsdayBuyCutoffWindow(currentTime, isHalfDay)) {
        // 不在买入截止窗口内，直接返回。
        // 当天执行标记由日期键自然隔离，无需额外重置 cancelCheckExecutedDate。
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      // 检查当天是否已完成撤单检查
      // 逻辑：处于买入截止窗口内时执行检查；仅在确认无需继续处理后才标记当天完成
      // 原因：末日保护期间已拒绝新买入，但若仍有撤单未确认成功，后续仍需继续复查
      //       已接受的撤单请求终态由 WebSocket 监控，无需额外轮询单笔订单状态
      const todayDateString = getHKDateKey(currentTime);
      if (cancelCheckExecutedDate === todayDateString) {
        // 当天已执行过，直接返回
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      // 收集所有唯一的交易标的
      const allTradingSymbols = new Set<string>();
      const { longSymbol, shortSymbol } = resolveMonitorSymbols(monitorContext);
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
      const pendingOrders = await trader.getPendingOrders(symbolsArray, true);
      if (!isLive()) {
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      // 过滤出买入订单
      const pendingBuyOrders = pendingOrders.filter((order) => order.side === OrderSide.Buy);
      if (pendingBuyOrders.length === 0) {
        if (!isLive()) {
          return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
        }

        cancelCheckExecutedDate = todayDateString;
        logger.info('[末日保护程序] 无未成交买入订单，无需撤单');
        return { executed: false, cancelRequestAcceptedCount: 0, nextRetryAtMs: null };
      }

      logger.info(`[末日保护程序] 发现 ${pendingBuyOrders.length} 个未成交买入订单，准备撤单`);

      // 撤销所有买入订单
      let cancelRequestAcceptedCount = 0;
      let cancelRetryRequired = false;
      for (const order of pendingBuyOrders) {
        try {
          if (!isLive()) {
            return {
              executed: cancelRequestAcceptedCount > 0,
              cancelRequestAcceptedCount,
              nextRetryAtMs: null,
            };
          }

          const cancelOutcome = await trader.cancelDoomsdayOrder(order.orderId, {
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
        } catch (err) {
          if (isExternalApiRequestError(err)) {
            throw err;
          }

          throw err;
        }
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

      cancelCheckExecutedDate = todayDateString;
      return { executed: true, cancelRequestAcceptedCount, nextRetryAtMs: null };
    },
  };
}
