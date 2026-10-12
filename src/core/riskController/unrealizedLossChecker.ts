/** 浮亏事实：精确 R1 与安全整数 N1，prepare 无副作用，最终授权后同步 publish。 */
import { logger } from '../../utils/logger/index.js';
import {
  exactCompare,
  exactMultiply,
  exactSubtract,
  formatDecimal,
} from '../../utils/numeric/exact.js';
import type {
  OrderRecorder,
  PreparedUnrealizedLossData,
  UnrealizedLossData,
  UnrealizedLossCheckResult,
} from '../../types/services.js';
import type { UnrealizedLossChecker, UnrealizedLossCheckerDeps } from './types.js';

/** 读取既有成本口径并准备精确 R1/N1；不依赖缓存状态，不发布浮亏事实。 */
function prepare(
  orderRecorder: OrderRecorder,
  symbol: string,
  isLongSymbol: boolean,
  dailyLossOffset: string,
): PreparedUnrealizedLossData {
  if (exactCompare(dailyLossOffset, '0') > 0)
    throw new TypeError('[risk] daily loss offset must be nonpositive');

  const basis = orderRecorder.getCostBasis(symbol, isLongSymbol);
  const n1 = basis?.quantity ?? 0;
  if (!Number.isSafeInteger(n1) || n1 < 0)
    throw new RangeError('[risk] position basis quantity must be safe integer');

  const r1 = exactSubtract(basis?.costAmount ?? '0', dailyLossOffset);
  return Object.freeze({ symbol, data: Object.freeze({ r1, n1 }) });
}

/** 创建单一浮亏缓存 owner，不以舍入均价重构成本或跳过内部非法事实。 */
export function createUnrealizedLossChecker(
  deps: UnrealizedLossCheckerDeps,
): UnrealizedLossChecker {
  const threshold = deps.maxUnrealizedLossPerSymbol;
  const values = new Map<string, UnrealizedLossData>();

  function publish(prepared: PreparedUnrealizedLossData): void {
    if (
      prepared.symbol.length === 0 ||
      !Number.isSafeInteger(prepared.data.n1) ||
      prepared.data.n1 < 0 ||
      exactCompare(prepared.data.r1, '0') < 0
    )
      throw new TypeError('[risk] invalid prepared R1/N1');

    values.set(prepared.symbol, Object.freeze({ ...prepared.data }));
  }

  function check(
    symbol: string,
    currentPrice: string,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult {
    if (
      threshold === null ||
      exactCompare(threshold, '0') <= 0 ||
      exactCompare(currentPrice, '0') <= 0
    )
      return { shouldLiquidate: false };

    const data = values.get(symbol);
    if (data === undefined) {
      logger.warn(`[浮亏监控] ${symbol} 浮亏数据未初始化，跳过检查`);
      return { shouldLiquidate: false };
    }

    if (data.n1 === 0) return { shouldLiquidate: false };

    const r2 = exactMultiply(currentPrice, String(data.n1));
    const loss = exactSubtract(r2, data.r1);
    if (exactCompare(loss, exactSubtract('0', threshold)) < 0) {
      return {
        shouldLiquidate: true,
        quantity: data.n1,
        reason: `[保护性清仓] ${isLongSymbol ? '做多标的' : '做空标的'} ${symbol} 浮亏=${formatDecimal(loss, 2, 'unsigned')} HKD 超过阈值 ${formatDecimal(threshold, 2, 'unsigned')} HKD (R1=${formatDecimal(data.r1, 2, 'unsigned')}, R2=${formatDecimal(r2, 2, 'unsigned')}, N1=${data.n1})，执行保护性清仓`,
      };
    }

    return { shouldLiquidate: false };
  }

  return {
    getUnrealizedLossData: (symbol) => values.get(symbol),
    clearUnrealizedLossData: (symbol) => {
      if (symbol === null || symbol === undefined || symbol === '') values.clear();
      else values.delete(symbol);
    },
    prepare,
    publish,
    check,
  };
}
