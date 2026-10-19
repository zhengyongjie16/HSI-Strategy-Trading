/**
 * 牛熊证风险事实刷新用例。
 *
 * 交易日重建查询单标的 warrant 报价，完整验证金融文本后以原 captured 授权向唯一 domain 风险状态发布。
 * market adapter 负责 SDK 映射及外部 IO retry；用例保留原错误分类，不增加本地重试或统一风险 workflow。
 */
import { parseWarrantType } from '../../domain/risk/warrantRiskChecker.js';
import { canonicalDecimal, formatDecimal } from '../../utils/numeric/exact.js';
import { isExternalApiRequestError, isProgramError } from '../../utils/apiFailure/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { formatError } from '../../utils/error/index.js';
import { WARRANT_TYPE_NAMES } from '../../constants/index.js';
import type { WarrantInfo } from '../../domain/risk/types.js';
import type {
  WarrantRiskRefresh,
  WarrantRiskRefreshDeps,
  WarrantRiskRefreshResult,
} from './types.js';

/** 创建真实查询用例，固定注入行情读取及已有风险状态，不在内部创建缓存或外部客户端。 */
export function createWarrantRiskRefresh(deps: WarrantRiskRefreshDeps): WarrantRiskRefresh {
  /** 查询仅在完整成功后生成候选；未知类型仍沿原业务标记为非牛熊证。 */
  async function readWarrantInfo(symbol: string, isLong: boolean): Promise<WarrantInfo> {
    const context = await deps.marketDataClient.getQuoteContext();
    const quotes = await context.warrantQuote([symbol]);
    const quote = quotes[0];
    if (!quote) return { isWarrant: false };

    const warrantType = parseWarrantType(quote.category);
    if (warrantType === null) return { isWarrant: false };

    const callPrice =
      quote.callPrice === null || quote.callPrice === undefined
        ? null
        : canonicalDecimal(quote.callPrice);
    if (isLong !== (warrantType === 'BULL')) {
      deps.logger.warn(
        `[风险检查警告] ${symbol} 的牛熊证类型不符合预期：期望${isLong ? '牛证' : '熊证'}，实际是${WARRANT_TYPE_NAMES[warrantType]}`,
      );
    }

    return { isWarrant: true, warrantType, callPrice, symbol };
  }

  /**
   * 完整读校验后以原 captured isCurrent 同步检查并发布，guard 与 publish 间不插入 await。
   * 授权失效只返回 INVALIDATED，不写缓存、不增加重试；查询及金融错误仍沿原通道处理。
   * 原可报告业务错误只返回 error，不清除先前风险事实，重建仍按其既有失败门禁处理。
   */
  async function refreshWarrantInfoForSymbol(
    symbol: string,
    isLong: boolean,
    isCurrent: () => boolean,
    name: string | null = null,
  ): Promise<WarrantRiskRefreshResult> {
    let info: WarrantInfo;
    try {
      info = await readWarrantInfo(symbol, isLong);
    } catch (error) {
      if (isExternalApiRequestError(error) || isProgramError(error)) throw error;

      const reason = formatError(error);
      deps.logger.warn(
        `[风险检查] 检查${isLong ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, name)} 牛熊证信息时出错：`,
        reason,
      );
      return { status: 'error', reason };
    }

    if (!isCurrent()) return { status: 'INVALIDATED' };

    deps.warrantRiskChecker.publishWarrantInfo(info, isLong);
    if (!info.isWarrant) {
      deps.logger.info(
        `[风险检查] ${isLong ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, name)} 不是牛熊证`,
      );
      return { status: 'notWarrant' };
    }

    deps.logger.info(
      `[风险检查] ${isLong ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, name)} 是${WARRANT_TYPE_NAMES[info.warrantType]}，回收价=${info.callPrice === null ? '未知' : formatDecimal(info.callPrice, 3, 'unsigned')}`,
    );
    return { status: 'ok' };
  }

  return { refreshWarrantInfoForSymbol };
}
