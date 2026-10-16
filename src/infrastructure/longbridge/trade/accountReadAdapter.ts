import { wrapExternalApiRequest } from '../../externalApi/index.js';

/** 原context账户金融IO边界。重试范围只含外部SDK await；映射故障保持internal/原identity。 */
import type { TradeContext } from 'longbridge';
import type { AccountReadPort } from '../../../types/accountReadPorts.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { mapAccountBalance, mapStockPositions } from './accountMapper.js';

/**
 * @param context 原Trader唯一SDK context
 * @returns 不包含SDK DTO的账户行为/IO port（非纯转换资格）
 */
export function createAccountReadAdapter(context: unknown): AccountReadPort {
  if (
    !isRecord(context) ||
    typeof context['accountBalance'] !== 'function' ||
    typeof context['stockPositions'] !== 'function'
  ) {
    throw new TypeError('[AccountReadAdapter] missing injected SDK account capability');
  }

  const ctx = context as Pick<TradeContext, 'accountBalance' | 'stockPositions'>;
  return {
    readPrimaryAccount: async (params) => {
      const balances = await wrapExternalApiRequest({
        operation: 'TradeContext.accountBalance',
        request: () => ctx.accountBalance(),
        ...(params?.retryConfig ? { retryConfig: params.retryConfig } : {}),
      });
      const primary = balances[0];
      if (primary === undefined)
        throw new TypeError('TradeContext.accountBalance returned no primary account');

      return mapAccountBalance(primary);
    },
    readStockPositions: async (params) => {
      const symbols = params?.symbols ?? null;
      const response = await wrapExternalApiRequest({
        operation: 'TradeContext.stockPositions',
        request: () => ctx.stockPositions(symbols ? [...symbols] : undefined),
        ...(params?.retryConfig ? { retryConfig: params.retryConfig } : {}),
      });
      return mapStockPositions(response);
    },
  };
}
