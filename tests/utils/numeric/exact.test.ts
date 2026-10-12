/** 精确金融文本的独立 BigInt oracle 与真实私有 clone 故障注入回归。 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BigNumber from 'bignumber.js';
import type * as Numeric from '../../../src/utils/numeric/exact.js';
import { createChildEnv } from '../../setup/childEnv.js';

/** 独立 oracle 的十进制整数系数/scale，不调用被测库生成期望。 */
type Decimal = { readonly coefficient: bigint; readonly scale: number };

/**
 * 将 oracle 输入转换为 BigInt 系数。
 * @param text 普通十进制文本
 * @returns 系数和 scale
 */
function decimal(text: string): Decimal {
  const [integer = '', fraction = ''] = text.split('.');
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}

/**
 * 将整数系数输出为普通规范文本。
 * @param coefficient 有符号整数系数
 * @param scale 小数位数
 * @returns 独立精确期望
 */
function plain(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  let normalized = text;
  if (text.includes('.')) {
    while (normalized.endsWith('0')) normalized = normalized.slice(0, -1);

    if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  }

  return negative && coefficient !== 0n ? `-${normalized}` : normalized;
}

/**
 * 独立整数余数 half-even oracle，包含负零字段政策。
 * @param numerator 分子文本
 * @param denominator 正分母文本
 * @param places 输出位数
 * @returns 保留负零的定点期望
 */
function rounded(numerator: string, denominator: string, places: number): string {
  const a = decimal(numerator);
  const b = decimal(denominator);
  const negative = a.coefficient < 0n;
  const top = (negative ? -a.coefficient : a.coefficient) * 10n ** BigInt(b.scale + places);
  const bottom = b.coefficient * 10n ** BigInt(a.scale);
  let quotient = top / bottom;
  const remainder = top % bottom;
  if (remainder * 2n > bottom || (remainder * 2n === bottom && quotient % 2n !== 0n)) {
    quotient += 1n;
  }

  const digits = quotient.toString().padStart(places + 1, '0');
  const fixed = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return negative ? `-${fixed}` : fixed;
}

/**
 * 固定种子的独立整数生成器。
 * @param state 当前种子
 * @returns 下一种子
 */
