/**
 * 全局状态类型约束测试
 *
 * 验证交易日历是 LastState 必需事实，MonitorState 不再暴露失效信号镜像。
 */
import { describe, expect, it } from 'bun:test';
import type { LastState, MonitorState } from '../../src/types/state.js';

describe('state type contracts', () => {
  it('keeps the minimal monitor runtime state constructible', () => {
    const state: MonitorState = {
      monitorSymbol: 'HSI.HK',
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    };

    expect(state.monitorSymbol).toBe('HSI.HK');
  });
});

// @ts-expect-error 交易日历是生命周期与交易时长计算的必需事实，不得省略。
const missingTradingCalendarSnapshot: LastState = null as unknown as Omit<
  LastState,
  'tradingCalendarSnapshot'
>;
void missingTradingCalendarSnapshot;
