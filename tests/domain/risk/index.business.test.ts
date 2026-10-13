/**
 * domain/risk/index 业务测试
 *
 * 功能：
 * - 验证风控组合（持仓/浮亏）场景意图与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { createRiskChecker } from '../../../src/domain/risk/index.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import { createPositionLimitChecker } from '../../../src/domain/risk/positionLimitChecker.js';
import { createWarrantRiskChecker } from '../../../src/domain/risk/warrantRiskChecker.js';
import type {
  PositionLimitChecker,
  UnrealizedLossChecker,
  WarrantRiskChecker,
} from '../../../src/domain/risk/types.js';
import {
  createAccountSnapshotDouble,
  createOrderRecorderDouble,
  createSignalDouble,
} from '../../helpers/testDoubles.js';

function createWarrantCheckerStub(): WarrantRiskChecker {
  return {
    setWarrantInfoFromCallPrice: () => ({ status: 'ok', isWarrant: true }),
    publishWarrantInfo: () => {},
    checkRisk: () => ({ allowed: true }),
    checkWarrantDistanceLiquidation: () => ({ shouldLiquidate: false }),
    getWarrantDistanceInfo: () => null,
    clearLongWarrantInfo: () => {},
    clearShortWarrantInfo: () => {},
  };
}

function getMissingUnrealizedLossData(): undefined {
  return;
}

function createUnrealizedLossCheckerStub(
  overrides: Partial<UnrealizedLossChecker> = {},
): UnrealizedLossChecker {
  const base: UnrealizedLossChecker = {
    getUnrealizedLossData: getMissingUnrealizedLossData,
    clearUnrealizedLossData: () => {},
    prepare: (_orderRecorder, symbol) => ({ symbol, data: { r1: '0', n1: 0 } }),
    publish: () => {},
    check: () => ({ shouldLiquidate: false }),
  };
  return { ...base, ...overrides };
}

function createPositionLimitCheckerStub(
  overrides: Partial<PositionLimitChecker> = {},
): PositionLimitChecker {
  const base: PositionLimitChecker = {
    checkLimit: () => ({ allowed: true }),
  };
  return { ...base, ...overrides };
}

describe('risk rule composition business flow', () => {
  it('compares available cash at full precision and preserves the position-limit check order', () => {
    let positionChecks = 0;
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => {
          positionChecks += 1;
          return { allowed: true };
        },
      }),
    });
    const params = {
      account: createAccountSnapshotDouble('0.300000000000000001'),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: '0.300000000000000001',
    };
    expect(checker.checkBeforeOrder(params)).toEqual({ allowed: true });
    expect(positionChecks).toBe(1);
    expect(
      checker.checkBeforeOrder({ ...params, orderNotional: '0.300000000000000002' }).allowed,
    ).toBeFalse();
    expect(positionChecks).toBe(1);
    expect(() =>
      checker.checkBeforeOrder({ ...params, account: { ...params.account, netAssets: 'NaN' } }),
    ).toThrow(TypeError);
  });

  it('shares one precise loss projection between publication, buy checks and display metrics', () => {
    const lossState = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: '10',
      onMissingData: () => {},
    });
    const warrantState = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    const checker = createRiskChecker({
      warrantRiskChecker: warrantState,
      positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
      unrealizedLossChecker: lossState,
    });
    const prepared = checker.prepareUnrealizedLossData(
      createOrderRecorderDouble({
        getCostBasis: () => ({ costAmount: '100.000000000000000001', quantity: 1 }),
      }),
      'BULL.HK',
      true,
      '-0.000000000000000001',
    );
    expect(checker.getUnrealizedLossMetrics('BULL.HK', '90')).toBeNull();
    checker.publishUnrealizedLossData(prepared);
    expect(lossState.getUnrealizedLossData('BULL.HK')).toEqual({
      r1: '100.000000000000000002',
      n1: 1,
    });

    expect(checker.getUnrealizedLossMetrics('BULL.HK', '90')).toEqual({
      r1: '100.000000000000000002',
      n1: 1,
      r2: '90',
      unrealizedPnL: '-10.000000000000000002',
    });
    expect(checker.checkUnrealizedLoss('BULL.HK', '90', true).shouldLiquidate).toBeTrue();
    checker.clearUnrealizedLossData('BULL.HK');
    expect(lossState.getUnrealizedLossData('BULL.HK')).toBeUndefined();

    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
    expect(warrantState.checkRisk('BULL.HK', 'BUYCALL', '20000').allowed).toBeFalse();
    checker.clearLongWarrantInfo();
    expect(warrantState.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toBeNull();
  });

  it('returns zero market value without a quote for an empty basis and rejects unsafe published quantities', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: () => ({ r1: '10', n1: 0 }),
      }),
      positionLimitChecker: createPositionLimitCheckerStub(),
    });
    expect(checker.getUnrealizedLossMetrics('BULL.HK', null)).toEqual({
      r1: '10',
      n1: 0,
      r2: '0',
      unrealizedPnL: '-10',
    });
    const invalid = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: () => ({ r1: '10', n1: 0.5 }),
      }),
      positionLimitChecker: createPositionLimitCheckerStub(),
    });
    expect(() => invalid.getUnrealizedLossMetrics('BULL.HK', '1')).toThrow(TypeError);
  });

  it('rejects buy when HKD available cash is insufficient', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub(),
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble('500'),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: '5000',
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('港币可用现金');
  });

  it('rejects buy when account data is unavailable before position-limit checking', () => {
    let positionLimitCalls = 0;
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub(),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => {
          positionLimitCalls += 1;
          return { allowed: true };
        },
      }),
    });

    const result = checker.checkBeforeOrder({
      account: null,
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: '5000',
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('账户数据不可用');
    expect(positionLimitCalls).toBe(0);
  });

  it('returns position limit checker rejection after passing buy preconditions', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: getMissingUnrealizedLossData,
      }),
      positionLimitChecker: createPositionLimitCheckerStub({
        checkLimit: () => ({
          allowed: false,
          reason: '持仓市值超过限制',
        }),
      }),
    });

    const result = checker.checkBeforeOrder({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
      signal: createSignalDouble('BUYCALL', 'BULL.HK'),
      orderNotional: '5000',
    });

    expect(result.allowed).toBeFalse();
    expect(result.reason).toBe('持仓市值超过限制');
  });

  it('builds unrealized-loss metrics from cached R1/N1 and current price', () => {
    const checker = createRiskChecker({
      warrantRiskChecker: createWarrantCheckerStub(),
      unrealizedLossChecker: createUnrealizedLossCheckerStub({
        getUnrealizedLossData: () => ({
          r1: '1000',
          n1: 100,
        }),
      }),
      positionLimitChecker: createPositionLimitCheckerStub(),
    });

    const metrics = checker.getUnrealizedLossMetrics('BULL.HK', '12');
    expect(metrics).toEqual({
      r1: '1000',
      n1: 100,
      r2: '1200',
      unrealizedPnL: '200',
    });
  });
});
