/**
 * 牛熊证候选筛选业务测试。
 * 验证三条寻标入口共享的纯策略、两层开区间、百分比单位和原始成交额精确比较，禁止显示回流判断。
 */
import { describe, expect, it } from 'bun:test';
import {
  buildExpiryDateFilters,
  resolveWarrantSelectionPolicy,
  selectBestWarrant,
} from '../../../../src/domain/seat/warrantSelection/index.js';
import type {
  DirectionalAutoSearchPolicy,
  ResolveWarrantSelectionPolicyInput,
  SelectBestWarrantInput,
} from '../../../../src/domain/seat/warrantSelection/types.js';

function createPolicy(
  direction: 'LONG' | 'SHORT',
  overrides: Partial<ResolveWarrantSelectionPolicyInput> = {},
): DirectionalAutoSearchPolicy {
  const result = resolveWarrantSelectionPolicy({
    direction,
    primaryThreshold: direction === 'LONG' ? '0.35' : '-0.35',
    minTurnoverPerMinute: '10000',
    switchDistanceRange:
      direction === 'LONG' ? { min: '0.2', max: '1.5' } : { min: '-1.5', max: '-0.2' },
    ...overrides,
  });
  if (!result.success) throw new Error(result.reason);

  return result.policy;
}

function createWarrant(
  symbol: string,
  distance: string,
  turnover = '300000',
  overrides: Partial<SelectBestWarrantInput['warrants'][number]> = {},
): SelectBestWarrantInput['warrants'][number] {
  return {
    symbol,
    callPrice: '20000.1234567890123456789',
    toCallPrice: distance,
    turnover,
    status: 'NORMAL',
    ...overrides,
  };
}

describe('warrant selection policy', () => {
  it('keeps expiry month group boundaries and array ordering', () => {
    expect(buildExpiryDateFilters(3)).toEqual([
      'MONTHS_3_TO_6',
      'MONTHS_6_TO_12',
      'OVER_12_MONTHS',
    ]);
    expect(buildExpiryDateFilters(3.01)).toEqual(['MONTHS_6_TO_12', 'OVER_12_MONTHS']);
    expect(buildExpiryDateFilters(6)).toEqual(['MONTHS_6_TO_12', 'OVER_12_MONTHS']);
    expect(buildExpiryDateFilters(6.01)).toEqual(['OVER_12_MONTHS']);
  });

  it.each(['LONG', 'SHORT'] as const)(
    'builds immutable exact %s policy and danger-side degraded band',
    (direction) => {
      const policy = createPolicy(direction, {
        primaryThreshold: direction === 'LONG' ? '0.3500000000000000001' : '-0.3500000000000000001',
      });
      expect(policy.primaryThreshold).toBe(
        direction === 'LONG' ? '0.3500000000000000001' : '-0.3500000000000000001',
      );

      expect(policy.degradedRange).toEqual(
        direction === 'LONG'
          ? { min: '0.2', max: policy.primaryThreshold }
          : { min: policy.primaryThreshold, max: '-0.2' },
      );
      expect(Object.isFrozen(policy)).toBeTrue();
      expect(Object.isFrozen(policy.degradedRange)).toBeTrue();
      expect(Object.isFrozen(policy.switchDistanceRange)).toBeTrue();
    },
  );

  it.each([
    { primaryThreshold: null },
    { minTurnoverPerMinute: null },
    { switchDistanceRange: null },
    { minTurnoverPerMinute: '-0.001' },
    { primaryThreshold: '0.2' },
    { primaryThreshold: '1.5' },
    { primaryThreshold: '0.1999999999999999999' },
    { primaryThreshold: '1.5000000000000000001' },
  ])('rejects missing or business-invalid LONG config without throwing: %j', (overrides) => {
    const result = resolveWarrantSelectionPolicy({
      direction: 'LONG',
      primaryThreshold: '0.35',
      minTurnoverPerMinute: '10000',
      switchDistanceRange: { min: '0.2', max: '1.5' },
      ...overrides,
    });
    expect(result.success).toBeFalse();
  });

  it.each(['-1.5', '-0.2', '-1.5000000000000000001', '-0.1999999999999999999'])(
    'rejects SHORT main threshold outside or equal to either safe boundary: %s',
    (primaryThreshold) => {
      expect(
        resolveWarrantSelectionPolicy({
          direction: 'SHORT',
          primaryThreshold,
          minTurnoverPerMinute: '10000',
          switchDistanceRange: { min: '-1.5', max: '-0.2' },
        }).success,
      ).toBeFalse();
    },
  );

  it('preserves malformed financial text as an internal failure rather than business rejection', () => {
    expect(() => createPolicy('LONG', { primaryThreshold: 'NaN' })).toThrow(TypeError);
    expect(() => createPolicy('LONG', { minTurnoverPerMinute: '1e3' })).toThrow(TypeError);
    expect(() =>
      createPolicy('LONG', { switchDistanceRange: { min: '0.2', max: 'Infinity' } }),
    ).toThrow(TypeError);
  });
});

