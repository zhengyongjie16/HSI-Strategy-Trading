/**
 * LongBridge 港股自动化量化交易系统 - 薄入口模块
 *
 * 职责：
 * - 初始化 dotenv 环境变量
 * - 在入口处统一装配 logger / tradeLogger 运行时边界
 * - 调用 app 顶层组装入口
 * - 在最外层统一处理启动异常输出
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { runApp } from './app/runApp.js';

dotenv.config({ path: '.env.local' });

const { createLoggerRuntime, installLogger } = await import('./utils/logger/index.js');
const { createTradeLoggerRuntime, installTradeLogger } =
  await import('./core/trader/tradeLogger.js');
const createWritable = ({
  write,
}: {
  readonly write: (
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) => void;
}): Writable =>
  new Writable({
    write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      write(chunk, encoding, callback);
    },
  });

const joinPath = (...parts: ReadonlyArray<string>) => path.join(...parts);
const fileSystemDeps = {
  createWriteStream: (filePath: string, options: Parameters<typeof fs.createWriteStream>[1]) =>
    fs.createWriteStream(filePath, options),
  existsSync: (filePath: string) => fs.existsSync(filePath),
  mkdirSync: (dirPath: string, options: { readonly recursive: boolean }) => {
    fs.mkdirSync(dirPath, options);
  },
  readdirSync: (dirPath: string) => fs.readdirSync(dirPath),
  statSync: (filePath: string) => fs.statSync(filePath),
  unlinkSync: (filePath: string) => {
    fs.unlinkSync(filePath);
  },
  readFileSync: (filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding),
  writeFileSync: (filePath: string, data: string, encoding: BufferEncoding) => {
    fs.writeFileSync(filePath, data, encoding);
  },
};

function createPinoLogger(params: {
  readonly isDebugEnabled: boolean;
  readonly consoleStream: Writable;
  readonly fileStream: Writable;
}) {
  const { isDebugEnabled, consoleStream, fileStream } = params;
  return pino(
    {
      level: isDebugEnabled ? 'debug' : 'info',
      customLevels: {
        debug: 20,
        info: 30,
        warn: 40,
        error: 50,
      },
      useOnlyCustomLevels: true,
    },
    pino.multistream([
      {
        level: isDebugEnabled ? 'debug' : 'info',
        stream: consoleStream,
      },
      {
        level: isDebugEnabled ? 'debug' : 'info',
        stream: fileStream,
      },
    ]),
  );
}

const loggerRuntime = createLoggerRuntime({
  env: process.env,
  processLike: process,
  deps: {
    createWritable,
    createPinoLogger,
    fs: fileSystemDeps,
    joinPath,
    stdout: process.stdout,
    stderr: process.stderr,
  },
});

installLogger(loggerRuntime.logger);
loggerRuntime.registerProcessHooks();

const tradeLoggerRuntime = createTradeLoggerRuntime({
  deps: {
    env: process.env,
    fs: fileSystemDeps,
    joinPath,
    logger: loggerRuntime.logger,
    stderr: process.stderr,
  },
});

installTradeLogger(tradeLoggerRuntime.recordTrade);

try {
  await runApp({ env: process.env });
} catch (err: unknown) {
  if (err instanceof Error) {
    if (err.name === 'ConfigValidationError') {
      console.error('程序启动失败：配置验证未通过');
      loggerRuntime.cleanupSync();
      process.exit(1);
    }

    if (err.name === 'AppStartupAbortError') {
      loggerRuntime.cleanupSync();
      process.exit(1);
    }
  }

  console.error('程序异常退出', err);
  loggerRuntime.cleanupSync();
  process.exit(1);
}
