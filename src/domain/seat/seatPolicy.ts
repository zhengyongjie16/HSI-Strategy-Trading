/** 席位纯规则：失败冻结、信号绑定校验与启动持仓优先，不执行 I/O 或状态发布。 */
import type { Position } from '../../types/account.js';
import type { SeatState, SymbolRegistry } from '../../types/seat.js';
import { isHongKongSymbol } from '../../utils/marketScope.js';
import { isSeatVersionMatch } from './seatIdentity.js';
import type {
  SeatUnavailableReason,
  SignalSeatValidationResult,
  ValidateSignalSeatParams,
} from './types.js';

/**
 * 判断席位是否处于可交易激活态（ACTIVE 且绑定有效 symbol）。
 *
 * @param seatState 席位状态，可为 null 或 undefined
 * @returns 席位已激活时返回 true，并收窄为包含非空 symbol 的 SeatState
 */
export function isSeatActive(
  seatState: SeatState | null | undefined,
): seatState is SeatState & { symbol: string } {
  if (!seatState) {
    return false;
  }

  if (seatState.status !== 'ACTIVE') {
    return false;
  }

  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0;
}

/**
 * 判断席位是否已绑定有效 symbol（不要求 ACTIVE）。
 *
 * @param seatState 席位状态，可为 null 或 undefined
 * @returns 只要 symbol 为非空字符串即返回 true
 */
export function hasSeatSymbol(
  seatState: SeatState | null | undefined,
): seatState is SeatState & { symbol: string } {
  return (
    seatState !== null &&
    seatState !== undefined &&
    typeof seatState.symbol === 'string' &&
    seatState.symbol.length > 0
  );
}

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
 * 检查席位是否当日冻结（frozenTradingDayKey 非 null 即冻结，midnight clear 重置）
 * @param seatState 席位状态
 * @returns 当日冻结时返回 true
 */
export function isSeatFrozenToday(seatState: SeatState): boolean {
  return seatState.frozenTradingDayKey !== null;
}

/**
 * 计算下一次寻标失败后的失败计数与冻结状态。
 *
 * 统一的失败计数与冻结规则：
 * - 每次失败将 searchFailCountToday + 1
 * - 当失败次数达到 maxSearchFailuresPerDay 时，当日冻结席位
 * - 冻结后保留已存在的 frozenTradingDayKey（若未能获取当日 key，则不覆盖）
 * @param params.currentSeat 当前席位状态
 * @param params.hkDateKey 当前香港日期键，用于写入冻结标记
 * @param params.maxSearchFailuresPerDay 当日最大允许失败次数
 * @returns 下次失败计数、冻结日期键与是否触发冻结
 */
export function resolveNextSearchFailureState(params: {
  readonly currentSeat: SeatState;
  readonly hkDateKey: string | null;
  readonly maxSearchFailuresPerDay: number;
}): {
  readonly nextFailCount: number;
  readonly frozenTradingDayKey: string | null;
  readonly shouldFreeze: boolean;
} {
  const nextFailCount = params.currentSeat.searchFailCountToday + 1;
  const shouldFreeze = nextFailCount >= params.maxSearchFailuresPerDay;
  const frozenTradingDayKey = shouldFreeze
    ? (params.hkDateKey ?? params.currentSeat.frozenTradingDayKey)
    : params.currentSeat.frozenTradingDayKey;

  return {
    nextFailCount,
    frozenTradingDayKey,
    shouldFreeze,
  };
}

/**
 * 解析席位不可用原因（席位已激活时返回 null）
 * @param seatState 席位状态
 * @returns 不可用原因枚举值，席位已激活时返回 null
 */
function resolveSeatUnavailableReason(seatState: SeatState): SeatUnavailableReason | null {
  if (isSeatActive(seatState)) {
    return null;
  }

  if (seatState.status === 'SEARCHING') {
    return 'SEAT_SEARCHING';
  }

  if (seatState.status === 'SWITCHING') {
    return 'SEAT_SWITCHING';
  }

  if (seatState.status === 'ACTIVATING') {
    return 'SEAT_ACTIVATING';
  }

  if (isSeatFrozenToday(seatState)) {
    return 'SEAT_FROZEN_TODAY';
  }

  return 'SEAT_EMPTY';
}

/**
 * 从非激活席位状态获取格式化的不可用原因文案。
 * 前提：调用方已确认 isSeatActive(seatState) === false。
 * @param seatState 席位状态
 * @returns 不可用原因的中文描述字符串
 */
