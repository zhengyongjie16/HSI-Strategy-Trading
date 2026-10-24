/**
 * ESLint 本地规则架构测试
 *
 * 覆盖本地 ESLint plugin 的规则注册、src 类型组织约束与测试目录豁免。
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

function hasRuleMessage(messages: Awaited<ReturnType<typeof lintText>>, ruleId: string): boolean {
  return messages.some((message) => message.ruleId === ruleId);
}

describe('local ESLint rules', () => {
  it.each([
    'longbridge',
    'longbridge/quote',
    ...[
      'fs',
      'fs/promises',
      'dns',
      'dns/promises',
      'timers',
      'timers/promises',
      'readline',
      'readline/promises',
      'http',
      'https',
      'http2',
      'net',
      'tls',
      'dgram',
      'os',
      'child_process',
      'worker_threads',
      'cluster',
      'process',
      'console',
    ].flatMap((specifier) => [specifier, `node:${specifier}`]),
  ])('preserves ambient module rejection for %s', async (specifier) => {
    const messages = await lintText('src/strategies/newAlpha/newMath.ts', `import '${specifier}';`);
    expect(
      messages.some(
        (message) =>
          message.ruleId === 'local/strategy-capabilities' && message.messageId === 'ambient',
      ),
    ).toBe(true);
  });

  it.each([
    'node:path',
    'node:util',
    'longbridge-extra',
    'node:longbridge',
    'longbridge-extra/quote',
    'fs/extra',
    'node:fs/promises/extra',
    'httpx',
    'node:https/extra',
    'node:worker_threads/extra',
  ])('preserves non-ambient module allowance for %s', async (specifier) => {
    const messages = await lintText('src/strategies/newAlpha/newMath.ts', `import '${specifier}';`);
    expect(messages.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual(
      [],
    );
  });

  it('allows destructured parameters without defaults', async () => {
    const messages = await lintText(
      'src/strategies/newAlpha/newMath.ts',
      'export const read = ({ now }: { readonly now: () => number }): number => now();',
    );
    expect(messages.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual(
      [],
    );
  });

  it.each([
    "import 'node:fs';",
    "import type { Stats } from 'node:fs'; export type Input = { stat: Stats };",
    "export { readFile } from 'node:fs/promises';",
    "import fs = require('node:fs'); void fs;",
    "export const load = () => import('node:http');",
    "export const load = () => require('node:timers');",
    "export type Input = import('node:fs').Stats;",
    "import os from 'node:os'; export const value = os.platform();",
    "import { platform } from 'os'; export const value = platform();",
    "import type { CpuInfo } from 'node:os'; export type Input = CpuInfo;",
    "export const load = () => fetch('https://invalid');",
    'export const start = () => globalThis.setTimeout(() => {}, 1);',
    'export const now = () => Date.now();',
    'export const now = () => new Date();',
    'export const env = () => process.env.ACTIVE_STRATEGY_ID;',
    'const { env } = process; export const value = env.ACTIVE_STRATEGY_ID;',
    'const { env: environment } = process; export const value = environment.ACTIVE_STRATEGY_ID;',
    'const { now } = Date; export const value = now();',
    'const { now: clockNow } = Date; export const value = clockNow();',
    'export const read = ({ now }: { readonly now: () => number } = Date): number => now();',
    'export const read = ({ now: clockNow }: { readonly now: () => number } = Date): number => clockNow();',
    "export const read = ({ ['now']: clockNow }: { readonly now: () => number } = Date): number => clockNow();",
    'const { hrtime } = process; export const value = hrtime.bigint();',
    "const { ['env']: environment } = process; export const value = environment.ACTIVE_STRATEGY_ID;",
    'export const value = process[`hrtime`].bigint();',
    'export const value = performance.now();',
    'export const value = globalThis.performance.now();',
    'export const value = process.hrtime.bigint();',
    'export const value = process.uptime();',
    'export const value = process.cwd();',
    'export const value = process.argv.join(" ");',
    "export const value = process.stdout.write('x');",
    'export const value = process.exit(0);',
    'export const swap = (next: NodeJS.Process) => { process = next; };',
    'export const read = ({ env }: { readonly env: NodeJS.ProcessEnv } = process) => env;',
    'export const stop = () => globalThis.process.exit(0);',
    "export const log = () => globalThis.console.log('x');",
    'export const clock = globalThis.performance;',
    'const Clock = Date; export const value = new Clock();',
    "export const log = () => console.log('x');",
    "import type { QuoteContext } from 'longbridge'; export type Input = { context: QuoteContext };",
  ])(
    'strategy synthetic rejects actual ambient/SDK capability: %s',
    async (source) => {
      for (const file of [
        'newMath.ts',
        'index.ts',
        'definition.ts',
        'verification/pendingVerification.ts',
      ]) {
        const messages = await lintText('src/strategies/newAlpha/' + file, source);
        expect(
          messages.some(
            (message) =>
              message.ruleId === 'local/strategy-capabilities' && message.messageId === 'ambient',
          ),
        ).toBe(true);
      }
    },
    20_000,
  );

  it.each([
    "import type { RuntimeClock } from '../../types/runtime.js'; export const run = (clock: RuntimeClock) => clock.now();",
    "import type { RuntimeScheduler } from '../../types/runtime.js'; export const run = (scheduler: RuntimeScheduler) => scheduler.scheduleTimer(() => {}, 1);",
    "import type { Logger } from '../../types/logger.js'; export const run = (logger: Logger) => logger.info('x');",
    "import type { StrategyEmitter } from '../../types/strategy.js'; export const run = (emit: StrategyEmitter) => emit({} as never);",
  ])(
    'strategy synthetic distinguishes injected runtime calls from pure roles: %s',
    async (source) => {
      const pure = await lintText('src/strategies/newAlpha/newMath.ts', source);
      expect(
        pure.some(
          (message) =>
            message.ruleId === 'local/strategy-capabilities' && message.messageId === 'injected',
        ),
      ).toBe(true);
      const runtime = await lintText('src/strategies/newAlpha/index.ts', source);
      expect(runtime.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual(
        [],
      );
    },
  );

  it('strategy synthetic confines real fatal calls to the two runtime roles', async () => {
    for (const file of [
      'newMath.ts',
      'definition.ts',
      'index.ts',
      'verification/pendingVerification.ts',
    ]) {
      const prefix = file.includes('/') ? '../../../' : '../../';
      const messages = await lintText(
        'src/strategies/newAlpha/' + file,
        `import type { StrategyDeps } from '${prefix}types/strategy.js'; export const run = (deps: StrategyDeps): void => { deps.onFatalError('direct'); const fail = deps.onFatalError; fail('alias'); const { onFatalError: fatal } = deps; fatal('destructured'); };`,
      );
      expect(
        messages.filter(
          (message) =>
            message.ruleId === 'local/strategy-capabilities' && message.messageId === 'injected',
        ),
      ).toHaveLength(file === 'newMath.ts' || file === 'definition.ts' ? 3 : 0);
    }

    const messages = await lintText(
      'src/strategies/newAlpha/newMath.ts',
      "import type { StrategyDeps } from '../../types/strategy.js'; export const retain = (deps: StrategyDeps): StrategyDeps => deps; export const run = (): number => { const local = { onFatalError: (): number => 1 }; return local.onFatalError(); };",
    );
    expect(messages.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual(
      [],
    );
  });

  it('strategy synthetic checks typed direct defaults without unrelated lint failures', async () => {
    const messages = await lintText(
      'src/strategies/newAlpha/newMath.ts',
      'export const read = ({ now }: { readonly now: () => number } = Date): number => now();',
    );
    expect(messages.map((message) => [message.ruleId, message.messageId])).toEqual([
      ['local/strategy-capabilities', 'ambient'],
    ]);

    for (const file of [
      'newMath.ts',
      'definition.ts',
      'index.ts',
      'verification/pendingVerification.ts',
    ]) {
      const legal = await lintText(
        'src/strategies/newAlpha/' + file,
        "export const read = ({ now }: { readonly now: () => number } = { now: (): number => 1 }): number => now(); export const renamed = ({ now: clockNow }: { readonly now: () => number } = { now: (): number => 1 }): number => clockNow(); export const computed = ({ ['now']: clockNow }: { readonly now: () => number } = { now: (): number => 1 }): number => clockNow(); export const date = (value: Date): Date => new Date(value);",
      );
      expect(legal.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual(
        [],
      );
    }
  });

  it('strategy synthetic allows pure types, explicit Date and local names but rejects definition evaluation', async () => {
    const pure = await lintText(
      'src/strategies/newAlpha/newMath.ts',
      "import type { Logger } from '../../types/logger.js'; import type { RuntimeClock } from '../../types/runtime.js'; import { basename } from 'node:path'; import { inspect } from 'node:util'; const fetch = (value: string) => value; const setTimeout = (value: number) => value; const clock = { now: () => 1 }; const logger = { info: (value: string) => value }; export const value = [fetch(basename('x')), setTimeout(1), new Date(1), clock.now(), logger.info(inspect(1))]; export type Input = { logger: Logger; clock: RuntimeClock; timer: ReturnType<typeof setTimeout> }; ",
    );
    expect(pure.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual([]);
    const definition = await lintText(
      'src/strategies/newAlpha/definition.ts',
      "import { run } from './index.js'; export const definition = Object.freeze({ instance: run() });",
    );
    expect(
      definition.some(
        (message) =>
          message.ruleId === 'local/strategy-capabilities' && message.messageId === 'evaluation',
      ),
    ).toBe(true);
    const deferred = await lintText(
      'src/strategies/newAlpha/definition.ts',
      "import { run } from './index.js'; export const definition = Object.freeze({ prepare: () => ({ create: run }) });",
    );
    expect(deferred.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual(
      [],
    );
  });

  it('strategy synthetic allows standard-library helpers, explicit Date, type references and local names', async () => {
    const messages = await lintText(
      'src/strategies/newAlpha/newMath.ts',
      "import { basename } from 'node:path'; import { inspect } from 'node:util'; const now = () => 1; const env = { ACTIVE_STRATEGY_ID: 'x' }; const performance = { now: () => 1 }; const process = { env: { ACTIVE_STRATEGY_ID: 'x' }, hrtime: { bigint: () => 1n }, uptime: () => 1 }; const Clock = Date; const { now: aliasNow } = { now: () => 2 }; const { env: localEnv } = { env: 'x' }; const { ['now']: computedNow } = { now: () => 3 }; export const value = [basename('x'), inspect(1), now(), env.ACTIVE_STRATEGY_ID, performance.now(), process.env.ACTIVE_STRATEGY_ID, process.hrtime.bigint(), process.uptime(), process[`uptime`](), aliasNow(), computedNow(), localEnv, new Clock(1), new Date(1), Date.parse('2024-01-01T00:00:00Z')]; export type Input = { at: Date; env: NodeJS.ProcessEnv; ctor: DateConstructor; local: typeof now };",
    );
    expect(messages.filter((message) => message.ruleId === 'local/strategy-capabilities')).toEqual(
      [],
    );
  });

  it('rejects named import aliases in src files', async () => {
    const messages = await lintText(
      'src/domain/seat/seatPolicy.ts',
      "import { foo as bar } from './foo.js';\nvoid bar;\n",
    );

    expect(hasRuleMessage(messages, 'local/no-import-alias')).toBe(true);
  });

  it('allows named imports without aliases in src files', async () => {
    const messages = await lintText(
      'src/domain/seat/seatPolicy.ts',
      "import { foo } from './foo.js';\nvoid foo;\n",
    );

    expect(hasRuleMessage(messages, 'local/no-import-alias')).toBe(false);
  });

  it('keeps named import aliases allowed in tests', async () => {
    const messages = await lintText(
      'tests/architecture/eslintLocalRules.test.ts',
      "import { foo as bar } from './foo.js';\nvoid bar;\n",
    );

    expect(hasRuleMessage(messages, 'local/no-import-alias')).toBe(false);
  });

  it('rejects type declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/domain/risk/dailyLossTracker.ts',
      "type Probe = { readonly id: string };\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects interface declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/domain/risk/dailyLossTracker.ts',
      "interface Probe { readonly id: string }\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects module declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/domain/risk/dailyLossTracker.ts',
      'declare namespace Probe {}\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects ambient function declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/domain/risk/dailyLossTracker.ts',
      'declare function probe(): void;\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects ambient variable declarations in src implementation files', async () => {
    const messages = await lintText(
      'src/domain/risk/dailyLossTracker.ts',
      'declare const probe: string;\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('allows type and interface declarations in adjacent types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      'export type Probe = { readonly id: string };\nexport interface Runner { run(): void }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(false);
  });

  it('allows type declarations in src types directory', async () => {
    const messages = await lintText(
      'src/types/strategy.ts',
      'export type Probe = { readonly id: string };\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(false);
  });

  it('rejects declaration files as type location exceptions', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.d.ts',
      'interface Probe { readonly id: string }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects src types directory declaration files as type location exceptions', async () => {
    const messages = await lintText(
      'src/types/probe.d.ts',
      'interface Probe { readonly id: string }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects enums in src implementation files', async () => {
    const messages = await lintText(
      'src/domain/risk/dailyLossTracker.ts',
      "enum Probe { A = 'a' }\nexport type ProbeValue = Probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('rejects enums anywhere under src', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "enum Probe { A = 'a' }\nexport type ProbeValue = Probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(true);
  });

  it('does not restrict type declarations in tests', async () => {
    const messages = await lintText(
      'tests/architecture/eslintLocalRules.test.ts',
      'type Probe = { readonly id: string };\ninterface Runner { run(): void }\n',
    );

    expect(hasRuleMessage(messages, 'local/type-definitions-location')).toBe(false);
  });

  it('rejects redundant named type aliases in src files', async () => {
    const messages = await lintText(
      'src/runtime/periodicSwitchWakeupRuntime/types.ts',
      [
        "import type { BoundedOneShotTimerController } from '../../src/types/timer.js';",
        'type PeriodicSwitchTimerHandle = BoundedOneShotTimerController;',
        'export type Probe = { readonly timerHandle: PeriodicSwitchTimerHandle | null };',
      ].join('\n'),
    );

    expect(hasRuleMessage(messages, 'local/no-redundant-type-alias')).toBe(true);
  });

  it('rejects redundant qualified named type aliases in src files', async () => {
    const messages = await lintText(
      'src/runtime/periodicSwitchWakeupRuntime/types.ts',
      [
        "import type * as TimerTypes from '../../src/types/timer.js';",
        'type PeriodicSwitchTimerHandle = TimerTypes.BoundedOneShotTimerController;',
        'export type Probe = { readonly timerHandle: PeriodicSwitchTimerHandle | null };',
      ].join('\n'),
    );

    expect(hasRuleMessage(messages, 'local/no-redundant-type-alias')).toBe(true);
  });

  it('rejects primitive equivalent type aliases in src files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      'export type Price = number;\n',
    );

    expect(hasRuleMessage(messages, 'local/no-redundant-type-alias')).toBe(true);
  });

  it('allows derived type aliases in src files', async () => {
    const messages = await lintText(
      'src/runtime/periodicSwitchWakeupRuntime/types.ts',
      [
        "type Direction = 'LONG' | 'SHORT';",
        'type Route = { readonly direction: Direction };',
        "export type DirectionFromRoute = Route['direction'];",
        'export type RouteKey = `${string}:${Direction}`;',
        'export type ReadonlyRoute = Readonly<Route>;',
        'export type RouteHandler = (route: Route) => void;',
      ].join('\n'),
    );

    expect(hasRuleMessage(messages, 'local/no-redundant-type-alias')).toBe(false);
  });

  it('does not restrict redundant type aliases in tests', async () => {
    const messages = await lintText(
      'tests/architecture/eslintLocalRules.test.ts',
      'type Source = { readonly id: string };\ntype Probe = Source;\n',
    );

    expect(hasRuleMessage(messages, 'local/no-redundant-type-alias')).toBe(false);
  });

  it('allows import type and type declarations in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "import type { Foo } from './foo.js';\nexport type Probe = Foo;\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(false);
  });

  it('rejects value imports in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "import { foo } from './foo.js';\nexport type Probe = { readonly id: string };\nvoid foo;\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects side-effect imports in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "import './setup.js';\nexport type Probe = { readonly id: string };\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects constants in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "export const probe = '1';\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects functions in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      'export function probe(): void {}\n',
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects classes in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      'export class Probe {}\n',
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects module declarations in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      'declare namespace Probe {}\n',
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects export all declarations in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "export * from './foo.js';\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects value export specifiers in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "export { foo } from './foo.js';\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects type re-export specifiers in types files', async () => {
    const messages = await lintText(
      'src/strategies/intradayRegression/types.ts',
      "export type { Foo } from './foo.js';\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('rejects control flow statements in types files', async () => {
    const messages = await lintText('src/strategies/intradayRegression/types.ts', 'if (true) {}\n');

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(true);
  });

  it('does not restrict runtime code in test types files', async () => {
    const messages = await lintText(
      'tests/strategies/intradayRegression/types.ts',
      "export const probe = '1';\n",
    );

    expect(hasRuleMessage(messages, 'local/types-file-only-types')).toBe(false);
  });

  it('rejects type declarations in src utils files', async () => {
    const messages = await lintText(
      'src/domain/strategy/utils.ts',
      "type Probe = { readonly id: string };\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('rejects interface declarations in src utils files', async () => {
    const messages = await lintText(
      'src/domain/strategy/utils.ts',
      "interface Probe { readonly id: string }\nconst probe: Probe = { id: '1' };\nvoid probe;\n",
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('rejects ambient function declarations in src utils files', async () => {
    const messages = await lintText(
      'src/domain/strategy/utils.ts',
      'declare function probe(): void;\n',
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('rejects ambient variable declarations in src utils files', async () => {
    const messages = await lintText(
      'src/domain/strategy/utils.ts',
      'declare const probe: string;\n',
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(true);
  });

  it('allows import type and type annotations in src utils files', async () => {
    const messages = await lintText(
      'src/domain/strategy/utils.ts',
      "import type { Probe } from './types.js';\nexport function normalizeProbe(probe: Probe): Probe {\n  return probe;\n}\n",
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(false);
  });

  it('does not restrict type declarations in test utils files', async () => {
    const messages = await lintText(
      'tests/app/shutdown/utils.ts',
      'type Probe = { readonly id: string };\ninterface Runner { run(): void }\n',
    );

    expect(hasRuleMessage(messages, 'local/utils-file-no-types')).toBe(false);
  });
});
