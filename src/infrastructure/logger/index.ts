/**
 * 文本日志基础设施
 *
 * 调用时固定时间与 extra 文本，按 file → console 投递到两个 Writable 队列；
 * 保留共同文件回调屏障、按消费日轮转及有界的资源关闭。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { inspect } from 'node:util';
import {
  IS_DEBUG,
  LOG_ANSI_CODE_REGEX,
  LOGGING,
  LOG_LEVELS,
  LOG_COLORS,
} from '../../constants/common.js';
import { resolveLogRootDir, shouldInstallGlobalProcessHooks } from '../../config/runtime/index.js';
import { toHongKongTimeLog } from '../../utils/time/index.js';
import type { Logger } from '../../types/logger.js';
import type { PreparedLogRecord, StandardStreamObserver } from './types.js';

const levelConfig = {
  [LOG_LEVELS.DEBUG]: { name: 'DEBUG', color: LOG_COLORS.gray },
  [LOG_LEVELS.INFO]: { name: 'INFO', color: '' },
  [LOG_LEVELS.WARN]: { name: 'WARN', color: LOG_COLORS.yellow },
  [LOG_LEVELS.ERROR]: { name: 'ERROR', color: LOG_COLORS.red },
} as const;

let closing = false;
let shutdownPromise: Promise<boolean> | null = null;
let shutdownIoFailed = false;
let rejectActiveShutdown: ((error: Error) => void) | null = null;

/** 只记录关闭期间的 IO 失败；关闭结果不追溯历史每条日志的成功与否。 */
function markIoFailure(): void {
  if (closing) {
    shutdownIoFailed = true;
  }
}

/** 将内部异步失败交给 Writable/关闭协议，不把编程错误降级为外部 IO 失败。 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('日志内部错误', { cause: error });
}

/** 同步 IO 调用仅接收系统错误；参数、状态或其他编程错误继续传播。 */
function isSystemIoError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^E[A-Z\d]+$/.test(error.code)
  );
}

/** 不再有未完成写入或待发 error 时，释放本模块的标准流观察器。 */
function releaseStandardObserver(observer: StandardStreamObserver): void {
  if (
    observer.listening &&
    observer.releaseRequested &&
    observer.pendingWrites === 0 &&
    !observer.awaitingError
  ) {
    observer.stream.removeListener('error', observer.onError);
    observer.stream.removeListener('close', observer.onClose);
    observer.listening = false;
  }
}

/** 标准流属于进程；只观察自身写入，绝不 end/destroy。 */
function createStandardObserver(
  stream: NodeJS.WriteStream,
  name: 'stdout' | 'stderr',
): StandardStreamObserver {
  const observer: StandardStreamObserver = {
    stream,
    name,
    pendingWrites: 0,
    errorEvents: 0,
    awaitingError: false,
    listening: false,
    releaseRequested: false,
    reportedFailure: false,
    onError(error: Error): void {
      observer.errorEvents += 1;
      observer.awaitingError = false;
      markIoFailure();
      if (!observer.reportedFailure) {
        observer.reportedFailure = true;
        if (name === 'stdout') {
          reportDiagnostic('[Logger] stdout 写入失败:', error);
        }
      }

      releaseStandardObserver(observer);
    },
    onClose(): void {
      observer.awaitingError = false;
      releaseStandardObserver(observer);
    },
  };
  return observer;
}

const stdoutObserver = createStandardObserver(process.stdout, 'stdout');
const stderrObserver = createStandardObserver(process.stderr, 'stderr');

/** 在 write 之前安装错误观察，覆盖 write 返回 true 后才到达的 IO 错误。 */
function observeStandardStream(observer: StandardStreamObserver): void {
  if (!observer.listening) {
    observer.listening = true;
    observer.stream.on('error', observer.onError);
    observer.stream.on('close', observer.onClose);
  }
}

/**
 * 保留标准流的原生背压返回值，同时消费写回调与其后可能到达的 error。
 * 错误回调不等于 error 事件已发出，不能在该回调内删掉唯一的错误监听。
 */
