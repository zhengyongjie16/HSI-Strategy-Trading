/**
 * 日志运行时模块
 *
 * 职责：
 * - 以工厂函数创建 pino logger 与文件轮转流
 * - 将进程级 hook 注册收口到组合根
 * - 为历史直接导入场景提供无副作用的 logger facade
 */
import type { Writable } from 'node:stream';
import { inspect } from 'node:util';
import { LOG_ANSI_CODE_REGEX, LOG_COLORS, LOGGING, LOG_LEVELS } from '../../constants/index.js';
import { isRecord } from '../helpers/index.js';
import { resolveLogRootDir, shouldInstallGlobalProcessHooks } from '../runtime/index.js';
import { toHongKongTimeLog } from '../time/index.js';
import type {
  LogObject,
  Logger,
  LoggerRuntime,
  LoggerRuntimeDeps,
  LoggerRuntimeFactoryParams,
} from './types.js';

/**
 * 保留目录下仅扩展名匹配且为文件的最新若干条，删除更早的。
 * 在写入当日文件前调用：若即将写入的文件已存在（覆盖/追加），保留数 = maxFiles；
 * 若即将新建文件，保留数 = max(0, maxFiles - 1)，写入后总数 ≤ maxFiles。
 * 仅依赖注入的 fs/path 边界，不依赖 logger，避免循环依赖。
 *
 * @param deps 注入的文件系统、路径拼接与 stderr 边界
 * @param logDir 日志目录
 * @param maxFiles 最多保留文件数（含即将写入的当日文件）
 * @param extension 扩展名（不含点），如 'log'、'json'
 * @param currentFileName 即将写入的文件名（如 '2026-02-13.log'）。若传入且在目录中已存在，则按"覆盖"语义保留 maxFiles 个；否则按"新建"语义保留 maxFiles - 1 个
 * @returns 无返回值
 */
export function retainLatestLogFiles(
  deps: Pick<LoggerRuntimeDeps, 'fs' | 'joinPath' | 'stderr'>,
  logDir: string,
  maxFiles: number,
  extension: string,
  currentFileName?: string,
): void {
  if (maxFiles < 1) {
    return;
  }

  const fsOps = deps.fs;
  const joinPath = deps.joinPath;
  const stderr = deps.stderr;

  if (!fsOps.existsSync(logDir)) {
    return;
  }

  const extSuffix = `.${extension}`;
  const names = fsOps.readdirSync(logDir);
  const files: string[] = [];

  for (const name of names) {
    if (!name.endsWith(extSuffix)) {
      continue;
    }

    const fullPath = joinPath(logDir, name);
    try {
      if (fsOps.statSync(fullPath).isFile()) {
        files.push(name);
      }
    } catch {
      // 无法 stat 的项跳过
    }
  }

  files.sort((left, right) => left.localeCompare(right, 'en'));
  const isOverwriting = typeof currentFileName === 'string' && files.includes(currentFileName);
  const toRetain = isOverwriting ? maxFiles : Math.max(0, maxFiles - 1);
  const toDelete = Math.max(0, files.length - toRetain);

  for (let index = 0; index < toDelete; index += 1) {
    const file = files[index];
    if (file === undefined) {
      continue;
    }

    const fullPath = joinPath(logDir, file);
    try {
      fsOps.unlinkSync(fullPath);
    } catch (error: unknown) {
      try {
        stderr.write(`[logRetention] 删除旧日志失败: ${fullPath} ${formatErrorLike(error)}\n`);
      } catch {
        // 忽略
      }
    }
  }
}

/**
 * 创建 logger 运行时。
 * 默认行为：按 env 解析日志目录、DEBUG 档位与进程 hook 策略，但不自动注册 hook。
 *
 * @param params logger 运行时工厂参数
 * @returns logger 运行时对象
 */
