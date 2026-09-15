/**
 * import boundary 架构测试
 *
 * 覆盖：
 * - types 层不得依赖 services 层
 * - services 层不得依赖 core 层
 * - services 层允许依赖定义好的策略类型路径
 */
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

async function lintText(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(process.cwd(), relativeFilePath),
  });

  return result?.messages ?? [];
}

describe('architecture import boundaries', () => {
  it('rejects imports from src/types to src/services', async () => {
    const messages = await lintText(
      'src/types/state.ts',
      "import type { MarketMonitor } from '../services/marketMonitor/types.js';\nexport type Probe = MarketMonitor;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
    expect(
      messages.some((message) => message.message.includes('types 层不得依赖 services 层')),
    ).toBe(true);
  });

  it('rejects imports from src/services to src/core except allowed ports', async () => {
    const messages = await lintText(
      'src/services/autoSymbolManager/utils.ts',
      "import { createRiskChecker } from '../core/riskController/index.js';\nvoid createRiskChecker;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
    expect(
      messages.some((message) => message.message.includes('services 层不得依赖 core 层')),
    ).toBe(true);
  });

  it('allows services imports from the defined strategy type path', async () => {
    const messages = await lintText(
      'src/services/autoSymbolManager/utils.ts',
      "import type { TradingSignalStrategy } from '../core/strategy/types.js';\nexport type Probe = TradingSignalStrategy;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  });

  it.each([
    ['src/app/runApp.ts', '../core/strategy/intradayRegression/definition.js'],
    ['src/types/state.ts', '../core/strategy/intradayRegression/types.js'],
    ['src/utils/numeric/index.ts', '../../core/strategy/intradayRegression/runtime/index.js'],
    ['src/core/strategy/intradayRegression/index.ts', '../otherStrategy/definition.js'],
  ])('rejects private strategy import from %s', async (file, source) => {
    const messages = await lintText(
      file,
      'import * as privateStrategy from ' + JSON.stringify(source) + '; void privateStrategy;',
    );
    expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
      true,
    );
  });

  it.each([
    ['tools/dailyIndicatorAnalysis/indicatorCalculators.ts', 'ema', false],
    ['tools/dailyIndicatorAnalysis/types.ts', 'types', true],
  ])('allows tools direct private leaf/type imports from %s', async (file, leaf, typeOnly) => {
    const source = '../../src/core/strategy/intradayRegression/runtime/' + leaf + '.js';
    const code = typeOnly
      ? 'import type { KDJIndicator } from "' + source + '"; export type Probe = KDJIndicator;'
      : 'import { readEmaValue } from "' + source + '"; void readEmaValue;';
    const messages = await lintText(file, code);
    expect(messages.filter((message) => message.fatal === true)).toEqual([]);
    expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
      false,
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  });

  it.each([
    ['src/app/runApp.ts', '../core/strategy/intradayRegression/runtime/ema.js', false],
    ['src/app/runApp.ts', '../core/strategy/intradayRegression/runtime/types.js', true],
    ['src/core/strategy/intradayRegression/index.ts', '../otherStrategy/runtime/ema.js', false],
    ['src/core/strategy/intradayRegression/index.ts', '../otherStrategy/runtime/types.js', true],
  ])(
    'rejects production private leaf/type imports from %s (%s)',
    async (file, source, typeOnly) => {
      const code = typeOnly
        ? 'import type { Probe } from "' + source + '"; export type Result = Probe;'
        : 'import { probe } from "' + source + '"; void probe;';
      const messages = await lintText(file, code);
      expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
        true,
      );
    },
  );

  it('allows private modules within their own strategy directory', async () => {
    const messages = await lintText(
      'src/core/strategy/intradayRegression/index.ts',
      "import { strategyDefinition } from './definition.js'; void strategyDefinition;",
    );
    expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
      false,
    );
  });
});