function writeStandardStream(
  observer: StandardStreamObserver,
  data: string,
  onComplete?: (error?: Error | null) => void,
): boolean {
  observeStandardStream(observer);
  observer.pendingWrites += 1;
  const previousErrorEvents = observer.errorEvents;
  const state = { completed: false };

  const complete = (error?: Error | null): void => {
    if (state.completed) {
      return;
    }

    state.completed = true;
    observer.pendingWrites -= 1;
    if (error) {
      markIoFailure();
      if (observer.errorEvents === previousErrorEvents && !observer.stream.closed) {
        observer.awaitingError = true;
      }
    }

    onComplete?.(error);
    releaseStandardObserver(observer);
  };

  try {
    return observer.stream.write(data, complete);
  } catch (error) {
    if (!state.completed) {
      state.completed = true;
      observer.pendingWrites -= 1;
    }

    if (!isSystemIoError(error)) {
      throw error;
    }

    markIoFailure();
    if (observer.name === 'stdout' && !observer.reportedFailure) {
      observer.reportedFailure = true;
      reportDiagnostic('[Logger] stdout 写入失败:', error);
    }

    onComplete?.(error);
    releaseStandardObserver(observer);
    return true;
  }
}

/** 独立旁路诊断，不递归调用 logger，也不让诊断失败替换原错误。 */
function reportDiagnostic(message: string, error?: unknown): void {
  try {
    const detail =
      error === undefined
        ? ''
        : ` ${inspect(error, { depth: 5, maxArrayLength: 100, customInspect: false })}`;
    writeStandardStream(stderrObserver, `${message}${detail}\n`);
  } catch {
    // stderr 也可能已经不可写；旁路报告仅尽力而为。
  }
}

/** 外部文件/标准流失败保持旁路政策，不向交易调用方抛出。 */
function reportIoFailure(message: string, error?: unknown): void {
  markIoFailure();
  reportDiagnostic(message, error);
}

/**
 * 保留最新文件，沿用当日文件已存在/即将新建时不同的计数规则。
 * 只处理日志目录，不接触交易恢复 JSONL。
 */
function retainLatestLogFiles(
  logDir: string,
  maxFiles: number,
  extension: string,
  currentFileName: string,
): void {
  if (maxFiles < 1 || !fs.existsSync(logDir)) {
    return;
  }

  const files: string[] = [];
  for (const name of fs.readdirSync(logDir)) {
    if (!name.endsWith('.' + extension)) {
      continue;
    }

    try {
      if (fs.statSync(path.join(logDir, name)).isFile()) {
        files.push(name);
      }
    } catch (error) {
      if (!isSystemIoError(error)) {
        throw error;
      }
      // 无法 stat 的项与原实现一样跳过。
    }
  }

  files.sort((a, b) => a.localeCompare(b, 'en'));
  const toRetain = files.includes(currentFileName) ? maxFiles : Math.max(0, maxFiles - 1);
  const toDelete = Math.max(0, files.length - toRetain);
  for (const name of files.slice(0, toDelete)) {
    const fullPath = path.join(logDir, name);
    try {
      fs.unlinkSync(fullPath);
    } catch (error) {
      if (!isSystemIoError(error)) {
        throw error;
      }

      reportIoFailure(`[logRetention] 删除旧日志失败: ${fullPath}`, error);
    }
  }
}

/** 只格式化已确认的原始值，绝不 inspect 不可信对象或调用其 customInspect。 */
function formatScalarExtra(extra: unknown): string {
  if (typeof extra === 'string' || typeof extra === 'boolean') {
    return inspect(extra, { depth: 5, maxArrayLength: 100 });
  }

  if (typeof extra === 'number' && Number.isFinite(extra)) {
    return inspect(Object.is(extra, -0) ? 0 : extra, { depth: 5, maxArrayLength: 100 });
  }

  if (typeof extra === 'bigint') {
    return inspect(String(extra), { depth: 5, maxArrayLength: 100 });
  }

  return '';
}

/**
 * 在调用内安全固定 extra；只执行一轮原生 stringify，由原生处理 toJSON/枚举规则。
 * 祖先路径区分循环与共享引用，BigInt 保真为字符串；失败不覆盖业务原错。
 */
function formatExtra(extra: unknown): string {
  if (extra === null || typeof extra !== 'object') {
    return formatScalarExtra(extra);
  }

  try {
    const ancestors: unknown[] = [];
    const serialized: unknown = JSON.stringify(
      extra,
      function (this: unknown, _key, value: unknown): unknown {
        if (typeof value === 'bigint') {
          return String(value);
        }

        if (value !== null && typeof value === 'object') {
          while (ancestors.length > 0 && ancestors.at(-1) !== this) {
            ancestors.pop();
          }

          if (ancestors.includes(value)) {
            return '[Circular]';
          }

          ancestors.push(value);
        }

        return value;
      },
    );
    if (typeof serialized !== 'string' || serialized === 'null') {
      return '';
    }

    if (serialized.startsWith('{') || serialized.startsWith('[')) {
      return serialized;
    }

    // Date、boxed primitive 或 toJSON 的标量结果；不解析对象或完整日志记录。
    const scalar: unknown = JSON.parse(serialized);
    return formatScalarExtra(scalar);
  } catch {
    return "'[Unserializable]'";
  }
}

