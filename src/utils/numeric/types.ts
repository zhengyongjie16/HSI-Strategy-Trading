/**
 * 已有指标number与结构数量文本的窄比较输入；SDK对象不允许进入通用numeric。
 * 金融算术使用exact模块规范文本，不能用此输入能力为金融number桥授权。
 */
export type DecimalInput = number | string;
