/**
 * 全局状态类型约束测试。
 * 交易日历必须完整注入；监控上下文只持有中性策略端口，不暴露私有指标运行态。
 */
import { describe, expect, it } from 'bun:test';
import type { LastState } from '../../src/types/state.js';
import { createMonitorContextDouble, createStrategyDouble } from '../helpers/testDoubles.js';

/** 使用类型层参数检验必需交易日历，不制造运行期伪造状态。 */
function verifyRequiredCalendar(incomplete: Omit<LastState, 'tradingCalendarSnapshot'>): void {
  // @ts-expect-error 交易日历是必需事实，不得省略。
  const missingCalendar: LastState = incomplete;
  void missingCalendar;
}
void verifyRequiredCalendar;

describe('state type contracts', () => {
  it('retains the injected strategy identity without host-owned indicator state', () => {
    const strategy = createStrategyDouble();
    const context = createMonitorContextDouble({ strategy });
    expect(context.strategy).toBe(strategy);
    expect(Object.hasOwn(context, 'state')).toBe(false);
    expect(Object.hasOwn(context, 'indicatorProfile')).toBe(false);
    expect(Object.hasOwn(context, 'delayedSignalVerifier')).toBe(false);
  });
});
