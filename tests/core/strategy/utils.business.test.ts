/**
 * strategy utils 业务测试
 *
 * 功能：
 * - 验证 factor 展示字符串的输出顺序、格式和空值过滤语义
 */
import { describe, expect, it } from 'bun:test';

import { buildIndicatorDisplayString } from '../../../src/core/strategy/utils.js';
import { createFactorSnapshotDouble } from '../../helpers/testDoubles.js';

describe('strategy utils display semantics', () => {
  it('formats factor snapshot fields in a stable output sequence', () => {
    const text = buildIndicatorDisplayString(createFactorSnapshotDouble());
    expect(text).toBe(
      'SESSION=am、REGIME=expanding、TREND=trend_up、SCORE=1.200、ER15=0.600、ER30=0.550、READY=Y',
    );
  });

  it('filters invalid factor values and preserves readiness semantics', () => {
    const text = buildIndicatorDisplayString(
      createFactorSnapshotDouble({
        volatilityRegime: null,
        trendClassification: null,
        trendScore: null,
        er15: null,
        er30: null,
        readiness: {
          regimeReady: false,
          trendReady: false,
          structureReady: false,
          confirmationReady: false,
          overallReady: false,
          reasons: ['波动率基线未就绪'],
        },
      }),
    );

    expect(text).toBe('SESSION=am、READY=N、REASON=波动率基线未就绪');
  });

  it('returns an empty string when factor snapshot is absent', () => {
    const text = buildIndicatorDisplayString(null);
    expect(text).toBe('');
  });
});
