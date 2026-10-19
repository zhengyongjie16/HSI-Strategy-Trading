/** 席位消费快照：按 ACTIVE 边界派生当前标的、版本与行情名称，不改变注册表状态。 */
import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MonitorContextSeatSnapshot } from './types.js';
import type { MonitorSymbolNames } from '../../types/monitor.js';
import { isSeatActive } from './seatPolicy.js';

/**
 * 解析唯一 monitorContext 的席位快照。
 * 默认行为：读取 symbolRegistry 中的多空席位状态与版本，并派生当前可消费的 ACTIVE 标的代码。
 *
 * @param symbolRegistry 席位注册表
 * @returns 席位版本与当前就绪标的代码快照
 */
export function resolveMonitorContextSeatSnapshot(
  symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>,
): MonitorContextSeatSnapshot {
  const longSeatState = symbolRegistry.getSeatState('LONG');
  const shortSeatState = symbolRegistry.getSeatState('SHORT');
  return {
    seatVersion: {
      long: symbolRegistry.getSeatVersion('LONG'),
      short: symbolRegistry.getSeatVersion('SHORT'),
    },
    longSymbol: isSeatActive(longSeatState) ? longSeatState.symbol : null,
    shortSymbol: isSeatActive(shortSeatState) ? shortSeatState.symbol : null,
  };
}

/**
 * 解析唯一 monitorContext 的标的名称。
 * 默认行为：基于席位快照、已验证的唯一 monitorSymbol 与 quotesMap 派生名称字段。
 *
 * @param params 席位注册表、唯一监控标的与行情 Map
 * @returns MonitorContext 所需的名称派生结果
 */
export function resolveMonitorContextSymbolNames(params: {
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly monitorSymbol: string;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
}): Readonly<MonitorSymbolNames> {
  const { symbolRegistry, monitorSymbol, quotesMap } = params;
  const seatSnapshot = resolveMonitorContextSeatSnapshot(symbolRegistry);
  const { longSymbol, shortSymbol } = seatSnapshot;
  const longQuote = longSymbol ? (quotesMap.get(longSymbol) ?? null) : null;
  const shortQuote = shortSymbol ? (quotesMap.get(shortSymbol) ?? null) : null;
  const monitorQuote = quotesMap.get(monitorSymbol) ?? null;
  return {
    longSymbolName: longSymbol ? (longQuote?.name ?? longSymbol) : '',
    shortSymbolName: shortSymbol ? (shortQuote?.name ?? shortSymbol) : '',
    monitorSymbolName: monitorQuote?.name ?? monitorSymbol,
  };
}
