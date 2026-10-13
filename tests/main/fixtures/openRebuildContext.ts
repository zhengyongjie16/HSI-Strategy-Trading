import { createEmptySnapshotFixture } from './accountPositionSnapshot.js';
import { createAccountSnapshotDouble } from '../../helpers/testDoubles.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';
import type { OpenRebuildContext } from '../../../src/main/lifecycle/types.js';
import type { LifecycleRuntimeFlags } from '../../../src/types/timeControlPlane.js';

/** Issue actual paired H evidence before a unit domain's open stage, retaining its original owner. */
export async function createOpenRebuildContextFixture(
  params: Readonly<{
    now: Date;
    runtime: LifecycleRuntimeFlags;
    termination: Pick<RuntimeTermination, 'isTerminated'>;
    snapshot?: AccountPositionSnapshot;
  }>,
): Promise<OpenRebuildContext> {
  const snapshot =
    params.snapshot ??
    createEmptySnapshotFixture({ account: createAccountSnapshotDouble('100000'), positions: [] });
  if (params.termination.isTerminated())
    throw new Error('Cannot issue open context after termination');

  snapshot.beginRebuild();
  const dayEpoch = snapshot.getStatus().token.dayEpoch;
  const receipt = await snapshot.requestRefresh({
    source: 'LIFECYCLE_REBUILD',
    dayEpoch,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (receipt.status !== 'COMMITTED') throw new Error('Open context H request aborted');

  const capturedToken = receipt.snapshotToken;
  return {
    now: params.now,
    runtime: params.runtime,
    dayEpoch,
    snapshotToken: capturedToken,
    isCurrent: () =>
      !params.termination.isTerminated() &&
      snapshot.getStatus().admission !== 'CLOSED' &&
      snapshot.isCurrent(capturedToken, { account: true, positions: true, paired: true }),
  };
}
