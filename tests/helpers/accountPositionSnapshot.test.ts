/** 中性 P1 fixture 的真实 owner 与就绪凭据契约，不通过旧缓存或 SDK shape 提供事实。 */
import { describe, expect, it } from 'bun:test';
import { createAccountSnapshotDouble, createPositionDouble } from './testDoubles.js';
import {
  createEmptySnapshotFixture,
  createSettlementFreshnessFixture,
  createSnapshotFixture,
} from './accountPositionSnapshot.js';

describe('P1 neutral snapshot fixtures', () => {
  it('cannot report an uninitialized snapshot as ready', async () => {
    const snapshot = createEmptySnapshotFixture();
    const freshness = createSettlementFreshnessFixture(snapshot);
    const error = await freshness.waitForFresh().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect(snapshot.getView().accountInitialized).toBe(false);
    expect(snapshot.getView().positionsInitialized).toBe(false);
  });

  it('publishes immutable financial text and integer quantity, then rejects an invalidated receipt', async () => {
    const position = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 100,
      availableQuantity: 100,
      costPrice: '0.123456789012345678',
    });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000.123456789012345678'),
      positions: [position],
    });
    const freshness = createSettlementFreshnessFixture(snapshot);
    const receipt = await freshness.waitForFresh();
    expect(receipt.snapshotToken).toEqual(snapshot.getView().token);
    expect(freshness.isCurrent(receipt)).toBe(true);
    expect(snapshot.getView().account?.totalCash).toBe('100000.123456789012345678');
    expect(snapshot.getAvailablePosition('BULL.HK')?.quantity).toBe(100);
    expect(snapshot.getAvailablePosition('BULL.HK')?.costPrice).toBe('0.123456789012345678');
    expect(Object.isFrozen(snapshot.getView())).toBe(true);
    expect(Object.isFrozen(snapshot.getView().positions)).toBe(true);
    expect(Object.isFrozen(snapshot.getView().positions[0])).toBe(true);
    snapshot.invalidate();
    expect(freshness.isCurrent(receipt)).toBe(false);
    expect(snapshot.getView().positionsInitialized).toBe(true);
    expect(snapshot.getView().positionsValid).toBe(false);
  });
});
