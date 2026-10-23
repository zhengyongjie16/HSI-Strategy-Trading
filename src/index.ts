/**
 * LongBridge 港股自动化量化交易系统 - 薄入口模块
 *
 * 职责：
 * - 消费由 Bun 启动时准备的环境变量
 * - 调用 app 顶层组装入口
 * - 在最外层统一处理启动异常输出，等待日志关闭后决定退出方式
 */
import { runApp } from './app/runApp.js';
import { shutdownLogger } from './infrastructure/logger/index.js';

let hasFailed = false;
let loggerShutdownCompleted = false;

try {
  await runApp({ env: process.env });
} catch (err: unknown) {
  hasFailed = true;
  if (err instanceof Error && err.name === 'ConfigValidationError') {
    console.error('程序启动失败：配置验证未通过');
  } else if (!(err instanceof Error && err.name === 'AppStartupAbortError')) {
    console.error('程序异常退出', err);
  }
} finally {
  try {
    loggerShutdownCompleted = await shutdownLogger();
  } catch (shutdownError: unknown) {
    console.error('日志关闭异常', shutdownError);
    hasFailed = true;
  }
}

if (hasFailed) {
  process.exit(1);
}

if (!loggerShutdownCompleted) {
  process.exit();
}