export function createLoggerRuntime(params: LoggerRuntimeFactoryParams): LoggerRuntime {
  const { env, processLike, deps } = params;
  const isDebugEnabled = env['DEBUG'] === 'true';
  const logRootDir = resolveLogRootDir(env);
  const shouldInstallProcessHooks = shouldInstallGlobalProcessHooks(env);
  const systemFileStream = createDateRotatingStream({
    deps,
    logRootDir,
    logSubDir: 'system',
  });
  const debugFileStream = isDebugEnabled
    ? createDateRotatingStream({
        deps,
        logRootDir,
        logSubDir: 'debug',
      })
    : null;
  const pinoLogger = deps.createPinoLogger({
    isDebugEnabled,
    consoleStream: createConsoleStream(deps),
    fileStream: createFileStream({
      deps,
      debugFileStream,
      isDebugEnabled,
      systemFileStream,
    }),
  });
  let isClosed = false;
  let isClosingAsync = false;
  let areProcessHooksRegistered = false;

  const runtimeLogger: Logger = {
    debug(msg: string, extra?: unknown): void {
      if (!isDebugEnabled) {
        return;
      }

      if (extra === null || extra === undefined) {
        pinoLogger.debug(msg);
        return;
      }

      pinoLogger.debug({ extra }, msg);
    },
    info(msg: string, extra?: unknown): void {
      if (extra === null || extra === undefined) {
        pinoLogger.info(msg);
        return;
      }

      pinoLogger.info({ extra }, msg);
    },
    warn(msg: string, extra?: unknown): void {
      if (extra === null || extra === undefined) {
        pinoLogger.warn(msg);
        return;
      }

      pinoLogger.warn({ extra }, msg);
    },
    error(msg: string, extra?: unknown): void {
      if (extra === null || extra === undefined) {
        pinoLogger.error(msg);
        return;
      }

      pinoLogger.error({ extra }, msg);
    },
  };

  /**
   * 同步清理 logger 资源。
   * 默认行为：刷新 pino 缓冲并同步关闭系统/调试文件流。
   *
   * @returns 无返回值
   */
  function cleanupSync(): void {
    if (isClosed || isClosingAsync) {
      return;
    }

    isClosed = true;

    try {
      pinoLogger.flush();
      systemFileStream.closeSync();
      if (debugFileStream !== null) {
        debugFileStream.closeSync();
      }
    } catch (error: unknown) {
      try {
        deps.stderr.write(`[Logger] 同步清理过程出错: ${formatErrorLike(error)}\n`);
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 异步清理 logger 资源。
   * 默认行为：按顺序等待系统与调试文件流优雅关闭。
   *
   * @returns 清理完成后的 Promise
   */
  async function cleanupAsync(): Promise<void> {
    if (isClosed) {
      return;
    }

    if (isClosingAsync) {
      return;
    }

    isClosingAsync = true;

    try {
      pinoLogger.flush();
      await systemFileStream.closeAsync();
      if (debugFileStream !== null) {
        await debugFileStream.closeAsync();
      }
    } finally {
      isClosed = true;
      isClosingAsync = false;
    }
  }

  /**
   * 注册进程级 logger hooks。
   * 默认行为：仅当 env 启用时注册 beforeExit / exit / uncaughtException / unhandledRejection。
   *
   * @returns 无返回值
   */
  function registerProcessHooks(): void {
    if (!shouldInstallProcessHooks || areProcessHooksRegistered) {
      return;
    }

    areProcessHooksRegistered = true;

    processLike.on('beforeExit', () => {
      cleanupSync();
    });

    processLike.on('exit', () => {
      cleanupSync();
    });

    processLike.on('uncaughtException', (error: unknown) => {
      try {
        runtimeLogger.error('未捕获的异常', error);
      } catch {
        try {
          deps.stderr.write(`未捕获的异常: ${formatErrorLike(error)}\n`);
        } catch {
          // 忽略
        }
      }

      cleanupSync();
      processLike.exit(1);
    });

    processLike.on('unhandledRejection', (reason: unknown) => {
      try {
        runtimeLogger.error('未处理的 Promise 拒绝', reason);
      } catch {
        try {
          deps.stderr.write(`未处理的 Promise 拒绝: ${formatErrorLike(reason)}\n`);
        } catch {
          // 忽略
        }
      }
    });
  }

  return {
    logger: runtimeLogger,
    cleanupSync,
    cleanupAsync,
    registerProcessHooks,
  };
}

const noopLogger: Logger = {
  debug: () => void 0,
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0,
};

let currentLogger: Logger = noopLogger;

/**
 * 运行时 logger facade。
 * 默认行为：在未安装 logger 运行时时使用空实现，避免模块顶层副作用。
 */
export const logger: Logger = {
  debug(msg: string, extra?: unknown): void {
    currentLogger.debug(msg, extra);
  },
  info(msg: string, extra?: unknown): void {
    currentLogger.info(msg, extra);
  },
  warn(msg: string, extra?: unknown): void {
    currentLogger.warn(msg, extra);
  },
  error(msg: string, extra?: unknown): void {
    currentLogger.error(msg, extra);
  },
};

/**
 * 安装当前进程内生效的 logger facade 目标。
 * 默认行为：将 `logger` facade 的方法转发到传入的 logger 实例。
 *
 * @param nextLogger 新的 logger 实例
 * @returns 无返回值
 */
export function installLogger(nextLogger: Logger): void {
  currentLogger = nextLogger;
}

/**
 * 重置 logger facade 的目标回空实现。
 * 默认行为：用于测试清理，避免跨用例泄漏 logger 安装状态。
 *
 * @returns 无返回值
 */
export function resetLogger(): void {
  currentLogger = noopLogger;
}

/**
 * 格式化额外数据为字符串。
 *
 * @param extra 待格式化的数据
 * @returns 格式化后的字符串表示
 */
function formatExtra(extra: unknown): string {
  return inspect(extra, { depth: 5, maxArrayLength: 100 });
}

/**
 * 将未知错误值格式化为字符串。
 *
 * @param error 待格式化的错误值
 * @returns 可直接写入日志的字符串
 */
function formatErrorLike(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return formatExtra(error);
}

/**
 * 获取当前香港时间日期字符串 (YYYY-MM-DD)。
 *
 * @returns 香港日期字符串，无法解析时返回空字符串
 */
function getCurrentDate(): string {
  const timestamp = toHongKongTimeLog(new Date());
  const datePart = timestamp.split(' ').at(0);
  return datePart ?? '';
}

/**
 * 创建带超时保护的 drain 事件处理器。
 *
 * @param stream 文件流或进程流
 * @param timeout 超时时间（毫秒）
 * @param callback 完成回调函数
 * @param onTimeout 超时时的回调函数
 * @returns 包含 drain 事件处理器和超时 ID 的对象
 */
function createDrainHandler(
  stream: NodeJS.WriteStream | Writable,
  timeout: number,
  callback: () => void,
  onTimeout?: () => void,
): { readonly onDrain: () => void; readonly timeoutId: NodeJS.Timeout } {
  let resolved = false;
  const timeoutId = setTimeout(() => {
    if (resolved) {
      return;
    }

    resolved = true;
    stream.removeListener('drain', onDrain);
    onTimeout?.();
    callback();
  }, timeout);

  function onDrain(): void {
    if (resolved) {
      return;
    }

    resolved = true;
    clearTimeout(timeoutId);
    callback();
  }

  return { onDrain, timeoutId };
}

/**
 * 带超时保护的写入辅助函数。
 *
 * @param stream 进程流（stdout/stderr）
 * @param data 待写入数据
 * @param timeout 超时时间（毫秒）
 * @param callback 完成回调函数
 * @returns 无返回值
 */
function writeWithDrainTimeout(
  stream: NodeJS.WriteStream,
  data: string,
  timeout: number,
  callback: () => void,
): void {
  const canContinue = stream.write(data);
  if (canContinue) {
    callback();
    return;
  }

  const { onDrain } = createDrainHandler(stream, timeout, callback);
  stream.once('drain', onDrain);
}

interface DateRotatingStreamState {
  readonly logDir: string;
  readonly logSubDir: string;
  currentDate: string | null;
  fileStream: Writable | null;
  rotatePromise: Promise<void> | null;
}

interface FileStreamChunkParams {
  readonly deps: Pick<LoggerRuntimeDeps, 'stderr'>;
  readonly systemFileStream: ReturnType<typeof createDateRotatingStream>;
  readonly debugFileStream: ReturnType<typeof createDateRotatingStream> | null;
  readonly isDebugEnabled: boolean;
  readonly chunk: Buffer;
  readonly callback: () => void;
}

interface DateRotatingStreamChunkParams {
  readonly deps: Pick<LoggerRuntimeDeps, 'createWritable' | 'fs' | 'joinPath' | 'stderr'>;
  readonly state: DateRotatingStreamState;
  readonly checkRotate: () => Promise<void>;
  readonly chunk: Buffer;
  readonly encoding: BufferEncoding;
  readonly callback: () => void;
}

/**
 * 处理日期轮转文件流的单次写入。
 *
 * @param params 写入参数
 * @returns 无返回值
 */
async function handleDateRotatingStreamChunk(params: DateRotatingStreamChunkParams): Promise<void> {
  const { deps, state, checkRotate, chunk, encoding, callback } = params;
  try {
    await checkRotate();

    if (state.fileStream?.writable !== true) {
      callback();
      return;
    }

    const currentStream = state.fileStream;
    const canContinue = currentStream.write(chunk, encoding);
    if (canContinue) {
      callback();
      return;
    }

    const { onDrain } = createDrainHandler(
      currentStream,
      LOGGING.DRAIN_TIMEOUT_MS,
      callback,
      () => {
        deps.stderr.write(`[DateRotatingStream] drain 超时 (${state.logSubDir})\n`);
      },
    );

    currentStream.once('drain', onDrain);
  } catch (error: unknown) {
    deps.stderr.write(
      `[DateRotatingStream] 写入失败 (${state.logSubDir}): ${formatErrorLike(error)}\n`,
    );
    callback();
  }
}

/**
 * 处理文件流的单次日志写入。
 *
 * @param params 写入参数
 * @returns 无返回值
 */
async function handleFileStreamChunk(params: FileStreamChunkParams): Promise<void> {
  const { deps, systemFileStream, debugFileStream, isDebugEnabled, chunk, callback } = params;
  let obj: LogObject;
  try {
    const parsed: unknown = JSON.parse(chunk.toString());
    if (!isLogObject(parsed)) {
      callback();
      return;
    }

    obj = parsed;
  } catch (error: unknown) {
    try {
      deps.stderr.write(`[FileStream] JSON解析失败: ${formatErrorLike(error)}\n`);
    } catch {
      // 忽略
    }

    callback();
    return;
  }

  try {
    const formatted = formatForFile(obj);
    const writePromises: Promise<void>[] = [];

    writePromises.push(
      new Promise<void>((resolve) => {
        systemFileStream.stream.write(formatted, (error: unknown) => {
          if (error) {
            deps.stderr.write(`[FileStream] 系统日志写入失败: ${formatErrorLike(error)}\n`);
          }

          resolve();
        });
      }),
    );

    if (obj.level === LOG_LEVELS.DEBUG && debugFileStream !== null && isDebugEnabled) {
      writePromises.push(
        new Promise<void>((resolve) => {
          debugFileStream.stream.write(formatted, (error: unknown) => {
            if (error) {
              deps.stderr.write(`[FileStream] Debug日志写入失败: ${formatErrorLike(error)}\n`);
            }

            resolve();
          });
        }),
      );
    }

    await Promise.all(writePromises);
    callback();
  } catch (error: unknown) {
    try {
      deps.stderr.write(`[FileStream] 处理日志失败: ${formatErrorLike(error)}\n`);
    } catch {
      // 忽略
    }

    callback();
  }
}

/**
 * 判断未知值是否满足文件日志格式对象结构。
 *
 * @param value 待判断的未知值
 * @returns 当值包含 level/time/msg 必要字段且类型正确时返回 true
 */
function isLogObject(value: unknown): value is LogObject {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value['level'] === 'number' &&
    typeof value['time'] === 'number' &&
    typeof value['msg'] === 'string'
  );
}

/**
 * 自定义格式化函数，将日志对象转换为文件输出格式。
 *
 * @param obj 日志对象
 * @returns 格式化后的日志行字符串
 */
function formatForFile(obj: LogObject): string {
  const timestamp = toHongKongTimeLog(new Date(obj.time));
  const levelMap: Readonly<Record<number, string>> = {
    20: 'DEBUG',
    30: 'INFO',
    40: 'WARN',
    50: 'ERROR',
  };
  const levelStr = `[${levelMap[obj.level] ?? 'INFO'}]`;
  let line = `${levelStr} ${timestamp} ${stripAnsiCodes(obj.msg)}`;

  if (obj.extra !== undefined && obj.extra !== null) {
    if (typeof obj.extra === 'object') {
      try {
        line += ` ${JSON.stringify(obj.extra)}`;
      } catch {
        line += ` ${stripAnsiCodes(formatExtra(obj.extra))}`;
      }
    } else {
      line += ` ${stripAnsiCodes(formatExtra(obj.extra))}`;
    }
  }

  return `${line}\n`;
}

/**
 * 自定义格式化函数，将日志对象转换为控制台输出格式。
 *
 * @param obj 日志对象
 * @returns 格式化后的日志行字符串
 */
function formatForConsole(obj: LogObject): string {
  const timestamp = toHongKongTimeLog(new Date(obj.time));
  const levelConfig: Readonly<Record<number, { readonly name: string; readonly color: string }>> = {
    20: { name: 'DEBUG', color: LOG_COLORS.gray },
    30: { name: 'INFO', color: '' },
    40: { name: 'WARN', color: LOG_COLORS.yellow },
    50: { name: 'ERROR', color: LOG_COLORS.red },
  };
  const config = levelConfig[obj.level] ?? { name: 'INFO', color: '' };
  const reset = config.color === '' ? '' : LOG_COLORS.reset;
  let line = `${config.color}[${config.name}] ${timestamp} ${obj.msg}${reset}`;

  if (obj.extra !== undefined && obj.extra !== null) {
    if (typeof obj.extra === 'object') {
      try {
        line += ` ${JSON.stringify(obj.extra)}`;
      } catch {
        line += ` ${formatExtra(obj.extra)}`;
      }
    } else {
      line += ` ${formatExtra(obj.extra)}`;
    }
  }

  return `${line}\n`;
}

/**
 * 移除字符串中的 ANSI 颜色/转义代码，用于文件日志输出时得到纯文本。
 *
 * @param str 可能包含 ANSI 代码的字符串
 * @returns 移除转义序列后的字符串
 */
function stripAnsiCodes(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }

  return str.replaceAll(LOG_ANSI_CODE_REGEX, '');
}

/**
 * 创建按日期分割的文件流（用于 pino 传输）。
 *
 * @param logRootDir 日志根目录
 * @param logSubDir 子目录名称
 * @returns 文件流与关闭句柄
 */
function createDateRotatingStream(params: {
  readonly deps: Pick<LoggerRuntimeDeps, 'createWritable' | 'fs' | 'joinPath' | 'stderr'>;
  readonly logRootDir: string;
  readonly logSubDir: string;
}): {
  readonly stream: Writable;
  readonly closeSync: () => void;
  readonly closeAsync: () => Promise<void>;
} {
  const { deps, logRootDir, logSubDir } = params;
  const logDir = deps.joinPath(logRootDir, logSubDir);
  if (!deps.fs.existsSync(logDir)) {
    deps.fs.mkdirSync(logDir, { recursive: true });
  }

  const state: DateRotatingStreamState = {
    logDir,
    logSubDir,
    currentDate: null,
    fileStream: null,
    rotatePromise: null,
  };

  const stream = deps.createWritable({
    write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      void handleDateRotatingStreamChunk({
        deps,
        state,
        checkRotate,
        chunk,
        encoding,
        callback,
      });
    },
  });

  /**
   * 同步关闭文件流。
   *
   * @returns 无返回值
   */
  function closeSync(): void {
    if (state.fileStream === null) {
      return;
    }

    try {
      state.fileStream.end();
      state.fileStream = null;
    } catch {
      // 忽略
    }
  }

  /**
   * 异步关闭文件流。
   *
   * @returns 关闭完成后的 Promise
   */
  async function closeAsync(): Promise<void> {
    if (state.fileStream === null) {
      return;
    }

    const currentStream = state.fileStream;
    state.fileStream = null;

    await new Promise<void>((resolve) => {
      currentStream.once('finish', () => {
        resolve();
      });

      currentStream.once('error', () => {
        resolve();
      });

      currentStream.end();
    });
  }

  /**
   * 检查并切换日志文件（如果日期变化）。
   *
   * @returns Promise，确保旧流关闭完成后再继续
   */
  async function checkRotate(): Promise<void> {
    const today = getCurrentDate();
    if (state.currentDate === today) {
      return;
    }

    if (state.rotatePromise !== null) {
      await state.rotatePromise;
      if (state.currentDate === today) {
        return;
      }
    }

    state.rotatePromise = doRotate(today);
    try {
      await state.rotatePromise;
    } finally {
      state.rotatePromise = null;
    }
  }

  /**
   * 执行实际的日志轮转操作。
   *
   * @param newDate 新日期字符串
   * @returns 无返回值
   */
  async function doRotate(newDate: string): Promise<void> {
    try {
      if (state.fileStream !== null) {
        const currentStream = state.fileStream;
        state.fileStream = null;

        await new Promise<void>((resolve) => {
          currentStream.once('finish', () => {
            resolve();
          });

          currentStream.once('error', (error: unknown) => {
            deps.stderr.write(
              `[DateRotatingStream] 关闭旧流错误 (${logSubDir}): ${formatErrorLike(error)}\n`,
            );
            resolve();
          });

          currentStream.end();
        });
      }

      state.currentDate = newDate;
      const currentLogFileName = `${state.currentDate}.log`;
      retainLatestLogFiles(
        deps,
        state.logDir,
        LOGGING.MAX_RETAINED_LOG_FILES,
        'log',
        currentLogFileName,
      );
      const logFile = deps.joinPath(state.logDir, currentLogFileName);
      state.fileStream = deps.fs.createWriteStream(logFile, {
        flags: 'a',
        encoding: 'utf8',
      });

      state.fileStream.on('error', (error: unknown) => {
        deps.stderr.write(
          `[DateRotatingStream] 文件流错误 (${state.logSubDir}): ${formatErrorLike(error)}\n`,
        );
      });
    } catch (error: unknown) {
      deps.stderr.write(
        `[DateRotatingStream] 日志轮转失败 (${state.logSubDir}): ${formatErrorLike(error)}\n`,
      );
    }
  }

  return {
    stream,
    closeSync,
    closeAsync,
  };
}

