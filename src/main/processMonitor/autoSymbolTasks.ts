/**
 * 自动换标任务调度模块
 *
 * 功能：
 * - 调度自动换标心跳任务（AUTO_SYMBOL_TICK）：定时检查席位状态，执行自动寻标与周期换标检查
 * - 调度换标距离检查任务（AUTO_SYMBOL_SWITCH_DISTANCE）：根据距回收价触发换标
 *
 * 调度规则：
 * - AUTO_SYMBOL_TICK：每个心跳周期都为 LONG 和 SHORT 方向调度
 * - AUTO_SYMBOL_SWITCH_DISTANCE：当价格发生变化或存在待处理换标流程时调度（用于持续推进状态机）
 */
import type { AutoSymbolTasksParams } from './types.js';

/**
 * 调度单监控标的的自动换标相关任务。
 * 为 LONG/SHORT 方向调度心跳任务（AUTO_SYMBOL_TICK），在价格变化或存在待处理换标时调度距离检查任务（AUTO_SYMBOL_SWITCH_DISTANCE），供异步队列执行寻标与换标。
 *
 * @param params 调度参数，包含监控标的、上下文、当前时间、交易状态等
 */
export function scheduleAutoSymbolTasks(params: AutoSymbolTasksParams): void {
  const {
    monitorContext,
    mainContext,
    autoSearchEnabled,
    currentTimeMs,
    canTradeNow,
    openProtectionActive,
    monitorPriceChanged,
    resolvedMonitorPrice,
  } = params;

  if (!autoSearchEnabled) {
    return;
  }

  const { autoSymbolManager, symbolRegistry } = monitorContext;
  const { monitorTaskQueue } = mainContext;

  const longSeatSnapshot = symbolRegistry.getSeatState('LONG');
  const shortSeatSnapshot = symbolRegistry.getSeatState('SHORT');

  monitorTaskQueue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
    data: {
      direction: 'LONG',
      seatVersion: symbolRegistry.getSeatVersion('LONG'),
      symbol: longSeatSnapshot.symbol ?? null,
      currentTimeMs,
      canTradeNow,
      openProtectionActive,
    },
  });

  monitorTaskQueue.scheduleLatest({
    type: 'AUTO_SYMBOL_TICK',
    dedupeKey: 'AUTO_SYMBOL_TICK:SHORT',
    data: {
      direction: 'SHORT',
      seatVersion: symbolRegistry.getSeatVersion('SHORT'),
      symbol: shortSeatSnapshot.symbol ?? null,
      currentTimeMs,
      canTradeNow,
      openProtectionActive,
    },
  });

  const hasPendingSwitch =
    autoSymbolManager.hasPendingSwitch('LONG') || autoSymbolManager.hasPendingSwitch('SHORT');

  if (monitorPriceChanged || hasPendingSwitch) {
    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_SWITCH_DISTANCE',
      dedupeKey: 'AUTO_SYMBOL_SWITCH_DISTANCE',
      data: {
        monitorPrice: resolvedMonitorPrice,
        seatSnapshots: {
          long: {
            seatVersion: symbolRegistry.getSeatVersion('LONG'),
            symbol: longSeatSnapshot.symbol ?? null,
          },
          short: {
            seatVersion: symbolRegistry.getSeatVersion('SHORT'),
            symbol: shortSeatSnapshot.symbol ?? null,
          },
        },
      },
    });
  }
}
