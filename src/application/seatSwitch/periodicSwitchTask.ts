/**
 * 周期换标任务用例。
 * 消费原 ACTIVE baseline/epoch/receipt，推进 due 检查并交接真实 SWITCHING WAIT；
 * 只对明确外部失败请求未来重评估，内部错误继续 fail-fast，runtime worker 不拥有失败政策。
 */
import { TRADING } from '../../constants/index.js';
import { isSeatSnapshotValid } from '../../domain/seat/seatIdentity.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { formatError } from '../../utils/error/index.js';
import type {
  PeriodicSwitchTask,
  PeriodicSwitchTaskStatus,
  PeriodicSwitchTaskHandler,
  PeriodicSwitchTaskHandlerDeps,
} from './types.js';

/** 创建 C worker 直接注入的两个回调；keeper 只交 owner，不伪造新交易授权。 */
export function createPeriodicSwitchTaskHandler(
  deps: PeriodicSwitchTaskHandlerDeps,
): PeriodicSwitchTaskHandler {
  const {
    monitorContext,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    snapshot,
    getCanTradeNow,
    logger,
  } = deps;

  async function handlePeriodicSwitchTask(
    task: PeriodicSwitchTask,
    canOwnTask: () => boolean,
  ): Promise<PeriodicSwitchTaskStatus> {
    const data = task.data;
    const isOriginOwnerCurrent = (): boolean =>
      canOwnTask() && snapshot.getView().token.dayEpoch === data.dayEpoch;
    const isActiveRouteCurrent = (): boolean => isOriginOwnerCurrent() && data.isRouteCurrent();
    const canContinue = (): boolean =>
      isActiveRouteCurrent() && data.canContinue() && getCanTradeNow();
    if (!isActiveRouteCurrent()) return 'skipped';

    if (!isSeatSnapshotValid(data.direction, data, monitorContext.symbolRegistry)) return 'skipped';

    if (!canContinue()) return 'blocked';

    let result;
    try {
      result = await monitorContext.seatSwitch.evaluatePeriodicSwitchDue({
        direction: data.direction,
        currentTime: new Date(data.currentTimeMs),
        canContinue,
      });
    } catch (error) {
      if (!isExternalApiRequestError(error)) throw error;

      if (!isActiveRouteCurrent()) return 'skipped';

      logger.error(
        `[SeatSwitch] 周期换标外部请求失败 direction=${data.direction} dedupe=${task.dedupeKey}`,
        formatError(error),
      );
      return 'failed';
    }

    // 原 ACTIVE 身份在同步发布 SWITCHING 后必然失效；只用真实发布见证交 owner，不继续 mutation。
    if (result.kind === 'WAIT') {
      const witness = result.publishedRoute;
      if (
        witness?.direction !== data.direction ||
        witness.symbol !== data.symbol ||
        !Number.isSafeInteger(witness.seatVersion) ||
        typeof witness.isCurrent !== 'function'
      ) {
        throw new TypeError('周期换标 WAIT 发布见证不匹配原任务来源');
      }

      if (!isOriginOwnerCurrent() || !witness.isCurrent()) return 'skipped';

      switchWakeupRuntime.handoffPendingSwitch({
        direction: data.direction,
        monitorContext,
        driveResult: result,
        originalDayEpoch: data.dayEpoch,
      });
      return isOriginOwnerCurrent() && witness.isCurrent() ? 'processed' : 'skipped';
    }

    if (!isActiveRouteCurrent()) return 'skipped';

    if (monitorContext.seatSwitch.getPeriodicSwitchPendingState(data.direction).pending) {
      // 已提交的空仓等待关门后仍由原周期 owner 保留，不能由旧 receipt/gate 拒绝交接。
      periodicSwitchWakeupRuntime.markWaitingEmpty(data);
      return 'processed';
    }

    periodicSwitchWakeupRuntime.clearWaitingEmpty(data);
    return 'processed';
  }

  /** 每个业务结果都交回原 ACTIVE baseline 释放 single-flight；失败时刻由 application 决策。 */
  function onPeriodicSwitchTaskResult(
    task: PeriodicSwitchTask,
    status: PeriodicSwitchTaskStatus,
    canOwnTask: () => boolean,
  ): void {
    const data = task.data;
    if (
      !canOwnTask() ||
      snapshot.getView().token.dayEpoch !== data.dayEpoch ||
      !data.isRouteCurrent()
    )
      return;

    periodicSwitchWakeupRuntime.replanRouteAfterTask({
      ...data,
      taskTimeMs: data.currentTimeMs,
      status,
      ...(status === 'failed'
        ? { reevaluateAtMs: deps.now().getTime() + TRADING.INTERVAL_MS }
        : {}),
    });
  }

  return { handlePeriodicSwitchTask, onPeriodicSwitchTaskResult };
}
