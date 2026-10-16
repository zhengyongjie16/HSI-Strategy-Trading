/**
 * 生命周期运行时顺序断言的方法名。
 * 数据来源：signalRuntimeDomain 单测记录的 owner 调用。
 * 使用范围：tests/runtime/lifecycle/cacheDomains 的顺序回归。
 */
export type OrderedMethod = 'stopAndDrain' | 'restart' | 'start' | 'clearPending';
