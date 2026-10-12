/**
 * 自动寻标任务处理器
 *
 * 核心职责：
 * - 处理 AUTO_SYMBOL_TICK 周期换标 due 任务
 * - 执行前校验席位快照，防止旧任务在换标后被错误执行
 */
import { logger } from '../../../../utils/logger/index.js';
import type {
  AdvancePendingSwitchResult,
  SwitchDriveResult,
} from '../../../../types/monitorContextPorts.js';
import type { PeriodicSwitchWakeupRuntime } from '../../../periodicSwitchWakeupRuntime/types.js';
import type { SwitchWakeupRuntime } from '../../../monitorQuoteEventRuntime/types.js';
import type { MonitorTask } from '../../monitorTaskQueue/types.js';
import type { MonitorTaskDataMap, MonitorTaskStatus } from '../types.js';
import type { PeriodicSwitchTaskData } from '../../../../types/periodicSwitch.js';
import type { MonitorContext } from '../../../../types/state.js';
import type { AccountPositionSnapshotReader } from '../../../../types/accountPosition.js';
import { isSeatSnapshotValid } from '../helpers/seatSnapshot.js';

function handoffPeriodicWakeup(params: {
  readonly context: MonitorContext;
  readonly data: PeriodicSwitchTaskData;
  readonly canContinue: () => boolean;
  readonly periodicSwitchWakeupRuntime: Pick<
    PeriodicSwitchWakeupRuntime,
    'markWaitingEmpty' | 'clearWaitingEmpty' | 'replanRouteAfterTask'
  >;
}): boolean {
  if (!params.canContinue()) {
    return false;
  }

  const baseline = params.data;
  const pendingState = params.context.autoSymbolManager.getPeriodicSwitchPendingState(
    params.data.direction,
  );
  if (pendingState.pending) {
    if (!params.canContinue()) {
      return false;
    }

    params.periodicSwitchWakeupRuntime.markWaitingEmpty(baseline);
    return true;
  }

  if (!params.canContinue()) {
    return false;
  }

  params.periodicSwitchWakeupRuntime.clearWaitingEmpty(baseline);
  if (!params.canContinue()) {
    return false;
  }

  params.periodicSwitchWakeupRuntime.replanRouteAfterTask({
    ...baseline,
    taskTimeMs: params.data.currentTimeMs,
    status: 'processed',
  });
  return true;
}

/**
 * 创建周期换标任务处理器（AUTO_SYMBOL_TICK）。
 * 执行前校验席位快照，防止换标后执行旧任务；该任务只触发周期换标 due 检查。
 *
 * @param deps 依赖注入，包含唯一 monitorContext、switchWakeupRuntime、getCanTradeNow
 * @returns AUTO_SYMBOL_TICK 处理函数
 */
