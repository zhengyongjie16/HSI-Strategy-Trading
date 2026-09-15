/**
 * calculateTradingFees 入口业务测试
 *
 * 覆盖：
 * - 校验工具读取默认交易日志路径并输出费用明细与汇总
 * - 防止入口层在读取持久化交易日志后跳过主输出流程
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

describe('calculateTradingFees index entry flow', () => {
  it('reads the default trade log file and prints fee details plus summary', async () => {
    const originalCwd = process.cwd();
    const originalConsoleLog = console.log;
    const root = mkdtempSync(path.join(tmpdir(), 'calculate-trading-fees-'));
    const logCalls: string[] = [];
    const fileContents = JSON.stringify([
      {
        orderId: 'order-1234567890',
        symbol: 'HK.12345',
        action: 'BUY',
        side: 'LONG',
        quantity: '200',
        price: '0.123',
        orderType: 'LO',
        status: 'FILLED',
      },
    ]);
    const tradesFile = path.join(root, 'logs', 'trades', '2026-01-21.json');

    try {
      mkdirSync(path.dirname(tradesFile), { recursive: true });
      writeFileSync(tradesFile, fileContents, 'utf8');
      // 默认路径由入口求值时的 cwd 决定；真实 fixture 不替换进程共享的 fs 模块。
      process.chdir(root);
      console.log = (...args: ReadonlyArray<unknown>) => {
        logCalls.push(args.map(String).join(' '));
      };

      await import(
        `../../../tools/calculateTradingFees/index.js?calculate-trading-fees-index-test-${Date.now()}`
      );
    } finally {
      console.log = originalConsoleLog;
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }

    expect(logCalls.some((line) => line.includes('总订单数：1'))).toBeTrue();
    expect(
      logCalls.some((line) => line.includes('订单ID | 标的 | 数量 | 价格 | 交易金额')),
    ).toBeTrue();
    expect(logCalls.some((line) => line.includes('order-1234...'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('总费用：'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('总费用：17.03 HKD'))).toBeTrue();
    expect(process.cwd()).toBe(originalCwd);
    expect(console.log).toBe(originalConsoleLog);
    // 清理后读取必须回到真实文件系统，不能返回费用 fixture 的内容。
    expect(() => readFileSync(tradesFile, 'utf8')).toThrow();
  });
});
