/**
 * 宿主配置边界测试：交易配置只包含执行、席位与风险政策，不读取或展示策略私有规则。
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { createTradingConfig as parseTradingConfig } from '../../src/config/trading/index.js';
import { validateAllConfig } from '../../src/config/validator/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { logger } from '../../src/utils/logger/index.js';

describe('host configuration boundary', () => {
  it('parses and validates complete host configuration without private strategy inputs', async () => {
    // 旧键的 presence 拒绝属于启动 loader；宿主解析和校验不再读取这些值。
    const strategyKeys = new Set([
      'SIGNAL_BUYCALL',
      'SIGNAL_SELLCALL',
      'SIGNAL_BUYPUT',
      'SIGNAL_SELLPUT',
      'VERIFICATION_DELAY_SECONDS_BUY',
      'VERIFICATION_DELAY_SECONDS_SELL',
      'VERIFICATION_INDICATORS_BUY',
      'VERIFICATION_INDICATORS_SELL',
      'ACTIVE_STRATEGY_ID',
    ]);
    const env: NodeJS.ProcessEnv = new Proxy(
      {
        LONGBRIDGE_AUTH_MODE: 'oauth',
        LONGBRIDGE_CLIENT_ID: 'offline-client-id',
        MONITOR_SYMBOL: 'HSI.HK',
        LONG_SYMBOL: 'BULL.HK',
        SHORT_SYMBOL: 'BEAR.HK',
        ORDER_OWNERSHIP_MAPPING: 'HS,HSI,HSI',
        LIQUIDATION_COOLDOWN_MINUTES: 'half-day',
        LIQUIDATION_TRIGGER_LIMIT: '2',
        SMART_CLOSE_TIMEOUT_MINUTES: '0',
      },
      {
        get(target, key, receiver): unknown {
          if (typeof key === 'string' && strategyKeys.has(key)) {
            throw new Error('宿主不得读取策略选择或规则值: ' + key);
          }

          return Reflect.get(target, key, receiver);
        },
      },
    );
    const config = parseTradingConfig({ env });
    const expectedMonitorKeys = [
      'monitorSymbol',
      'longSymbol',
      'shortSymbol',
      'autoSearchConfig',
      'orderOwnershipMapping',
      'targetNotional',
      'maxPositionNotional',
      'maxUnrealizedLossPerSymbol',
      'buyIntervalSeconds',
      'liquidationCooldown',
      'liquidationTriggerLimit',
      'smartCloseEnabled',
      'smartCloseTimeoutMinutes',
    ].sort((left, right) => left.localeCompare(right));
    for (const candidate of [config, createTradingConfig()]) {
      expect(Object.keys(candidate).sort((left, right) => left.localeCompare(right))).toEqual([
        'global',
        'monitor',
      ]);

      expect(
        Object.keys(candidate.monitor).sort((left, right) => left.localeCompare(right)),
      ).toEqual(expectedMonitorKeys);
    }

    expect(config.monitor.orderOwnershipMapping).toEqual(['HSI', 'HS']);
    expect(config.monitor.liquidationCooldown).toEqual({ mode: 'half-day' });
    expect(config.monitor.liquidationTriggerLimit).toBe(2);
    expect(config.monitor.smartCloseTimeoutMinutes).toBe(0);

    const messages: string[] = [];
    const info = spyOn(logger, 'info').mockImplementation((message) => {
      messages.push(message);
    });
    try {
      await validateAllConfig({ env, tradingConfig: config });
      expect(messages).toContain('监控标的: HSI.HK');
      expect(messages).toContain('保护性清仓后买入冷却: half-day');
      expect(
        messages.some((message) =>
          /信号配置|延迟验证|BUYCALL|SELLCALL|BUYPUT|SELLPUT/.test(message),
        ),
      ).toBe(false);
    } finally {
      info.mockRestore();
    }
  });
});
