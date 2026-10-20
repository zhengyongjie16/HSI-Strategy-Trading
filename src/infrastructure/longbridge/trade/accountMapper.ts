/** Longbridge 账户与持仓金融边界：SDK 文本保真，账户数量允许小数，交易数量仍走安全整数出口。 */
import type { AccountBalance, StockPositionsResponse } from 'longbridge';
import type { CashInfo, Position } from '../../../types/account.js';
import { canonicalDecimal } from '../../../utils/numeric/exact.js';

/**
 * 账户持仓数量投影：只证明有限非负 number，允许美股等小数持仓。
 * 策略交易数量不得使用此出口，仍必须由 safeQuantityNumber 证明非负安全整数。
 * @param quantity SDK 数量文本
 * @returns 有限非负持仓数量
 */
function finitePositionQuantity(quantity: string): number {
  const value = Number(canonicalDecimal(quantity));
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Position quantity must be a finite nonnegative number');
  }

  return value;
}

/** 映射账户资产依据；持仓市值公式留在 accountService。 */
export function mapAccountBalance(account: AccountBalance): {
  readonly currency: string;
  readonly totalCash: string;
  readonly netAssets: string;
  readonly cashInfos: ReadonlyArray<CashInfo>;
} {
  return {
    currency: account.currency,
    totalCash: canonicalDecimal(account.totalCash.toString()),
    netAssets: canonicalDecimal(account.netAssets.toString()),
    cashInfos: account.cashInfos.map((cash) => ({
      currency: cash.currency,
      availableCash: canonicalDecimal(cash.availableCash.toString()),
    })),
  };
}

/** 不聚合渠道或重算成本，保留 API 返回的全部持仓明细。 */
export function mapStockPositions(response: StockPositionsResponse): ReadonlyArray<Position> {
  return response.channels.flatMap((channel) =>
    channel.positions.map((position) => ({
      accountChannel: channel.accountChannel,
      symbol: position.symbol,
      symbolName: position.symbolName,
      quantity: finitePositionQuantity(position.quantity.toString()),
      availableQuantity: finitePositionQuantity(position.availableQuantity.toString()),
      currency: position.currency,
      costPrice: canonicalDecimal(position.costPrice.toString()),
    })),
  );
}
