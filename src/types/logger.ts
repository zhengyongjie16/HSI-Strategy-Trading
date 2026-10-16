/**
 * Logger 接口定义。
 * 类型用途：定义日志记录器的公开方法契约，供业务模块注入和调用。
 * 数据来源：由 createLogger 工厂函数实现并返回。
 * 使用范围：全局使用，业务模块通过依赖注入获取实例。
 */
export interface Logger {
  readonly debug: (msg: string, extra?: unknown) => void;
  readonly info: (msg: string, extra?: unknown) => void;
  readonly warn: (msg: string, extra?: unknown) => void;
  readonly error: (msg: string, extra?: unknown) => void;
}
