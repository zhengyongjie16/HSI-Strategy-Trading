import type { LOG_LEVELS } from '../../constants/index.js';

/**
 * 日志对象接口。
 * 类型用途：描述单条结构化日志记录的数据结构，供日志格式化器序列化输出。
 * 数据来源：由 logger 模块各级别方法（debug/info/warn/error）构造生成。
 * 使用范围：仅 logger 模块内部使用。
 */
export type LogObject = {
  readonly level: (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];
  readonly time: number;
  readonly msg: string;
  readonly extra?: unknown;
};
