/**
 * 账户与持仓展示服务：只读取 canonical snapshot，以精确金额/比率一次生成展示文本。
 * 不主动请求、不缓存第二份账户；保留原生显示路径的负零符号政策。
 */
import { ACCOUNT_CHANNEL_MAP } from '../../../constants/common.js';
import { logger } from '../../logger/index.js';
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

/** 将 number 的最短往返指数文本展开为普通十进制，不量化有效数字。 */
function expandExponentialText(text: string): string {
  const exponentIndex = text.includes('e') ? text.indexOf('e') : text.indexOf('E');
  if (exponentIndex === -1) return text;

  const mantissa = text.slice(0, exponentIndex);
  const exponent = Number(text.slice(exponentIndex + 1));
  if (!Number.isSafeInteger(exponent)) {
    throw new RangeError('Display quantity exponent must be a safe integer');
  }

  const negative = mantissa.startsWith('-');
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa;
  const decimalIndex = unsignedMantissa.indexOf('.');
  const integerPart =
    decimalIndex === -1 ? unsignedMantissa : unsignedMantissa.slice(0, decimalIndex);
  const fractionPart = decimalIndex === -1 ? '' : unsignedMantissa.slice(decimalIndex + 1);
  const digits = `${integerPart}${fractionPart}`;
  const point = integerPart.length + exponent;
  const sign = negative ? '-' : '';

  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;

  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;

  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** 数量只作为展示事实；转普通十进制文本，避免指数形式回流精确运算。 */
function toPlainDecimalText(value: number): string {
  return expandExponentialText(String(value));
}

/** 验证有限非负数量后按旧字段位数显示；小数持仓只影响展示，不进入交易数量。 */
function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError('Display position quantity must be a finite nonnegative number');
  }

  return formatDecimal(toPlainDecimalText(quantity), 2, 'preserve');
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
        ? exactMultiply(toPlainDecimalText(position.quantity), currentPrice)
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
