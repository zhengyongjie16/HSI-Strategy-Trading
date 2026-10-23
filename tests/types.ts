/** 主入口原生环境测试的单次隔离场景；环境覆盖值为 undefined 时从子进程环境中移除该键。 */
export type IndexEnvironmentScenario = {
  readonly files?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly flags?: ReadonlyArray<string>;
  readonly launch?: 'direct' | 'external-env-file' | 'external-cwd' | 'package-start';
};

/** mock runApp 回传的入口观测；只包含合成哨兵、公开键名及契约结果。 */
export type IndexEnvironmentProbe = {
  readonly calls: number;
  readonly envIdentity: boolean;
  readonly isDebug: boolean;
  readonly debug: string | null;
  readonly nodeEnv: string | null;
  readonly sentinels: Readonly<Record<string, string>>;
  readonly templateMismatchedKeys: ReadonlyArray<string>;
};
