/** 受控重建激活：独立基线不重复运行期 I/O，仅原 token/席位仍有效且全局关闭时发布 ACTIVE。 */
import { describe, expect, it } from 'bun:test';
import { commitRebuiltSeatActivation } from '../../../src/application/seatActivation/rebuiltSeats.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import {
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
} from '../../helpers/testDoubles.js';

async function createRebuildFixture() {
  const registry = createSymbolRegistry(createMonitorConfigDouble());
  registry.updateSeatState('LONG', {
    ...registry.getSeatState('LONG'),
    symbol: 'BULL.HK',
    status: 'ACTIVATING',
    callPrice: '20000',
  });
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const input = {
    snapshotToken: snapshot.getView().token,
    seats: [
      {
        direction: 'LONG' as const,
        symbol: 'BULL.HK',
        status: 'ACTIVATING' as const,
        seatVersion: registry.getSeatVersion('LONG'),
        lastSeatActivatedAt: 1234,
      },
    ],
  };
  return { registry, snapshot, input };
}

describe('受控基线 activation', () => {
  it('只在原完整基线有效且全局关闭时发布，并保留原 carryover 时间及版本', async () => {
    const { registry, snapshot, input } = await createRebuildFixture();
    const version = registry.getSeatVersion('LONG');
    expect(
      commitRebuiltSeatActivation(
        {
          symbolRegistry: registry,
          snapshot,
          getIsTradingEnabled: () => false,
          isTerminated: () => false,
        },
        input,
      ),
    ).toBe(true);

    expect(registry.getSeatState('LONG')).toMatchObject({
      status: 'ACTIVE',
      lastSeatActivatedAt: 1234,
    });
    expect(registry.getSeatVersion('LONG')).toBe(version);
  });

  it('旧 token 不发布 ACTIVE，交易开门误用则 fail-fast', async () => {
    const { registry, snapshot, input } = await createRebuildFixture();
    const deps = {
      symbolRegistry: registry,
      snapshot,
      getIsTradingEnabled: () => false,
      isTerminated: () => false,
    };
    snapshot.invalidate();
    expect(commitRebuiltSeatActivation(deps, input)).toBe(false);
    expect(registry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(() =>
      commitRebuiltSeatActivation({ ...deps, getIsTradingEnabled: () => true }, input),
    ).toThrow('全局交易关闭');
  });
});
