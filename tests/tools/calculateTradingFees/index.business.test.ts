/**
 * calculateTradingFees 入口业务测试
 *
 * 覆盖：
 * - 校验工具读取默认交易日志 JSONL 路径并输出普通成交费用与汇总
 * - 确保护性清仓混合记录不参与成交费用统计
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createMixedTradeLogRepository } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import type { PersistableTradeRecord } from '../../../src/types/trader.js';

const TRADING_DAY = '2026-01-21';
const EXECUTION_TIME_MS = 1768963515000;
const ORDER_REVISION_MS = 1768963517000;

const validTrade: PersistableTradeRecord = {
  orderId: 'order-1234567890',
  symbol: 'HK.12345',
  symbolName: null,
  monitorSymbol: 'HSI.HK',
  action: 'BUYCALL',
  side: 'BUY',
  quantity: '200',
  price: '0.123',
  orderType: 'LO',
  status: 'FILLED',
  error: null,
  reason: null,
  signalTriggerTime: null,
  executedAt: '2026-01-21T10:45:15.000+08:00',
  executedAtMs: EXECUTION_TIME_MS,
  timestamp: '2026-01-21T10:45:17.000+08:00',
  isProtectiveClearance: false,
};

describe('calculateTradingFees index entry flow', () => {
  it('reads repository-written mixed JSONL and calculates fees only for ordinary trades', async () => {
    const originalCwd = process.cwd();
    const originalConsoleLog = console.log;
    const root = mkdtempSync(path.join(tmpdir(), 'calculate-trading-fees-'));
    const logCalls: string[] = [];
    const logRoot = path.join(root, 'logs');
    const tradesFile = path.join(logRoot, 'trades', `${TRADING_DAY}.jsonl`);

    try {
      const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => logRoot });
      const secondTrade: PersistableTradeRecord = { ...validTrade, orderId: 'order-2345678901' };

      repository.appendTradeRecord(validTrade);
      repository.appendExecutionProgressIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        symbol: 'HK.12345',
        orderId: 'protective-order',
        factStage: 'OPEN',
        cumulativeQuantity: '200',
        cumulativeAmount: '24.6',
        lastExecutionTimeMs: EXECUTION_TIME_MS,
        orderRevisionMs: ORDER_REVISION_MS,
      });
      repository.appendTradeRecord(secondTrade);
      repository.appendCompletionIdempotent({
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: ORDER_REVISION_MS,
        orderBaselines: [
          {
            orderId: 'protective-order',
            symbol: 'HK.12345',
            side: 'SELL',
            cumulativeQuantity: '200',
            cumulativeAmount: '24.6',
            lastExecutionTimeMs: EXECUTION_TIME_MS,
            orderRevisionMs: ORDER_REVISION_MS,
          },
        ],
      });
      expect(readFileSync(tradesFile, 'utf8').split('\n')).toHaveLength(5);

      // 默认路径由入口求值时的 cwd 决定；仓储写入隔离临时日志目录。
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

    expect(logCalls.some((line) => line.includes('总订单数：2'))).toBeTrue();
    expect(
      logCalls.some((line) => line.includes('订单ID | 标的 | 数量 | 价格 | 交易金额')),
    ).toBeTrue();
    expect(logCalls.some((line) => line.includes('order-1234...'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('order-2345...'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('总费用：34.06 HKD'))).toBeTrue();
    expect(process.cwd()).toBe(originalCwd);
    expect(console.log).toBe(originalConsoleLog);
    // 清理后读取必须回到真实文件系统，不能返回费用 fixture 的内容。
    expect(() => readFileSync(tradesFile, 'utf8')).toThrow();
  });
});
