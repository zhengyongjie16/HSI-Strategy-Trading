/** 交易行情原始金融文本在终态一次格式化的展示投影，不回流价格或涨跌事实。 */
export type QuoteDisplay = {
  readonly nameText: string;
  readonly codeText: string;
  readonly priceText: string;
  readonly changeAmountText: string;
  readonly changePercentText: string;
};