/** 当前实际消费时的香港日期，不能换成日志记录的调用时间。 */
function getCurrentDate(): string {
  return toHongKongTimeLog(new Date()).split(' ').at(0) ?? '';
}

/**
 * 单次 drain 等待：drain/error/close/超时/取消共用结算与清理。
 * 返回的取消函数释放监听、timer 和当前 Writable 回调，不销毁传入的全局标准流。
 */
function waitForDrain(
  stream: fs.WriteStream | NodeJS.WriteStream,
  timeout: number,
  callback: () => void,
  onTimeout?: () => void,
): () => void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function complete(): void {
    if (settled) {
      return;
    }

    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
    }

    stream.removeListener('drain', complete);
    stream.removeListener('error', onFailure);
    stream.removeListener('close', onFailure);
    callback();
  }

  function onFailure(): void {
    markIoFailure();
    complete();
  }

  stream.once('drain', complete);
  stream.once('error', onFailure);
  stream.once('close', onFailure);
  if (stream.destroyed || stream.closed || stream.errored) {
    onFailure();
  } else {
    timer = setTimeout(() => {
      markIoFailure();
      onTimeout?.();
      complete();
    }, timeout);
  }

  return complete;
}

/** 按日期分割的文件流；继承 Writable 以保留既有串行消费与背压语义。 */
class DateRotatingStream extends Writable {
  private readonly _logSubDir: string;
  private readonly _logDir: string;
  private _currentDate: string | null = null;
  private _fileStream: fs.WriteStream | null = null;
  private _rotatePromise: Promise<void> | null = null;
  private _cancelWait: (() => void) | null = null;
  private _cancelWrite: (() => void) | null = null;

  public constructor(logRootDir: string, logSubDir: string) {
    super();
    this._logSubDir = logSubDir;
    this._logDir = path.join(logRootDir, logSubDir);
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  /** await 后重新检查销毁状态，防止超时取消后续开文件或迟到写入。 */
  public override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let settled = false;
    const complete = (error?: Error | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      this._cancelWrite = null;
      callback(error);
    };
    this._cancelWrite = complete;
    void this._checkRotate()
      .then(() => {
        if (this.destroyed) {
          complete();
          return;
        }

        const currentStream = this._fileStream;
        if (!currentStream?.writable) {
          markIoFailure();
          if (IS_DEBUG) {
            reportDiagnostic(`[DateRotatingStream] 文件流不可用 (${this._logSubDir})`);
          }

          complete();
          return;
        }

        let canContinue: boolean;
        try {
          canContinue = currentStream.write(chunk, encoding);
        } catch (error) {
          if (!isSystemIoError(error)) {
            throw error;
          }

          reportIoFailure(`[DateRotatingStream] 写入失败 (${this._logSubDir}):`, error);
          complete();
          return;
        }

        if (canContinue) {
          complete();
        } else {
          this._cancelWait = waitForDrain(
            currentStream,
            LOGGING.DRAIN_TIMEOUT_MS,
            () => {
              this._cancelWait = null;
              complete();
            },
            () => {
              if (IS_DEBUG) {
                reportDiagnostic(`[DateRotatingStream] drain 超时 (${this._logSubDir})`);
              }
            },
          );
        }
      })
      .catch((error: unknown) => {
        complete(asError(error));
      });
  }

  /** 队列排空后结束并观察底层文件 finish/close；未写入过时不新建文件。 */
  public override _final(callback: (error?: Error | null) => void): void {
    const stream = this._fileStream;
    if (!stream || this.destroyed) {
      callback();
      return;
    }

    void this._closeFileStream(stream).then(
      () => {
        callback();
      },
      (error: unknown) => {
        callback(asError(error));
      },
    );
  }

