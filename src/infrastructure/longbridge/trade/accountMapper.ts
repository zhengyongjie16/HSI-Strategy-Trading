/** Longbridge 账户与持仓金融边界：SDK 文本保真，数量进入领域前证明安全整数。 */
import type { AccountBalance, StockPositionsResponse } from 'longbridge';
import type { CashInfo, Position } from '../../../types/account.js';
import { canonicalDecimal, safeQuantityNumber } from '../../../utils/numeric/exact.js';

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
      quantity: safeQuantityNumber(position.quantity.toString()),
      availableQuantity: safeQuantityNumber(position.availableQuantity.toString()),
      currency: position.currency,
      costPrice: canonicalDecimal(position.costPrice.toString()),
    })),
  );
}
