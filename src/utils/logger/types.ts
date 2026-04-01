import type { Writable } from 'node:stream';
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

/**
 * Logger 接口定义。
 * 类型用途：定义日志记录器的公开方法契约，供业务模块注入和调用。
 * 数据来源：由 logger 运行时工厂或测试替身实现并返回。
 * 使用范围：全局使用，业务模块通过依赖注入获取实例。
 */
export interface Logger {
  debug: (msg: string, extra?: unknown) => void;
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
}

/**
 * Logger 后端接口。
 * 类型用途：封装可注入的结构化日志实现，兼容 pino 等后端。
 * 数据来源：由入口组合根构造并注入。
 * 使用范围：仅 logger 运行时工厂与入口装配层使用。
 */
export interface LoggerBackend {
  debug: (objOrMsg: unknown, msg?: string) => void;
  info: (objOrMsg: unknown, msg?: string) => void;
  warn: (objOrMsg: unknown, msg?: string) => void;
  error: (objOrMsg: unknown, msg?: string) => void;
  flush: () => void;
}

/**
 * Logger 可注入的文件流构造器。
 * 类型用途：允许调用方显式创建 Writable，logger 模块只消费抽象工厂。
 * 数据来源：由入口组合根提供。
 * 使用范围：仅 logger 运行时工厂使用。
 */
export type LoggerWritableFactory = (
  params: Readonly<{
    write: (
      chunk: Buffer,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) => void;
  }>,
) => Writable;

/**
 * Logger 可注入的文件系统边界。
 * 类型用途：屏蔽 logger 模块对 node:fs 的直接依赖。
 * 数据来源：由入口组合根提供。
 * 使用范围：仅 logger 运行时工厂使用。
 */
export interface LoggerFileSystem {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options: { readonly recursive: boolean }) => void;
  readdirSync: (path: string) => ReadonlyArray<string>;
  statSync: (path: string) => { isFile: () => boolean };
  unlinkSync: (path: string) => void;
  createWriteStream: (
    path: string,
    options: { readonly flags: string; readonly encoding: BufferEncoding },
  ) => Writable;
}

/**
 * Logger 运行时依赖集合。
 * 类型用途：统一收口所有需要由入口注入的 Node 依赖与后端工厂。
 * 数据来源：由 src/index.ts 组装并传入。
 * 使用范围：仅 logger 运行时工厂使用。
 */
export interface LoggerRuntimeDeps {
  readonly createWritable: LoggerWritableFactory;
  readonly createPinoLogger: (params: {
    readonly isDebugEnabled: boolean;
    readonly consoleStream: Writable;
    readonly fileStream: Writable;
  }) => LoggerBackend;
  readonly fs: LoggerFileSystem;
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}

/**
 * Logger 运行时可注入的进程对象。
 * 类型用途：为 logger 工厂提供可测试的 process-like 边界，便于验证进程钩子注册。
 * 数据来源：生产环境由 Node.js `process` 提供，测试可传入替身对象。
 * 使用范围：仅 logger 模块与入口装配层使用。
 */
export interface LoggerProcessLike {
  on: (
    event: 'beforeExit' | 'exit' | 'uncaughtException' | 'unhandledRejection',
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => LoggerProcessLike;
  exit: (code?: number) => void;
}

/**
 * Logger 工厂参数。
 * 类型用途：统一描述 createLoggerRuntime 所需的环境与进程边界。
 * 数据来源：由组合根在入口处显式传入。
 * 使用范围：仅 logger 模块与 app 入口边界使用。
 */
export type LoggerRuntimeFactoryParams = Readonly<{
  env: NodeJS.ProcessEnv;
  processLike: LoggerProcessLike;
  deps: LoggerRuntimeDeps;
}>;

/**
 * Logger 运行时对象。
 * 类型用途：封装 logger 实例、清理能力与进程钩子注册能力，供入口装配层显式管理生命周期。
 * 数据来源：由 createLoggerRuntime 创建。
 * 使用范围：仅 logger 模块与 app 入口边界使用。
 */
export interface LoggerRuntime {
  readonly logger: Logger;
  cleanupSync: () => void;
  cleanupAsync: () => Promise<void>;
  registerProcessHooks: () => void;
}
