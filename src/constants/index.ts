/**
 * 全局常量模块
 *
 * 统一管理项目中使用的所有常量，包括：
 * - 时间相关：毫秒换算、时区偏移
 * - 交易相关：目标金额、K线配置、主循环间隔
 * - 验证相关：信号去抖与冷却配置
 * - 日志相关：流超时配置
 * - API相关：重试策略、缓存TTL、频率限制
 * - 监控相关：价格/指标变化检测阈值
 * - 指标缓存相关：计算缓存、时序缓存配置
 * - 信号相关：交易信号类型定义
 */
import { FilterWarrantExpiryDate, OrderStatus, OrderType, Period } from 'longbridge';
import type { OrderTypeConfig, SignalType } from '../types/signal.js';

/** 时间相关常量 */
export const TIME = {
  /** 每秒的毫秒数 */
  MILLISECONDS_PER_SECOND: 1000,

  /** 每分钟的毫秒数 */
  MILLISECONDS_PER_MINUTE: 60 * 1000,

  /** 每日的毫秒数 */
  MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,

  /** 香港时区偏移量（毫秒），用于 UTC 转香港时间 */
  HONG_KONG_TIMEZONE_OFFSET_MS: 8 * 60 * 60 * 1000,
} as const;

/** 运行时环境变量与档位常量 */
export const RUNTIME = {
  /** 环境变量：运行时档位（app/test） */
  PROFILE_ENV_KEY: 'APP_RUNTIME_PROFILE',

  /** 环境变量：日志根目录 */
  LOG_ROOT_DIR_ENV_KEY: 'APP_LOG_ROOT_DIR',

  /** 环境变量：是否安装进程级钩子 */
  ENABLE_PROCESS_HOOKS_ENV_KEY: 'APP_ENABLE_PROCESS_HOOKS',

  /** 正常运行档位 */
  APP_PROFILE: 'app',

  /** 测试运行档位 */
  TEST_PROFILE: 'test',
} as const;

/** 港股日期键格式正则（YYYY-MM-DD），用于解析与校验 */
export const HK_DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 交易相关常量 */
export const TRADING = {
  /** 默认目标金额（港币），单次开仓的目标市值 */
  DEFAULT_TARGET_NOTIONAL: 10000,

  /** 默认单实例最大持仓市值（港币） */
  DEFAULT_MAX_POSITION_NOTIONAL: 100000,

  /** 默认单实例最大浮亏（港币，0 表示关闭） */
  DEFAULT_MAX_UNREALIZED_LOSS: 0,

  /** 默认买入间隔（秒） */
  DEFAULT_BUY_INTERVAL_SECONDS: 60,

  /** 默认保护性清仓触发次数上限 */
  DEFAULT_LIQUIDATION_TRIGGER_LIMIT: 1,

  /** 默认订单价格修改最小间隔（秒） */
  DEFAULT_ORDER_MONITOR_PRICE_UPDATE_INTERVAL: 5,

  /** 默认订单超时时间（秒） */
  DEFAULT_ORDER_TIMEOUT_SECONDS: 180,

  /** 基础对象直连订阅周期（阶段 2 固定：1m/5m/15m） */
  CANDLE_PERIODS: [Period.Min_1, Period.Min_5, Period.Min_15] as const,

  /** 因子运行主周期（TrendFactorRuntime 当前按 1m 样本计算） */
  FACTOR_CANDLE_PERIOD: Period.Min_1,

  /** K线缓存上限（1m）：覆盖约 20 个交易日同 session 波动率分位基线 */
  CANDLE_COUNT: 7_000,

  /** 主循环执行间隔（毫秒），mainProgram 的执行频率 */
  INTERVAL_MS: 1000,

  /** 默认订单备注（提交订单时写入，便于排查） */
  DEFAULT_ORDER_REMARK: 'QuantDemo',

  /** 保护性清仓订单备注后缀（用于重启恢复时识别订单语义） */
  PROTECTIVE_LIQUIDATION_REMARK_SUFFIX: '|PL',

  /** 保护性清仓业务事件完成日志原因（用于冷却恢复） */
  PROTECTIVE_LIQUIDATION_COMPLETED_REASON: 'PROTECTIVE_LIQUIDATION_COMPLETED',
} as const;

