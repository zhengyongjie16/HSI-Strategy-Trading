/**
 * EventFlow 保护性终态依赖类型契约
 *
 * 超时保护性 SELL 在写入终态快照前必须持久化成交进度，
 * 因此构造 EventFlow 时不得遗漏 preparation 依赖。
 */
import { describe, expect, it } from 'bun:test';
import type { EventFlowDeps } from '../../src/core/trader/orderMonitor/types.js';

describe('EventFlowDeps type contract', () => {
  it('keeps the protective terminal preparation dependency constructible', () => {
    const deps: Pick<EventFlowDeps, 'prepareProtectiveTerminalExecution'> = {
      prepareProtectiveTerminalExecution: () => null,
    };

    expect(deps.prepareProtectiveTerminalExecution).toBeDefined();
  });
});

// @ts-expect-error 保护性 timeout 终态依赖必须由每个 EventFlow 构造方显式提供。
const missingProtectiveTerminalPreparation: Pick<
  EventFlowDeps,
  'prepareProtectiveTerminalExecution'
> = {};
void missingProtectiveTerminalPreparation;