describe('strict two-stage exact candidate selection', () => {
  it('excludes non-HK warrants from candidate admission even when they rank better', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrant('BAD.US', '0.004', '900000'),
        createWarrant('BEST.HK', '0.004', '200000'),
      ],
      tradingMinutes: 10,
      policy: createPolicy('LONG'),
    });

    expect(result.candidate?.symbol).toBe('BEST.HK');
    expect(result.primaryCandidateCount).toBe(1);
  });

  it.each([
    { direction: 'LONG', far: '0.008', nearest: '0.004', degraded: '0.0034' },
    { direction: 'SHORT', far: '-0.008', nearest: '-0.004', degraded: '-0.0034' },
  ] as const)(
    'prefers %s PRIMARY then exact turnover on a distance tie',
    ({ direction, far, nearest, degraded }) => {
      const result = selectBestWarrant({
        warrants: [
          createWarrant('FAR.HK', far, '500000'),
          createWarrant('TIE-LOW.HK', nearest, '200000.0000000000000001'),
          createWarrant('BEST.HK', nearest, '200000.0000000000000002'),
          createWarrant('DEGRADED.HK', degraded, '900000'),
        ],
        tradingMinutes: 10,
        policy: createPolicy(direction),
      });
      expect(result.candidate).toMatchObject({
        symbol: 'BEST.HK',
        selectionStage: 'PRIMARY',
        callPrice: '20000.1234567890123456789',
        turnoverPerMinute: '20000',
        distanceDeltaToThreshold: '0.05',
      });
      expect(result.primaryCandidateCount).toBe(3);
      expect(result.degradedCandidateCount).toBe(1);
    },
  );

  it.each([
    { direction: 'LONG', far: '0.0022', nearest: '0.003499999999999999999' },
    { direction: 'SHORT', far: '-0.0022', nearest: '-0.003499999999999999999' },
  ] as const)(
    'only uses %s degraded candidates when PRIMARY is completely empty',
    ({ direction, far, nearest }) => {
      const result = selectBestWarrant({
        warrants: [
          createWarrant('FAR.HK', far),
          createWarrant('TIE.HK', nearest, '200000'),
          createWarrant('BEST.HK', nearest, '200001'),
        ],
        tradingMinutes: 10,
        policy: createPolicy(direction),
      });
      expect(result.candidate?.symbol).toBe('BEST.HK');
      expect(result.candidate?.selectionStage).toBe('DEGRADED');
      expect(result.candidate?.distanceDeltaToThreshold).toBe('0.0000000000000000001');
      expect(result.primaryCandidateCount).toBe(0);
      expect(result.degradedCandidateCount).toBe(3);
    },
  );

  it.each([
    { direction: 'LONG', threshold: '0.0035', dangerBoundary: '0.002' },
    { direction: 'SHORT', threshold: '-0.0035', dangerBoundary: '-0.002' },
  ] as const)(
    'excludes %s primary and degraded equal boundaries exactly',
    ({ direction, threshold, dangerBoundary }) => {
      const result = selectBestWarrant({
        warrants: [
          createWarrant('THRESHOLD.HK', threshold),
          createWarrant('BOUNDARY.HK', dangerBoundary),
        ],
        tradingMinutes: 10,
        policy: createPolicy(direction),
      });
      expect(result).toEqual({
        candidate: null,
        primaryCandidateCount: 0,
        degradedCandidateCount: 0,
      });
    },
  );

  it.each([
    {
      direction: 'LONG',
      nearer: '0.003500000000000000001',
      farther: '0.003500000000000000002',
      distance: '0.3500000000000000001',
    },
    {
      direction: 'SHORT',
      nearer: '-0.003500000000000000001',
      farther: '-0.003500000000000000002',
      distance: '-0.3500000000000000001',
    },
  ] as const)(
    'does not collapse near-threshold %s values into number or display equality',
    ({ direction, nearer, farther, distance }) => {
      const result = selectBestWarrant({
        warrants: [
          createWarrant('FARTHER.HK', farther, '900000'),
          createWarrant('NEARER.HK', nearer),
        ],
        tradingMinutes: 10,
        policy: createPolicy(direction),
      });
      expect(result.candidate?.symbol).toBe('NEARER.HK');
      expect(result.candidate?.distancePct).toBe(distance);
      expect(result.candidate?.distanceDeltaToThreshold).toBe('0.0000000000000000001');
    },
  );

  it.each([
    {
      direction: 'LONG',
      threshold: '1.85',
      range: { min: '1', max: '4' },
      distance: '0.0185000001',
    },
    {
      direction: 'SHORT',
      threshold: '-3.5',
      range: { min: '-8', max: '-2' },
      distance: '-0.035000001',
    },
  ] as const)(
    'converts raw SDK ratio to percentage for realistic %s thresholds',
    ({ direction, threshold, range, distance }) => {
      const result = selectBestWarrant({
        warrants: [createWarrant('MATCH.HK', distance)],
        tradingMinutes: 10,
        policy: createPolicy(direction, {
          primaryThreshold: threshold,
          switchDistanceRange: range,
        }),
      });
      expect(result.candidate?.symbol).toBe('MATCH.HK');
      expect(result.candidate?.selectionStage).toBe('PRIMARY');
    },
  );

  it('keeps PRIMARY open toward the safe side rather than imposing the switch safe upper boundary', () => {
    const result = selectBestWarrant({
      warrants: [createWarrant('SAFE-SIDE.HK', '0.03')],
      tradingMinutes: 10,
      policy: createPolicy('LONG'),
    });
    expect(result.candidate?.symbol).toBe('SAFE-SIDE.HK');
  });

  it('checks turnover minimum with exact cross product: equality passes, a lower low-order value fails', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrant('UNDER.HK', '0.0036', '30000.002999999999999999'),
        createWarrant('EQUAL.HK', '0.004', '30000.003'),
      ],
      tradingMinutes: 3,
      policy: createPolicy('LONG', { minTurnoverPerMinute: '10000.001' }),
    });
    expect(result.candidate?.symbol).toBe('EQUAL.HK');
    expect(result.candidate?.turnoverPerMinute).toBe('10000');
    expect(result.primaryCandidateCount).toBe(1);
  });

  it('filters absent/non-normal/nonpositive facts before distance bands and retains a stable exact tie', () => {
    const result = selectBestWarrant({
      warrants: [
        createWarrant('', '0.004'),
        createWarrant('NON-NORMAL.HK', '0.004', '300000', { status: 'NON_NORMAL' }),
        createWarrant('NULL-STATUS.HK', '0.004', '300000', { status: null }),
        createWarrant('MISSING-STATUS.HK', '0.004', '300000', { status: undefined }),
        createWarrant('NO-CALL.HK', '0.004', '300000', { callPrice: null }),
        createWarrant('ZERO-CALL.HK', '0.004', '300000', { callPrice: '0' }),
        createWarrant('NO-DIST.HK', '0.004', '300000', { toCallPrice: undefined }),
        createWarrant('ZERO-TURNOVER.HK', '0.004', '0'),
        createWarrant('NO-TURNOVER.HK', '0.004', '300000', { turnover: null }),
        createWarrant('FIRST.HK', '0.004'),
        createWarrant('SECOND.HK', '0.004'),
      ],
      tradingMinutes: 10,
      policy: createPolicy('LONG'),
    });
    expect(result.candidate?.symbol).toBe('FIRST.HK');
    expect(result.primaryCandidateCount).toBe(2);
  });

  it('retains zero-minute behavior: positive minimum rejects; zero minimum does not rank on undefined division', () => {
    const warrants = [
      createWarrant('FIRST.HK', '0.004', '1'),
      createWarrant('SECOND.HK', '0.004', '1000'),
    ];
    expect(
      selectBestWarrant({ warrants, tradingMinutes: 0, policy: createPolicy('LONG') }).candidate,
    ).toBeNull();

    expect(
      selectBestWarrant({
        warrants,
        tradingMinutes: 0,
        policy: createPolicy('LONG', { minTurnoverPerMinute: '0' }),
      }).candidate,
    ).toMatchObject({ symbol: 'FIRST.HK', turnoverPerMinute: '0' });
  });

  it.each([{ callPrice: 'NaN' }, { turnover: 'Infinity' }, { toCallPrice: '2e-3' }])(
    'fails fast on malformed NORMAL financial facts: %j',
    (overrides) => {
      expect(() =>
        selectBestWarrant({
          warrants: [createWarrant('BROKEN.HK', '0.004', '300000', overrides)],
          tradingMinutes: 10,
          policy: createPolicy('LONG'),
        }),
      ).toThrow(TypeError);
    },
  );

  it('rejects corrupted policy boundaries and nonfinite technical minutes before selection', () => {
    const policy = createPolicy('LONG');
    expect(() => selectBestWarrant({ warrants: [], tradingMinutes: Infinity, policy })).toThrow(
      TypeError,
    );

    expect(() =>
      selectBestWarrant({
        warrants: [],
        tradingMinutes: 10,
        policy: { ...policy, degradedRange: { min: '0.1', max: '0.35' } },
      }),
    ).toThrow(TypeError);

    expect(() =>
      selectBestWarrant({
        warrants: [],
        tradingMinutes: 10,
        policy: { ...policy, primaryThreshold: '1.5' },
      }),
    ).toThrow(RangeError);
  });
});
