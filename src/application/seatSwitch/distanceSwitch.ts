import type { SeatSwitchWorkflow, StartSwitchOnDistanceResult } from '../../types/seatSwitch.js';
import type { SymbolRegistry } from '../../types/seat.js';

/** 距离换标事件用例：从原行情/席位身份与 canonical 持仓发起距离检查，不代管 WAIT 或激活。 */
import { TRADING } from '../../constants/common.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { isSeatActive } from '../../domain/seat/seatPolicy.js';

import type { QuoteUpdatedEvent } from '../../types/marketPorts.js';
import type {
  StartDistanceSwitchExecutor,
  DistanceSwitchExecutorDeps,
  DistanceSwitchPrecheckSnapshot,
  DistanceSwitchExecutionResult,
} from './types.js';

/**
 * 为 autoSearch 开启场景创建最小距离换标启动执行器。
 *
 * @param deps 持仓快照依赖
 * @returns monitor quote 驱动的距离换标启动执行函数
 */
export function createDistanceSwitchExecutor(
  deps: DistanceSwitchExecutorDeps,
): StartDistanceSwitchExecutor {
  return async function startDistanceSwitchOnMonitorQuote(params: {
    readonly monitorContext: {
      readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
      readonly seatSwitch: SeatSwitchWorkflow;
    };
    readonly event: QuoteUpdatedEvent;
    readonly canContinue: () => boolean;
    readonly retryConsumed: boolean;
    readonly isDirectionCurrent: (direction: 'LONG' | 'SHORT') => boolean;
  }): Promise<DistanceSwitchExecutionResult> {
    const { monitorContext, event } = params;
    const longSeat = monitorContext.symbolRegistry.getSeatState('LONG');
    const shortSeat = monitorContext.symbolRegistry.getSeatState('SHORT');
    const monitorPrice = event.quote.price;
    const results: StartSwitchOnDistanceResult[] = [];
    const before = captureDistanceSwitchPrecheckSnapshot(monitorContext);

    try {
      if (isSeatActive(longSeat) && params.canContinue() && params.isDirectionCurrent('LONG')) {
        const positions = deps.snapshot.getView().positions;
        results.push(
          await monitorContext.seatSwitch.startSwitchOnDistance({
            direction: 'LONG',
            monitorPrice,
            positions,
            canContinue: () => params.canContinue() && params.isDirectionCurrent('LONG'),
          }),
        );
      }

      if (isSeatActive(shortSeat) && params.canContinue() && params.isDirectionCurrent('SHORT')) {
        const positions = deps.snapshot.getView().positions;
        results.push(
          await monitorContext.seatSwitch.startSwitchOnDistance({
            direction: 'SHORT',
            monitorPrice,
            positions,
            canContinue: () => params.canContinue() && params.isDirectionCurrent('SHORT'),
          }),
        );
      }
    } catch (error) {
      if (!isExternalApiRequestError(error)) throw error;

      if (!params.canContinue()) return { kind: 'RESULTS', results };

      if (params.retryConsumed || !isDistanceSwitchPrecheckRetrySafe(monitorContext, before))
        throw error;

      return { kind: 'RETRY_PRECHECK', retryAtMs: deps.now().getTime() + TRADING.INTERVAL_MS };
    }

    return { kind: 'RESULTS', results };
  };
}

/**
 * 读取单侧距离换标预检事实。
 *
 * @param monitorContext 当前唯一监控上下文
 * @param direction 席位方向
 * @returns 调用 startSwitchOnDistance 前的单侧权威快照
 */
function captureDistanceSwitchPrecheckDirection(
  monitorContext: {
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly seatSwitch: SeatSwitchWorkflow;
  },
  direction: 'LONG' | 'SHORT',
): DistanceSwitchPrecheckSnapshot[number] {
  const seatState = monitorContext.symbolRegistry.getSeatState(direction);
  return {
    direction,
    seatStatus: seatState.status,
    seatSymbol: seatState.symbol,
    seatVersion: monitorContext.symbolRegistry.getSeatVersion(direction),
    hasPendingSwitch: monitorContext.seatSwitch.hasPendingSwitch(direction),
  };
}

/** 距离事件捕获两方向原身份，明确外部失败只有在未发布任何换标计划时才可重评估。 */
export function captureDistanceSwitchPrecheckSnapshot(monitorContext: {
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly seatSwitch: SeatSwitchWorkflow;
}): DistanceSwitchPrecheckSnapshot {
  return [
    captureDistanceSwitchPrecheckDirection(monitorContext, 'LONG'),
    captureDistanceSwitchPrecheckDirection(monitorContext, 'SHORT'),
  ];
}

/** 两方向都无 pending 且身份未变才能证明没有已提交的换标副作用。 */
function isDistanceSwitchPrecheckRetrySafe(
  monitorContext: {
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly seatSwitch: SeatSwitchWorkflow;
  },
  snapshot: DistanceSwitchPrecheckSnapshot,
): boolean {
  return snapshot.every((entry) => {
    const seatState = monitorContext.symbolRegistry.getSeatState(entry.direction);
    return (
      !entry.hasPendingSwitch &&
      !monitorContext.seatSwitch.hasPendingSwitch(entry.direction) &&
      seatState.status === entry.seatStatus &&
      seatState.symbol === entry.seatSymbol &&
      monitorContext.symbolRegistry.getSeatVersion(entry.direction) === entry.seatVersion
    );
  });
}
