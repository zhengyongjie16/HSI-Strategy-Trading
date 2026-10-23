/**
 * 全局常量模块
 *
 * 统一管理项目中使用的所有常量，包括：
 * - 时间相关：毫秒换算、时区偏移
 * - 交易相关：目标金额、K线配置、时间唤醒恢复间隔
 * - 验证相关：延迟信号验证的时间窗口配置
 * - 日志相关：流超时配置
 * - API相关：重试策略、缓存TTL、频率限制
 * - 监控相关：价格/指标变化检测阈值
 * - 指标缓存相关：计算缓存、时序缓存配置
 * - 信号相关：交易信号类型定义
 */
import type { OrderTypeConfig, SignalType } from '../types/signal.js';
import type { MarketWarrantExpiryRange } from '../types/marketPorts.js';

/** 时间相关常量 */
export const TIME = {
  /** 每秒的毫秒数 */
  MILLISECONDS_PER_SECOND: 1000,

  /** 每分钟的毫秒数 */
  MILLISECONDS_PER_MINUTE: 60 * 1000,

  /** 每日的毫秒数 */
  MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,

  /** setTimeout 可安全接收的最大延迟（毫秒） */
  MAX_TIMER_DELAY_MS: 2_147_483_647,

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
  /** K线周期，用于订阅和获取实时K线数据 */
  CANDLE_PERIOD: 'MIN_1',

  /** K线数量，获取的实时K线条数 */
  CANDLE_COUNT: 200,

  /** 时间唤醒评估异常后的恢复重试间隔（毫秒） */
  INTERVAL_MS: 1000,

  /** 默认订单备注（提交订单时写入，便于排查） */
  DEFAULT_ORDER_REMARK: 'QuantDemo',

  /** 保护性清仓订单备注后缀（用于重启恢复时识别订单语义） */
  PROTECTIVE_LIQUIDATION_REMARK_SUFFIX: '|PL',

  /** 保护性清仓业务事件完成日志原因（用于冷却恢复） */
} as const;

/** 自动寻标相关常量 */
export const AUTO_SYMBOL_SEARCH_COOLDOWN_MS = 600_000;
export const AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS = 3_000;

/** 自动寻标当日最大失败次数（达到后冻结席位至次日） */
export const AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY = 3;

/** 末日保护相关常量 */
export const DOOMSDAY = {
  /** 买入截止窗口：距离收盘前的分钟数 */
  BUY_CUTOFF_MINUTES_BEFORE_CLOSE: 15,

  /** 清仓接管窗口：距离收盘前的分钟数 */
  CLEARANCE_TAKEOVER_MINUTES_BEFORE_CLOSE: 5,
} as const;

/** 生命周期重建相关常量 */
export const LIFECYCLE = {
  /** 开盘重建失败后首次重试间隔（毫秒） */
  DEFAULT_REBUILD_RETRY_DELAY_MS: 30_000,

  /** 指数退避最大倍数，避免重试间隔无限增大 */
  MAX_RETRY_BACKOFF_FACTOR: 16,

  /** 交易日历预热向前看天数（需求窗口右边界） */
  CALENDAR_PREWARM_LOOKAHEAD_DAYS: 7,

  /** 交易日历预热无仍持仓时的默认回看天数 */
  CALENDAR_PREWARM_DEFAULT_LOOKBACK_DAYS: 14,

  /** 交易日历接口最大回看天数（超出则抛错阻断重建） */
  CALENDAR_API_MAX_LOOKBACK_DAYS: 365,
} as const;

/** 买入风险检查入口的同标的共用限流窗口，不属于策略验证政策。 */
export const BUY_RISK_CHECK_COOLDOWN_MS = 10_000;

/** 交易持久化相关常量 */
export const TRADE_PERSISTENCE = {
  /** 相对工作目录的固定交易持久化目录 */
  RELATIVE_DIR: 'data/trades',

  /** 按香港交易日分文件，最多保留最新日文件数 */
  MAX_RETAINED_DAILY_FILES: 7,
} as const;

/** 文本日志流与关闭协议常量 */
export const LOGGING = {
  /** 运行期文件流 drain 超时时间（毫秒） */
  DRAIN_TIMEOUT_MS: 5000,

  /** 运行期控制台流 drain 超时时间（毫秒） */
  CONSOLE_DRAIN_TIMEOUT_MS: 3000,

  /** 从首次 shutdown 开始计算的单个关闭总超时（毫秒） */
  SHUTDOWN_TIMEOUT_MS: 5000,

  /** 按日期分文件的日志最多保留文件数（system 与 debug 子目录各自限制） */
  MAX_RETAINED_LOG_FILES: 7,
} as const;

/** 日志级别数值，供文本路由与内部记录使用。 */
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

/** 订单相关常量 */
export const ORDER_PRICE_DIFF_THRESHOLD = '0.001';

/** 订单路径行情重试统一参数 */
export const ORDER_QUOTE_RETRY = {
  /** 行情未就绪时的重试间隔（毫秒） */
  INTERVAL_MS: 2 * TIME.MILLISECONDS_PER_SECOND,

  /** 行情未就绪时的最大重试次数 */
  MAX_ATTEMPTS: 5,
} as const;

/** 配置解析支持的中性订单类型代码；SDK 映射只由 trade adapter 负责。 */
export const ORDER_TYPE_CONFIG_VALUES: ReadonlySet<string> = new Set<OrderTypeConfig>([
  'LO',
  'ELO',
  'MO',
]);

/** 风险检查相关常量（牛熊证） */
/** 牛证最低距离回收价百分比文本（低于此值拒绝买入） */
export const BULL_WARRANT_MIN_DISTANCE_PERCENT = '0.35';

/** 熊证最高距离回收价百分比文本（高于此值拒绝买入） */
export const BEAR_WARRANT_MAX_DISTANCE_PERCENT = '-0.35';

/** 牛证触发清仓的距离回收价百分比文本（低于或等于此值触发保护清仓） */
export const BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT = '0.3';

/** 熊证触发清仓的距离回收价百分比文本（高于或等于此值触发保护清仓） */
export const BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT = '-0.3';

/** 监控标的价格最小有效值文本（低于此值视为异常） */
export const MIN_MONITOR_PRICE_THRESHOLD = '1';

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

/** 订单 API 暂态状态码：超时、限流和服务端临时不可用 */
export const ORDER_API_TRANSIENT_STATUS_CODE_SET = new Set([
  '408',
  '425',
  '429',
  '500',
  '502',
  '503',
  '504',
]);

/** 订单 API 暂态错误消息关键词 */
export const ORDER_API_RETRYABLE_MESSAGE_HINTS = [
  'network',
  'timeout',
  'timed out',
  'temporarily unavailable',
  'service unavailable',
  'service busy',
  'connection',
  'econnreset',
  'etimedout',
  'rate limit',
] as const;

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
export const EXPIRY_DATE_FILTERS: ReadonlyArray<MarketWarrantExpiryRange> = [
  'MONTHS_3_TO_6',
  'MONTHS_6_TO_12',
  'OVER_12_MONTHS',
];

export const LONG_DIRECTION_NAME = '\u505A\u591A\u6807\u7684';

export const SHORT_DIRECTION_NAME = '\u505A\u7A7A\u6807\u7684';
