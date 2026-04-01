/**
 * 交易记录模块
 *
 * 职责：
 * - 记录交易到 JSON 文件（<logRootDir>/trades/YYYY-MM-DD.json）
 * - 识别错误类型（资金不足、不支持做空、网络错误等）
 *
 * 记录内容：订单ID、标的、方向、数量、价格、状态、原因、时间戳
 */
import { LOGGING } from '../../constants/index.js';
import { retainLatestLogFiles } from '../../utils/logger/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import { getHKDateKey, toHongKongTimeIso } from '../../utils/time/index.js';
import { isRecord } from '../../utils/helpers/index.js';
import type { TradeRecord } from '../../types/trader.js';
import type {
  ErrorTypeIdentifier,
  TradeLoggerRuntime,
  TradeLoggerRuntimeDeps,
  TradeLoggerRuntimeFactoryParams,
} from './types.js';

/**
 * 类型守卫：校验 unknown 是否为符合 TradeRecord 结构的对象。
 *
 * @param record 待校验值
 * @returns 为 true 时收窄为 TradeRecord
 */
function isValidTradeRecord(record: unknown): record is TradeRecord {
  if (!isRecord(record)) {
    return false;
  }

  // 校验必需字段的类型（允许 null）
  return (
    (record['orderId'] === null || typeof record['orderId'] === 'string') &&
    (record['symbol'] === null || typeof record['symbol'] === 'string') &&
    (record['symbolName'] === null || typeof record['symbolName'] === 'string') &&
    (record['baseInstrumentSymbol'] === null ||
      typeof record['baseInstrumentSymbol'] === 'string') &&
    (record['action'] === null || typeof record['action'] === 'string') &&
    (record['side'] === null || typeof record['side'] === 'string') &&
    (record['quantity'] === null || typeof record['quantity'] === 'string') &&
    (record['price'] === null || typeof record['price'] === 'string') &&
    (record['orderType'] === null || typeof record['orderType'] === 'string') &&
    (record['status'] === null || typeof record['status'] === 'string') &&
    (record['error'] === null || typeof record['error'] === 'string') &&
    (record['reason'] === null || typeof record['reason'] === 'string') &&
    (record['signalTriggerTime'] === null || typeof record['signalTriggerTime'] === 'string') &&
    (record['executedAt'] === null || typeof record['executedAt'] === 'string') &&
    (record['executedAtMs'] === null || typeof record['executedAtMs'] === 'number') &&
    (record['timestamp'] === null || typeof record['timestamp'] === 'string') &&
    (record['isProtectiveClearance'] === null ||
      typeof record['isProtectiveClearance'] === 'boolean')
  );
}

/**
 * 类型守卫：校验 unknown 是否为 TradeRecord 数组（每项通过 isValidTradeRecord）。
 *
 * @param records 待校验值
 * @returns 为 true 时收窄为 TradeRecord[]
 */
function isValidTradeRecordArray(records: unknown): records is TradeRecord[] {
  return Array.isArray(records) && records.every(isValidTradeRecord);
}

/**
 * 识别错误类型（通过错误消息关键词匹配）
 * 用于区分资金不足、不支持做空、订单不存在、网络错误、限流等，便于日志与风控处理。
 * @param errorMessage 错误消息原文（将转为小写后匹配关键词）
 * @returns 错误类型标识对象，各布尔字段表示是否匹配对应类型
 */
export function identifyErrorType(errorMessage: string): ErrorTypeIdentifier {
  const lowerMsg = errorMessage.toLowerCase();
  return {
    isShortSellingNotSupported:
      lowerMsg.includes('does not support short selling') ||
      lowerMsg.includes('不支持做空') ||
      lowerMsg.includes('short selling') ||
      lowerMsg.includes('做空'),
    isInsufficientFunds:
      lowerMsg.includes('insufficient') ||
      lowerMsg.includes('资金不足') ||
      lowerMsg.includes('余额不足'),
    isOrderNotFound:
      lowerMsg.includes('not found') || lowerMsg.includes('不存在') || lowerMsg.includes('找不到'),
    isNetworkError:
      lowerMsg.includes('network') ||
      lowerMsg.includes('网络') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('超时'),
    isRateLimited:
      lowerMsg.includes('rate limit') || lowerMsg.includes('频率') || lowerMsg.includes('too many'),
  };
}

/**
 * 创建 tradeLogger 运行时。
 * 默认行为：按注入的 env 解析日志目录，按香港日期分文件写入交易记录，并执行保留策略。
 *
 * @param params tradeLogger 运行时工厂参数
 * @returns tradeLogger 运行时对象
 */