  /** 同时覆盖当前文件与轮转中仍在关闭的旧文件；不等待不可控的系统销毁完成。 */
  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this._cancelWait?.();
    this._cancelWait = null;
    this._cancelWrite?.();
    this._cancelWrite = null;
    this._fileStream?.destroy();
    callback(error);
  }

  /** 每次调用都读取 Writable 状态，包含 await 期间发生的销毁。 */
  private _isCancelled(): boolean {
    return this.destroyed;
  }

  private async _checkRotate(): Promise<void> {
    if (this._isCancelled()) {
      return;
    }

    const today = getCurrentDate();
    if (this._currentDate === today) {
      return;
    }

    if (this._rotatePromise) {
      await this._rotatePromise;
      if (this._isCancelled() || this._currentDate === today) {
        return;
      }
    }

    this._rotatePromise = this._doRotate(today);
    try {
      await this._rotatePromise;
    } finally {
      this._rotatePromise = null;
    }
  }

  /** 旧流在整个关闭等待内保持可取消引用；每个 await 后阻止取消后的续开。 */
  private async _doRotate(newDate: string): Promise<void> {
    if (this._isCancelled()) {
      return;
    }

    if (this._fileStream) {
      await this._closeFileStream(this._fileStream);
      if (this._isCancelled()) {
        return;
      }

      this._fileStream = null;
    }

    this._currentDate = newDate;
    const currentFileName = `${newDate}.log`;
    try {
      retainLatestLogFiles(this._logDir, LOGGING.MAX_RETAINED_LOG_FILES, 'log', currentFileName);
      if (this._isCancelled()) {
        return;
      }

      this._fileStream = fs.createWriteStream(path.join(this._logDir, currentFileName), {
        flags: 'a',
        encoding: 'utf8',
      });
    } catch (error) {
      if (!isSystemIoError(error)) {
        throw error;
      }

      reportIoFailure(`[DateRotatingStream] 日志轮转失败 (${this._logSubDir}):`, error);
      return;
    }

    this._fileStream.on('error', (error: Error) => {
      reportIoFailure(`[DateRotatingStream] 文件流错误 (${this._logSubDir}):`, error);
    });

    if (this._isCancelled()) {
      this._fileStream.destroy();
    }
  }

  /** finished 等待自有文件资源关闭，AbortController 只取消观察，销毁由 _destroy 负责。 */
  private async _closeFileStream(stream: fs.WriteStream): Promise<void> {
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
    };
    this._cancelWait = cancel;
    // 错误由文件流监听旁路报告；这里仍等 close，不能在 error 时提前丢掉旧流引用。
    const completion = finished(stream, { cleanup: true, error: false, signal: controller.signal });
    try {
      try {
        stream.end();
      } catch (error) {
        if (!isSystemIoError(error)) {
          controller.abort();
          throw error;
        }

        reportIoFailure(`[DateRotatingStream] 结束文件失败 (${this._logSubDir}):`, error);
        stream.destroy();
      }

      try {
        await completion;
      } catch (error) {
        if (!this.destroyed && !controller.signal.aborted) {
          reportIoFailure(`[DateRotatingStream] 关闭文件失败 (${this._logSubDir}):`, error);
        }
      }
    } finally {
      // end 同步抛错时也消费取消观察产生的 rejection。
      void completion.catch(() => null);
      if (this._cancelWait === cancel) {
        this._cancelWait = null;
      }
    }
  }
}

const logRootDir = resolveLogRootDir(process.env);
const systemFileStream = new DateRotatingStream(logRootDir, 'system');
const debugFileStream = IS_DEBUG ? new DateRotatingStream(logRootDir, 'debug') : null;
let cancelConsoleWrite: (() => void) | null = null;
let cancelFileWrite: (() => void) | null = null;

/** 控制台队列只按级别路由已准备文本，不重新访问 extra 或解析记录。 */
const consoleStream = new Writable({
  objectMode: true,
  write(record: PreparedLogRecord, _encoding, callback): void {
    let settled = false;
    const complete = (error?: Error | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      cancelConsoleWrite = null;
      callback(error);
    };
    cancelConsoleWrite = complete;
    try {
      const observer = record.level >= LOG_LEVELS.WARN ? stderrObserver : stdoutObserver;
      if (writeStandardStream(observer, record.consoleLine)) {
        complete();
      } else {
        cancelConsoleWrite = waitForDrain(
          observer.stream,
          LOGGING.CONSOLE_DRAIN_TIMEOUT_MS,
          complete,
        );
      }
    } catch (error) {
      complete(asError(error));
    }
  },
  destroy(error, callback): void {
    cancelConsoleWrite?.();
    cancelConsoleWrite = null;
    callback(error);
  },
});

