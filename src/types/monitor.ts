/**
 * 唯一监控标的的名称缓存，由 app/context 与既有 rebuild 同步写入。
 * 消费方取得同一对象的 Readonly/Pick；不从名称反推席位归属，也不复制为运行期镜像。
 */
export type MonitorSymbolNames = {
  longSymbolName: string;
  shortSymbolName: string;
  monitorSymbolName: string;
};
