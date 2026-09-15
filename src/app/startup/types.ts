import type { PreparedStrategy } from '../../core/strategy/types.js';

/** composition root 或离线 fixture 注入的文件元信息端口。 */
export interface StrategyFileStatus {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

/** 加载依赖；文件路径为绝对路径，importModule 只接收 file URL。 */
export interface StrategyFileSystem {
  readonly readDirectory: (path: string) => Promise<ReadonlyArray<string>>;
  readonly lstat: (path: string) => Promise<StrategyFileStatus>;
  readonly realpath: (path: string) => Promise<string>;
  readonly importModule: (href: string) => Promise<unknown>;
}

/** loaderModuleHref 仅用于离线工程替换模块位置，不能来自 env/cwd。 */
export type PrepareStrategyDeps = StrategyFileSystem & {
  readonly loaderModuleHref?: string;
};

/** 唯一 env 快照；准备层不自行读取 process.env。 */
export type PrepareStrategyParams = {
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** 选中策略的准备结果；不含实例或未选定义。 */
export type PreparedStrategySelection = {
  readonly strategyId: string;
  readonly prepared: PreparedStrategy;
};

/** 元信息验证后的单个策略位置，不缓存配置或模块。 */
export type StrategyLocation = {
  readonly strategyId: string;
  readonly definitionPath: string;
};
