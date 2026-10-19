import type { AccountSnapshot, Position } from './account.js';

/** 本地事实身份；所有异步消费者必须同时比较 epoch、代次及所需组件。 */
export type SnapshotToken = {
  readonly dayEpoch: number;
  readonly snapshotGeneration: number;
  readonly commitRevision: number;
  readonly accountRevision: number;
  readonly positionRevision: number;
  readonly pairedRevision: number;
};

/** 读取所依赖的组件；成对读取不冒充券商远端原子快照。 */
type SnapshotComponents = {
  readonly account: boolean;
  readonly positions: boolean;
  readonly paired?: boolean;
};

/** 深度不可变权威事实，初始化与有效性分别表达，不由空数组推断。 */
export type AccountPositionSnapshotView = {
  readonly token: SnapshotToken;
  readonly account: AccountSnapshot | null;
  readonly positions: ReadonlyArray<Position>;
  readonly accountInitialized: boolean;
  readonly positionsInitialized: boolean;
  readonly accountValid: boolean;
  readonly positionsValid: boolean;
};

/** 独立参与者的刷新请求；只有未发出批次可以合并。 */
export type SnapshotRefreshRequest = {
  readonly source: string;
  readonly dayEpoch: number;
  readonly refreshAccount: boolean;
  readonly refreshPositions: boolean;
};

/** 外部仅能收到合法提交或生命周期取消，过期结果由 owner 内部重新排队。 */
export type SnapshotRefreshReceipt =
  | {
      readonly status: 'COMMITTED';
      readonly snapshotToken: SnapshotToken;
      readonly view: AccountPositionSnapshotView;
    }
  | { readonly status: 'ABORTED' };

/** 参与者取消不取消共享批次或券商 IO。 */
export type SnapshotRefreshHandle = {
  readonly result: Promise<SnapshotRefreshReceipt>;
  readonly cancel: () => void;

  /** 仅取消本参与者尚未进入真实issued批的排队请求；已issued结果仍交原参与者收口。 */
  readonly cancelIfNotIssued: () => void;
};

/** 日切/终止清理请求；日切 epoch 由生命周期指定，重入不重复推进。 */
type SnapshotClearRequest = {
  readonly reason: 'DAY_CUT' | 'STOP';
  readonly dayEpoch: number;
};

/** 用于诊断和 drain 的单 owner 状态，不暴露内部集合。 */
type SnapshotCommitStatus = {
  readonly admission: 'OPEN' | 'REBUILD' | 'CLOSED';
  readonly token: SnapshotToken;
};

/** broker 保真读取能力；金融文本与安全整数数量在 adapter 校验。 */
export interface SnapshotReadPort {
  getAccountSnapshot: () => Promise<AccountSnapshot>;
  getStockPositions: () => Promise<ReadonlyArray<Position>>;
}

/** 所有业务消费者仅拥有不可变读取能力。 */
export interface AccountPositionSnapshotReader {
  getView: () => AccountPositionSnapshotView;
  getAvailablePosition: (symbol: string) => Position | null;
  isCurrent: (token: SnapshotToken, components: SnapshotComponents) => boolean;
  getStatus: () => SnapshotCommitStatus;
}

/** 由唯一 snapshot owner 执行的刷新参与能力；不公开独立 commit 或第二份 snapshot。 */
interface AccountPositionSnapshotRefresh {
  readonly requestRefresh: (request: SnapshotRefreshRequest) => SnapshotRefreshHandle;
}

/** 同一 canonical snapshot 的失效、重建、关门及 drain 能力；消费方只取实际方法。 */
interface AccountPositionSnapshotLifecycle {
  readonly invalidate: () => void;

  readonly invalidateAccount: () => void;

  /** 仅等待调用时真正已发 IO 落定，不关门/失效、不把 participant cancel 当作 drain。 */
  readonly waitForIssuedDrain: () => Promise<void>;

  /** 同步关闭普通请求并推进读取代次，仅接受 LIFECYCLE_REBUILD source。 */
  readonly beginRebuild: () => void;

  /** 同步失效与取消先于返回；Promise 仅在全部已发 broker IO settled 后完成。 */
  readonly requestClear: (request: SnapshotClearRequest) => Promise<void>;

  readonly openAdmission: () => void;
}

/** 唯一 canonical owner 的完整产物；读取、刷新与生命周期能力全部引用同一实例。 */
export interface AccountPositionSnapshot
  extends
    AccountPositionSnapshotReader,
    AccountPositionSnapshotRefresh,
    AccountPositionSnapshotLifecycle {}
