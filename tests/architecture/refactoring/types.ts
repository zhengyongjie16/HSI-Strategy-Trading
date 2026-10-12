/** 冻结记录来自 P0.3 仓库外审计，不以目录或总计数替代 occurrence。 */
export type Occurrence = {
  readonly file: string;
  readonly key: string;
  readonly owner: string;
  readonly cutoff: string;
  readonly evidence: string;
  readonly sourcePhysicalDeadline?: string;
  readonly sourcePhysicalStage?: Stage;
};

/** 当前阶段配置由主 agent 在纵切验收后收紧，P0 不冒充未来出口。 */
export type Stage =
  | 'P0'
  | 'P1'
  | 'P2'
  | 'P3A'
  | 'P3B'
  | 'P3C'
  | 'P3D'
  | 'P3E'
  | 'P3F'
  | 'P4.1'
  | 'P4.2'
  | 'P4.3'
  | 'P4.4'
  | 'P4.5'
  | 'P5'
  | 'P6';

/** AST 检查结果以及独立维度的多重集合。 */
export type Scan = {
  readonly imports: ReadonlyArray<string>;
  readonly uses: ReadonlyArray<string>;
  readonly origins: ReadonlyArray<string>;
  readonly tradeContexts: ReadonlyArray<string>;
  readonly legacy: ReadonlyArray<string>;
  readonly snapshot: ReadonlyArray<string>;
  readonly snapshotExposures: ReadonlyArray<string>;
  readonly helperCalls: ReadonlyArray<string>;
  readonly neutralFixtureCalls: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
};

/** P1 固定事实工厂与 readonly 契约检查；不向业务层注入私有 store 能力。 */
export type SnapshotBoundaryScan = {
  readonly owners: ReadonlyArray<string>;
  readonly creations: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
};

/** 审计字段原分类和消费依据，UNKNOWN 不伪装成已完成金融验收。 */
export type AuditedField = {
  readonly file: string;
  readonly parent: string;
  readonly name: string;
  readonly type: string;
  readonly classification: string;
  readonly closure: string;
};

/** 只声明门禁实际消费的 JSON 结构；其他原始审计信息保留供人工导航。 */
export type Baseline = {
  readonly schema: number;
  readonly stage: Stage;
  readonly imports: ReadonlyArray<Occurrence>;
  readonly uses: ReadonlyArray<Occurrence>;
  readonly origins: ReadonlyArray<Occurrence>;
  readonly legacy: ReadonlyArray<Occurrence>;
  readonly legacyObservations: ReadonlyArray<Occurrence>;
  readonly snapshot: ReadonlyArray<Occurrence>;
  readonly snapshotExposures: ReadonlyArray<Occurrence>;
  readonly helperCalls: ReadonlyArray<Occurrence>;
  readonly stagedViolations: ReadonlyArray<Occurrence>;
  readonly fields: ReadonlyArray<AuditedField>;
  readonly numericSites: ReadonlyArray<Occurrence>;
};