/**
 * 创建控制台流（使用自定义格式）。
 *
 * @returns 控制台输出流
 */
function createConsoleStream(
  deps: Pick<LoggerRuntimeDeps, 'createWritable' | 'stderr' | 'stdout'>,
): Writable {
  return deps.createWritable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
      try {
        const parsed: unknown = JSON.parse(chunk.toString());
        if (!isLogObject(parsed)) {
          callback();
          return;
        }

        const formatted = formatForConsole(parsed);
        if (parsed.level >= LOG_LEVELS.WARN) {
          writeWithDrainTimeout(deps.stderr, formatted, LOGGING.CONSOLE_DRAIN_TIMEOUT_MS, callback);
          return;
        }

        writeWithDrainTimeout(deps.stdout, formatted, LOGGING.CONSOLE_DRAIN_TIMEOUT_MS, callback);
      } catch (error: unknown) {
        try {
          deps.stderr.write(`[Logger Error] ${formatErrorLike(error)}\n`);
        } catch {
          // 如果连 stderr 都失败，只能忽略
        }

        callback();
      }
    },
  });
}

/**
 * 创建文件流（使用自定义格式）。
 *
 * @param params 文件流依赖
 * @returns 文件输出流
 */
function createFileStream(params: {
  readonly deps: Pick<LoggerRuntimeDeps, 'createWritable' | 'stderr'>;
  readonly systemFileStream: ReturnType<typeof createDateRotatingStream>;
  readonly debugFileStream: ReturnType<typeof createDateRotatingStream> | null;
  readonly isDebugEnabled: boolean;
}): Writable {
  return params.deps.createWritable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
      void handleFileStreamChunk({
        deps: params.deps,
        systemFileStream: params.systemFileStream,
        debugFileStream: params.debugFileStream,
        isDebugEnabled: params.isDebugEnabled,
        chunk,
        callback,
      }).catch((error: unknown) => {
        try {
          params.deps.stderr.write(`[FileStream] 未捕获的异常: ${formatErrorLike(error)}\n`);
        } catch {
          // 忽略
        }

        callback();
      });
    },
  });
}
