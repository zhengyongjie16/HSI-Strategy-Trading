import type { MarketWarrantListItem } from '../../../types/marketPorts.js';

/**
 * 单方向候选筛选策略。
 * 数据来源：主阈值、换标安全区间与分均成交额配置，经纯规则校验后生成。
 * 使用范围：启动补席、运行期空席位寻标和换标预寻标；所有金融字段均为精确十进制文本。
 */
export type DirectionalAutoSearchPolicy = {
  readonly direction: 'LONG' | 'SHORT';

  /** 内部百分比值口径，0.35 表示 0.35%。 */
  readonly primaryThreshold: string;
  readonly minTurnoverPerMinute: string;

  /** 降级带为开区间，主阈值及危险侧安全边界均不入选。 */
  readonly degradedRange: Readonly<{ min: string; max: string }>;

  /** 完整换标安全区间；两端相等触发换标，不限制主层候选的安全侧上限。 */
  readonly switchDistanceRange: Readonly<{ min: string; max: string }>;
};

/**
 * 构造候选筛选策略的最小金融配置。
 * 数据来源：application 按方向提取配置；缺失字段明确返回业务拒绝，非法金融文本直接抛出。
 * 使用范围：warrantSelection 纯策略构造边界，不读取配置、时钟或 logger。
 */
export type ResolveWarrantSelectionPolicyInput = Readonly<{
  direction: 'LONG' | 'SHORT';
  primaryThreshold: string | null;
  minTurnoverPerMinute: string | null;
  switchDistanceRange: Readonly<{ min: string; max: string }> | null;
}>;

/**
 * 候选策略构造结果。
 * 数据来源：主阈值必须严格位于安全区间内的领域不变量检查。
 * 使用范围：application 为业务拒绝添加入口日志；不将非法金融文本吞为无候选。
 */
export type WarrantSelectionPolicyResult =
  | Readonly<{ success: true; policy: DirectionalAutoSearchPolicy }>
  | Readonly<{ success: false; reason: string }>;

/**
 * 双层筛选的事实输入。
 * 数据来源：market adapter 按方向、界内条件和到期范围查询后的中性列表事实。
 * 使用范围：纯候选筛选；仅 status 正常、身份与金融字段有效的行可进入距离分层。
 */
export type SelectBestWarrantInput = Readonly<{
  warrants: ReadonlyArray<
    Pick<MarketWarrantListItem, 'symbol' | 'callPrice' | 'toCallPrice' | 'turnover' | 'status'>
  >;
  tradingMinutes: number;
  policy: DirectionalAutoSearchPolicy;
}>;

/** 候选命中阶段，由双层开区间筛选生成，供日志和入口决策使用。 */
export type WarrantSelectionStage = 'PRIMARY' | 'DEGRADED';

/**
 * 通过基础准入的内部候选快照。
 * 数据来源：SDK 小数距离比值乘 100 后的精确百分比文本，以及原始成交额和交易分钟数。
 * 使用范围：仅 warrantSelection；不保存近似分均成交额用于比较。
 */
export type EvaluatedWarrantCandidate = Readonly<{
  symbol: string;
  callPrice: string;
  distancePct: string;
  turnover: string;
  tradingMinutes: string;
}>;

/** 候选分层后保留的精确排序依据，仅供 warrantSelection 内部选优。 */
export type RankedWarrantCandidate = EvaluatedWarrantCandidate &
  Readonly<{
    selectionStage: WarrantSelectionStage;
    distanceDeltaToThreshold: string;
  }>;

/**
 * 自动寻标候选。
 * 数据来源：纯规则按距主阈值的精确差值优先、原成交额/分钟数比率次之选出。
 * 使用范围：三条寻标链路；turnoverPerMinute 仅为零位 half-even 日志投影，不回流判断。
 */
export type WarrantCandidate = Readonly<{
  symbol: string;
  callPrice: string;
  distancePct: string;
  turnoverPerMinute: string;
  selectionStage: WarrantSelectionStage;
  distanceDeltaToThreshold: string;
}>;

/** 双层筛选结果与命中数量，由纯规则生成，供 application 日志和测试使用。 */
export type WarrantSelectionResult = Readonly<{
  candidate: WarrantCandidate | null;
  primaryCandidateCount: number;
  degradedCandidateCount: number;
}>;
