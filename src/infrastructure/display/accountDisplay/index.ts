/**
 * 账户与持仓展示服务：只读取 canonical snapshot，以精确金额/比率一次生成展示文本。
 * 不主动请求、不缓存第二份账户；保留原生显示路径的负零符号政策。
 */
import { ACCOUNT_CHANNEL_MAP } from '../../../constants/index.js';
import { logger } from '../../../utils/logger/index.js';
import {
  exactCompare,
  exactMultiply,
  formatDecimal,
  formatRatio,
} from '../../../utils/numeric/exact.js';
import type { DisplayAccountAndPositionsParams } from '../../../types/display.js';

function formatAccountChannel(accountChannel: string): string {
  return accountChannel
    ? (ACCOUNT_CHANNEL_MAP[accountChannel.toLowerCase()] ?? accountChannel)
    : '未知账户';
}

/** 验证安全整数数量后按旧字段位数显示，不容忍内部数量损坏。 */
function formatQuantity(quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError('Display position quantity must be a nonnegative safe integer');
  }

  return formatDecimal(String(quantity), 2, 'preserve');
}

/** 从当前只读事实生成日志；金融错误向上穿透，由业务 owner 关闭门禁。 */
export function displayAccountAndPositions({
  snapshot,
  quotesMap,
}: DisplayAccountAndPositionsParams): void {
  const view = snapshot.getView();
  const account = view.accountValid ? view.account : null;
  const positions = view.positionsValid ? view.positions : [];

  if (account) {
    logger.info(
      `账户概览 [${account.currency}] 余额=${formatDecimal(account.totalCash, 2, 'preserve')} 市值=${formatDecimal(account.netAssets, 2, 'preserve')} 持仓市值≈${formatDecimal(account.positionValue, 2, 'preserve')}`,
    );
  }

  if (positions.length === 0) {
    logger.info('当前无股票持仓。');
    return;
  }

  logger.info('股票持仓：');
  const totalAssets = account?.netAssets ?? '0';
  for (const position of positions) {
    const quote = quotesMap?.get(position.symbol) ?? null;
    const currentPrice = quote?.price ?? null;
    const quantityText = formatQuantity(position.quantity);
    const availableText = formatQuantity(position.availableQuantity);
    const marketValue =
      currentPrice !== null && exactCompare(currentPrice, '0') > 0
        ? exactMultiply(String(position.quantity), currentPrice)
        : '0';
    const positionPercentText =
      exactCompare(totalAssets, '0') > 0 && exactCompare(marketValue, '0') > 0
        ? formatRatio(exactMultiply(marketValue, '100'), totalAssets, 2, 'preserve')
        : '0.00';
    const priceText =
      currentPrice === null ? '现价=N/A' : `现价=${formatDecimal(currentPrice, 3, 'preserve')}`;
    logger.info(
      `- [${formatAccountChannel(position.accountChannel)}] ${quote?.name ?? position.symbolName}(${position.symbol}) 持仓=${quantityText} 可用=${availableText} ${priceText} 市值=${formatDecimal(marketValue, 2, 'preserve')} 仓位=${positionPercentText}% ${position.currency}`,
    );
  }
}