/** 单实例趋势延续策略默认值与固定 preset。 */
export const STRATEGY = {
  /** 固定基础对象 preset */
  BASE_INSTRUMENT_SYMBOL: 'HSI.HK',

  /** 默认席位模式 */
  DEFAULT_SEAT_MODE: 'static',

  /** 自动寻标默认值 */
  AUTO_SEARCH: {
    minDistancePctBull: 0.8,
    minDistancePctBear: -0.8,
    minTurnoverPerMinuteBull: 300_000,
    minTurnoverPerMinuteBear: 300_000,
    expiryMinMonths: 6,
    openDelayMinutes: 5,
    switchIntervalMinutes: 0,
    switchDistanceRangeBull: {
      min: 0.6,
      max: 1.5,
    },
    switchDistanceRangeBear: {
      min: -1.5,
      max: -0.6,
    },
  } as const,

  /** 波动率状态默认值 */
  REGIME_THRESHOLDS: {
    atrShortPeriod: 5,
    atrLongPeriod: 30,
    rvQuantileWindowDays: 20,
    trendOnVolExpansion: 1.2,
    trendOffVolExpansion: 0.9,
    extremeVolExpansion: 1.8,
    trendOnVolQuantile: 0.7,
    trendOffVolQuantile: 0.4,
    extremeVolQuantile: 0.95,
  } as const,

  /** 趋势评分默认值 */
  TREND_SCORE_THRESHOLDS: {
    w15: 0.25,
    w30: 0.35,
    w60: 0.4,
    classificationThreshold: 0.8,
    entryThreshold: 0.9,
    exitThreshold: 0.35,
    reverseInvalidationThreshold: 0.5,
  } as const,

  /** ER 默认值 */
  ER_THRESHOLDS: {
    er15EntryMin: 0.4,
    er30EntryMin: 0.35,
    er15ExitMax: 0.25,
    er30ExitMax: 0.2,
    strongTrendErFloor: 0.45,
  } as const,

  /** VWAP 确认默认值 */
  VWAP_CONFIRM_RULES: {
    distanceBandAtr: 0.1,
    slopeWindowBars: 5,
    maxCrossCountLast10m: 2,
  } as const,

  /** 开盘结构默认值 */
  OPENING_STRUCTURE_RULES: {
    openingRangeMinutes: 20,
    breakoutScoreMin: 0.8,
    outsidePersistenceWindowBars: 5,
    outsidePersistenceMin: 0.6,
    retestToleranceAtr: 0.2,
    confirmBars: 2,
    morningNoiseWindowMinutes: 20,
    afternoonNoiseWindowMinutes: 15,
  } as const,

  /** 午后延续默认值 */
  PM_CONTINUATION_RULES: {
    amMoveZMin: 0.8,
    middayHoldMin: 0.6,
    pmReExpansionTrendScoreMin: 0.9,
    pmReExpansionEr15Min: 0.35,
    pmConfirmCutoffTime: '13:30',
  } as const,

  /** 交易标的适配默认值 */
  INSTRUMENT_ADAPTATION_RULES: {
    bullBuyMinDistancePct: 0.35,
    bearBuyMaxDistancePct: -0.35,
    bullLiquidationDistancePct: 0.3,
    bearLiquidationDistancePct: -0.3,
  } as const,
} as const;

/** 自动寻标相关常量 */
export const AUTO_SYMBOL_SEARCH_COOLDOWN_MS = 600_000;
export const AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS = 3_000;

/** 自动寻标当日最大失败次数（达到后冻结席位至次日） */
export const AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY = 3;

/** 生命周期重建相关常量 */
export const LIFECYCLE = {
  /** 开盘重建失败后首次重试间隔（毫秒） */
  DEFAULT_REBUILD_RETRY_DELAY_MS: 30_000,

  /** 指数退避最大倍数，避免重试间隔无限增大 */
  MAX_RETRY_BACKOFF_FACTOR: 16,

  /** 交易日历预热向前看天数（需求窗口右边界） */
  CALENDAR_PREWARM_LOOKAHEAD_DAYS: 7,

  /** 交易日历预热固定回看天数 */
  CALENDAR_PREWARM_FALLBACK_LOOKBACK_DAYS: 14,

  /** 交易日历接口最大回看天数（超出则抛错阻断重建） */
  CALENDAR_API_MAX_LOOKBACK_DAYS: 365,
} as const;

