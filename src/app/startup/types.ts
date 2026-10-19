import type { RuntimeSymbolValidationInput } from '../../config/types.js';
import type { Position } from '../../types/account.js';
import type { TradingConfig } from '../../types/config.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { TradingDayInfo } from '../../types/tradingCalendar.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { PreparedStrategy } from '../../types/strategy.js';

/** composition root 或离线 fixture 注入的文件元信息端口。 */
interface StrategyFileStatus {
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

/**
 * 交易日信息解析器依赖。
 * 类型用途：创建交易日解析函数时注入依赖。
 * 数据来源：由 app 启动组装 marketDataClient 与错误回调。
 * 使用范围：仅 app 启动交易日状态初始化使用。
 */
export interface TradingDayInfoResolverDeps {
  readonly marketDataClient: Pick<MarketDataClient, 'isTradingDay'>;
  readonly onResolveError: (err: unknown) => void;
}

/**
 * 交易日信息解析函数签名。
 * 类型用途：统一交易日信息解析函数类型。
 * 数据来源：由 createTradingDayInfoResolver 创建并返回。
 * 使用范围：仅 app 启动交易日状态初始化使用。
 */
export type TradingDayInfoResolver = (currentTime: Date) => Promise<TradingDayInfo>;

/**
 * 运行时标的校验收集器。
 * 类型用途：聚合 requiredSymbols 去重集合和 runtimeValidationInputs 校验输入数组。
 * 数据来源：由 app 运行时标的收集阶段初始化并持续写入。
 * 使用范围：仅 app 装配层运行时校验链路使用。
 */
export type MutableRuntimeValidationCollector = {
  requiredSymbols: Set<string>;
  runtimeValidationInputs: RuntimeSymbolValidationInput[];
};

/**
 * 运行时标的校验收集结果。
 * 类型用途：仅向调用方暴露完成去重后的运行时校验输入。
 * 数据来源：由 collectRuntimeValidationSymbols 返回。
 * 使用范围：仅 app 顶层装配与测试替身使用。
 */
export type RuntimeValidationCollector = Readonly<{
  runtimeValidationInputs: ReadonlyArray<RuntimeSymbolValidationInput>;
}>;

/**
 * 运行时标的校验收集参数。
 * 类型用途：封装 collectRuntimeValidationSymbols 所需的配置、席位注册表与持仓列表。
 * 数据来源：由 app 顶层装配在 startup snapshot 后传入。
 * 使用范围：仅 app 运行时标的校验链路使用。
 */
export type RuntimeValidationCollectionParams = Readonly<{
  tradingConfig: TradingConfig;
  symbolRegistry: SymbolRegistry;
  positions: ReadonlyArray<Position>;
}>;

/**
 * 追加运行时标的校验输入的参数。
 * 类型用途：封装单次 pushRuntimeValidationSymbol 所需字段与收集器引用。
 * 数据来源：由 app 运行时校验收集流程组装。
 * 使用范围：仅 app 装配层运行时校验链路使用。
 */
export type PushRuntimeValidationSymbolParams = Readonly<{
  symbol: string | null;
  label: string;
  requireLotSize: boolean;
  required: boolean;
  collector: MutableRuntimeValidationCollector;
}>;
