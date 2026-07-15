/**
 * 自动标的管理工具模块
 *
 * 职责：
 * - 提供席位冻结失败计数、信号席位校验与失败原因格式化能力
 * - 提供席位启动恢复与 SymbolRegistry 构建能力
 */
import type { MonitorConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type {
  RuntimeWritableSeatState,
  SeatState,
  SeatTruthChangedListener,
  SymbolRegistry,
} from '../../types/seat.js';
import { isSeatActive, isSeatVersionMatch } from '../../utils/seat/guards.js';
import type {
  SeatEntry,
  SeatStateCandidate,
  SeatStateChangedListener,
  SeatUnavailableReason,
  SignalSeatValidationResult,
  SymbolSeatEntry,
  ValidateSignalSeatParams,
} from './types.js';

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

const SEAT_UNAVAILABLE_REASON_MAP: Readonly<Record<SeatUnavailableReason, string>> = {
  SEAT_EMPTY: '席位为空',
  SEAT_FROZEN_TODAY: '席位已冻结（当日）',
  SEAT_SEARCHING: '席位正在寻标',
  SEAT_SWITCHING: '席位正在换标',
  SEAT_ACTIVATING: '席位正在激活',
};

/**
 * 从非激活席位状态获取格式化的不可用原因文案。
 * 前提：调用方已确认 isSeatActive(seatState) === false。
 * @param seatState 席位状态
 * @returns 不可用原因的中文描述字符串
 */
export function describeSeatUnavailable(seatState: SeatState): string {
  const reason = resolveSeatUnavailableReason(seatState);
  return reason === null ? '席位不可用' : SEAT_UNAVAILABLE_REASON_MAP[reason];
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
 * 启动时优先使用已有持仓的标的，避免自动寻标覆盖现有仓位。
 * @param params.autoSearchEnabled 是否启用自动寻标
 * @param params.candidateSymbol 候选标的代码
 * @param params.configuredSymbol 配置文件中指定的标的代码
 * @param params.positions 当前持仓列表
 * @returns 启动时应使用的标的代码，无合适标的时返回 null
 */
export function resolveSeatOnStartup({
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
    return configuredSymbol ?? null;
  }

  if (!candidateSymbol) {
    return null;
  }

  const hasPosition = positions.some((position) => {
    return position.symbol === candidateSymbol && position.quantity > 0;
  });
  return hasPosition ? candidateSymbol : null;
}

/**
 * 断言席位状态满足注册表存储前的基础不变量。
 *
 * @param seatState 待校验的席位状态
 * @param allowStaticBootstrap 是否允许仅在构造期出现、尚无激活时间的静态 ACTIVE 席位
 * @returns 无返回值；校验通过后调用方可将状态写入注册表
 * @throws {Error} 状态与标的绑定、时间字段或 ACTIVE 激活时间约束不一致时抛出
 */
function assertSeatStateInvariant(
  seatState: SeatStateCandidate,
  allowStaticBootstrap: boolean,
): void {
  if (seatState.status === 'EMPTY' || seatState.status === 'SEARCHING') {
    if (seatState.symbol !== null) {
      throw new Error(`SymbolRegistry 席位状态无效：${seatState.status} 不得绑定标的`);
    }
  } else if (typeof seatState.symbol !== 'string' || seatState.symbol.length === 0) {
    throw new Error(`SymbolRegistry 席位状态无效：${seatState.status} 必须绑定标的`);
  }

  for (const [field, value] of [
    ['lastSwitchAt', seatState.lastSwitchAt],
    ['lastSearchAt', seatState.lastSearchAt],
    ['lastSeatActivatedAt', seatState.lastSeatActivatedAt],
  ] as const) {
    if (value !== null && !Number.isFinite(value)) {
      throw new Error(`SymbolRegistry 席位状态无效：${field} 必须是有限时间戳`);
    }
  }

  if (seatState.status !== 'ACTIVE' || seatState.lastSeatActivatedAt !== null) {
    return;
  }

  if (!allowStaticBootstrap) {
    throw new Error('SymbolRegistry 席位状态无效：运行时 ACTIVE 必须具有有效激活时间');
  }

  const isStaticBootstrap =
    seatState.lastSwitchAt === null &&
    seatState.lastSearchAt === null &&
    (seatState.callPrice ?? null) === null &&
    seatState.searchFailCountToday === 0 &&
    seatState.frozenTradingDayKey === null;
  if (!isStaticBootstrap) {
    throw new Error('SymbolRegistry 席位状态无效：仅静态 bootstrap ACTIVE 可缺少激活时间');
  }
}

/**
 * 断言 public mutation 输入是可写入的运行时席位状态，并排除构造期静态 bootstrap 例外。
 *
 * @param seatState 待写入 SymbolRegistry 的候选席位状态
 * @returns 无返回值；断言成功后将参数收窄为 RuntimeWritableSeatState
 * @throws {Error} 运行时状态不满足席位不变量时抛出
 */
function assertRuntimeSeatStateInvariant(
  seatState: SeatStateCandidate,
): asserts seatState is RuntimeWritableSeatState {
  assertSeatStateInvariant(seatState, false);
}

/**
 * 创建包含当前状态、版本与事件版本的内部席位条目。
 *
 * @param state 已满足判别联合约束的初始席位状态
 * @param allowStaticBootstrap 是否允许构造期静态 ACTIVE 席位缺少激活时间
 * @returns 包含状态和版本号的席位条目，初始版本号为 1
 */
function createSeatEntry(state: SeatState, allowStaticBootstrap: boolean): SeatEntry {
  assertSeatStateInvariant(state, allowStaticBootstrap);
  return {
    state,
    version: 1,
    lastEventVersion: 1,
  };
}

/**
 * 规范化席位状态写入对象。
 * @param nextState 调用方传入的下一席位状态
 * @returns 可写入注册表的完整席位状态
 */
function normalizeSeatState(nextState: RuntimeWritableSeatState): RuntimeWritableSeatState {
  assertRuntimeSeatStateInvariant(nextState);
  return {
    ...nextState,
    callPrice: nextState.callPrice ?? null,
  };
}

/**
 * 从唯一 monitor 席位存储中解析指定方向的席位条目（内部辅助函数）
 * @param seatStore 唯一 monitor 的席位存储
 * @param direction 方向（LONG 或 SHORT）
 * @returns 对应方向的席位条目
 */
function resolveSeatEntry(seatStore: SymbolSeatEntry, direction: 'LONG' | 'SHORT'): SeatEntry {
  return direction === 'LONG' ? seatStore.long : seatStore.short;
}

/**
 * 在所有同步 listener 都已尝试执行后，将收集到的错误暴露给上游运行时。
 *
 * @param listenerErrors listener 执行过程中收集的错误
 * @returns 无返回值；无错误时正常返回
 * @throws {AggregateError} 任一 listener 执行失败时抛出，已提交的席位真相不会回滚
 */
function throwIfListenerErrors(listenerErrors: ReadonlyArray<unknown>): void {
  if (listenerErrors.length > 0) {
    throw new AggregateError(listenerErrors, 'SymbolRegistry listener 执行失败');
  }
}

/**
 * 创建席位注册表并初始化唯一 monitor 的多/空席位状态。
 * @param monitor 唯一监控标的配置
 * @returns 实现了 SymbolRegistry 接口的注册表对象
 */
export function createSymbolRegistry(monitor: MonitorConfig): SymbolRegistry {
  const listeners = new Set<SeatStateChangedListener>();
  const truthListeners = new Set<SeatTruthChangedListener>();

  const autoSearchEnabled = monitor.autoSearchConfig.autoSearchEnabled;
  const seatStore: SymbolSeatEntry = {
    long: autoSearchEnabled
      ? createSeatEntry(
          {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: null,
            callPrice: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
          false,
        )
      : createSeatEntry(
          {
            symbol: monitor.longSymbol,
            status: 'ACTIVE',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: null,
            callPrice: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
          true,
        ),
    short: autoSearchEnabled
      ? createSeatEntry(
          {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: null,
            callPrice: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
          false,
        )
      : createSeatEntry(
          {
            symbol: monitor.shortSymbol,
            status: 'ACTIVE',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: null,
            callPrice: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
          true,
        ),
  };

  /**
   * 广播席位状态变化事件，并收集 listener 错误供 mutation 完成全部事件广播后统一抛出。
   * 事件由状态写入或原子状态版本更新发布，单独 bump 版本不发布状态变化事件。
   *
   * @param event 已提交的状态变化事件，含方向、前后状态与事件版本
   * @param listenerErrors 本次 mutation 共享的错误收集器，用于保证后续 state/truth listener 仍会执行
   * @returns 无返回值；所有 state listener 均已尝试执行
   */
  function emitSeatStateChanged(
    event: Parameters<SeatStateChangedListener>[0],
    listenerErrors: unknown[],
  ): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        listenerErrors.push(error);
      }
    }
  }

  /**
   * 广播已提交席位 truth 的变化事件，并继续收集 listener 错误。
   * 事件在 public mutation 完整提交并完成细粒度状态事件发布后同步发出。
   *
   * @param event 已提交 truth 的方向事件
   * @param listenerErrors 与 state event 共享的错误收集器，确保 truth listener 不被前序失败阻断
   * @returns 无返回值；所有 truth listener 均已尝试执行
   */
  function emitSeatTruthChanged(
    event: Parameters<SeatTruthChangedListener>[0],
    listenerErrors: unknown[],
  ): void {
    for (const listener of truthListeners) {
      try {
        listener(event);
      } catch (error) {
        listenerErrors.push(error);
      }
    }
  }

  return {
    getSeatState(direction: 'LONG' | 'SHORT'): SeatState {
      return resolveSeatEntry(seatStore, direction).state;
    },
    getSeatVersion(direction: 'LONG' | 'SHORT'): number {
      return resolveSeatEntry(seatStore, direction).version;
    },
    resolveSeatBySymbol(symbol: string): {
      direction: 'LONG' | 'SHORT';
      seatVersion: number;
    } | null {
      if (!symbol) {
        return null;
      }

      if (
        seatStore.long.state.status !== 'EMPTY' &&
        seatStore.long.state.status !== 'SEARCHING' &&
        seatStore.long.state.symbol === symbol
      ) {
        return {
          direction: 'LONG',
          seatVersion: seatStore.long.version,
        };
      }

      if (
        seatStore.short.state.status !== 'EMPTY' &&
        seatStore.short.state.status !== 'SEARCHING' &&
        seatStore.short.state.symbol === symbol
      ) {
        return {
          direction: 'SHORT',
          seatVersion: seatStore.short.version,
        };
      }

      return null;
    },
    updateSeatState(direction: 'LONG' | 'SHORT', nextState: RuntimeWritableSeatState): SeatState {
      const seatEntry = resolveSeatEntry(seatStore, direction);
      const previousState = seatEntry.state;
      const previousVersion = seatEntry.lastEventVersion;
      seatEntry.state = normalizeSeatState(nextState);
      seatEntry.lastEventVersion = seatEntry.version;
      const listenerErrors: unknown[] = [];
      emitSeatStateChanged(
        {
          direction,
          previousState,
          nextState: seatEntry.state,
          previousVersion,
          nextVersion: seatEntry.version,
        },
        listenerErrors,
      );
      emitSeatTruthChanged({ direction }, listenerErrors);
      throwIfListenerErrors(listenerErrors);
      return seatEntry.state;
    },
    updateSeatStateWithVersionBump(
      direction: 'LONG' | 'SHORT',
      nextState: RuntimeWritableSeatState,
    ): { readonly seatState: SeatState; readonly seatVersion: number } {
      const seatEntry = resolveSeatEntry(seatStore, direction);
      const previousState = seatEntry.state;
      const previousStateEventVersion = seatEntry.lastEventVersion;
      seatEntry.state = normalizeSeatState(nextState);
      seatEntry.version += 1;
      seatEntry.lastEventVersion = seatEntry.version;
      const listenerErrors: unknown[] = [];
      emitSeatStateChanged(
        {
          direction,
          previousState,
          nextState: seatEntry.state,
          previousVersion: previousStateEventVersion,
          nextVersion: seatEntry.version,
        },
        listenerErrors,
      );
      emitSeatTruthChanged({ direction }, listenerErrors);
      throwIfListenerErrors(listenerErrors);
      return { seatState: seatEntry.state, seatVersion: seatEntry.version };
    },
    onSeatStateChanged(listener: SeatStateChangedListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onSeatTruthChanged(listener: SeatTruthChangedListener): () => void {
      truthListeners.add(listener);
      return () => {
        truthListeners.delete(listener);
      };
    },
  };
}