/** system/debug 的本条回调全部落定才消费下一条，不能改成直接扇出。 */
const fileStream = new Writable({
  objectMode: true,
  write(record: PreparedLogRecord, _encoding, callback): void {
    const needsDebug = record.level === LOG_LEVELS.DEBUG && debugFileStream !== null;
    let pending = needsDebug ? 2 : 1;
    let settled = false;
    const complete = (error?: Error | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      cancelFileWrite = null;
      callback(error);
    };

    const onWrite = (error?: Error | null): void => {
      if (error && !fileStream.destroyed) {
        complete(error);
        return;
      }

      pending -= 1;
      if (pending === 0) {
        complete();
      }
    };
    cancelFileWrite = complete;
    try {
      systemFileStream.write(record.fileLine, onWrite);
      if (needsDebug) {
        debugFileStream.write(record.fileLine, onWrite);
      }
    } catch (error) {
      complete(asError(error));
    }
  },
  destroy(error, callback): void {
    cancelFileWrite?.();
    cancelFileWrite = null;
    callback(error);
  },
});

/** 自有队列的错误表示内部契约/编程错误，运行期 fail-fast，关闭期 reject。 */
function onOwnedStreamError(error: Error): void {
  if (!closing) {
    throw error;
  }

  rejectActiveShutdown?.(error);
}

for (const stream of [consoleStream, fileStream, systemFileStream, debugFileStream]) {
  stream?.on('error', onOwnedStreamError);
}

/** 同步准备两端文本并按真实的 file → console 次序投递，方法不依赖 this。 */
function writeLog(level: PreparedLogRecord['level'], msg: string, extra: unknown): void {
  if (level === LOG_LEVELS.DEBUG && !IS_DEBUG) {
    return;
  }

  if (closing) {
    throw new Error('日志已开始关闭，不能继续写入');
  }

  const timestamp = toHongKongTimeLog(new Date());
  const formattedExtra = formatExtra(extra);
  const suffix = formattedExtra === '' ? '' : ` ${formattedExtra}`;
  const config = levelConfig[level];
  const reset = config.color === '' ? '' : LOG_COLORS.reset;
  const prefix = `[${config.name}] ${timestamp} `;
  const record: PreparedLogRecord = {
    level,
    consoleLine: `${config.color}${prefix}${msg}${reset}${suffix}\n`,
    fileLine: `${prefix}${msg.replaceAll(LOG_ANSI_CODE_REGEX, '')}${suffix.replaceAll(LOG_ANSI_CODE_REGEX, '')}\n`,
  };
  fileStream.write(record);
  consoleStream.write(record);
}

/** 同步四方法单例；只接受消息与可选 extra，不向业务暴露关闭或流操作。 */
export const logger: Logger = {
  debug(msg: string, extra?: unknown): void {
    writeLog(LOG_LEVELS.DEBUG, msg, extra);
  },
  info(msg: string, extra?: unknown): void {
    writeLog(LOG_LEVELS.INFO, msg, extra);
  },
  warn(msg: string, extra?: unknown): void {
    writeLog(LOG_LEVELS.WARN, msg, extra);
  },
  error(msg: string, extra?: unknown): void {
    writeLog(LOG_LEVELS.ERROR, msg, extra);
  },
};

/** 先安装 finished 再 end；同步 end 失败也不遗留未消费的完成观察。 */
async function endOwnedStream(stream: Writable, signal: AbortSignal): Promise<void> {
  const completion = finished(stream, { cleanup: true, signal });
  try {
    stream.end();
    await completion;
  } catch (error) {
    void completion.catch(() => null);
    throw error;
  }
}

/** 外层排空之后才结束下游，console 的慢端不会延迟文件自身的关闭。 */
async function closeFileStreams(signal: AbortSignal): Promise<void> {
  await endOwnedStream(fileStream, signal);
  if (signal.aborted) {
    return;
  }

  await Promise.all([
    endOwnedStream(systemFileStream, signal),
    ...(debugFileStream ? [endOwnedStream(debugFileStream, signal)] : []),
  ]);
}

/** 每次读取 signal，避免把 await 前的状态当作异步等待后的状态。 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** 标准流仅提交回调屏障；错误、关闭、取消与写回调只结算一次。 */
function standardStreamBarrier(
  observer: StandardStreamObserver,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    function complete(error?: Error | null, internal = false): void {
      if (settled) {
        return;
      }

      settled = true;
      observer.stream.removeListener('error', onError);
      observer.stream.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
      if (internal && error) {
        reject(error);
        return;
      }

      if (error) {
        markIoFailure();
      }

      resolve();
    }

    function onError(error: Error): void {
      complete(error);
    }

    function onClose(): void {
      markIoFailure();
      complete();
    }

    function onAbort(): void {
      complete();
    }

    if (signal.aborted) {
      complete();
      return;
    }

    observeStandardStream(observer);
    observer.stream.once('error', onError);
    observer.stream.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      writeStandardStream(observer, '', complete);
    } catch (error) {
      complete(asError(error), true);
    }
  });
}

