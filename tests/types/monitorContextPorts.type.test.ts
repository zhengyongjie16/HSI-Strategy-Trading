/**
 * monitorContextPorts 类型约束测试
 *
 * 验证 WAIT owner 非空以及 advancePendingSwitch 的 stillPending 判别联合。
 */
import { describe, expect, it } from 'bun:test';
import type {
  AdvancePendingSwitchResult,
  StartSwitchOnDistanceResult,
  SwitchDriveResult,
} from '../../src/types/monitorContextPorts.js';

describe('monitorContextPorts type contracts', () => {
  it('keeps valid switch result variants constructible', () => {
    const waitResult: SwitchDriveResult = {
      kind: 'WAIT',
      wakeups: [{ kind: 'FRESHNESS' }],
    };
    const pendingResult: AdvancePendingSwitchResult = {
      advanced: true,
      direction: 'LONG',
      stillPending: true,
      driveResult: waitResult,
    };

    expect(pendingResult.stillPending).toBeTrue();
  });
});

// @ts-expect-error WAIT 必须至少声明一个可继续推进的 owner。
const emptyWait: SwitchDriveResult = { kind: 'WAIT', wakeups: [] };
void emptyWait;

// @ts-expect-error stillPending=true 只能搭配非空 WAIT。
const pendingWithoutWait: AdvancePendingSwitchResult = {
  advanced: true,
  direction: 'LONG',
  stillPending: true,
  driveResult: { kind: 'COMPLETED' },
};
void pendingWithoutWait;

const completedWithWait: AdvancePendingSwitchResult = {
  advanced: true,
  direction: 'LONG',
  stillPending: false,
  // @ts-expect-error stillPending=false 不得搭配 WAIT。
  driveResult: { kind: 'WAIT', wakeups: [{ kind: 'FRESHNESS' }] },
};
void completedWithWait;

const startedWithoutWait: StartSwitchOnDistanceResult = {
  started: true,
  direction: 'LONG',
  // @ts-expect-error started=true 只能交接非空 WAIT owner。
  driveResult: { kind: 'COMPLETED' },
};
void startedWithoutWait;
