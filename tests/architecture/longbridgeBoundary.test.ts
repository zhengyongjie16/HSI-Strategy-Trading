/**
 * 最终 Longbridge 边界：生产 SDK 只存在于 trade/market adapter。
 * 同时验证 runtime、type-only、dynamic 与 re-export 入口，不依赖历史 allowance。
 */
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { createAuditProgram, listTypeScript, scanProgram } from './refactoring/scanner.js';

/** 在独立编译根内复用正式 scanner；不求值动态模块或 SDK。 */
function scanSources(sources: Readonly<Record<string, string>>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsi-final-longbridge-'));
  try {
    const files = Object.entries(sources).map(([file, source]) => {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, source);
      return absolute;
    });
    const program = createAuditProgram(root, files);
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    return scanProgram(root, program, files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const imports = [
  "import { Decimal } from 'longbridge'; export const amount = new Decimal('1');",
  "import type { QuoteContext } from 'longbridge'; export type Input = { readonly context: QuoteContext };",
  "export const load = () => import('longbridge');",
  "type Context = import('longbridge').QuoteContext; export type Input = { readonly context: Context };",
  "export { Decimal } from 'longbridge';",
  "export const load = () => require('longbridge');",
];

describe('cohesive strategy synthetic boundaries', () => {
  const contracts = {
    'src/types/runtime.ts':
      'export interface RuntimeClock { readonly now: () => Date } export interface RuntimeScheduler { readonly scheduleTimer: (callback: () => void, delay: number) => number; readonly clearTimer: (handle: number) => void }',
    'src/types/strategy.ts': 'export type StrategyEmitter = (value: string) => void;',
    'src/types/logger.ts': 'export interface Logger { readonly info: (value: string) => void }',
  };

  it('protects all owners and import forms including types, constants and JSON', () => {
    const target = '../otherAlpha/constants.js';
    const edges = [
      `import { value } from '${target}'; void value;`,
      `import type { Value } from '../otherAlpha/types.js'; export type Result = { value: Value };`,
      `export { value } from '${target}';`,
      `export * from '${target}';`,
      `export type { Value } from '../otherAlpha/types.js';`,
      `export const load = () => import('${target}');`,
      `export const load = () => require('${target}');`,
      `import value = require('${target}'); void value;`,
      `export type Result = import('../otherAlpha/types.js').Value;`,
      `import config from '../otherAlpha/config.json'; void config;`,
    ];
    const sources: Record<string, string> = {
      'src/strategies/otherAlpha/constants.ts': 'export const value = 1;',
      'src/strategies/otherAlpha/types.ts': 'export type Value = { readonly value: number };',
      'src/strategies/otherAlpha/config.json': '{}',
    };
    for (const [index, source] of edges.entries()) {
      sources[`src/strategies/newAlpha/probe${index}.ts`] = source;
      sources[`src/app/probe${index}.ts`] = source.replaceAll(
        '../otherAlpha/',
        '../strategies/otherAlpha/',
      );
    }

    const scan = scanSources(sources);
    for (const file of Object.keys(sources).filter((candidate) => candidate.includes('/probe')))
      expect(
        scan.violations.some((row) => row.includes(file) && /LAYER|DYNAMIC_EDGE/.test(row)),
      ).toBe(true);
  });

  it('defaults new modules and nested indexes to pure, retaining exact runtime exceptions', () => {
    const pureFiles = [
      'newMath.ts',
      'indicators/index.ts',
      'profile/index.ts',
      'verification/index.ts',
      'verification/newStore.ts',
    ];
    const sources: Record<string, string> = {
      ...contracts,
      'src/strategies/newAlpha/index.ts': 'export const run = () => 1;',
      'src/strategies/newAlpha/definition.ts':
        'export const definition = Object.freeze({ prepare: () => ({ create: () => 1 }) });',
      'src/strategies/newAlpha/verification/pendingVerification.ts':
        'export const pending = () => 1;',
      'src/strategies/newAlpha/typeProbe.ts':
        "import type { run } from './index.js'; export type Factory = typeof run;",
    };
    for (const [index, file] of pureFiles.entries()) {
      const prefix = file.includes('/') ? '../' : './';
      sources[`src/strategies/newAlpha/${file}`] =
        `import { run } from '${prefix}index.js'; export const value = run();`;

      sources[`src/strategies/newAlpha/definitionProbe${index}.ts`] =
        `import { definition } from './definition.js'; void definition;`;

      sources[`src/strategies/newAlpha/pendingProbe${index}.ts`] =
        `export const load = () => import('./verification/pendingVerification.js');`;
    }

    const scan = scanSources(sources);
    for (const file of Object.keys(sources).filter(
      (candidate) =>
        /newMath|\/index.ts|Probe|newStore/.test(candidate) &&
        candidate !== 'src/strategies/newAlpha/index.ts',
    ))
      expect(
        scan.violations.some((row) => row.includes(file) && /LAYER|DYNAMIC_EDGE/.test(row)),
      ).toBe(true);
  });

  it('rejects ambient IO for every role while preserving pure standard-library and type references', () => {
    const negative = [
      "import 'node:fs';",
      "import type { Stats } from 'node:fs'; export type Input = { stat: Stats };",
      "export { readFile } from 'node:fs/promises';",
      "import fs = require('node:fs'); void fs;",
      "export const load = () => import('node:http');",
      "export const load = () => require('node:timers');",
      "export type Input = import('node:fs').Stats;",
      "export const load = () => fetch('https://invalid');",
      'export const start = () => globalThis.setTimeout(() => {}, 1);',
      'export const now = () => Date.now();',
      'export const now = () => new Date();',
      'export const env = () => process.env.ACTIVE_STRATEGY_ID;',
      "export const log = () => console.log('x');",
    ];
    const sources: Record<string, string> = {};
    for (const [index, source] of negative.entries())
      for (const role of [
        'definition.ts',
        'index.ts',
        'verification/pendingVerification.ts',
        'newMath.ts',
      ])
        sources[`src/strategies/alpha${index}/${role}`] = source;

    const scan = scanSources(sources);
    for (const file of Object.keys(sources))
      expect(
        scan.violations.some((row) => row.includes(file) && row.includes('DOMAIN_DIRECT_IO')),
      ).toBe(true);

    const positive = scanSources({
      ...contracts,
      'src/strategies/newAlpha/newMath.ts':
        "import { basename } from 'node:path'; import { inspect } from 'node:util'; import type { Logger } from '../../types/logger.js'; import type { RuntimeScheduler } from '../../types/runtime.js'; const fetch = (x: string) => x; const setTimeout = (x: number) => x; export const value = inspect(basename(fetch('a'))); export const count = setTimeout(1); export const date = new Date(1); export type Input = { logger: Logger; scheduler: RuntimeScheduler; timer: ReturnType<typeof globalThis.setTimeout> };",
    });
    expect(positive.violations).toEqual([]);
  });

  it('detects injected capability calls by signature, not by local member spelling', () => {
    const contractImports =
      "import type { RuntimeClock, RuntimeScheduler } from '../../types/runtime.js'; import type { StrategyEmitter } from '../../types/strategy.js'; import type { Logger } from '../../types/logger.js';";
    const calls = [
      'export const run = (clock: RuntimeClock) => clock.now();',
      'export const run = (scheduler: RuntimeScheduler) => scheduler.scheduleTimer(() => {}, 1);',
      'export const run = (logger: Logger) => logger.info("x");',
      'export const run = (emit: StrategyEmitter) => emit("x");',
      'export const run = (clock: RuntimeClock) => { const { now } = clock; return now(); };',
    ] as const;
    const sources: Record<string, string> = { ...contracts };
    for (const [index, call] of calls.entries())
      sources[`src/strategies/newAlpha/pure${index}.ts`] = contractImports + call;

    sources['src/strategies/newAlpha/index.ts'] = contractImports + calls[0];
    sources['src/strategies/newAlpha/verification/pendingVerification.ts'] =
      contractImports.replaceAll("'../../", "'../../../") + calls[1];

    sources['src/strategies/newAlpha/local.ts'] =
      'const clock = { now: () => 1 }; const logger = { info: (value: string) => value }; const emit = (value: number) => value; export const value = [clock.now(), logger.info("x"), emit(1)];';
    const scan = scanSources(sources);
    for (const [index] of calls.entries())
      expect(
        scan.violations.some(
          (row) => row.includes(`pure${index}.ts`) && row.includes('STRATEGY_PURE_CAPABILITY'),
        ),
      ).toBe(true);

    expect(
      scan.violations.filter((row) => /\/index.ts|pendingVerification.ts|local.ts/.test(row)),
    ).toEqual([]);
  });

  it('confines real StrategyDeps fatal calls to runtime roles without banning local names or types', () => {
    const sources: Record<string, string> = {
      'src/types/strategy.ts': readFileSync('src/types/strategy.ts', 'utf8'),
      'src/strategies/newAlpha/local.ts':
        "import type { StrategyDeps } from '../../types/strategy.js'; export const retain = (deps: StrategyDeps): StrategyDeps => deps; export const run = (): number => { const local = { onFatalError: (): number => 1 }; return local.onFatalError(); };",
    };
    const roles = [
      'newMath.ts',
      'definition.ts',
      'index.ts',
      'verification/pendingVerification.ts',
    ];
    for (const role of roles) {
      const prefix = role.includes('/') ? '../../../' : '../../';
      sources[`src/strategies/newAlpha/${role}`] =
        `import type { StrategyDeps } from '${prefix}types/strategy.js'; export const run = (deps: StrategyDeps): void => { deps.onFatalError('direct'); const fail = deps.onFatalError; fail('alias'); const { onFatalError: fatal } = deps; fatal('destructured'); };`;
    }

    const scan = scanSources(sources);
    for (const role of roles)
      expect(
        scan.violations.filter(
          (row) =>
            row.includes(`src/strategies/newAlpha/${role}`) &&
            row.includes('STRATEGY_PURE_CAPABILITY'),
        ),
      ).toHaveLength(role === 'newMath.ts' || role === 'definition.ts' ? 3 : 0);

    expect(scan.violations.filter((row) => row.includes('/local.ts'))).toEqual([]);
  });

  it('rejects SDK and ambient logger access through every module syntax in all roles', () => {
    const loggerEdges = [
      "import { logger } from '../../infrastructure/logger/index.js'; void logger;",
      "export { logger } from '../../infrastructure/logger/index.js';",
      "import logger = require('../../infrastructure/logger/index.js'); void logger;",
      "export const load = () => import('../../infrastructure/logger/index.js');",
      "export const load = () => require('../../infrastructure/logger/index.js');",
    ];
    const sources: Record<string, string> = {
      'src/infrastructure/logger/index.ts': 'export const logger = { info: () => undefined };',
    };
    for (const [index, source] of [...imports, ...loggerEdges].entries())
      for (const role of [
        'newMath.ts',
        'index.ts',
        'definition.ts',
        'verification/pendingVerification.ts',
      ])
        sources[`src/strategies/probe${index}/${role}`] = role.includes('/')
          ? source.replaceAll("'../../", "'../../../")
          : source;

    const scan = scanSources(sources);
    for (const file of Object.keys(sources).filter((candidate) =>
      candidate.startsWith('src/strategies/'),
    )) {
      const isSdk = Number(/probe(\d+)/.exec(file)?.[1]) < imports.length;
      expect(
        (isSdk ? scan.imports : scan.violations).some(
          (row) => row.includes(file) && (isSdk || row.includes('DOMAIN_DIRECT_IO')),
        ),
      ).toBe(true);
    }
  });

  it('retains snapshot mirror checks at the new owner rather than broadening owners', () => {
    const scan = scanSources({
      'src/strategies/newAlpha/newStore.ts':
        'export const state = { cachedAccount: null, cachedPositions: [] }; export const read = () => state.cachedAccount;',
      'src/strategies/newAlpha/sampleStore.ts':
        'export const sample = { timestamp: 1, close: 2 }; export const read = () => sample.close;',
    });
    expect(scan.snapshot.some((row) => row.includes('newStore.ts'))).toBe(true);
    expect(scan.snapshotExposures.some((row) => row.includes('newStore.ts'))).toBe(true);
    expect(scan.snapshot.filter((row) => row.includes('sampleStore.ts'))).toEqual([]);
    expect(scan.snapshotExposures.filter((row) => row.includes('sampleStore.ts'))).toEqual([]);
  });

  it('blocks definition evaluation and SDK exposure through neutral-looking shells', () => {
    const scan = scanSources({
      'src/strategies/newAlpha/index.ts': 'export const run = () => 1;',
      'src/strategies/newAlpha/definition.ts':
        "import { run } from './index.js'; export const value = Object.freeze({ instance: run() });",
      'src/strategies/otherAlpha/definition.ts':
        'export const value = Object.freeze({ prepare: () => ({ create: () => 1 }) });',
      'src/types/shell.ts':
        "import type { QuoteContext } from 'longbridge'; export type Shell = { readonly sdk: { readonly context: QuoteContext } };",
      'src/strategies/newAlpha/types.ts':
        "import type { Shell } from '../../types/shell.js'; export type Input = { readonly shell: Shell };",
      'src/strategies/newAlpha/equals.ts': "import sdk = require('longbridge'); void sdk;",
    });
    expect(
      scan.violations.some(
        (row) =>
          row.includes('newAlpha/definition.ts') && row.includes('STRATEGY_DEFINITION_EVALUATION'),
      ),
    ).toBe(true);

    expect(
      scan.violations.some(
        (row) => row.includes('newAlpha/types.ts') && row.includes('SDK_EXPOSURE'),
      ),
    ).toBe(true);

    expect(
      scan.imports.some((row) => row.includes('equals.ts') && row.includes('IMPORT_EQUALS')),
    ).toBe(true);
    expect(scan.violations.filter((row) => row.includes('otherAlpha/definition.ts'))).toEqual([]);
  });
});

describe('final Longbridge SDK boundary', () => {
  it('has no production SDK import or symbol outside trade/market adapters', () => {
    const root = process.cwd();
    const files = listTypeScript(path.join(root, 'src'));
    const scan = scanProgram(root, createAuditProgram(root, files), files);
    expect(scan.imports).toEqual([]);
    expect(scan.uses).toEqual([]);
    expect(scan.origins).toEqual([]);
    expect(
      scan.violations.filter((key) => key.includes('SDK_EXPOSURE') || key.includes('NONLITERAL')),
    ).toEqual([]);
  });

  it.each(imports)(
    'allows legal market imports but rejects the same business edge: %s',
    (source) => {
      const scan = scanSources({
        'src/infrastructure/longbridge/market/probe.ts': source,
        'src/infrastructure/longbridge/trade/probe.ts': source,
        'src/application/orderExecution/probe.ts': source,
      });
      expect(scan.imports.length).toBeGreaterThan(0);
      expect(
        scan.imports.every((row) => row.includes('src/application/orderExecution/probe.ts')),
      ).toBe(true);

      expect(
        scan.uses.every((row) => row.includes('src/application/orderExecution/probe.ts')),
      ).toBe(true);

      expect(
        scan.origins.every((row) => row.includes('src/application/orderExecution/probe.ts')),
      ).toBe(true);
    },
  );

  it.each([
    "const sdk = 'longbridge'; export const load = () => import(sdk);",
    'export const load = () => import(`longbridge`);',
  ])(
    'rejects unresolved business SDK imports instead of treating them as SDK-free: %s',
    (source) => {
      const scan = scanSources({ 'src/application/orderExecution/probe.ts': source });
      expect(scan.violations.filter((key) => key.includes('NONLITERAL'))).toHaveLength(1);
    },
  );

  it('keeps the verified selected-strategy loader legal under the final NONLITERAL gate', () => {
    const scan = scanSources({
      'src/app/startup/types.ts':
        'export type StrategyLocation = { readonly definitionPath: string }; export interface StrategyFileSystem { readonly importModule: (href: string) => Promise<unknown>; }',
      'src/app/startup/prepareStrategy.ts':
        'export function prepareStrategy(params: unknown, deps: unknown) { return [params, deps]; }',
      'src/app/startup/strategyLoaderHelpers.ts':
        "import { pathToFileURL } from 'node:url'; import type { StrategyLocation, StrategyFileSystem } from './types.js'; export async function importStrategyDefinition(location: StrategyLocation, fs: StrategyFileSystem) { return fs.importModule(pathToFileURL(location.definitionPath).href); }",
      'src/app/runAppDeps.ts':
        "import { prepareStrategy as prepare } from './startup/prepareStrategy.js'; prepare({}, { importModule: (href: string) => import(href) });",
    });
    expect(scan.imports).toEqual([]);
    expect(scan.uses).toEqual([]);
    expect(scan.origins).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
});
