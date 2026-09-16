import type { Position } from '../types/account.js';
import type { SymbolRegistry } from '../types/seat.js';
import type { LastState } from '../types/state.js';
import type { Trader } from '../types/services.js';
import { readAccountAndPositionsBothSettled } from '../utils/accountPositions/index.js';

/**
 * 刷新账户与持仓缓存（仅数据拉取，不做行情订阅）。默认行为：仅当 lastState.cachedAccount 为空时双读取
 * trader.getAccountSnapshot 与 getStockPositions，否则直接使用已有缓存；两项请求均成功后依次更新
 * lastState 的 cachedAccount、cachedPositions 与 positionCache；任一读取失败不提交。
 *
 * 失败语义：非外部 API 失败在观察点立即经 reportFatalError 上报，两个请求全部落定后抛出原始错误
 * （内部错误优先、保留原始身份）；纯外部失败保持原样，交由上层恢复/重试策略处理。
 *
 * @param trader Trader 实例，用于拉取账户与持仓
 * @param lastState 状态对象，用于读取/更新缓存（cachedAccount、cachedPositions、positionCache）
 * @param reportFatalError 运行时 fatal 上报入口，必须由调用方注入真实 termination 回调
 * @returns Promise<void>，无返回值；任一读取失败时抛出原始错误
 */
export async function refreshAccountAndPositions(
  trader: Trader,
  lastState: LastState,
  reportFatalError: (error: unknown) => void,
): Promise<void> {
  if (lastState.cachedAccount !== null) {
    return;
  }

  const { account, positions } = await readAccountAndPositionsBothSettled({
    trader,
    reportFatalError,
  });

  lastState.cachedAccount = account;
  lastState.cachedPositions = positions;
  lastState.positionCache.update(positions);
}

/**
 * 收集运行时需要获取行情的标的代码集合（监控标的 + 席位占用标的 + 持仓标的 + 订单持有标的）。默认行为：合并去重后返回 Set。
 *
 * @param monitorConfig 唯一监控配置（monitorSymbol、longSymbol、shortSymbol）
 * @param symbolRegistry 标的注册表，用于解析席位当前占用标的
 * @param positions 当前持仓数组
 * @param orderHoldSymbols 订单持有标的集合
 * @returns 需要拉取行情的标的代码集合
 */
export function collectRuntimeQuoteSymbols(
  monitorConfig: {
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  },
  symbolRegistry: SymbolRegistry,
  positions: ReadonlyArray<Position>,
  orderHoldSymbols: ReadonlySet<string>,
): Set<string> {
  const symbols = collectAllQuoteSymbols(monitorConfig, symbolRegistry);
  for (const position of positions) {
    if (position.symbol) {
      symbols.add(position.symbol);
    }
  }

  for (const symbol of orderHoldSymbols) {
    if (symbol) {
      symbols.add(symbol);
    }
  }

  return symbols;
}

/**
 * 收集所有需要获取行情的标的代码（监控标的 + 席位占用标的），供运行时快照与订阅链路批量拉取行情。
 *
 * @param monitorConfig 唯一监控配置（monitorSymbol、longSymbol、shortSymbol）
 * @param symbolRegistry 标的注册表，可选；传入时从席位状态解析做多/做空占用标的并加入集合
 * @returns 需要拉取行情的标的代码集合
 */
function collectAllQuoteSymbols(
  monitorConfig: {
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  },
  symbolRegistry?: SymbolRegistry | null,
): Set<string> {
  const symbols = [monitorConfig.monitorSymbol];
  if (!symbolRegistry) {
    return new Set(symbols);
  }

  const longSeat = symbolRegistry.getSeatState('LONG');
  const shortSeat = symbolRegistry.getSeatState('SHORT');
  if (longSeat.symbol) {
    symbols.push(longSeat.symbol);
  }

  if (shortSeat.symbol) {
    symbols.push(shortSeat.symbol);
  }

  return new Set(symbols);
}
