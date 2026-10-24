/**
 * 生命周期开盘域授权 fixture。
 * 通过真实快照 owner 签发 paired H evidence，保留该轮原 owner 与 captured token。
 */
import { createEmptySnapshotFixture } from '../../../helpers/accountPositionSnapshot.js';
import { createAccountSnapshotDouble } from '../../../helpers/testDoubles.js';
import type { AccountPositionSnapshot } from '../../../../src/types/accountPosition.js';
import type { RuntimeTermination } from '../../../../src/types/runtime.js';
import type { OpenRebuildContext } from '../../../../src/runtime/lifecycle/types.js';

/** 在单域 open 工作前取得真实 paired H evidence，不重绑原 owner。 */
export async function createOpenRebuildContextFixture(
  params: Readonly<{
    now: Date;
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
    dayEpoch,
    snapshotToken: capturedToken,
    isCurrent: () =>
      !params.termination.isTerminated() &&
      snapshot.getStatus().admission !== 'CLOSED' &&
      snapshot.isCurrent(capturedToken, { account: true, positions: true, paired: true }),
  };
}
