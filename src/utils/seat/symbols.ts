import type { SeatSymbolSnapshotEntry, SymbolRegistry } from '../../types/seat.js';
import { hasSeatSymbol } from './guards.js';

/**
 * 获取指定方向的已绑定席位标的代码。
 *
 * @param symbolRegistry 具备 getSeatState 能力的席位查询口
 * @param direction 席位方向
 * @returns 席位已绑定 symbol 时返回标的代码，否则返回 null
 */
export function resolveBoundSeatSymbol(
  symbolRegistry: Pick<SymbolRegistry, 'getSeatState'>,
  direction: 'LONG' | 'SHORT',
): string | null {
  const seatState = symbolRegistry.getSeatState(direction);
  return hasSeatSymbol(seatState) ? seatState.symbol : null;
}

/**
 * 收集唯一监控标的当前已绑定席位的标的代码列表。
 *
 * @param params 包含只读 symbolRegistry 查询口
 * @returns 已绑定席位的 monitorSymbol、direction 与 symbol 条目数组
 */
export function collectBoundSeatSymbols(params: {
  readonly symbolRegistry: Pick<SymbolRegistry, 'getMonitorSymbol' | 'getSeatState'>;
}): ReadonlyArray<SeatSymbolSnapshotEntry> {
  const entries: SeatSymbolSnapshotEntry[] = [];
  const monitorSymbol = params.symbolRegistry.getMonitorSymbol();

  const longSymbol = resolveBoundSeatSymbol(params.symbolRegistry, 'LONG');
  if (longSymbol !== null) {
    entries.push({
      monitorSymbol,
      direction: 'LONG',
      symbol: longSymbol,
    });
  }

  const shortSymbol = resolveBoundSeatSymbol(params.symbolRegistry, 'SHORT');
  if (shortSymbol !== null) {
    entries.push({
      monitorSymbol,
      direction: 'SHORT',
      symbol: shortSymbol,
    });
  }

  return entries;
}
