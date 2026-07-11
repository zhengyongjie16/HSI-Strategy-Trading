import type { SymbolRegistry } from '../../types/seat.js';
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
