/** Broker业务订单状态：保留提交/改单/撤单在途的真实语义，不含SDK数值枚举。 */
export type OrderReadStatus =
  | 'UNCONFIRMED'
  | 'UNREPORTED'
  | 'REPLACEMENT_UNREPORTED'
  | 'PROTECTION_UNREPORTED'
  | 'CONDITIONAL_UNREPORTED'
  | 'FILLED'
  | 'SUBMISSION_PENDING'
  | 'WORKING'
  | 'REPLACEMENT_REQUESTED'
  | 'REPLACEMENT_PENDING'
  | 'REPLACED'
  | 'PARTIALLY_FILLED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLATION_PENDING'
  | 'REJECTED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'PARTIALLY_CANCELED';

/** 读取所有真实broker订单种类；不把不明/特殊单伪造为LO或MO。 */
export type OrderReadType =
  | 'UNSPECIFIED'
  | 'LO'
  | 'ELO'
  | 'MO'
  | 'AO'
  | 'ALO'
  | 'ODD'
  | 'LIT'
  | 'MIT'
  | 'TSLPAMT'
  | 'TSLPPCT'
  | 'TSMAMT'
  | 'TSMPCT'
  | 'SLO';
