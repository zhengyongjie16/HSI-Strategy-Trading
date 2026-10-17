/**
 * 订单监控模块（WebSocket 推送）
 *
 * 职责：
 * - 组装恢复流、事件流、订单操作流、单订单状态查询、route runtime/processor 与终态结算流程
 * - 初始化 WebSocket 私有主题订阅并分发订单推送
 * - 对外暴露事件驱动的 OrderMonitor 接口
 */

import { withTrustedOrderExecutionTimes } from '../../../domain/order/executionFact.js';
import { recordOrderTerminalConfirmation } from './orderObservation.js';
import {
  assertProtectiveSellRawTerminalStateFactsReady,
  normalizeTerminalStateSnapshot,
} from '../../../domain/order/orderFactMerge.js';
import { isOpenOrderReadStatus } from '../../../domain/order/orderReadLifecycle.js';
import { buildOrderMonitorConfig } from '../../../domain/order/orderTrackingPolicy.js';
import type {
  OrderMonitorTrackedOrder,
  OrderMutationRequest,
  PendingSellOrderSnapshot,
  ReplaceOrderPriceOutcome,
  TerminalStateSnapshot,
} from '../../../domain/order/types.js';
import type { OrderExecutionLedgerFact } from '../../../types/orderExecutionLedger.js';
import type { OrderPushDecoder } from '../../../types/orderPushPorts.js';
import type { OrderExecutionTimeEvidence } from '../../../types/orderRecorder.js';
import type { OrderStateChangedEvent } from '../../../types/orderTracking.js';
import type { TradeMutationPermit } from '../../../types/rateLimit.js';
import type { OrderFact } from '../../../types/trade.js';
import type {
  CancelOrderOutcome,
  DoomsdayCancelOrderOutcome,
  DoomsdayCancelOrderRequest,
} from '../../../types/orderCancellation.js';
import { isExternalApiRequestError } from '../../../utils/apiFailure/index.js';
import type { CancelOrderMutationRequest, OrderMonitor, OrderMonitorDeps } from '../types.js';
import { createEventFlow } from './eventFlow.js';
import {
  acknowledgeLatestReplaceTerminal,
  acknowledgeQueriedTerminalState,
  createOrderOps,
  peekLatestReplaceTerminal,
  peekQueriedTerminalState,
} from './orderOps.js';
import { createOrderStatusQuery } from './orderStatusQuery.js';
import { createRecoveryFlow } from './recoveryFlow.js';
import { createRouteProcessor } from './routeProcessor.js';
import { createRouteRuntime } from './routeRuntime.js';
import { createSettlementFlow } from './settlementFlow.js';
import type {
  CancelOrderBeforeBrokerMutation,
  CancelOrderPreflightOutcome,
  OrderMonitorRuntimeStore,
  OrderMonitorWakeupKind,
  RouteRuntime,
} from './types.js';

/** 将只允许 route 内部使用的撤单结果阻断在公共 API 边界。 */
function requirePublicCancelOrderOutcome(outcome: CancelOrderPreflightOutcome): CancelOrderOutcome {
  if (outcome.kind === 'CANCEL_NOT_STARTED') {
    throw new Error('[订单监控] 常规撤单不得返回 CANCEL_NOT_STARTED');
  }

  return outcome;
}

/**
 * 创建订单监控器。
 *
 * @param deps 依赖（orderDetailReadPort、orderPushPort、tradeMutationPort、rateLimiter、cacheManager、orderRecorder、dailyLossTracker、orderHoldRegistry、tradingConfig 等）
 * @returns 实现 OrderMonitor 接口的实例
 */
