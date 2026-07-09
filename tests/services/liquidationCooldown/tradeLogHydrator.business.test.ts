/**
 * tradeLogHydrator 业务测试
 *
 * 功能：
 * - 验证交易日志回放时对触发计数器与冷却状态的恢复行为。
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { TRADING } from '../../../src/constants/index.js';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createLiquidationCooldownTracker } from '../../../src/services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../../src/services/liquidationCooldown/tradeLogHydrator.js';

const TEST_LOG_ROOT_DIR = path.join(process.cwd(), 'tests', 'logs');

function createCompletedRecord(params: {
  monitorSymbol: string;
  action: 'SELLCALL' | 'SELLPUT';
  executedAtMs: number;
}): Record<string, unknown> {
  return {
    orderId: null,
    symbol: null,
    symbolName: null,
    monitorSymbol: params.monitorSymbol,
    action: params.action,
    side: 'SELL',
    quantity: null,
    price: null,
    orderType: null,
    status: 'FILLED',
    error: null,
    reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
    signalTriggerTime: null,
    executedAt: new Date(params.executedAtMs).toISOString(),
    executedAtMs: params.executedAtMs,
    timestamp: new Date(params.executedAtMs).toISOString(),
    isProtectiveClearance: true,
  };
}

describe('tradeLogHydrator business flow', () => {
  it('skips hydration when today trade log does not exist', () => {
    const infoLogs: string[] = [];
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => 1_000,
    });
    const hydrator = createTradeLogHydrator({
      readFileSync: () => '[]',
      existsSync: () => false,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 1_000,
      logger: {
        info: (message) => {
          infoLogs.push(message);
        },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: tracker,
    });

    const boundaries = hydrator.hydrate();

    expect(infoLogs.some((message) => message.includes('当日成交日志不存在'))).toBe(true);
    expect(boundaries.size).toBe(0);
  });

  it('fails fast when existing trade log JSON is invalid', () => {
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => 1_000,
    });
    const hydrator = createTradeLogHydrator({
      readFileSync: () => '{invalid-json',
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 1_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: tracker,
    });

    expect(() => hydrator.hydrate()).toThrow('成交日志解析失败');
  });

  it('fails fast when existing trade log root is not an array', () => {
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => 1_000,
    });
    const hydrator = createTradeLogHydrator({
      readFileSync: () => JSON.stringify({ records: [] }),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => 1_000,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: tracker,
    });

    expect(() => hydrator.hydrate()).toThrow('成交日志根节点必须为数组');
  });

  it('restores trigger count from completed events when cooldown not yet activated', () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => nowMs,
    });
    const tradingConfig = createTradingConfig({
      monitor: createMonitorConfig({
        monitorSymbol: 'HSI.HK',
        liquidationTriggerLimit: 2,
        liquidationCooldown: { mode: 'minutes', minutes: 5 },
      }),
    });
    const records = [
      createCompletedRecord({
        monitorSymbol: 'HSI.HK',
        action: 'SELLCALL',
        executedAtMs: nowMs - 10_000,
      }),
    ];
    const hydrator = createTradeLogHydrator({
      readFileSync: () => JSON.stringify(records),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });

    const boundaries = hydrator.hydrate();

    const next = tracker.recordLiquidationTrigger({
      symbol: 'HSI.HK',
      direction: 'LONG',
      executedTimeMs: nowMs,
      triggerLimit: 2,
      cooldownConfig: { mode: 'minutes', minutes: 5 },
    });
    expect(next).toEqual({
      currentCount: 2,
      cooldownActivated: true,
    });
    expect(boundaries.get('HSI.HK:LONG')).toBe(nowMs - 10_000);
  });

  it('restores active cooldown from completed events', () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const executedAtMs = nowMs - 30_000;
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => nowMs,
    });
    const tradingConfig = createTradingConfig({
      monitor: createMonitorConfig({
        monitorSymbol: 'HSI.HK',
        liquidationTriggerLimit: 1,
        liquidationCooldown: { mode: 'minutes', minutes: 5 },
      }),
    });
    const records = [
      createCompletedRecord({
        monitorSymbol: 'HSI.HK',
        action: 'SELLCALL',
        executedAtMs,
      }),
    ];
    const hydrator = createTradeLogHydrator({
      readFileSync: () => JSON.stringify(records),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });

    const boundaries = hydrator.hydrate();

    const remainingMs = tracker.getRemainingMs({
      symbol: 'HSI.HK',
      direction: 'LONG',
      cooldownConfig: { mode: 'minutes', minutes: 5 },
      currentTimeMs: nowMs,
    });
    expect(remainingMs).toBe(270_000);
    expect(boundaries.get('HSI.HK:LONG')).toBe(executedAtMs);
  });

  it('fails fast when protective clearance record monitorSymbol mismatches configured monitor', () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => nowMs,
    });
    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          createCompletedRecord({
            monitorSymbol: 'HSCEI.HK',
            action: 'SELLCALL',
            executedAtMs: nowMs - 30_000,
          }),
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: tracker,
    });

    expect(() => hydrator.hydrate()).toThrow('monitorSymbol 不匹配唯一配置');
  });

  it('fails fast when protective clearance record action cannot resolve direction', () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => nowMs,
    });
    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          createCompletedRecord({
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs: nowMs - 30_000,
          }),
          {
            ...createCompletedRecord({
              monitorSymbol: 'HSI.HK',
              action: 'SELLCALL',
              executedAtMs: nowMs - 20_000,
            }),
            action: 'BUYCALL',
          },
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => TEST_LOG_ROOT_DIR,
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: tracker,
    });

    expect(() => hydrator.hydrate()).toThrow('action 无法解析方向');
  });
});
