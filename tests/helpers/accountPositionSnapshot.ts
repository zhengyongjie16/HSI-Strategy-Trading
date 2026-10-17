/**
 * P1 镜像测试的中性快照 fixture。
 * 通过真实 canonical owner 发布事实，不把账户持仓重新挂回 RuntimeStateFixtures，也不构造 SDK 对象。
 */
import { createDiagnosticObserverDouble } from './diagnostics.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import type { AccountSnapshot, Position } from '../../src/types/account.js';
import type {
  AccountPositionSnapshot,
  AccountPositionSnapshotReader,
  SnapshotReadPort,
} from '../../src/types/accountPosition.js';
import type {
  SettlementFreshnessReader,
  SettlementReadinessReceipt,
} from '../../src/types/settlement.js';

/** 创建未初始化 owner，供装配与手动控制读取完成的测试使用。 */
export function createEmptySnapshotFixture(
  params: {
    readonly account?: AccountSnapshot;
    readonly positions?: ReadonlyArray<Position>;
    readonly dayEpoch?: number;
    readonly readPort?: SnapshotReadPort;
    readonly reportFatalError?: (error: unknown) => void;
  } = {},
): AccountPositionSnapshot {
  return createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    readPort: params.readPort ?? {
      getAccountSnapshot: async () => {
        if (params.account === undefined) {
          throw new Error('测试未配置账户事实');
        }

        return params.account;
      },
      getStockPositions: async () => params.positions ?? [],
    },
    scheduler: { schedule: queueMicrotask },
    reportFatalError:
      params.reportFatalError ??
      ((error) => {
        throw error;
      }),
    dayEpoch: params.dayEpoch ?? 0,
  });
}

/** 用真实 owner 初始化指定事实；字段是否初始化由真实请求决定，不以空数组代替未初始化。 */
export async function createSnapshotFixture(
  params: {
    readonly account?: AccountSnapshot;
    readonly positions?: ReadonlyArray<Position>;
    readonly dayEpoch?: number;
    readonly readPort?: SnapshotReadPort;
    readonly reportFatalError?: (error: unknown) => void;
  } = {},
): Promise<AccountPositionSnapshot> {
  const snapshot = createEmptySnapshotFixture(params);
  if (params.account !== undefined || params.positions !== undefined) {
    const receipt = await snapshot.requestRefresh({
      source: 'TEST_SETUP',
      dayEpoch: snapshot.getView().token.dayEpoch,
      refreshAccount: params.account !== undefined,
      refreshPositions: params.positions !== undefined,
    }).result;
    if (receipt.status !== 'COMMITTED') {
      throw new Error('测试快照初始化被取消');
    }
  }

  return snapshot;
}

/** 已就绪的窄 settlement reader；仍校验真实 snapshot token，不伪造 Promise<void> freshness。 */
export function createSettlementFreshnessFixture(
  snapshot: AccountPositionSnapshotReader,
): SettlementFreshnessReader {
  const isSnapshotReady = (receipt: SettlementReadinessReceipt): boolean =>
    receipt.settlementVersion === 0 &&
    snapshot.isCurrent(receipt.snapshotToken, {
      account: true,
      positions: true,
      paired: true,
    });
  return {
    waitForFresh: async () => {
      const receipt: SettlementReadinessReceipt = {
        snapshotToken: snapshot.getView().token,
        settlementVersion: 0,
        ready: true,
      };
      if (!isSnapshotReady(receipt)) {
        throw new Error('测试尚未发布成对 canonical 基线');
      }

      return receipt;
    },
    isCurrent: isSnapshotReady,
    onFreshReached: () => () => {},
  };
}
