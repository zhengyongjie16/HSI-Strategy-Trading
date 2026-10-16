/**
 * 生命周期清单纯校验。
 * 只比较声明、实际 acquisition 登记与调用 trace；不执行资源动作、不排序或生成执行计划。
 */
import { CLEANUP_PHASE_ORDER } from '../../constants/cleanup.js';
import type { CleanupPhase } from '../../types/cleanup.js';
import type {
  LifecycleChecklist,
  LifecycleChecklistGroup,
  LifecycleChecklistObservation,
  LifecycleChecklistResource,
} from './types.js';

/** 仅将一条资源声明投影为具名操作标识，不取得或调用对应方法。 */
function resourceOperations(
  resource: LifecycleChecklistResource,
  group: LifecycleChecklistGroup,
): ReadonlyArray<string> {
  const operations =
    group === 'finalDrainAndDispose'
      ? resource.finalDrainAndDispose.map(([, operation]) => operation)
      : (resource[group] ?? []);
  return operations.map((operation) => `${resource.resource}.${operation}`);
}

/** 比较已有调用中相邻依赖的首次出现位置；允许受控重建重试重复同一真实操作。 */
function checkOrder(
  operations: ReadonlyArray<string>,
  trace: ReadonlyArray<string>,
  group: LifecycleChecklistGroup,
): ReadonlyArray<string> {
  return operations.slice(1).flatMap((after, index) => {
    const before = operations[index];
    if (before === undefined) return [];

    const beforeIndex = trace.indexOf(before);
    const afterIndex = trace.indexOf(after);
    return beforeIndex !== -1 && afterIndex !== -1 && beforeIndex >= afterIndex
      ? [`${group}: order ${before} -> ${after}`]
      : [];
  });
}

/**
 * 校验静态资源声明及可选的真实观察值。遗漏由实际 trace/登记反向发现，不另存第二份预期资源清单。
 * cleanup 顺序仅查固定 CLEANUP_PHASE_ORDER；这里不产生执行器，也不改变原有 phase 或注册顺序。
 * @param checklist app 资源声明与安全依赖
 * @param observation 真实 factory 的 cleanup 登记和具名路径 trace
 * @returns 全部校验错误；输入保持不变
 */
export function validateLifecycleChecklist(
  checklist: LifecycleChecklist,
  observation: LifecycleChecklistObservation = {},
): ReadonlyArray<string> {
  const errors: string[] = [];
  const resources = new Set<string>();
  for (const resource of checklist.resources) {
    if (resources.has(resource.resource)) errors.push(`duplicate resource: ${resource.resource}`);

    resources.add(resource.resource);
    if (!resource.createdBy.trim()) errors.push(`missing owner: ${resource.resource}`);

    if (resource.finalDrainAndDispose.length === 0 && !resource.retainedBy?.trim()) {
      errors.push(`missing cleanup policy: ${resource.resource}`);
    }
  }

  const timeWakeup = checklist.resources.find(({ resource }) => resource === 'timeWakeupRuntime');
  if (
    timeWakeup !== undefined &&
    (!timeWakeup.runsWhileTradingClosed ||
      (timeWakeup.midnightStopAndDrain?.length ?? 0) > 0 ||
      (timeWakeup.openRebuildStart?.length ?? 0) > 0)
  ) {
    errors.push('TimeWakeupRuntime must remain running across midnight/rebuild');
  }

  for (const group of [
    'startAfterRebuild',
    'stopAdmissionAndStopNow',
    'midnightStopAndDrain',
    'openRebuildStart',
    'finalDrainAndDispose',
  ] as const) {
    const operations = checklist.resources.flatMap((resource) =>
      resourceOperations(resource, group),
    );
    const declared = new Set<string>();
    for (const operation of operations) {
      if (declared.has(operation)) errors.push(`${group}: duplicate operation ${operation}`);

      declared.add(operation);
    }

    const dependencies = checklist.order.filter((order) => order.group === group);
    for (const dependency of dependencies) {
      for (const operation of dependency.operations) {
        if (!declared.has(operation)) errors.push(`${group}: undeclared dependency ${operation}`);
      }
    }

    const trace = observation.traces?.[group];
    if (trace === undefined) continue;

    for (const operation of declared) {
      if (!trace.includes(operation)) errors.push(`${group}: missing operation ${operation}`);
    }

    for (const operation of new Set(trace)) {
      if (!declared.has(operation)) errors.push(`${group}: unlisted operation ${operation}`);
    }

    for (const resource of checklist.resources) {
      errors.push(...checkOrder(resourceOperations(resource, group), trace, group));
    }

    for (const dependency of dependencies) {
      errors.push(...checkOrder(dependency.operations, trace, group));
    }

    if (group === 'finalDrainAndDispose') {
      const phases = new Map<string, CleanupPhase>(
        checklist.resources.flatMap((resource) =>
          resource.finalDrainAndDispose.map(
            ([phase, operation]) => [`${resource.resource}.${operation}`, phase] as const,
          ),
        ),
      );
      let previous = -1;
      for (const operation of trace) {
        const phase = phases.get(operation);
        if (phase === undefined) continue;

        const current = CLEANUP_PHASE_ORDER[phase];
        if (current < previous) errors.push(`${group}: cleanup phase order ${operation}`);

        previous = current;
      }
    }
  }

  if (observation.cleanupRegistrations !== undefined) {
    const counts = new Map<string, number>();
    for (const resource of checklist.resources) {
      for (const [phase, operation] of resource.finalDrainAndDispose) {
        const key = `${resource.createdBy}:${phase}:${resource.resource}.${operation}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    for (const { createdBy, cleanupPhase, operation } of observation.cleanupRegistrations) {
      const key = `${createdBy}:${cleanupPhase}:${operation}`;
      const count = counts.get(key) ?? 0;
      if (count === 0) errors.push(`unlisted cleanup registration: ${key}`);
      else counts.set(key, count - 1);
    }

    for (const [key, count] of counts) {
      if (count > 0) errors.push(`missing cleanup registration: ${key} (${count})`);
    }
  }

  return errors;
}