export function createAutoSymbolTickHandler({
  monitorContext,
  switchWakeupRuntime,
  periodicSwitchWakeupRuntime,
  getCanTradeNow,
  snapshot,
  canOwnTask,
}: {
  readonly monitorContext: MonitorContext;
  readonly switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'handoffPendingSwitch'>;
  readonly periodicSwitchWakeupRuntime: Pick<
    PeriodicSwitchWakeupRuntime,
    'markWaitingEmpty' | 'clearWaitingEmpty' | 'replanRouteAfterTask'
  >;
  readonly getCanTradeNow: () => boolean;
  readonly snapshot: Pick<AccountPositionSnapshotReader, 'getView'>;
  readonly canOwnTask: () => boolean;
}): (task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>) => Promise<MonitorTaskStatus> {
  function handoffPendingWakeup(params: {
    readonly context: MonitorContext;
    readonly direction: 'LONG' | 'SHORT';
    readonly result: SwitchDriveResult | AdvancePendingSwitchResult;
    readonly originalDayEpoch: number;
    readonly canContinue: () => boolean;
  }): void {
    const { result } = params;

    if (!params.canContinue()) {
      return;
    }

    if ('kind' in result) {
      if (result.kind !== 'WAIT') {
        return;
      }

      if (!params.canContinue()) {
        return;
      }

      switchWakeupRuntime.handoffPendingSwitch({
        direction: params.direction,
        monitorContext: params.context,
        driveResult: result,
        originalDayEpoch: params.originalDayEpoch,
      });
      return;
    }

    if (!result.advanced) {
      return;
    }

    if (!result.stillPending) {
      return;
    }

    if (!params.canContinue()) {
      return;
    }

    switchWakeupRuntime.handoffPendingSwitch({
      direction: params.direction,
      monitorContext: params.context,
      driveResult: result.driveResult,
      originalDayEpoch: params.originalDayEpoch,
    });
  }

  async function handleAutoSymbolTick(
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>,
  ): Promise<MonitorTaskStatus> {
    const data: PeriodicSwitchTaskData = task.data;
    const context = monitorContext;
    const isOriginOwnerCurrent = (): boolean =>
      canOwnTask() && snapshot.getView().token.dayEpoch === data.dayEpoch;
    const canContinue = (): boolean =>
      isOriginOwnerCurrent() && data.canContinue() && getCanTradeNow();
    if (!isOriginOwnerCurrent() || !data.isRouteCurrent()) return 'skipped';

    const isSnapshotValid = isSeatSnapshotValid(
      data.direction,
      {
        seatVersion: data.seatVersion,
        symbol: data.symbol,
        lastSeatActivatedAt: data.lastSeatActivatedAt,
      },
      context,
    );
    if (!isSnapshotValid) {
      logger.debug(
        `[MonitorTaskProcessor] AUTO_SYMBOL_TICK 快照失效，跳过 type=${task.type} direction=${data.direction} dedupe=${task.dedupeKey}`,
      );
      return 'skipped';
    }

    if (!canContinue()) {
      return 'blocked';
    }

    const dueParams = {
      direction: data.direction,
      currentTime: new Date(data.currentTimeMs),
      dayEpoch: data.dayEpoch,
      canContinue,
    };
    const dueResult = await context.autoSymbolManager.evaluatePeriodicSwitchDue(dueParams);

    // 首次 WAIT 已同步发布 SWITCHING，不能再用已失效的 ACTIVE mutation 票否认它。
    // keeper 只交接本次真实 pending identity；不替换原 receipt/position/canContinue。
    if (dueResult.kind === 'WAIT' && dueResult.publishedRoute !== undefined) {
      const publishedRoute = dueResult.publishedRoute;
      if (
        publishedRoute.direction !== data.direction ||
        publishedRoute.symbol !== data.symbol ||
        !Number.isSafeInteger(publishedRoute.seatVersion) ||
        typeof publishedRoute.isCurrent !== 'function'
      ) {
        throw new TypeError('周期换标 WAIT 发布见证不匹配原任务来源');
      }

      const canKeepPublishedRoute = (): boolean =>
        isOriginOwnerCurrent() && publishedRoute.isCurrent();
      if (!canKeepPublishedRoute()) return 'skipped';

      handoffPendingWakeup({
        context,
        direction: data.direction,
        result: dueResult,
        originalDayEpoch: data.dayEpoch,
        canContinue: canKeepPublishedRoute,
      });
      // SWITCHING 后续归真实 switch wakeup owner；不向旧 ACTIVE waiting-empty 写第二份账。
      return canKeepPublishedRoute() ? 'processed' : 'skipped';
    }

    handoffPendingWakeup({
      context,
      direction: data.direction,
      result: dueResult,
      originalDayEpoch: data.dayEpoch,
      canContinue: () => isOriginOwnerCurrent() && data.isRouteCurrent(),
    });

    if (
      !handoffPeriodicWakeup({
        context,
        data,
        canContinue: () => isOriginOwnerCurrent() && data.isRouteCurrent(),
        periodicSwitchWakeupRuntime,
      })
    ) {
      return 'blocked';
    }

    return 'processed';
  }

  return handleAutoSymbolTick;
}
