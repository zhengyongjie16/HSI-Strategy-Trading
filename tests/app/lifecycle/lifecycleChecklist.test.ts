/** 生命周期清单纯校验：结构、反向覆盖、重复与顺序负例；真实接线另见 wiring 测试。 */
import { describe, expect, it } from 'bun:test';
import { LIFECYCLE_CHECKLIST } from './lifecycleChecklist.js';
import { validateLifecycleChecklist } from './lifecycleChecklistValidation.js';

// 仅缩小纯函数负例输入；不作为生产路径的覆盖证据。
const drainChecklist = {
  resources: LIFECYCLE_CHECKLIST.resources.filter(({ resource }) =>
    ['orderMonitor', 'quoteSubscriptionRuntime', 'strategy'].includes(resource),
  ),
  order: [
    {
      group: 'midnightStopAndDrain' as const,
      operations: [
        'orderMonitor.stopRuntimeAndDrain',
        'quoteSubscriptionRuntime.stopAndDrain',
        'strategy.resetForTradingDay',
      ],
    },
  ],
};

const drainTrace = [
  'orderMonitor.stopRuntimeAndDrain',
  'quoteSubscriptionRuntime.stopAndDrain',
  'strategy.resetForTradingDay',
] as const;

describe('lifecycle checklist validation', () => {
  it('accepts the static declaration without changing its input', () => {
    const before = JSON.stringify(LIFECYCLE_CHECKLIST);
    expect(validateLifecycleChecklist(LIFECYCLE_CHECKLIST)).toEqual([]);
    expect(JSON.stringify(LIFECYCLE_CHECKLIST)).toBe(before);
  });

  it('rejects both an omitted declaration and an omitted real operation', () => {
    const observation = { traces: { midnightStopAndDrain: drainTrace } };
    const omitted = {
      ...drainChecklist,
      resources: drainChecklist.resources.filter(({ resource }) => resource !== 'strategy'),
    };
    expect(validateLifecycleChecklist(omitted, observation)).toContain(
      'midnightStopAndDrain: unlisted operation strategy.resetForTradingDay',
    );

    expect(
      validateLifecycleChecklist(drainChecklist, {
        traces: { midnightStopAndDrain: drainTrace.slice(0, -1) },
      }),
    ).toContain('midnightStopAndDrain: missing operation strategy.resetForTradingDay');
  });

  it('rejects duplicate resources and duplicate action declarations', () => {
    expect(
      validateLifecycleChecklist({
        ...drainChecklist,
        resources: [...drainChecklist.resources, ...drainChecklist.resources],
      }),
    ).toContain('duplicate resource: strategy');

    expect(
      validateLifecycleChecklist({
        ...drainChecklist,
        resources: drainChecklist.resources.map((resource) => ({
          ...resource,
          midnightStopAndDrain: [
            ...(resource.midnightStopAndDrain ?? []),
            ...(resource.midnightStopAndDrain ?? []),
          ],
        })),
      }),
    ).toContain('midnightStopAndDrain: duplicate operation strategy.resetForTradingDay');
  });

  it('rejects quote/strategy draining before order facts and cleanup phase reversal', () => {
    expect(
      validateLifecycleChecklist(drainChecklist, {
        traces: {
          midnightStopAndDrain: [drainTrace[2], drainTrace[1], drainTrace[0]],
        },
      }),
    ).toContain(
      'midnightStopAndDrain: order orderMonitor.stopRuntimeAndDrain -> quoteSubscriptionRuntime.stopAndDrain',
    );

    expect(
      validateLifecycleChecklist(drainChecklist, {
        traces: {
          finalDrainAndDispose: [
            'strategy.destroy',
            'orderMonitor.stopRuntimeAndDrain',
            'orderMonitor.teardown',
            'quoteSubscriptionRuntime.stopAndDrain',
          ],
        },
      }),
    ).toContain('finalDrainAndDispose: cleanup phase order orderMonitor.stopRuntimeAndDrain');
  });

  it('rejects TimeWakeup midnight self-drain and loss of its closed-day lifetime', () => {
    for (const patch of [
      { midnightStopAndDrain: ['stopAndDrain'] },
      { runsWhileTradingClosed: false },
    ]) {
      expect(
        validateLifecycleChecklist({
          ...LIFECYCLE_CHECKLIST,
          resources: LIFECYCLE_CHECKLIST.resources.map((resource) =>
            resource.resource === 'timeWakeupRuntime' ? { ...resource, ...patch } : resource,
          ),
        }),
      ).toContain('TimeWakeupRuntime must remain running across midnight/rebuild');
    }
  });
});