export function createTradeLoggerRuntime(
  params: TradeLoggerRuntimeFactoryParams,
): TradeLoggerRuntime {
  const { deps } = params;
  const logRootDir = resolveLogRootDir(deps.env);
  const tradeLogDir = deps.joinPath(logRootDir, 'trades');

  /**
   * 写入单条交易记录。
   * 默认行为：确保日志目录存在、按香港日期读取旧文件、追加新记录并刷新到磁盘。
   *
   * @param tradeRecord 单笔交易记录，字段可为 null
   * @returns 无返回值；写入失败时仅记录错误日志
   */
  function writeTradeRecord(tradeRecord: TradeRecord): void {
    try {
      ensureTradeLogDir(deps, tradeLogDir);

      const dayKey = getHKDateKey(new Date());
      const logFileName = `${dayKey}.json`;
      const logFile = deps.joinPath(tradeLogDir, logFileName);
      retainLatestLogFiles(
        {
          fs: deps.fs,
          joinPath: deps.joinPath,
          stderr: deps.stderr,
        },
        tradeLogDir,
        LOGGING.MAX_RETAINED_LOG_FILES,
        'json',
        logFileName,
      );

      const trades = readTradeRecords(deps, logFile);
      trades.push(normalizeTradeRecord(tradeRecord));
      deps.fs.writeFileSync(logFile, JSON.stringify(trades, null, 2), 'utf8');
    } catch (err: unknown) {
      deps.logger.error('写入交易记录失败', err);
    }
  }

  return {
    recordTrade: writeTradeRecord,
  };
}

const noopRecordTrade: TradeLoggerRuntime['recordTrade'] = () => void 0;

let currentRecordTrade: TradeLoggerRuntime['recordTrade'] = noopRecordTrade;

/**
 * 运行时 tradeLogger facade。
 * 默认行为：在未安装 tradeLogger 运行时时使用空实现，避免模块顶层副作用。
 *
 * @param tradeRecord 单笔交易记录
 * @returns 无返回值
 */
export function recordTrade(tradeRecord: TradeRecord): void {
  currentRecordTrade(tradeRecord);
}

/**
 * 安装当前进程内生效的 tradeLogger 记录目标。
 * 默认行为：将 `recordTrade` facade 转发到传入的记录实现。
 *
 * @param nextRecordTrade 新的记录实现
 * @returns 无返回值
 */
export function installTradeLogger(nextRecordTrade: TradeLoggerRuntime['recordTrade']): void {
  currentRecordTrade = nextRecordTrade;
}

/**
 * 重置 tradeLogger facade 的目标回空实现。
 * 默认行为：用于测试清理，避免跨用例泄漏 tradeLogger 安装状态。
 *
 * @returns 无返回值
 */
export function resetTradeLogger(): void {
  currentRecordTrade = noopRecordTrade;
}

/**
 * 确保交易日志目录存在。
 *
 * @param deps tradeLogger 运行时依赖
 * @param tradeLogDir 交易日志目录
 * @returns 无返回值
 */
function ensureTradeLogDir(deps: TradeLoggerRuntimeDeps, tradeLogDir: string): void {
  if (deps.fs.existsSync(tradeLogDir)) {
    return;
  }

  deps.fs.mkdirSync(tradeLogDir, { recursive: true });
}

/**
 * 读取并校验已有交易记录文件。
 *
 * @param deps tradeLogger 运行时依赖
 * @param logFile 交易记录文件路径
 * @returns 已有交易记录数组，异常或格式不符时返回空数组
 */
function readTradeRecords(deps: TradeLoggerRuntimeDeps, logFile: string): TradeRecord[] {
  if (!deps.fs.existsSync(logFile)) {
    return [];
  }

  const content = deps.fs.readFileSync(logFile, 'utf8');
  try {
    const parsed: unknown = JSON.parse(content);
    if (isValidTradeRecordArray(parsed)) {
      return parsed;
    }

    deps.logger.warn(`交易记录文件格式错误，重置为空数组: ${logFile}`);
    return [];
  } catch (error: unknown) {
    const parseErrorMessage = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`解析交易记录文件失败，重置为空数组: ${logFile}`, parseErrorMessage);
    return [];
  }
}

/**
 * 规范化单条交易记录。
 * 默认行为：将可空字段统一填充为 null，确保落盘 JSON 结构稳定。
 *
 * @param tradeRecord 原始交易记录
 * @returns 规范化后的交易记录
 */
function normalizeTradeRecord(tradeRecord: TradeRecord): TradeRecord {
  const executedAtMs = Number.isFinite(tradeRecord.executedAtMs) ? tradeRecord.executedAtMs : null;

  return {
    orderId: tradeRecord.orderId ?? null,
    symbol: tradeRecord.symbol ?? null,
    symbolName: tradeRecord.symbolName ?? null,
    baseInstrumentSymbol: tradeRecord.baseInstrumentSymbol ?? null,
    action: tradeRecord.action ?? null,
    side: tradeRecord.side ?? null,
    quantity: tradeRecord.quantity ?? null,
    price: tradeRecord.price ?? null,
    orderType: tradeRecord.orderType ?? null,
    status: tradeRecord.status ?? null,
    error: tradeRecord.error ?? null,
    reason: tradeRecord.reason ?? null,
    signalTriggerTime: tradeRecord.signalTriggerTime ?? null,
    executedAt: tradeRecord.executedAt ?? null,
    executedAtMs,
    timestamp: toHongKongTimeIso(),
    isProtectiveClearance: tradeRecord.isProtectiveClearance ?? null,
  };
}
