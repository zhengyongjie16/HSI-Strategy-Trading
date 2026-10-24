/**
 * import boundary 架构测试。
 * 验证低层依赖限制、策略单根私有边界及同策略的合法跨层装配，不求值业务模块。
 */
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';

async function lintText(relativeFilePath: string, code: string) {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfig: {
      languageOptions: {
        parserOptions: {
          projectService: {
            allowDefaultProject: [
              'src/strategies/newAlpha/*.ts',
              'src/strategies/newAlpha/*/*.ts',
              'src/strategies/intradayRegression/types.d.ts',
              'src/types/probe.d.ts',
            ],
            maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 30,
          },
        },
      },
    },
  });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(process.cwd(), relativeFilePath),
  });

  const messages = result?.messages ?? [];
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages;
}

describe('architecture import boundaries', () => {
  it.each([
    ['@/strategies/intradayRegression/types.js', 'privateStrategy'],
    ['../intradayRegression/types.js?raw', 'privateStrategy'],
    ['@/strategies/intradayRegression/types.js#types', 'privateStrategy'],
    ['@/strategies/newAlpha/index.js#entry', 'pureRole'],
    ['@/strategies/newAlpha/otherMath.js', null],
    ['./otherMath.js?raw', null],
    ['node:path', null],
  ])('preserves strategy import resolution for %s', async (specifier, messageId) => {
    const messages = await lintText(
      'src/strategies/newAlpha/newMath.ts',
      `import '${specifier}';`,
    );
    expect(
      messages
        .filter((message) => message.ruleId === 'local/strategy-private-boundary')
        .map((message) => message.messageId),
    ).toEqual(messageId === null ? [] : [messageId]);
  });

  it.each([
    "import type { Input } from '../intradayRegression/types.js'; export type Output = { value: Input };",
    "export * from '../intradayRegression/constants.js';",
    "export type { Input } from '../intradayRegression/types.js';",
    "export const load = () => import('../intradayRegression/config.json');",
    "export const load = () => require('../intradayRegression/constants.js');",
    "import value = require('../intradayRegression/constants.js'); void value;",
    "export type Input = import('../intradayRegression/types.js').Input;",
  ])(
    'new strategy cannot bypass ownership through an alternate import form: %s',
    async (source) => {
      const messages = await lintText('src/strategies/newAlpha/newMath.ts', source);
      expect(
        messages.some(
          (message) =>
            message.ruleId === 'local/strategy-private-boundary' &&
            message.messageId === 'privateStrategy',
        ),
      ).toBe(true);
    },
  );

  it.each([
    "import type { Input } from './index.js'; export type Value = { input: Input };",
    "export type Input = import('./verification/pendingVerification.js').Input;",
    "export type { Input } from './definition.js';",
  ])('keeps implementation roles private even through reverse type edges: %s', async (source) => {
    const messages = await lintText('src/strategies/newAlpha/newMath.ts', source);
    expect(
      messages.some(
        (message) =>
          message.ruleId === 'local/strategy-private-boundary' && message.messageId === 'pureRole',
      ),
    ).toBe(true);
  });

  it.each(['newMath.ts', 'indicators/index.ts', 'profile/index.ts', 'verification/index.ts'])(
    'keeps new pure module %s from reverse-importing the root instance',
    async (file) => {
      const source = file.includes('/') ? '../index.js' : './index.js';
      const messages = await lintText(
        'src/strategies/newAlpha/' + file,
        `import { run } from '${source}'; void run;`,
      );
      expect(
        messages.some(
          (message) =>
            message.ruleId === 'local/strategy-private-boundary' &&
            message.messageId === 'pureRole',
        ),
      ).toBe(true);
    },
  );

  it.each([
    ['newMath.ts', "import { add } from './otherMath.js'; export const value = add(1);"],
    [
      'types.ts',
      "import type { RuntimeScheduler } from '../../types/runtime.js'; export type Input = { scheduler: RuntimeScheduler };",
    ],
    [
      'definition.ts',
      "import { run } from './index.js'; export const definition = Object.freeze({ prepare: () => ({ create: run }) });",
    ],
    [
      'index.ts',
      "import { pending } from './verification/pendingVerification.js'; export const run = pending;",
    ],
  ])('permits same-owner role-appropriate import in %s', async (file, source) => {
    const messages = await lintText('src/strategies/newAlpha/' + file, source);
    expect(
      messages.filter((message) => message.ruleId === 'local/strategy-private-boundary'),
    ).toEqual([]);
  });

  it('rejects imports from src/types to src/services', async () => {
    const messages = await lintText(
      'src/types/lifecycle.ts',
      "import type { MarketMonitor } from '../services/marketMonitor/types.js';\nexport type Probe = MarketMonitor;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
    expect(
      messages.some((message) => message.message.includes('types 层不得依赖高层或旧 owner')),
    ).toBe(true);
  });

  it('rejects display adapter imports from the old core owner', async () => {
    const messages = await lintText(
      'src/infrastructure/display/marketMonitor/utils.ts',
      "import { createRiskChecker } from '../../../core/riskController/index.js';\nvoid createRiskChecker;\n",
    );

    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
    expect(
      messages.some((message) =>
        message.message.includes('infrastructure 层不得依赖高层或旧 owner'),
      ),
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
    ['src/app/runApp.ts', '../strategies/intradayRegression/definition.js'],
    ['src/types/lifecycle.ts', '../strategies/intradayRegression/types.js'],
    ['src/utils/numeric/index.ts', '../../strategies/intradayRegression/index.js'],
    ['src/app/runApp.ts', '../strategies/intradayRegression/config.js'],
    ['src/strategies/intradayRegression/signalRules.ts', '../otherStrategy/types.js'],
    ['src/strategies/intradayRegression/index.ts', '../otherStrategy/types.js'],
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
    const source = '../../src/strategies/intradayRegression/indicators/' + leaf + '.js';
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
    ['src/app/runApp.ts', '../strategies/intradayRegression/indicators/ema.js', false],
    ['src/app/runApp.ts', '../strategies/intradayRegression/indicators/types.js', true],
    [
      'src/strategies/intradayRegression/signalRules.ts',
      '../otherStrategy/indicators/ema.js',
      false,
    ],
    [
      'src/strategies/intradayRegression/signalRules.ts',
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
    ['src/strategies/intradayRegression/signalRules.ts', './indicators/ema.js'],
    ['src/strategies/intradayRegression/index.ts', './types.js'],
    ['src/strategies/intradayRegression/definition.ts', './index.js'],
    ['src/strategies/intradayRegression/definition.ts', './config.js'],
  ])(
    'allows same-strategy private imports across the single owner from %s',
    async (file, source) => {
      const messages = await lintText(
        file,
        'import * as privateStrategy from ' + JSON.stringify(source) + '; void privateStrategy;',
      );
      expect(messages.some((message) => message.ruleId === 'local/strategy-private-boundary')).toBe(
        false,
      );
    },
  );

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