/** 信号去抖与冷却相关常量。 */
export const VERIFICATION = {
  /** 验证通过信号冷却时间（秒），同标的同方向在此时间内只允许一个信号进入风险检查 */
  VERIFIED_SIGNAL_COOLDOWN_SECONDS: 10,
} as const;

/** 日志相关常量，用于 pino 日志系统 */
export const LOGGING = {
  /** 文件流 drain 超时时间（毫秒），程序退出时等待日志写入 */
  DRAIN_TIMEOUT_MS: 5000,

  /** 控制台流 drain 超时时间（毫秒） */
  CONSOLE_DRAIN_TIMEOUT_MS: 3000,

  /** 按日期分文件的日志最多保留文件数（system 与 debug 子目录各自限制） */
  MAX_RETAINED_LOG_FILES: 7,
} as const;

/** 日志级别常量（pino 自定义级别：DEBUG=20, INFO=30, WARN=40, ERROR=50） */
export const LOG_LEVELS = {
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
} as const;

/** 日志 ANSI 颜色常量（用于控制台高亮） */
export const LOG_COLORS = {
  reset: '\u001B[0m',
  yellow: '\u001B[33m',
  red: '\u001B[31m',
  gray: '\u001B[90m',
  green: '\u001B[32m',
  cyan: '\u001B[96m',
} as const;

/** ANSI 转义字符（ESC，ASCII 27） */
const LOG_ANSI_ESC = String.fromCodePoint(27);

/** ANSI 颜色代码正则（ESC[...m） */
export const LOG_ANSI_CODE_REGEX = new RegExp(LOG_ANSI_ESC + String.raw`\[[0-9;]*m`, 'g');

/** 是否为调试模式（环境变量 DEBUG=true 时启用） */
export const IS_DEBUG = process.env['DEBUG'] === 'true';

/** API 相关常量，用于 Longbridge API 调用 */
export const API = {
  /** 默认重试次数，API 调用失败时的重试上限 */
  DEFAULT_RETRY_COUNT: 2,

  /** 默认重试延迟（毫秒） */
  DEFAULT_RETRY_DELAY_MS: 300,

  /** 交易日缓存 TTL（毫秒），避免频繁查询交易日历 */
  TRADING_DAY_CACHE_TTL_MS: 24 * 60 * 60 * 1000,

  /** 未成交订单缓存 TTL（毫秒） */
  PENDING_ORDERS_CACHE_TTL_MS: 30_000,

  /** 频率限制缓冲时间（毫秒），用于时间窗口边界的安全余量 */
  RATE_LIMIT_BUFFER_MS: 100,

  /** 两次 API 调用最小间隔（毫秒），API 要求 20ms，加 10ms 缓冲 */
  MIN_CALL_INTERVAL_MS: 30,
} as const;

/** 指标缓存相关常量 */
export const INDICATOR_CACHE = {
  /** 指标计算缓存 TTL（毫秒） */
  CALCULATION_TTL_MS: 5_000,

  /** 指标计算最大缓存条目数（防止内存泄漏） */
  CALCULATION_MAX_SIZE: 50,

  /** 指标时序缓存默认最大条目数（环形缓冲区） */
  TIMESERIES_DEFAULT_MAX_ENTRIES: 100,
} as const;

/** 行情监控相关常量，用于 MarketMonitor 检测价格/指标变化 */
export const MONITOR = {
  /** 价格变化检测阈值，低于此值不触发更新 */
  PRICE_CHANGE_THRESHOLD: 0.001,

  /** 技术指标变化检测阈值（EMA/RSI/MFI/KDJ/MACD） */
  INDICATOR_CHANGE_THRESHOLD: 0.001,

  /** 涨跌幅变化检测阈值（百分比） */
  CHANGE_PERCENT_THRESHOLD: 0.01,
} as const;

/** 订单相关常量 */
export const ORDER_PRICE_DIFF_THRESHOLD = 0.001;