/** 先停止外层队列，再取消内层等待；所有持有旧流的实例仍能被 destroy 触达。 */
function cancelOwnedWork(): Error | null {
  let failure: Error | null = null;
  for (const stream of [consoleStream, fileStream, systemFileStream, debugFileStream]) {
    try {
      stream?.destroy();
    } catch (error) {
      failure ??= asError(error);
    }
  }

  return failure;
}

/** 完成/取消后撤销标准流观察；未决写入只保留消费迟到错误所需的监听。 */
function releaseStandardObservers(): void {
  stdoutObserver.releaseRequested = true;
  stderrObserver.releaseRequested = true;
  releaseStandardObserver(stdoutObserver);
  releaseStandardObserver(stderrObserver);
}

/**
 * 单次有界关闭。true 仅表示本次队列、文件关闭与标准流屏障完成，不是 fsync 或历史成功保证。
 * 外部 IO/总超时返回 false；内部错误在取消自有工作后 reject。同步发布同一个 Promise。
 */
export function shutdownLogger(): Promise<boolean> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  closing = true;
  shutdownPromise = new Promise<boolean>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let reportedFailure = false;
    const reportFailure = (message: string): void => {
      if (!reportedFailure) {
        reportedFailure = true;
        reportDiagnostic(message);
      }
    };

    const timer = setTimeout(() => {
      reportFailure(`[Logger] 日志关闭超时 (${LOGGING.SHUTDOWN_TIMEOUT_MS}ms)`);
      complete(false);
    }, LOGGING.SHUTDOWN_TIMEOUT_MS);

    function complete(success: boolean, error?: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      rejectActiveShutdown = null;
      let internalError = error;
      if (!success) {
        controller.abort();
        const cancelError = cancelOwnedWork();
        internalError ??= cancelError ?? undefined;
      }

      releaseStandardObservers();
      if (internalError) {
        reject(internalError);
      } else {
        resolve(success);
      }
    }

    rejectActiveShutdown = (error: Error): void => {
      complete(false, error);
    };

    // Promise 先发布，再触发任何 end/回调；重入 shutdown 也只能取得这个 Promise。
    queueMicrotask(() => {
      void (async () => {
        await Promise.all([
          closeFileStreams(controller.signal),
          endOwnedStream(consoleStream, controller.signal),
        ]);

        if (isAborted(controller.signal)) {
          return;
        }

        // 文件关闭及其旁路诊断全部先于标准流屏障，包含入口直接写入 stderr 的错误。
        if (shutdownIoFailed) {
          reportFailure('[Logger] 日志关闭期间发生 IO 失败');
        }

        await Promise.all([
          standardStreamBarrier(stdoutObserver, controller.signal),
          standardStreamBarrier(stderrObserver, controller.signal),
        ]);

        if (!isAborted(controller.signal)) {
          if (shutdownIoFailed) {
            reportFailure('[Logger] 日志关闭期间发生 IO 失败');
          }

          complete(!shutdownIoFailed);
        }
      })().catch((error: unknown) => {
        if (!controller.signal.aborted) {
          complete(false, asError(error));
        }
      });
    });
  });
  return shutdownPromise;
}

/** 进程异常仍按原策略报告；关闭状态下不递归触碰已结束的日志队列。 */
function reportProcessError(message: string, error: unknown): void {
  if (closing) {
    reportDiagnostic(`${message}:`, error);
    return;
  }

  try {
    logger.error(message, error);
  } catch {
    reportDiagnostic(`${message}:`, error);
  }
}

if (shouldInstallGlobalProcessHooks(process.env)) {
  process.once('beforeExit', () => {
    void shutdownLogger().then(
      (success) => {
        if (!success) {
          process.exit();
        }
      },
      (error: unknown) => {
        reportDiagnostic('[Logger] 日志关闭内部错误:', error);
        process.exit(1);
      },
    );
  });

  process.on('uncaughtException', (error: Error) => {
    reportProcessError('未捕获的异常', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    reportProcessError('未处理的 Promise 拒绝', reason);
  });
}
