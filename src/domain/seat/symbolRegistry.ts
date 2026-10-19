/** 席位注册表：维护唯一 monitor 的双方向身份、纯状态及同步 truth 事件；不拥有激活用例。 */
import type {
  RuntimeWritableSeatState,
  SeatState,
  SeatTruthChangedListener,
  SymbolRegistry,
} from '../../types/seat.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import type {
  SeatEntry,
  SeatRegistryConfig,
  SeatStateCandidate,
  SeatStateChangedListener,
  SymbolSeatEntry,
} from './types.js';

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
  // shared SeatState 已是金融文本；校验原文而不归一化或给未知回收价填0。
  if (seatState.callPrice !== null && seatState.callPrice !== undefined)
    exactCompare(seatState.callPrice, '0');

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
export function createSymbolRegistry(monitor: SeatRegistryConfig): SymbolRegistry {
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
    updateSeatState(direction: 'LONG' | 'SHORT', nextState: RuntimeWritableSeatState): void {
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
    },
    updateSeatStateWithVersionBump(
      direction: 'LONG' | 'SHORT',
      nextState: RuntimeWritableSeatState,
    ): { readonly seatVersion: number } {
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
      return { seatVersion: seatEntry.version };
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