export function createOrderMonitor(deps: OrderMonitorDeps): OrderMonitor {
  const { logger } = deps;
  const {
    rateLimiter,
    cacheManager,
    marketDataClient,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry,
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress,
    postTradeConsistencyRuntime,
    tradingConfig,
    symbolRegistry,
    isContinuousTradingAllowed: isLifecycleContinuousTradingAllowed,
    termination,
    now,
    scheduleTimer,
    clearTimer,
  } = deps;
  const isContinuousTradingAllowed = (): boolean =>
    !termination.isTerminated() && isLifecycleContinuousTradingAllowed();
  const config = buildOrderMonitorConfig(tradingConfig.global);
  const runtime: OrderMonitorRuntimeStore = {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map<string, OrderFact>(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceTerminalByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'STOPPED',
    running: false,
    unsubscribeQuoteUpdated: null,
  };
  // 仅保存 ELO/LO 原卖单到已 accepted MO 后继的身份；金额始终由 recorder 持有。
  const acceptedSellContinuations = new Map<string, string>();
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;
  let teardownPromise: Promise<void> | null = null;
  let finalized = false;
  let routeRuntime: RouteRuntime | null = null;
  let orderIngressGeneration = 0;
  let orderIngressDrain: Promise<void> = Promise.resolve();
  const activePublicOperations = new Set<Promise<unknown>>();

  /** 公共operation ledger包含实际query/replace/cancel的整个等待链，而非只SDK invoke。 */
  function registerPublicOperation<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    activePublicOperations.add(promise);
    void promise.then(
      () => {
        activePublicOperations.delete(promise);
      },
      () => {
        activePublicOperations.delete(promise);
      },
    );
    return promise;
  }

  function captureWorkGuard(): () => boolean {
    const generation = orderIngressGeneration;
    return () =>
      generation === orderIngressGeneration &&
      !finalized &&
      !termination.isTerminated() &&
      runtime.runtimeState !== 'STOPPED';
  }

  function getExecutionTimeEvidence(orderId: string): ReadonlyArray<OrderExecutionTimeEvidence> {
    const fact = orderRecorder.getExecutionFact(orderId);
    return [
      ...dailyLossTracker.getExecutionTimeEvidence(),
      ...(fact?.executionTimeMs === null || fact === null
        ? []
        : [
            {
              brokerOrderId: fact.brokerOrderId,
              symbol: fact.symbol,
              side: fact.side,
              cumulativeQuantity: fact.cumulativeQuantity,
              cumulativeAmount: fact.cumulativeAmount,
              lastExecutionTimeMs: fact.executionTimeMs,
              orderRevisionMs: fact.updatedAtMs,
              phase: fact.phase,
            },
          ]),
    ];
  }

  function triggerRoute(symbol: string, wakeupKind: OrderMonitorWakeupKind): void {
    if (routeRuntime === null) {
      throw new Error('[订单监控] route runtime 尚未初始化，禁止触发 route');
    }

    routeRuntime.triggerRoute(symbol, wakeupKind);
  }

  const settlementFlow = createSettlementFlow({
    runtime,
    diagnostics: deps.diagnostics,
    now,
    orderHoldRegistry,
    orderRecorder,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress,
    postTradeConsistencyRuntime,
    emitOrderStateChanged: (event) => {
      for (const listener of runtime.orderStateChangedListeners) {
        listener(event);
      }
    },
  });

  const orderStatusQuery = createOrderStatusQuery({
    requestExternalApi: deps.requestExternalApi,
    orderDetailReadPort: deps.orderDetailReadPort,
    executionLedgerPort: deps.executionLedgerPort,
    rateLimiter,
    getExecutionTimeEvidence,
  });

  const orderOps = createOrderOps({
    wait: deps.wait,
    logger: logger,
    diagnostics: deps.diagnostics,
    captureWorkGuard,
    tradeMutationPort: deps.tradeMutationPort,
    termination,
    now,
    runtime,
    monitorConfig: tradingConfig.monitor,
    rateLimiter,
    cacheManager,
    orderHoldRegistry,
    orderRecorder,
    recordCumulativeExecution: (params) => {
      settlementFlow.recordCumulativeExecution(params);
    },
    orderStatusQuery,
    triggerRoute,
  });

  let activeHandler: ((event: OrderFact) => void) | null = null;
  const recoveryFlow = createRecoveryFlow({
    logger: logger,
    diagnostics: deps.diagnostics,
    now,
    termination,
    runtime,
    orderHoldRegistry,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    trackOrder: orderOps.trackOrder,
    cancelOrder: async (orderId) =>
      requirePublicCancelOrderOutcome(await orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' })),
    settleOrder: settlementFlow.settleOrder,
    handleOrderChangedWhenActive: (event) => {
      if (!activeHandler) {
        throw new Error('[订单监控] ACTIVE 事件处理器尚未初始化');
      }

      activeHandler(event);
    },
  });

  const eventFlow = createEventFlow({
    logger: logger,
    diagnostics: deps.diagnostics,
    now,
    monitorConfig: tradingConfig.monitor,
    runtime,
    orderRecorder,
    recordCumulativeExecution: (params) => {
      settlementFlow.recordCumulativeExecution(params);
    },
    prepareProtectiveTerminalExecution: settlementFlow.prepareProtectiveTerminalExecution,
    settleOrder: settlementFlow.settleOrder,
    cacheBootstrappingEvent: recoveryFlow.cacheBootstrappingEvent,
    triggerRoute,
  });
  activeHandler = eventFlow.handleOrderChangedWhenActive;

  function cancelOrderForRoute(
    orderId: string,
    beforeBrokerCancel?: CancelOrderBeforeBrokerMutation,
  ): Promise<CancelOrderPreflightOutcome> {
    return orderOps.cancelOrder(orderId, { kind: 'ORDER_FACT' }, beforeBrokerCancel);
  }

  /** 超时转换只有一层；重复同一 ACK 幂等，冲突 ACK 属于内部交易一致性错误。 */
  function recordAcceptedSellContinuation(originalOrderId: string, marketOrderId: string): void {
    if (
      originalOrderId.length === 0 ||
      marketOrderId.length === 0 ||
      originalOrderId === marketOrderId
    ) {
      throw new Error('[订单监控] 超时转市价缺少独立 broker identity');
    }

    const previous = acceptedSellContinuations.get(originalOrderId);
    if (previous !== undefined && previous !== marketOrderId)
      throw new Error('[订单监控] 同一卖单出现冲突的超时转市价 ACK');

    acceptedSellContinuations.set(originalOrderId, marketOrderId);
  }

  /** 操作身份独立于 tracking 终态与恢复；这里只给出原单和真实 accepted 后继，不推造经济事实。 */
  function getSellOperationOrderIds(originalOrderId: string): ReadonlyArray<string> {
    const marketOrderId = acceptedSellContinuations.get(originalOrderId);
    return marketOrderId === undefined ? [originalOrderId] : [originalOrderId, marketOrderId];
  }

  const routeProcessor = createRouteProcessor({
    logger: logger,
    diagnostics: deps.diagnostics,
    tradeMutationPort: deps.tradeMutationPort,
    now,
    runtime,
    config,
    orderRecorder,
    rateLimiter,
    isContinuousTradingAllowed,
    recordAcceptedSellContinuation,
    trackOrder: orderOps.trackOrder,
    cancelOrder: cancelOrderForRoute,
    settleOrder: settlementFlow.settleOrder,
    replaceOrderPrice: async (orderId, newPrice) => {
      await orderOps.replaceOrderPrice(orderId, newPrice, {
        kind: 'CONTINUOUS_TRADING_AUTHORIZED',
        authorize: isContinuousTradingAllowed,
      });
    },
  });

  routeRuntime = createRouteRuntime({
    scheduleBoundedOneShotAt: deps.scheduleBoundedOneShotAt,
    runtime,
    config,
    marketDataClient,
    processRoute: routeProcessor.processRoute,
    now,
    scheduleTimer,
    clearTimer,
    termination,
  });

  async function recoverOrderTrackingFromSnapshot(
    allOrders: ReadonlyArray<OrderFact>,
  ): Promise<void> {
    if (termination.isTerminated()) return;

    await recoveryFlow.recoverOrderTrackingFromSnapshot(allOrders);
    if (termination.isTerminated()) return;

    if (routeRuntime === null) {
      throw new Error('[订单监控] route runtime 尚未初始化，禁止恢复后 bootstrap route');
    }

    routeRuntime.bootstrapActiveRoutes();
  }

  /**
   * 活跃订单 state-check 终态的唯一收口入口。
   *
   * 调用方必须先 peek 原始 broker snapshot；本入口只接受通过严格 raw 准入后的
   * canonical 事实。结算失败时不确认缓存，使同一原始观察能安全重试。
   */
  function settleActiveTerminalFromRaw(
    orderId: string,
    trackedOrder: OrderMonitorTrackedOrder,
    terminalState: TerminalStateSnapshot,
  ) {
    assertProtectiveSellRawTerminalStateFactsReady(trackedOrder, terminalState);
    const isProtectiveSell = trackedOrder.side === 'SELL' && trackedOrder.isProtectiveLiquidation;
    const normalizedTerminalState = normalizeTerminalStateSnapshot(
      trackedOrder,
      terminalState,
      isProtectiveSell,
    );
    recordOrderTerminalConfirmation(
      { runtime, diagnostics: deps.diagnostics, now },
      {
        orderId,
        closedReason: normalizedTerminalState.closedReason,
        source: 'STATE_CHECK',
        orderUpdatedAtMs: normalizedTerminalState.orderUpdatedAtMs,
      },
    );
    const alreadySettled = runtime.closedOrderIds.has(orderId);
    const settlementResult = settlementFlow.settleOrder({
      orderId,
      closedReason: normalizedTerminalState.closedReason,
      source: 'STATE_CHECK',
      executedPrice: normalizedTerminalState.executedPrice,
      executedAmount: normalizedTerminalState.executedAmount,
      executedQuantity: normalizedTerminalState.executedQuantity,
      executedTimeMs: normalizedTerminalState.executedTimeMs,
      orderUpdatedAtMs: normalizedTerminalState.orderUpdatedAtMs,
    });

    return {
      alreadySettled,
      normalizedTerminalState,
      settlementResult,
    };
  }

  /**
   * 在统一撤单 mutation 后完成权威终态的本地结算。
   * 普通与末日入口共享 broker/终态事实链路，仅在公开结果是否允许
   * `CANCEL_NOT_STARTED` 上分流，避免两条路径的结算语义漂移。
   *
   * @param orderId 订单唯一标识
   * @param request 撤单 mutation 授权来源
   * @returns 包含 permit 内未开始事实或已完成本地结算的撤单结果
   */
  async function cancelAndSettle(
    orderId: string,
    request: CancelOrderMutationRequest,
  ): Promise<CancelOrderPreflightOutcome> {
    const outcome = await orderOps.cancelOrder(orderId, request);
    if (outcome.kind === 'CANCEL_NOT_STARTED') {
      return outcome;
    }

    if (outcome.kind !== 'ALREADY_CLOSED') {
      return outcome;
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (!trackedOrder) {
      const terminalState = peekQueriedTerminalState(runtime, orderId);
      if (terminalState !== null) {
        acknowledgeQueriedTerminalState(runtime, orderId, terminalState);
      }

      return outcome;
    }

    const terminalState = peekQueriedTerminalState(runtime, orderId);
    if (terminalState === null) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但缺少 raw terminal snapshot，拒绝向调用方暴露半成品结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
      };
    }

    const terminalSettlement = settleActiveTerminalFromRaw(orderId, trackedOrder, terminalState);
    if (!terminalSettlement.settlementResult.handled && !terminalSettlement.alreadySettled) {
      logger.error(
        `[订单监控] 订单 ${orderId} 已确认终态，但本地结算失败，拒绝向调用方暴露未结算结果`,
      );
      return {
        kind: 'UNKNOWN_FAILURE',
        errorCode: null,
      };
    }

    acknowledgeQueriedTerminalState(runtime, orderId, terminalState);

    const terminalExecution = {
      submittedQuantity: terminalState.submittedQuantity,
      // 结算可使用已知事实防止陈旧查询倒退；重规划则必须保留经纪商原始成交量是否缺失。
      executedQuantity:
        terminalState.executedQuantity === null
          ? null
          : terminalSettlement.normalizedTerminalState.executedQuantity,
    };

    return {
      ...outcome,
      relatedBuyOrderIds: terminalSettlement.settlementResult.relatedBuyOrderIds,
      terminalExecution,
    };
  }

  /**
   * 执行常规撤单，并阻断只允许末日路径观察的未开始结果。
   *
   * @param orderId 订单唯一标识
   * @param request 常规 mutation 授权来源
   * @returns 常规撤单结果
   */
  async function cancelOrder(
    orderId: string,
    request: OrderMutationRequest,
  ): Promise<CancelOrderOutcome> {
    return registerPublicOperation(async () =>
      requirePublicCancelOrderOutcome(await cancelAndSettle(orderId, request)),
    );
  }

  /**
   * 执行末日保护撤单，保留 permit 内门禁失效且 broker 未调用的事实。
   *
   * @param orderId 订单唯一标识
   * @param request 末日窗口授权请求
   * @returns 末日保护撤单结果
   */
  function cancelDoomsdayOrder(
    orderId: string,
    request: DoomsdayCancelOrderRequest,
  ): Promise<DoomsdayCancelOrderOutcome> {
    return registerPublicOperation(() => cancelAndSettle(orderId, request));
  }

  /**
   * 在外层最终报价 callback permit 内执行信号驱动改单，并沿用同一终态结算收口。
   * 该入口没有可选 permit 或重新排队分支，防止 final quote 与 SDK replace 之间出现 TOCTOU。
   */
  async function replaceOrderPriceWithPermit(
    orderId: string,
    newPrice: string,
    request: OrderMutationRequest,
    permit: TradeMutationPermit,
    quantity?: number | null,
  ) {
    const result = await registerPublicOperation(() =>
      orderOps.replaceOrderPriceWithPermit(orderId, newPrice, request, permit, quantity),
    );
    if (result.kind === 'POST_FAILURE_CONFIRMATION_REQUIRED') {
      return {
        kind: 'POST_FAILURE_CONFIRMATION_REQUIRED' as const,
        confirmAfterPermitReleased: () =>
          registerPublicOperation(async () => {
            const confirmed = await result.confirmAfterPermitReleased();
            return settleReplaceOutcome(orderId, confirmed);
          }),
      };
    }

    return settleReplaceOutcome(orderId, result);
  }

  /** 只在实际query完成后同步结算，绝不在外层FIFO内启动后继query。 */
  function settleReplaceOutcome(
    orderId: string,
    result: ReplaceOrderPriceOutcome,
  ): ReplaceOrderPriceOutcome {
    const replaceTerminal = peekLatestReplaceTerminal(runtime, orderId);
    if (replaceTerminal === null) {
      return result;
    }

    const trackedOrder = runtime.trackedOrders.get(orderId);
    if (trackedOrder === undefined) {
      return result;
    }

    const terminalSettlement = settleActiveTerminalFromRaw(orderId, trackedOrder, replaceTerminal);
    if (!terminalSettlement.settlementResult.handled && !terminalSettlement.alreadySettled) {
      throw new Error(`[订单监控] 订单 ${orderId} 改单终态已确认但本地结算失败`);
    }

    acknowledgeLatestReplaceTerminal(runtime, orderId, replaceTerminal);
    acknowledgeQueriedTerminalState(runtime, orderId, replaceTerminal);
    return result;
  }

  /**
   * 初始化 WebSocket 订阅（订阅 Private 主题）。
   *
   * @returns 初始化 Promise
   */
  function observeIngressRead<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((error: unknown) => {
      if (!isExternalApiRequestError(error)) termination.reportFatalError(error);

      throw error;
    });
  }

  function handleOrderPush(err: Error | null, decoder: OrderPushDecoder): void {
    if (finalized) return;

    if (err) {
      logger.error('[订单监控] WebSocket 推送错误:', err.message);
      return;
    }

    if (runtime.runtimeState === 'STOPPED' || termination.isTerminated()) return;

    const generation = orderIngressGeneration;
    // ingress 串行包含实际 ledger IO；stop 等本链，旧 generation 不发布或重发订单。
    orderIngressDrain = orderIngressDrain
      .then(async () => {
        if (
          generation !== orderIngressGeneration ||
          runtime.runtimeState === 'STOPPED' ||
          termination.isTerminated()
        )
          return;

        const readFact = decoder.inspect();
        let executions: ReadonlyArray<OrderExecutionLedgerFact> = [];
        if (readFact.executedQuantity > 0) {
          await rateLimiter.throttle();
          if (generation !== orderIngressGeneration || termination.isTerminated()) return;

          const results = await Promise.allSettled([
            observeIngressRead(
              deps.requestExternalApi({
                operation: 'TradeContext.todayExecutions',
                request: () =>
                  deps.executionLedgerPort.todayExecutions({ orderId: readFact.orderId }),
              }),
            ),
            observeIngressRead(
              deps.requestExternalApi({
                operation: 'TradeContext.historyExecutions',
                request: () =>
                  deps.executionLedgerPort.historyExecutions({
                    symbol: readFact.symbol,
                    endAt: new Date(readFact.updatedAtMs),
                  }),
              }),
            ),
          ]);
          for (const result of results) if (result.status === 'rejected') throw result.reason;

          if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled')
            throw new Error('[订单监控] ledger result invariant');

          executions = [...results[0].value, ...results[1].value];
        }

        const known = runtime.trackedOrders.get(readFact.orderId);
        // 保护性 SELL 必须保留本次原始价准入，完整 ledger 仅证明执行时间，不授权借旧价收口。
        const confirmed =
          !(known?.executionSide === 'SELL' && known.isProtectiveLiquidation) &&
          known?.lastOrderUpdateAtMs !== undefined &&
          known.lastOrderUpdateAtMs !== null &&
          known.executionPhase !== null
            ? {
                brokerOrderId: known.orderId,
                symbol: known.symbol,
                side: known.executionSide,
                cumulativeQuantity: known.executedQuantity,
                cumulativeAmount: known.executedAmount,
                executionTimeMs: known.lastExecutedTimeMs,
                updatedAtMs: known.lastOrderUpdateAtMs,
                phase: known.executionPhase,
                executedPrice: known.executedPrice,
              }
            : undefined;
        const mapped = decoder.decode(executions, confirmed);
        if (generation !== orderIngressGeneration || termination.isTerminated()) return;

        const trusted = withTrustedOrderExecutionTimes(
          [mapped],
          getExecutionTimeEvidence(mapped.orderId),
        )[0];
        if (trusted === undefined) throw new Error('[订单监控] missing mapped ingress fact');

        eventFlow.handleOrderChanged(trusted);
      })
      .catch((error: unknown) => {
        termination.reportFatalError(error);
      });
  }

  async function initializeSubscription(): Promise<void> {
    if (finalized || termination.isTerminated()) return;

    if (runtime.runtimeState === 'STOPPED') {
      runtime.runtimeState = 'BOOTSTRAPPING';
      recoveryFlow.clearBootstrappingEventBuffer();
    }

    if (initialized) return;

    deps.orderPushPort.setOnOrderChanged(handleOrderPush);
    await deps.requestExternalApi({
      operation: 'TradeContext.subscribe.private',
      request: () => deps.orderPushPort.subscribePrivate(),
    });
    initialized = true;
    if (teardownPromise !== null || termination.isTerminated()) {
      runtime.runtimeState = 'STOPPED';
      recoveryFlow.clearBootstrappingEventBuffer();
      return;
    }

    logger.info('[订单监控] WebSocket 订阅初始化成功');
  }

  /** 合并并发初始化，失败后允许非终止生命周期重新尝试订阅。 */
  function initialize(): Promise<void> {
    if (finalized || termination.isTerminated()) return Promise.resolve();

    initializationPromise ??= initializeSubscription().finally(() => {
      initializationPromise = null;
    });
    return initializationPromise;
  }

  /**
   * 仅供最终 cleanup 在业务 route 和订单事实排空后调用，跨日停止不得调用。
   * 封闭后续初始化授权，等待已开始的订阅落定，再退订真正成功的 Private 订阅。
   * SDK 未提供取消在途请求或关闭 native context 的合同；挂起请求仍须等待，错误交给 cleanup 汇总。
   */
  function teardown(): Promise<void> {
    if (teardownPromise !== null) return teardownPromise;

    finalized = true;
    teardownPromise = Promise.resolve().then(async () => {
      await initializationPromise;
      if (!initialized) return;

      await deps.requestExternalApi({
        operation: 'TradeContext.unsubscribe.private',
        request: () => deps.orderPushPort.unsubscribePrivate(),
      });
      initialized = false;
    });
    return teardownPromise;
  }

  /**
   * 生命周期完整清空 tracking、accepted 转单身份与 BOOTSTRAPPING 事件缓存。
   *
   * @returns 无返回值
   */
  function clearTrackedOrders(): void {
    recoveryFlow.resetRecoveryTrackingState();
    recoveryFlow.clearBootstrappingEventBuffer();
    runtime.trackedOrderLifecycles.clear();
    runtime.closedOrderIds.clear();
    acceptedSellContinuations.clear();
    runtime.runtimeState = 'STOPPED';
  }

  /**
   * 先关闭订单监控入口并丢弃 BOOTSTRAPPING 缓冲事件，再排空所有 symbol route。
   *
   * 先切换为 STOPPED 可阻止停止期间的晚到 WS 事件继续推进；route 排空完成前不清除
   * tracked truth，供已在途的订单动作安全收口。
   *
   * @returns 所有在途 route 完成后的 Promise
   * @throws route runtime 尚未初始化，或在途 route 以错误结束时抛出
   */
  async function stopRuntimeAndDrain(): Promise<void> {
    runtime.runtimeState = 'STOPPED';
    orderIngressGeneration++;
    recoveryFlow.clearBootstrappingEventBuffer();
    if (routeRuntime === null) {
      throw new Error('[订单监控] route runtime 尚未初始化，禁止停止 runtime');
    }

    const results = await Promise.allSettled([
      routeRuntime.stopAndDrain(),
      orderIngressDrain,
      ...activePublicOperations,
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  function onOrderStateChanged(listener: (event: OrderStateChangedEvent) => void): () => void {
    runtime.orderStateChangedListeners.add(listener);
    return () => {
      runtime.orderStateChangedListeners.delete(listener);
    };
  }

  /**
   * 获取指定标的的未成交卖单快照。
   *
   * 这里只读取 runtime tracked truth，不再依赖旧 quoteFlow owner。
   *
   * @param symbol 标的代码
   * @returns 卖单快照列表（按 submittedAt 升序）
   */
  function getPendingSellOrders(symbol: string): ReadonlyArray<PendingSellOrderSnapshot> {
    const pendingOrders: PendingSellOrderSnapshot[] = [];
    for (const order of runtime.trackedOrders.values()) {
      if (order.symbol !== symbol || order.executionSide !== 'SELL') {
        continue;
      }

      if (!isOpenOrderReadStatus(order.status)) {
        continue;
      }

      if (order.status === 'PARTIALLY_CANCELED') {
        continue;
      }

      const remaining = order.submittedQuantity - order.executedQuantity;
      if (!Number.isFinite(remaining) || remaining <= 0) {
        continue;
      }

      pendingOrders.push({
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.executionSide,
        status: order.status,
        orderType: order.orderType,
        isProtectiveLiquidation: order.isProtectiveLiquidation,
        submittedPrice: order.submittedPrice,
        submittedQuantity: order.submittedQuantity,
        executedQuantity: order.executedQuantity,
        submittedAt: order.submittedAt,
      });
    }

    return [...pendingOrders].sort((left, right) => left.submittedAt - right.submittedAt);
  }

  function hasPendingProtectiveLiquidationOrders(direction: 'LONG' | 'SHORT'): boolean {
    for (const trackedOrder of runtime.trackedOrders.values()) {
      if (!trackedOrder.isProtectiveLiquidation) {
        continue;
      }

      if (!isOpenOrderReadStatus(trackedOrder.status)) {
        continue;
      }

      if (trackedOrder.side !== 'SELL') {
        continue;
      }

      const trackedDirection = trackedOrder.isLongSymbol ? 'LONG' : 'SHORT';
      if (trackedDirection === direction) {
        return true;
      }
    }

    return false;
  }

  return {
    initialize,
    teardown,
    onOrderStateChanged,
    trackOrder: orderOps.trackOrder,
    cancelOrder,
    cancelDoomsdayOrder,
    replaceOrderPriceWithPermit,
    startRuntime: () => {
      if (!finalized && !termination.isTerminated()) routeRuntime.start();
    },
    stopRuntimeAndDrain,
    recoverOrderTrackingFromSnapshot,
    getPendingSellOrders,
    getSellOperationOrderIds,
    hasPendingProtectiveLiquidationOrders,
    clearTrackedOrders,
  };
}
