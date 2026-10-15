/**
 * import boundary 架构测试。
 * 验证低层依赖限制、策略四根私有边界及同策略的合法跨层装配，不求值业务模块。
 */
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

async function lintText(relativeFilePath: string, code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(process.cwd(), relativeFilePath),
  });

  const messages = result?.messages ?? [];
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages;
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

  it('rejects display adapter imports from the old core owner', async () => {
    const messages = await lintText(
      'src/infrastructure/display/marketMonitor/utils.ts',
      "import { createRiskChecker } from '../../../core/riskController/index.js';\nvoid createRiskChecker;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
    expect(
      messages.some((message) => message.message.includes('display adapter 不得依赖 core 层')),
    ).toBe(true);
  });

  it('allows display adapter imports from neutral strategy contracts', async () => {
    const messages = await lintText(
      'src/infrastructure/display/marketMonitor/utils.ts',
      "import type { TradingSignalStrategy } from '../../../types/strategy.js';\nexport type Probe = TradingSignalStrategy;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  });

  it('does not retain the old core strategy type exception', async () => {
    const messages = await lintText(
      'src/infrastructure/display/marketMonitor/utils.ts',
      "import type { TradingSignalStrategy } from '../../../core/strategy/types.js';\nexport type Probe = TradingSignalStrategy;\n",
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it.each([
    ['src/app/runApp.ts', './startup/strategyDefinitions/intradayRegression/definition.js'],
    ['src/types/state.ts', '../domain/strategy/intradayRegression/types.js'],
    ['src/utils/numeric/index.ts', '../../runtime/strategy/intradayRegression/index.js'],
    ['src/app/runApp.ts', '../config/strategy/intradayRegression/config.js'],
    ['src/domain/strategy/intradayRegression/signalRules.ts', '../otherStrategy/types.js'],
    [
      'src/runtime/strategy/intradayRegression/index.ts',
      '../../../domain/strategy/otherStrategy/types.js',
    ],
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
    const source = '../../src/domain/strategy/intradayRegression/indicators/' + leaf + '.js';
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
    ['src/app/runApp.ts', '../domain/strategy/intradayRegression/indicators/ema.js', false],
    ['src/app/runApp.ts', '../domain/strategy/intradayRegression/indicators/types.js', true],
    [
      'src/domain/strategy/intradayRegression/signalRules.ts',
      '../otherStrategy/indicators/ema.js',
      false,
    ],
    [
      'src/domain/strategy/intradayRegression/signalRules.ts',
      '../otherStrategy/indicators/types.js',
      true,
    ],
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

  it.each([
    ['src/domain/strategy/intradayRegression/signalRules.ts', './indicators/ema.js'],
    [
      'src/runtime/strategy/intradayRegression/index.ts',
      '../../../domain/strategy/intradayRegression/types.js',
    ],
    [
      'src/app/startup/strategyDefinitions/intradayRegression/definition.ts',
      '../../../../runtime/strategy/intradayRegression/index.js',
    ],
    [
      'src/app/startup/strategyDefinitions/intradayRegression/definition.ts',
      '../../../../config/strategy/intradayRegression/config.js',
    ],
  ])('allows same-strategy private imports across the four roots from %s', async (file, source) => {
    const messages = await lintText(
      file,
      'import * as privateStrategy from ' + JSON.stringify(source) + '; void privateStrategy;',
    );
    expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
      false,
    );
  });

  it('allows only the directly injected selected-loader dynamic import', async () => {
    const messages = await lintText(
      'src/app/runAppDeps.ts',
      "import { prepareStrategy } from './startup/prepareStrategy.js'; void prepareStrategy({ env: {} }, { importModule: (href: string) => import(href) });",
    );
    expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
      false,
    );
  });

  it.each([
    'export const load = (href: string) => import(href);',
    "import { prepareStrategy } from './startup/prepareStrategy.js'; void prepareStrategy({ env: {} }, { importModule: (href: string) => import(String(href)) });",
  ])('rejects dynamic loading outside the selected-loader shape: %s', async (code) => {
    const messages = await lintText('src/app/runAppDeps.ts', code);
    expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
      true,
    );
  });
});