function describeSeatUnavailable(seatState: SeatState): string {
  const reason = resolveSeatUnavailableReason(seatState);
  switch (reason) {
    case 'SEAT_EMPTY': {
      return '席位为空';
    }

    case 'SEAT_FROZEN_TODAY': {
      return '席位已冻结（当日）';
    }

    case 'SEAT_SEARCHING': {
      return '席位正在寻标';
    }

    case 'SEAT_SWITCHING': {
      return '席位正在换标';
    }

    case 'SEAT_ACTIVATING': {
      return '席位正在激活';
    }

    case null: {
      return '席位不可用';
    }

    default: {
      throw new Error('未知的席位不可用原因');
    }
  }
}

/**
 * 从交易动作推导席位方向。
 *
 * @param action 交易信号动作
 * @returns LONG、SHORT；HOLD 返回 null，其余非法动作直接抛错
 */
function resolveSignalDirection(
  action: ValidateSignalSeatParams['signal']['action'],
): 'LONG' | 'SHORT' | null {
  switch (action) {
    case 'BUYCALL':
    case 'SELLCALL': {
      return 'LONG';
    }

    case 'BUYPUT':
    case 'SELLPUT': {
      return 'SHORT';
    }

    case 'HOLD': {
      return null;
    }

    default: {
      throw new Error(`不支持的席位校验信号动作: ${String(action)}`);
    }
  }
}

/**
 * 校验信号是否仍绑定到当前席位。
 * 默认行为：按 action 推导方向后，依次校验席位 ACTIVE、席位版本匹配与席位标的一致性。
 *
 * @param params 校验所需的 signal 与 symbolRegistry
 * @returns 校验结果；成功时返回收窄后的就绪 seatState，失败时返回失败原因
 */
export function validateSignalSeat(params: ValidateSignalSeatParams): SignalSeatValidationResult {
  const direction = resolveSignalDirection(params.signal.action);
  if (direction === null) {
    return {
      valid: false,
      reason: 'INVALID_SIGNAL_ACTION',
    };
  }

  const seatState = params.symbolRegistry.getSeatState(direction);
  const seatVersion = params.symbolRegistry.getSeatVersion(direction);
  if (!isSeatActive(seatState)) {
    return {
      valid: false,
      reason: 'SEAT_UNAVAILABLE',
      seatState,
    };
  }

  if (!isSeatVersionMatch(params.signal.seatVersion, seatVersion)) {
    return {
      valid: false,
      reason: 'SEAT_VERSION_MISMATCH',
    };
  }

  if (params.signal.symbol !== seatState.symbol) {
    return {
      valid: false,
      reason: 'SEAT_SYMBOL_MISMATCH',
    };
  }

  return {
    valid: true,
  };
}

/**
 * 格式化信号席位校验失败原因。
 * 默认行为：席位不可用时复用席位状态描述，其余失败返回统一中文原因。
 *
 * @param result validateSignalSeat 返回的失败结果
 * @returns 可直接用于日志的中文失败原因
 */
export function describeSignalSeatValidationFailure(
  result: Extract<SignalSeatValidationResult, { valid: false }>,
): string {
  switch (result.reason) {
    case 'INVALID_SIGNAL_ACTION': {
      return '信号动作不支持席位校验';
    }

    case 'SEAT_UNAVAILABLE': {
      return describeSeatUnavailable(result.seatState);
    }

    case 'SEAT_VERSION_MISMATCH': {
      return '席位版本不匹配';
    }

    case 'SEAT_SYMBOL_MISMATCH': {
      return '标的已切换';
    }

    default: {
      throw new Error('未知的信号席位校验失败原因');
    }
  }
}

/**
 * 解析启动恢复候选：静态模式使用配置，自动模式仅检查港股历史候选及正总持仓。
 * 候选不代表已通过交易状态准入，application 必须在绑定前完成当次状态查询。
 * @param params.autoSearchEnabled 是否启用自动寻标
 * @param params.candidateSymbol 候选标的代码
 * @param params.configuredSymbol 配置文件中指定的标的代码
 * @param params.positions 当前持仓列表
 * @returns 尚待状态准入的候选代码，无合适候选时返回 null
 */
export function resolveStartupSeatCandidate({
  autoSearchEnabled,
  candidateSymbol,
  configuredSymbol,
  positions,
}: {
  readonly autoSearchEnabled: boolean;
  readonly candidateSymbol: string | null;
  readonly configuredSymbol: string | null;
  readonly positions: ReadonlyArray<Position>;
}): string | null {
  if (!autoSearchEnabled) {
    return configuredSymbol !== null &&
      configuredSymbol.length > 0 &&
      isHongKongSymbol(configuredSymbol)
      ? configuredSymbol
      : null;
  }

  if (!candidateSymbol || !isHongKongSymbol(candidateSymbol)) {
    return null;
  }

  const hasPosition = positions.some((position) => {
    return position.symbol === candidateSymbol && position.quantity > 0;
  });
  return hasPosition ? candidateSymbol : null;
}