/** 订单路径行情重试统一参数 */
export const ORDER_QUOTE_RETRY = {
  /** 行情未就绪时的重试间隔（毫秒） */
  INTERVAL_MS: 2 * TIME.MILLISECONDS_PER_SECOND,

  /** 行情未就绪时的最大重试次数 */
  MAX_ATTEMPTS: 5,
} as const;

/** 配置字符串到 OpenAPI 订单类型的映射 */
export const ORDER_TYPE_CONFIG_TO_OPEN_API: Readonly<Record<OrderTypeConfig, OrderType>> = {
  LO: OrderType.LO,
  ELO: OrderType.ELO,
  MO: OrderType.MO,
};

/** OpenAPI 订单类型到配置字符串的映射（仅支持 LO/ELO/MO） */
export const OPEN_API_ORDER_TYPE_TO_CONFIG: Readonly<Partial<Record<OrderType, OrderTypeConfig>>> =
  {
    [OrderType.LO]: 'LO',
    [OrderType.ELO]: 'ELO',
    [OrderType.MO]: 'MO',
  };

/** 订单类型显示文本映射 */
export const ORDER_TYPE_LABEL_MAP: ReadonlyMap<OrderType, string> = new Map([
  [OrderType.LO, '限价单'],
  [OrderType.ELO, '增强限价单'],
  [OrderType.MO, '市价单'],
  [OrderType.ALO, '竞价限价单'],
  [OrderType.SLO, '特别限价单'],
]);

/** 订单类型代码映射 */
export const ORDER_TYPE_CODE_MAP: ReadonlyMap<OrderType, string> = new Map([
  [OrderType.LO, 'LO'],
  [OrderType.ELO, 'ELO'],
  [OrderType.MO, 'MO'],
  [OrderType.ALO, 'ALO'],
  [OrderType.SLO, 'SLO'],
]);

/** 未成交订单状态集合（New/PartialFilled/WaitToNew/WaitToReplace/PendingReplace/Replaced/WaitToCancel/PendingCancel） */
export const PENDING_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.New,
  OrderStatus.PartialFilled,
  OrderStatus.WaitToNew,
  OrderStatus.WaitToReplace,
  OrderStatus.PendingReplace,
  OrderStatus.Replaced,
  OrderStatus.WaitToCancel,
  OrderStatus.PendingCancel,
]) as ReadonlySet<OrderStatus>;

/** 不可改单的订单状态集合（包含改单中与撤单中状态） */
export const NON_REPLACEABLE_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.WaitToReplace,
  OrderStatus.PendingReplace,
  OrderStatus.WaitToCancel,
  OrderStatus.PendingCancel,
]) as ReadonlySet<OrderStatus>;

/** 不可改单的订单类型集合（MO 市价单不支持改单） */
export const NON_REPLACEABLE_ORDER_TYPES = new Set<OrderType>([
  OrderType.MO,
]) as ReadonlySet<OrderType>;

/** 风险检查相关常量（牛熊证） */
/** 牛证最低距离回收价百分比（低于此值拒绝买入） */
export const BULL_WARRANT_MIN_DISTANCE_PERCENT = 0.35;

/** 熊证最高距离回收价百分比（高于此值拒绝买入） */
export const BEAR_WARRANT_MAX_DISTANCE_PERCENT = -0.35;

/** 牛证触发清仓的距离回收价百分比（低于此值触发保护清仓） */
export const BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT = 0.3;

/** 熊证触发清仓的距离回收价百分比（高于此值触发保护清仓） */
export const BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT = -0.3;

/** 监控标的价格最小有效值（低于此值视为异常） */
export const MIN_MONITOR_PRICE_THRESHOLD = 1;

/** 价格格式化小数位数 */
export const DEFAULT_PRICE_DECIMALS = 3;

/** orderMonitor 改单临时阻塞（602013）重试退避序列（毫秒） */
export const ORDER_MONITOR_REPLACE_TEMP_BLOCK_BACKOFF_MS = [1000, 2000, 4000, 8000] as const;

/** orderMonitor 撤单重试退避：基础间隔（毫秒） */
export const ORDER_MONITOR_CANCEL_RETRY_BASE_DELAY_MS = 1000;

/** orderMonitor 撤单重试退避：最大间隔（毫秒） */
export const ORDER_MONITOR_CANCEL_RETRY_MAX_DELAY_MS = 30_000;

