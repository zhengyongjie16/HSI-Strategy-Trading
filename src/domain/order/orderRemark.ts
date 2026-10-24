/** 订单 remark provenance：新单写入目的，恢复只读取既有后缀，不推断完整历史 purpose。 */
import { TRADING } from '../../constants/common.js';

/** 生成 broker remark；protective 身份只由该订单的原始请求决定。 */
export function buildOrderRemark(isProtectiveLiquidation: boolean): string {
  return isProtectiveLiquidation
    ? `${TRADING.DEFAULT_ORDER_REMARK}${TRADING.PROTECTIVE_LIQUIDATION_REMARK_SUFFIX}`
    : TRADING.DEFAULT_ORDER_REMARK;
}

/** 仅既有 |PL 后缀证明 protective 身份；不从价格、订单类型或更新时间补造。 */
export function hasProtectiveLiquidationRemark(remark: string | null | undefined): boolean {
  return (
    typeof remark === 'string' && remark.endsWith(TRADING.PROTECTIVE_LIQUIDATION_REMARK_SUFFIX)
  );
}