function next(state: bigint): bigint {
  return (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 128n;
}

/** 仅在独立子进程注册原用例，让 spy 先于真实 exact 模块的首次求值。 */
async function registerExactTests(): Promise<void> {
  const clones: Array<typeof BigNumber> = [];
  const clone = BigNumber.clone.bind(BigNumber);
  const capture = spyOn(BigNumber, 'clone').mockImplementation((config) => {
    const constructor = clone(config);
    clones.push(constructor);
    return constructor;
  });
  let numeric: typeof Numeric;
  try {
    numeric = await import('../../../src/utils/numeric/exact.js');
  } finally {
    capture.mockRestore();
  }

  describe('SDK 无关精确金融文本契约', () => {
    test('独立 BigInt 差分：正负算术、mixed cross product、whole lot 与显示', () => {
      let state = 73421n;
      let negativeProducts = 0;
      let mixedRatios = 0;
      for (let index = 0; index < 500; index += 1) {
        state = next(state);
        const a = index % 2 === 0 ? state : -state;
        if (a < 0n) negativeProducts += 1;

        state = next(state);
        const b = state + 1n;
        const scaleA = index % 29;
        const scaleB = index % 17;
        const left = plain(a, scaleA);
        const right = plain(b, scaleB);
        const common = Math.max(scaleA, scaleB);
        const alignedA = a * 10n ** BigInt(common - scaleA);
        const alignedB = b * 10n ** BigInt(common - scaleB);
        expect(numeric.exactAdd(left, right)).toBe(plain(alignedA + alignedB, common));
        expect(numeric.exactSubtract(left, right)).toBe(plain(alignedA - alignedB, common));
        expect(numeric.exactMultiply(left, right)).toBe(plain(a * b, scaleA + scaleB));
        let comparison: -1 | 0 | 1 = 0;
        if (alignedA < alignedB) comparison = -1;

        if (alignedA > alignedB) comparison = 1;

        expect(numeric.exactCompare(left, right)).toBe(comparison);
        expect(numeric.formatRatio(left, right, index % 5, 'preserve')).toBe(
          rounded(left, right, index % 5),
        );
        const absolute = plain(a < 0n ? -a : a, scaleA);
        const expectedLots =
          ((a < 0n ? -a : a) * 10n ** BigInt(scaleB)) / (b * 10n ** BigInt(scaleA));
        expect(numeric.integerQuotient(absolute, right)).toBe(expectedLots.toString());
        const lot = BigInt((index % 11) + 1);
        const expectedQuantity =
          (((a < 0n ? -a : a) * 10n ** BigInt(scaleB)) / (b * 10n ** BigInt(scaleA) * lot)) * lot;
        expect(numeric.wholeLotQuantity(absolute, right, lot.toString())).toBe(
          expectedQuantity.toString(),
        );
        const other = index % 3 === 0 ? -b : b;
        if (a < 0n !== other < 0n) mixedRatios += 1;

        const cross = alignedA * 11n - other * 10n ** BigInt(common - scaleB) * 7n;
        let ratioComparison: -1 | 0 | 1 = 0;
        if (cross < 0n) ratioComparison = -1;

        if (cross > 0n) ratioComparison = 1;

        expect(numeric.compareRatios(left, '7', plain(other, scaleB), '11')).toBe(ratioComparison);
      }

      expect(negativeProducts).toBe(250);
      expect(mixedRatios).toBeGreaterThan(0);
    });

    test('整数商整手预算边界与高位接近整数不能先 div/floor', () => {
      expect(numeric.wholeLotQuantity('7000', '0.07', '10000')).toBe('100000');
      expect(numeric.wholeLotQuantity('7499.999', '2.500', '1000')).toBe('2000');
      expect(numeric.wholeLotQuantity('7500', '2.500', '1000')).toBe('3000');
      expect(numeric.wholeLotQuantity('1', '2.500', '1000')).toBe('0');
      expect(numeric.integerQuotient(`0.${'9'.repeat(100)}`, '1')).toBe('0');
      expect(numeric.integerQuotient('2.9999999999999999999999999999', '3')).toBe('0');
      expect(() => numeric.wholeLotQuantity('1', '0', '100')).toThrow(RangeError);
      expect(() => numeric.wholeLotQuantity('1', '1', '0.5')).toThrow(RangeError);
    });

    test('保留金额/数量依据与低位权威修訂；不乘回显示均价', () => {
      expect(numeric.formatRatio('1000', '3000', 3, 'unsigned')).toBe('0.333');
      expect(numeric.canonicalDecimal('1000')).toBe('1000');
      expect(numeric.compareRatios('1000', '3000', '0.333', '1')).toBe(1);
      const original = numeric.exactMultiply('3.3333333333333334', '6');
      const revised = numeric.exactMultiply('3.3333333333333335', '6');
      expect(original).toBe('20.0000000000000004');
      expect(numeric.exactSubtract(revised, original)).toBe('0.0000000000000006');
      expect(
        numeric.exactAdd(
          numeric.exactSubtract('15.0000000000000001', original),
          '4.9999999999999999',
        ),
      ).toBe('-0.0000000000000004');
    });

    test('cross product 相等与两侧，显示距离不得放行', () => {
      for (const [price, expected] of [
        ['20070', 0],
        ['20069.99', -1],
        ['20070.01', 1],
      ] as const) {
        const numerator = numeric.exactMultiply(numeric.exactSubtract(price, '20000'), '100');
        expect(numeric.compareRatios(numerator, '20000', '0.35', '1')).toBe(expected);
      }

      expect(numeric.formatRatio('6999', '20000', 3, 'unsigned')).toBe('0.350');
      expect(numeric.compareRatios('6999', '20000', '0.35', '1')).toBe(-1);
      expect(numeric.compareRatios('-1', '3', '-2', '6')).toBe(0);
      for (const denominator of ['0', '-0', '-1']) {
        expect(() => numeric.compareRatios('1', denominator, '1', '1')).toThrow(RangeError);
      }
    });

    test('字段一次 half-even，符号与补零显式政策；durable 原值不舍入', () => {
      for (const value of ['1.005', '1.015', '1.0051', '9007199254740993.125', '-1.015']) {
        expect(numeric.formatDecimal(value, 2, 'preserve')).toBe(rounded(value, '1', 2));
        expect(numeric.formatRatio(value, '1', 2, 'preserve')).toBe(rounded(value, '1', 2));
        expect(numeric.canonicalDecimal(value)).toBe(value);
      }

      const tinyTail = `1.005${'0'.repeat(30)}1`;
      expect(numeric.formatRatio(tinyTail, '1', 2, 'preserve')).toBe('1.01');
      for (const value of ['-0.0001', '-0.005']) {
        expect(numeric.formatDecimal(value, 2, 'preserve')).toBe('-0.00');
        expect(numeric.formatRatio(value, '1', 2, 'preserve')).toBe('-0.00');
        expect(numeric.formatDecimal(value, 2, 'unsigned')).toBe('0.00');
        expect(numeric.formatRatio(value, '1', 2, 'unsigned')).toBe('0.00');
      }

      expect(numeric.formatDecimal('-0', 2, 'preserve')).toBe('0.00');
      expect(numeric.canonicalDecimal('1000000000000000000000.001')).toBe(
        '1000000000000000000000.001',
      );
      expect(numeric.requireCanonicalDecimal('0.3')).toBe('0.3');
      for (const value of ['0.30', '1e3', '-0', '+1', '01']) {
        expect(() => numeric.requireCanonicalDecimal(value)).toThrow();
      }
    });

    test('财务 toNumber 毒针与 clone 全局配置隔离', () => {
      const spies = clones.map((constructor) =>
        spyOn(constructor.prototype, 'toNumber').mockImplementation(() => {
          throw new Error('Financial toNumber poisoned');
        }),
      );
      const privateConstructor = clones[0];
      if (!privateConstructor) throw new Error('Private clone was not captured');

      const displayClone = privateConstructor.clone.bind(privateConstructor);
      const displayCapture = spyOn(privateConstructor, 'clone').mockImplementation((config) => {
        const constructor = displayClone(config);
        spies.push(
          spyOn(constructor.prototype, 'toNumber').mockImplementation(() => {
            throw new Error('Display toNumber poisoned');
          }),
        );
        return constructor;
      });
      const previous = BigNumber.config();
      try {
        BigNumber.config({ DECIMAL_PLACES: 0, ROUNDING_MODE: BigNumber.ROUND_UP, RANGE: [-1, 1] });
        expect(numeric.exactAdd('0.1', '0.2')).toBe('0.3');
        expect(numeric.exactMultiply('100000', '0.001')).toBe('100');
        expect(numeric.exactSubtract('1.0000000000000000001', '1')).toBe('0.0000000000000000001');
        expect(numeric.exactCompare('100', '99')).toBe(1);
        expect(numeric.integerQuotient('1000', '3')).toBe('333');
        expect(numeric.wholeLotQuantity('7000', '0.07', '10000')).toBe('100000');
        expect(numeric.compareRatios('1000', '3000', '1', '3')).toBe(0);
        expect(numeric.formatDecimal('1.0051', 2, 'unsigned')).toBe('1.01');
        expect(numeric.formatRatio('1000', '3000', 3, 'unsigned')).toBe('0.333');
        expect(numeric.canonicalDecimal('1000.001')).toBe('1000.001');
        expect(() => numeric.safeQuantityNumber('1')).toThrow('Financial toNumber poisoned');
      } finally {
        BigNumber.config(previous);
        displayCapture.mockRestore();
        for (const spy of spies) spy.mockRestore();
      }
    });

    test('安全整数数量出口与聚合后重验，禁止 number 财务入口', () => {
      expect(numeric.safeQuantityNumber('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
      expect(numeric.sumSafeQuantities(['10', '20'])).toBe(30);
      for (const value of ['9007199254740992', '0.5', '-1']) {
        expect(() => numeric.safeQuantityNumber(value)).toThrow(RangeError);
      }

      expect(() => numeric.sumSafeQuantities(['9007199254740991', '1'])).toThrow(RangeError);
      for (const value of ['NaN', 'Infinity', '-Infinity', '1e1000000001', '1e-1000000001', ' 1']) {
        expect(() => numeric.canonicalDecimal(value)).toThrow(TypeError);
      }

      // @ts-expect-error 财务入口必须在类型与运行时均拒绝 number。
      expect(() => numeric.exactAdd(0.1, '0.2')).toThrow(TypeError);
    });

    test('真实库 RANGE 故障注入：parse/运算溢出与非零下溢 fatal，精确抵消合法', () => {
      const constructor = clones[0];
      if (!constructor) throw new Error('Private clone was not captured');

      const previous = constructor.config();
      try {
        constructor.config({ RANGE: [-4, 4] });
        expect(() => numeric.canonicalDecimal('100000')).toThrow(RangeError);
        expect(() => numeric.canonicalDecimal('0.00001')).toThrow(RangeError);
        expect(() => numeric.exactMultiply('10000', '10')).toThrow(RangeError);
        expect(() => numeric.exactMultiply('0.001', '0.001')).toThrow(RangeError);
        expect(numeric.exactAdd('0.001', '-0.001')).toBe('0');
        expect(numeric.exactSubtract('0.001', '0.001')).toBe('0');
        expect(numeric.exactMultiply('0', '0.001')).toBe('0');
        expect(numeric.integerQuotient('0.001', '10000')).toBe('0');
        expect(() => numeric.formatRatio('0.001', '10000', 2, 'unsigned')).toThrow(RangeError);
        expect(numeric.formatRatio('0.001', '1', 2, 'unsigned')).toBe('0.00');
      } finally {
        constructor.config(previous);
      }
    });

    test('显示 clone 显式继承真实 RANGE：受控默认范围外的大小输入仍得到正确比率', () => {
      const constructor = clones[0];
      if (!constructor) throw new Error('Private clone was not captured');

      const previous = constructor.config();
      // 模拟 clone 默认 RANGE 比精确后端小；缺少显式 RANGE 时本例必然下溢/溢出。
      const displayCapture = spyOn(constructor, 'clone').mockImplementation((config) =>
        clone({ ...config, RANGE: config?.RANGE ?? [-4, 4] }),
      );
      try {
        constructor.config({ RANGE: [-20, 20] });
        const large = `1${'0'.repeat(10)}`;
        const small = `0.${'0'.repeat(10)}1`;
        const smallDenominator = `0.${'0'.repeat(9)}1`;
        expect(numeric.formatRatio(large, `${large}0`, 2, 'unsigned')).toBe(
          rounded(large, `${large}0`, 2),
        );

        expect(numeric.formatRatio(small, smallDenominator, 2, 'unsigned')).toBe(
          rounded(small, smallDenominator, 2),
        );
        // 合法字段舍入到零不属于库下溢，不得误拒。
        expect(numeric.formatRatio('-0.001', '1', 2, 'preserve')).toBe(rounded('-0.001', '1', 2));
        expect(
          displayCapture.mock.calls.every(
            ([config]) =>
              Array.isArray(config?.RANGE) && config.RANGE[0] === -20 && config.RANGE[1] === 20,
          ),
        ).toBe(true);
      } finally {
        displayCapture.mockRestore();
        constructor.config(previous);
      }
    });

    test('4096 不是合法输入 cap：4097 位及超过 80 位的产物仍精确保留低位', () => {
      const integer = '9'.repeat(4097);
      expect(numeric.exactAdd(integer, '1')).toBe(`1${'0'.repeat(4097)}`);
      expect(numeric.exactMultiply(integer, integer)).toBe((BigInt(integer) ** 2n).toString());
      expect(numeric.integerQuotient(integer, '7')).toBe((BigInt(integer) / 7n).toString());
      const highScale = `0.${'0'.repeat(4096)}1`;
      expect(numeric.exactMultiply(highScale, highScale)).toBe(`0.${'0'.repeat(8193)}1`);
      expect(numeric.exactAdd(integer, highScale)).toBe(`${integer}.${'0'.repeat(4096)}1`);
      expect(numeric.formatRatio(integer, '7', 3, 'preserve')).toBe(rounded(integer, '7', 3));
    });
  });
}

if (process.env['EXACT_NUMERIC_TEST_CHILD'] === '1') {
  await registerExactTests();
} else {
  test('独立子进程完整执行精确金融文本原 10 项契约（含真实 clone 故障注入）', () => {
    const isolationRoot = mkdtempSync(path.join(tmpdir(), 'exact-numeric-test-'));
    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          '--no-env-file',
          'test',
          '--preload',
          fileURLToPath(new URL('../../setup/testRuntime.ts', import.meta.url)),
          fileURLToPath(import.meta.url),
        ],
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...createChildEnv(isolationRoot), EXACT_NUMERIC_TEST_CHILD: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      const output = stdout + stderr;
      expect(result.exitCode, output).toBe(0);
      expect(output).toMatch(/\b10 pass\b/);
      expect(output).toMatch(/\b0 fail\b/);
      const assertionCount = /\b(\d+) expect\(\) calls\b/.exec(output)?.[1];
      expect(Number(assertionCount)).toBeGreaterThanOrEqual(4101);
    } finally {
      rmSync(isolationRoot, { recursive: true, force: true });
    }
  });
}
