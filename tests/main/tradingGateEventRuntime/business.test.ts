/**
 * tradingGateEventRuntime 业务测试
 *
 * 覆盖 gate state fanout 在单个 listener 失败时仍继续通知后续 listener。
 */
import { describe, expect, it } from 'bun:test';
import { createTradingGateEventRuntime } from '../../../src/main/tradingGateEventRuntime/index.js';

describe('tradingGateEventRuntime', () => {
  it('单个 listener 抛错时仍继续通知后续 listener', () => {
    const runtime = createTradingGateEventRuntime();
    const calls: string[] = [];

    runtime.onGateStateChanged(() => {
      calls.push('first');
      throw new Error('listener failed');
    });

    runtime.onGateStateChanged(() => {
      calls.push('second');
    });

    expect(() => {
      runtime.emitGateStateChanged({
        previousCanTrade: false,
        nextCanTrade: true,
      });
    }).not.toThrow();
    expect(calls).toEqual(['first', 'second']);
  });

  it('自动寻标授权 listener 的内部错误必须向时间控制平面 fail-fast', () => {
    const runtime = createTradingGateEventRuntime();
    runtime.onAutoSearchAuthorizationChanged(() => {
      throw new Error('auto-search authorization invariant broken');
    });

    expect(() => {
      runtime.emitAutoSearchAuthorizationChanged({
        previousAuthorized: true,
        nextAuthorized: false,
      });
    }).toThrow('auto-search authorization invariant broken');
  });
});
