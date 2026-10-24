/**
 * 信号运行时缓存域（CacheDomain: signalRuntime）
 *
 * 午夜清理：
 * - 先终止 freshness 等待，随后停止普通 K 线业务 owner、交易标的风险 runtime、monitor quote runtime、switch wakeup runtime、周期换标 runtime、自动寻标 runtime 与激活 dispatcher
 * - 再排空监控处理器并停止席位退场清理 owner，随后排空买卖处理器，最后停止订单监控 runtime、成交后一致性 runtime（含持仓回调）与订阅 owner
 * - 清空交易任务队列（买入/卖出/监控）
 * - 重置同一个策略实例的指标、样本及等待状态
 * - 调用成交后一致性 runtime 的跨日清理
 *
 * 开盘重建：
 * - 先执行订阅首轮真相投影，再启动成交后一致性 runtime 并完成 rebuild baseline
 * - 随后启动显示与订阅 owner、席位清理与激活 dispatcher、自动寻标 runtime 与周期换标 runtime
 * - 再启动普通 K 线业务 owner、交易标的风险 runtime、monitor quote runtime 与 switch wakeup runtime
 * - 再重启买入、卖出、监控任务处理器
 */
import type { CacheDomain, CacheDomainOpenRebuildResult } from '../types.js';
import type { SignalRuntimeDomainDeps } from './types.js';

/**
 * 清空买入、卖出、监控三条任务队列。
 *
 * @param deps 包含 buyTaskQueue、sellTaskQueue、monitorTaskQueue
 * @returns 各队列移除的任务数量
 */
function clearTradeQueues(
  deps: Pick<SignalRuntimeDomainDeps, 'buyTaskQueue' | 'sellTaskQueue' | 'monitorTaskQueue'>,
): {
  readonly removedBuy: number;
  readonly removedSell: number;
  readonly removedMonitor: number;
} {
  const { buyTaskQueue, sellTaskQueue, monitorTaskQueue } = deps;
  const removedBuy = buyTaskQueue.clearAll({ reasonCode: 'DAY_CLEAR' });
  const removedSell = sellTaskQueue.clearAll({ reasonCode: 'DAY_CLEAR' });
  const removedMonitor = monitorTaskQueue.clearAll();
  return {
    removedBuy,
    removedSell,
    removedMonitor,
  };
}

/**
 * 创建信号运行时缓存域。
 * 午夜清理时先中断 freshness 等待并停止上游事件 owner，再排空监控处理器并停止席位退场清理 owner，随后排空买卖处理器，最后依次排空订单监控、成交后一致性 runtime 与订阅 owner、清空任务队列并执行跨日清理；开盘重建时先恢复订阅投影和 runtime baseline，再启动事件 owner、周期换标 runtime 与处理器。
 *
 * @param deps 依赖注入，包含各处理器、队列与 postTradeConsistencyRuntime 等
 * @returns 实现 CacheDomain 的信号运行时域实例
 */
export function createSignalRuntimeDomain(deps: SignalRuntimeDomainDeps): CacheDomain {
  const {
    logger,
    monitorContext,
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    businessEventProgram,
    tradingRiskEventRuntime,
    monitorQuoteEventRuntime,
    monitorDisplayRuntime,
    tradingQuoteDisplayRuntime,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    quoteSubscriptionRuntime,
    autoSearchWakeupRuntime,
    seatActivationDispatcher,
    seatRuntimeCleanupDispatcher,
    orderMonitor,
    postTradeConsistencyRuntime,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  } = deps;

  return {
    async midnightClear(): Promise<void> {
      postTradeConsistencyRuntime.abortWaiting();
      await businessEventProgram.stopAndDrain();
      await tradingRiskEventRuntime.stopAndDrain();
      await monitorQuoteEventRuntime.stopAndDrain();
      await monitorDisplayRuntime.stopAndDrain();
      await tradingQuoteDisplayRuntime.stopAndDrain();
      await switchWakeupRuntime.stopAndDrain();
      await periodicSwitchWakeupRuntime.stopAndDrain();
      await autoSearchWakeupRuntime.stopAndDrain();
      seatActivationDispatcher.stop();
      await monitorTaskProcessor.stopAndDrain();
      seatRuntimeCleanupDispatcher.stop();
      await buyProcessor.stopAndDrain();
      await sellProcessor.stopAndDrain();
      await orderMonitor.stopRuntimeAndDrain();
      await postTradeConsistencyRuntime.stopAndDrain();
      await quoteSubscriptionRuntime.stopAndDrain();

      const queueResult = clearTradeQueues({
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
      });
      monitorContext.strategy.resetForTradingDay();

      postTradeConsistencyRuntime.midnightClear();

      logger.debug(
        `[Lifecycle][signalRuntime] 午夜清理完成: buy=${queueResult.removedBuy}, sell=${queueResult.removedSell}, monitor=${queueResult.removedMonitor}`,
      );
    },
    async openRebuild(ctx): Promise<CacheDomainOpenRebuildResult> {
      if (!ctx.isCurrent() || deps.termination.isTerminated()) return { status: 'ABORTED' };

      await quoteSubscriptionRuntime.reconcileFromCurrentTruth();
      if (!ctx.isCurrent() || deps.termination.isTerminated()) return { status: 'ABORTED' };

      postTradeConsistencyRuntime.resetAbort();
      postTradeConsistencyRuntime.start();
      const baselineReady = await postTradeConsistencyRuntime.completeRebuildBaseline();
      if (!baselineReady || !ctx.isCurrent() || deps.termination.isTerminated())
        return { status: 'ABORTED' };

      tradingQuoteDisplayRuntime.start();
      quoteSubscriptionRuntime.start();
      seatRuntimeCleanupDispatcher.start();
      seatActivationDispatcher.start();
      autoSearchWakeupRuntime.start();
      periodicSwitchWakeupRuntime.start();
      monitorDisplayRuntime.start();
      businessEventProgram.start();
      tradingRiskEventRuntime.start();
      monitorQuoteEventRuntime.start();
      switchWakeupRuntime.start();
      buyProcessor.restart();
      sellProcessor.restart();
      monitorTaskProcessor.restart();
      orderMonitor.startRuntime();
      logger.debug(
        '[Lifecycle][signalRuntime] runtime baseline、显示 owner、业务 owner、订阅 owner、处理器与订单监控 runtime 已重启',
      );
      return ctx.isCurrent() && !deps.termination.isTerminated()
        ? { status: 'COMMITTED', snapshotToken: ctx.snapshotToken }
        : { status: 'ABORTED' };
    },
  };
}