/** orderMonitor WAIT_WS_ONLY 模式阻塞时间（等同“无限等待 WS”） */
export const ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS = Number.MAX_SAFE_INTEGER;

/**
 * Longbridge API 错误码常量（订单监控使用）
 *
 * 订单关闭/状态未知类业务错误码:
 * - 601011: Order has been cancelled (订单已撤销)
 * - 601012: Order has been filled (订单已成交)
 * - 601013: Order has been rejected (订单已拒绝)
 * - 603001: Order not found (订单不存在，需要再做 orderDetail 权威确认)
 */
export const ORDER_CLOSED_ERROR_CODE_SET = new Set(['601011', '601012', '601013', '603001']);

/**
 * 不支持改单（订单类型不支持）错误码:
 * - 602012: Order amendment is not supported for this order type
 */
export const REPLACE_UNSUPPORTED_BY_TYPE_ERROR_CODE_SET = new Set(['602012']);

/**
 * 不支持改单（订单状态暂不允许）错误码:
 * - 602013: Order status does not allow amendment
 */
export const REPLACE_TEMP_BLOCKED_BY_STATUS_ERROR_CODE_SET = new Set(['602013']);

/** 百分比格式化小数位数 */
export const DEFAULT_PERCENT_DECIMALS = 2;

/** 牛熊证距离回收价清仓订单类型 */
export const WARRANT_LIQUIDATION_ORDER_TYPE: OrderTypeConfig = 'ELO';

/** 标的代码格式正则（ticker.region） */
export const SYMBOL_WITH_REGION_REGEX = /^[A-Z0-9]+\.[A-Z]{2,5}$/;

/** 账户渠道映射表 */
export const ACCOUNT_CHANNEL_MAP: Record<string, string> = {
  lb_papertrading: '模拟交易',
  paper_trading: '模拟交易',
  papertrading: '模拟交易',
  real_trading: '实盘交易',
  realtrading: '实盘交易',
  live: '实盘交易',
  demo: '模拟交易',
};

/** 有效的交易信号集合，不包含 HOLD（仅用于判断是否需要执行交易） */
export const STRATEGY_ACTIONS: ReadonlyArray<Exclude<SignalType, 'HOLD'>> = [
  'BUYCALL',
  'SELLCALL',
  'BUYPUT',
  'SELLPUT',
] as const;

/** 有效的交易信号集合，不包含 HOLD（仅用于判断是否需要执行交易） */
export const VALID_SIGNAL_ACTIONS = new Set<SignalType>(STRATEGY_ACTIONS);

/** 信号操作描述映射，用于日志输出 */
export const ACTION_DESCRIPTIONS: Record<SignalType, string> = {
  BUYCALL: '买入做多',
  BUYPUT: '买入做空',
  SELLCALL: '卖出做多',
  SELLPUT: '卖出做空',
  HOLD: '持有',
};

/** 信号操作详细描述映射，用于执行链路日志 */
export const SIGNAL_ACTION_DESCRIPTIONS: Record<SignalType, string> = {
  BUYCALL: '买入做多标的（做多）',
  SELLCALL: '卖出做多标的（平仓）',
  BUYPUT: '买入做空标的（做空）',
  SELLPUT: '卖出做空标的（平仓）',
  HOLD: '持有',
};

/** 轮证类型中文名称映射 */
export const WARRANT_TYPE_NAMES: Readonly<Record<'BULL' | 'BEAR', string>> = {
  BULL: '牛证',
  BEAR: '熊证',
};

/** 自动寻标默认到期日筛选条件 */
export const EXPIRY_DATE_FILTERS: ReadonlyArray<FilterWarrantExpiryDate> = [
  FilterWarrantExpiryDate.Between_3_6,
  FilterWarrantExpiryDate.Between_6_12,
  FilterWarrantExpiryDate.GT_12,
];

/** 订单归属解析常量（标准化规则 + 多空标记） */
export const ORDER_OWNERSHIP = {
  NORMALIZE_PATTERN: /[^\p{L}\p{N}]/gu,
  LONG_MARKERS: ['RC', 'BULL', 'CALL', '\u725B'],
  SHORT_MARKERS: ['RP', 'BEAR', 'PUT', '\u718A'],
} as const;
