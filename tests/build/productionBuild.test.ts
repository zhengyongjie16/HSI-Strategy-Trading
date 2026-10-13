/** 正式 clean + tsc 离线集成：真实 src 与静态 JSON，不创建 SDK context 或运行应用。 */
import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChildEnv } from '../setup/childEnv.js';
import { createEventHarness } from '../runtime/businessEventProgram/fixtures.js';
import type { createBusinessEventProgram } from '../../src/runtime/businessEventProgram/index.js';
import type {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import type { createTerminationRuntime } from '../../src/app/runtime/createTerminationRuntime.js';
import type { createSelectedStrategy } from '../../src/app/startup/createSelectedStrategy.js';
import type { prepareStrategy } from '../../src/app/startup/prepareStrategy.js';
import type { PrepareStrategyDeps } from '../../src/app/startup/types.js';
import type { createCleanup } from '../../src/app/shutdown/createCleanup.js';
import type { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import type { TradingSignalStrategy } from '../../src/types/strategy.js';
import asset from '../../src/config/strategy/intradayRegression/config.json';

const roots: string[] = [];
const project = fileURLToPath(new URL('../../', import.meta.url));
const replaceabilityCallsKey = '__strategyReplaceabilityCalls';
type ReplaceabilityMode = 'source' | 'dist';
type ReplaceabilityCase = {
  readonly id: 'private-buy-schema' | 'private-sell-schema';
  readonly directory: 'privateBuySchema' | 'privateSellSchema';
  readonly action: 'BUYCALL' | 'SELLPUT';
  readonly symbol: 'BULL.HK' | 'BEAR.HK';
  readonly symbolName: '牛' | '熊';
  readonly reason: 'private-buy:threshold' | 'private-sell:filled-buy';
};
type ReplaceabilityRuntime = {
  readonly prepareStrategy: typeof prepareStrategy;
  readonly createSelectedStrategy: typeof createSelectedStrategy;
  readonly createCleanup: typeof createCleanup;
  readonly createBusinessEventProgram: typeof createBusinessEventProgram;
  readonly createBuyTaskQueue: typeof createBuyTaskQueue;
  readonly createSellTaskQueue: typeof createSellTaskQueue;
  readonly createTerminationRuntime: typeof createTerminationRuntime;
  readonly createSymbolRegistry: typeof createSymbolRegistry;
};

const replaceabilityCases: ReadonlyArray<ReplaceabilityCase> = [
  {
    id: 'private-buy-schema',
    directory: 'privateBuySchema',
    action: 'BUYCALL',
    symbol: 'BULL.HK',
    symbolName: '牛',
    reason: 'private-buy:threshold',
  },
  {
    id: 'private-sell-schema',
    directory: 'privateSellSchema',
    action: 'SELLPUT',
    symbol: 'BEAR.HK',
    symbolName: '熊',
    reason: 'private-sell:filled-buy',
  },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 临时工程复用真实 package 命令和编译配置，不构造替代构建流水线。 */
async function fixture() {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'static JSON build 空格 '));
  roots.push(root);
  await cp(nodePath.join(project, 'src'), nodePath.join(root, 'src'), { recursive: true });
  for (const name of ['package.json', 'tsconfig.json', 'tsconfig.build.json'])
    await cp(nodePath.join(project, name), nodePath.join(root, name));

  await symlink(
    nodePath.join(project, 'node_modules'),
    nodePath.join(root, 'node_modules'),
    'junction',
  );
  const cwd = nodePath.join(root, 'empty cwd');
  await mkdir(cwd);
  async function build() {
    return run(['build'], root, root);
  }

  async function add(name: string, config: unknown = asset) {
    const directory = nodePath.join(root, 'src/app/startup/strategyDefinitions', name);
    const configDirectory = nodePath.join(root, 'src/config/strategy', name);
    await Promise.all([
      mkdir(directory, { recursive: true }),
      mkdir(configDirectory, { recursive: true }),
    ]);
    await writeFile(nodePath.join(configDirectory, 'config.json'), JSON.stringify(config));
    await writeFile(
      nodePath.join(directory, 'definition.ts'),
      `
      import config from '../../../../config/strategy/${name}/config.json';
      import { parseStrategyConfig } from '../../../../config/strategy/intradayRegression/config.js';
      export const strategyDefinition = {
        id: '${name}',
        prepare() {
          parseStrategyConfig(config);
          return { create() { throw Error('create must remain deferred'); } };
        }
      };
    `,
    );
  }

  async function addReplaceabilityStrategies(): Promise<void> {
    const buy = nodePath.join(root, 'src/app/startup/strategyDefinitions/privateBuySchema');
    const sell = nodePath.join(root, 'src/app/startup/strategyDefinitions/privateSellSchema');
    const buyConfig = nodePath.join(root, 'src/config/strategy/privateBuySchema');
    const sellConfig = nodePath.join(root, 'src/config/strategy/privateSellSchema');
    await Promise.all(
      [buy, sell, buyConfig, sellConfig].map((directory) => mkdir(directory, { recursive: true })),
    );

    await writeFile(
      nodePath.join(buyConfig, 'config.json'),
      JSON.stringify({ mode: 'threshold', threshold: 7, action: 'BUYCALL', label: 'threshold' }),
    );

    await writeFile(
      nodePath.join(sellConfig, 'config.json'),
      JSON.stringify({
        authorization: 'filled-buy',
        direction: 'SHORT',
        action: 'SELLPUT',
        label: 'filled-buy',
      }),
    );

    await writeFile(
      nodePath.join(buy, 'definition.ts'),
      `import type {
  StrategyDefinition,
  StrategyDeps,
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../../types/strategy.js';
import configJson from '../../../../config/strategy/privateBuySchema/config.json';

type PrivateBuyConfig = {
  readonly mode: 'threshold';
  readonly threshold: number;
  readonly action: 'BUYCALL';
  readonly label: 'threshold';
};
const config = configJson as PrivateBuyConfig;
const calls = ((globalThis as Record<string, unknown>)['${replaceabilityCallsKey}'] ??= {}) as Record<string, number>;
function bump(name: string): void {
  calls[name] = (calls[name] ?? 0) + 1;
}
bump('private-buy-schema:import');

export const strategyDefinition: StrategyDefinition = Object.freeze({
  id: 'private-buy-schema',
  prepare() {
    bump('private-buy-schema:prepare');
    if (config.mode !== 'threshold' || config.threshold !== 7 || config.action !== 'BUYCALL') {
      throw new Error('private buy schema was not loaded');
    }

    return Object.freeze({
      create(deps: StrategyDeps): TradingSignalStrategy {
        bump('private-buy-schema:create');
        return {
          strategyId: 'private-buy-schema',
          onCandlestick(
            context: StrategyMarketContext,
            emit: StrategyEmitter,
          ): ReadonlyArray<StrategyDisplayItem> {
            bump('private-buy-schema:onCandlestick');
            if (context.allowNewEvaluation) {
              emit({
                action: config.action,
                triggerTimeMs: deps.clock.now().getTime(),
                reason: 'private-buy:' + config.label,
              });
            }
            return [{ label: config.label, valueText: 'ready' }];
          },
          invalidateDirection() {},
          invalidateAll() {},
          resetForTradingDay() {},
          destroy() {
            bump('private-buy-schema:destroy');
          },
        };
      },
    });
  },
});
`,
    );

    await writeFile(
      nodePath.join(sell, 'definition.ts'),
      `import type {
  StrategyDefinition,
  StrategyDeps,
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../../types/strategy.js';
import configJson from '../../../../config/strategy/privateSellSchema/config.json';

type PrivateSellConfig = {
  readonly authorization: 'filled-buy';
  readonly direction: 'SHORT';
  readonly action: 'SELLPUT';
  readonly label: 'filled-buy';
};
const config = configJson as PrivateSellConfig;
const calls = ((globalThis as Record<string, unknown>)['${replaceabilityCallsKey}'] ??= {}) as Record<string, number>;
function bump(name: string): void {
  calls[name] = (calls[name] ?? 0) + 1;
}
bump('private-sell-schema:import');

export const strategyDefinition: StrategyDefinition = Object.freeze({
  id: 'private-sell-schema',
  prepare() {
    bump('private-sell-schema:prepare');
    if (
      config.authorization !== 'filled-buy' ||
      config.direction !== 'SHORT' ||
      config.action !== 'SELLPUT'
    ) {
      throw new Error('private sell schema was not loaded');
    }

    return Object.freeze({
      create(deps: StrategyDeps): TradingSignalStrategy {
        bump('private-sell-schema:create');
        return {
          strategyId: 'private-sell-schema',
          onCandlestick(
            context: StrategyMarketContext,
            emit: StrategyEmitter,
          ): ReadonlyArray<StrategyDisplayItem> {
            bump('private-sell-schema:onCandlestick');
            if (context.allowNewEvaluation) {
              emit({
                action: config.action,
                triggerTimeMs: deps.clock.now().getTime(),
                reason: 'private-sell:' + config.label,
              });
            }
            return [{ label: config.label, valueText: 'ready' }];
          },
          invalidateDirection() {},
          invalidateAll() {},
          resetForTradingDay() {},
          destroy() {
            bump('private-sell-schema:destroy');
          },
        };
      },
    });
  },
});
`,
    );
  }
  const runner = nodePath.join(root, 'load.mjs');
  await writeFile(
    runner,
    `
    import { prepareStrategy } from './dist/src/app/startup/prepareStrategy.js';
    import { lstat, readdir, realpath } from 'node:fs/promises';
    const selection = await prepareStrategy({ env: { ACTIVE_STRATEGY_ID: process.argv[2] } }, {
      lstat, realpath, readDirectory: readdir, importModule: href => import(href)
    });
    console.log(selection.strategyId);
  `,
  );
  async function load(id: string) {
    return run([runner, id], cwd, root);
  }
  return { root, add, addReplaceabilityStrategies, build, load };
}

/** 同时收集两个管道，避免大编译诊断堵塞子进程。 */
async function run(command: ReadonlyArray<string>, cwd: string, isolationRoot: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      '--no-env-file',
      '--preload',
      fileURLToPath(new URL('../setup/testRuntime.ts', import.meta.url)),
      ...command,
    ],
    { cwd, env: createChildEnv(isolationRoot), stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** 返回相对产物清单，检查真实编译输出而非硬编码数量。 */
async function files(root: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(root, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return [entry.name];

      const children = await files(nodePath.join(root, entry.name));
      return children.map((name) => entry.name + '/' + name);
    }),
  );
  return groups.flat();
}

/** 从同一临时工程加载 source 或正式 dist 的真实策略装配链。 */
async function loadReplaceabilityRuntime(
  root: string,
  mode: ReplaceabilityMode,
): Promise<ReplaceabilityRuntime> {
  const sourceRoot = nodePath.join(root, mode === 'source' ? 'src' : 'dist/src');
  const extension = mode === 'source' ? '.ts' : '.js';
  const load = async <TModule extends object>(relativePath: string): Promise<TModule> => {
    const href = pathToFileURL(nodePath.join(sourceRoot, relativePath + extension)).href;
    const module: unknown = await import(href);
    return module as TModule;
  };
  const [startup, selected, cleanup, business, queue, termination, registry] = await Promise.all([
    load<Pick<ReplaceabilityRuntime, 'prepareStrategy'>>('app/startup/prepareStrategy'),
    load<Pick<ReplaceabilityRuntime, 'createSelectedStrategy'>>(
      'app/startup/createSelectedStrategy',
    ),
    load<Pick<ReplaceabilityRuntime, 'createCleanup'>>('app/shutdown/createCleanup'),
    load<Pick<ReplaceabilityRuntime, 'createBusinessEventProgram'>>(
      'runtime/businessEventProgram/index',
    ),
    load<Pick<ReplaceabilityRuntime, 'createBuyTaskQueue' | 'createSellTaskQueue'>>(
      'runtime/asyncProgram/tradeTaskQueue/index',
    ),
    load<Pick<ReplaceabilityRuntime, 'createTerminationRuntime'>>(
      'app/runtime/createTerminationRuntime',
    ),
    load<Pick<ReplaceabilityRuntime, 'createSymbolRegistry'>>('domain/seat/symbolRegistry'),
  ]);
  return {
    prepareStrategy: startup.prepareStrategy,
    createSelectedStrategy: selected.createSelectedStrategy,
    createCleanup: cleanup.createCleanup,
    createBusinessEventProgram: business.createBusinessEventProgram,
    createBuyTaskQueue: queue.createBuyTaskQueue,
    createSellTaskQueue: queue.createSellTaskQueue,
    createTerminationRuntime: termination.createTerminationRuntime,
    createSymbolRegistry: registry.createSymbolRegistry,
  };
}

/** 通过真实 loader/实例/行情事件/emitter/queue 运行一个最小策略闭环。 */
async function runReplaceabilitySmoke(
  root: string,
  mode: ReplaceabilityMode,
  testCase: ReplaceabilityCase,
): Promise<void> {
  const runtime = await loadReplaceabilityRuntime(root, mode);
  const extension = mode === 'source' ? '.ts' : '.js';
  const sourceRoot = nodePath.join(root, mode === 'source' ? 'src' : 'dist/src');
  const imported: string[] = [];
  const calls = Object.create(null) as Record<string, number>;
  (globalThis as Record<string, unknown>)[replaceabilityCallsKey] = calls;
  const strategyFileSystem: PrepareStrategyDeps = {
    loaderModuleHref: pathToFileURL(
      nodePath.join(sourceRoot, 'app/startup/prepareStrategy' + extension),
    ).href,
    lstat,
    realpath,
    readDirectory: (path: string) => readdir(path),
    importModule: async (href: string): Promise<unknown> => {
      imported.push(fileURLToPath(href));
      const module: unknown = await import(href);
      return module;
    },
  };
  const selection = await runtime.prepareStrategy(
    { env: { ACTIVE_STRATEGY_ID: testCase.id } },
    strategyFileSystem,
  );

  let selected: TradingSignalStrategy | null = null;
  const strategySlot: TradingSignalStrategy = {
    strategyId: testCase.id,
    onCandlestick: (context, emit) => {
      if (selected === null) {
        throw new Error('selected strategy was not created');
      }

      return selected.onCandlestick(context, emit);
    },
    invalidateDirection: (direction) => selected?.invalidateDirection(direction),
    invalidateAll: () => selected?.invalidateAll(),
    resetForTradingDay: () => selected?.resetForTradingDay(),
    destroy: () => selected?.destroy(),
  };
  const harness = createEventHarness({
    strategy: strategySlot,
    createBusinessEventProgram: runtime.createBusinessEventProgram,
    createBuyTaskQueue: runtime.createBuyTaskQueue,
    createSellTaskQueue: runtime.createSellTaskQueue,
    createSymbolRegistry: runtime.createSymbolRegistry,
    createTerminationRuntime: runtime.createTerminationRuntime,
  });
  const cleanup = runtime.createCleanup();
  selected = runtime.createSelectedStrategy(
    selection,
    {
      clock: harness.deps.clock,
      scheduler: {
        scheduleTimer: () => {
          throw new Error('replaceability fixture must not schedule a timer');
        },
        clearTimer: () => {},
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      onFatalError: harness.termination.reportFatalError,
    },
    cleanup,
  );

  try {
    harness.program.start();
    harness.publish();
    await Promise.resolve();
    expect(harness.contexts).toHaveLength(1);
    expect(harness.termination.isTerminated()).toBeFalse();
    expect(harness.displays).toHaveLength(1);
    expect(
      harness.contexts[0]?.seats.find((seat) => seat.direction === 'SHORT')?.hasFilledBuyOrders,
    ).toBeTrue();

    const task =
      testCase.action === 'BUYCALL' ? harness.buyTaskQueue.pop() : harness.sellTaskQueue.pop();
    expect(task?.type).toBe(testCase.action === 'BUYCALL' ? 'STRATEGY_BUY' : 'STRATEGY_SELL');
    expect(task?.data).toMatchObject({
      action: testCase.action,
      symbol: testCase.symbol,
      symbolName: testCase.symbolName,
      seatVersion: 1,
      triggerTime: new Date(harness.mutable.nowMs),
      reason: testCase.reason,
    });

    expect(
      testCase.action === 'BUYCALL'
        ? harness.sellTaskQueue.isEmpty()
        : harness.buyTaskQueue.isEmpty(),
    ).toBeTrue();
  } finally {
    await harness.program.stopAndDrain();
    await cleanup.execute();
  }

  const directory = nodePath.join(
    root,
    mode === 'source'
      ? 'src/app/startup/strategyDefinitions'
      : 'dist/src/app/startup/strategyDefinitions',
    testCase.directory,
  );
  expect(imported).toEqual([nodePath.join(directory, `definition${extension}`)]);
  expect(calls).toEqual({
    [`${testCase.id}:import`]: 1,
    [`${testCase.id}:prepare`]: 1,
    [`${testCase.id}:create`]: 1,
    [`${testCase.id}:onCandlestick`]: 1,
    [`${testCase.id}:destroy`]: 1,
  });
  const other = replaceabilityCases.find(({ id }) => id !== testCase.id);
  if (other === undefined) {
    throw new Error('replaceability fixture requires two strategies');
  }

  expect(calls[`${other.id}:import`] ?? 0).toBe(0);
  expect(calls[`${other.id}:prepare`] ?? 0).toBe(0);
  expect(calls[`${other.id}:create`] ?? 0).toBe(0);
}

test('package build is only clean + tsc; actual JSON semantics, JSON-only rebuild and added/deleted imports', async () => {
  const f = await fixture();
  const packageConfig: unknown = JSON.parse(
    await readFile(nodePath.join(f.root, 'package.json'), 'utf8'),
  );
  assert.ok(
    typeof packageConfig === 'object' && packageConfig !== null && 'scripts' in packageConfig,
  );

  assert.ok(
    typeof packageConfig.scripts === 'object' &&
      packageConfig.scripts !== null &&
      'build' in packageConfig.scripts,
  );
  expect(packageConfig.scripts.build).toBe('bun run clean && tsc -p tsconfig.build.json');
  const result1 = await f.build();
  expect(result1.exitCode).toBe(0);
  const output = nodePath.join(f.root, 'dist/src/config/strategy/intradayRegression/config.json');
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(asset);
  const outputs = await files(nodePath.join(f.root, 'dist'));
  expect(outputs.every((name) => name.startsWith('src/') && /\.(js|json)$/.test(name))).toBe(true);
  const changed = {
    ...asset,
    verification: { ...asset.verification, buy: { delaySeconds: 0.5, indicators: ['D'] } },
  };
  await writeFile(
    nodePath.join(f.root, 'src/config/strategy/intradayRegression/config.json'),
    JSON.stringify(changed),
  );
  const result2 = await f.build();
  expect(result2.exitCode).toBe(0);
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(changed);
  await f.add('alpha');
  const result3 = await f.build();
  expect(result3.exitCode).toBe(0);
  const result4 = await f.load('alpha');
  expect(result4.exitCode).toBe(0);
  const alpha = nodePath.join(f.root, 'dist/src/app/startup/strategyDefinitions/alpha');
  expect(
    JSON.parse(
      await readFile(nodePath.join(f.root, 'dist/src/config/strategy/alpha/config.json'), 'utf8'),
    ),
  ).toEqual(asset);

  await Promise.all([
    rm(nodePath.join(f.root, 'src/app/startup/strategyDefinitions/alpha'), { recursive: true }),
    rm(nodePath.join(f.root, 'src/config/strategy/alpha'), { recursive: true }),
  ]);
  const result5 = await f.build();
  expect(result5.exitCode).toBe(0);
  await assert.rejects(readFile(nodePath.join(alpha, 'definition.js')));
}, 180_000);

test('build never prepares: invalid DSL/schema compile, only selected startup fails before create', async () => {
  const f = await fixture();
  await f.add('alpha');
  await f.add('bad', { ...asset, signals: { ...asset.signals, BUYCALL: '(ADX>1)' } });
  await f.add('unknown', { ...asset, extra: true });
  // 未导入的坏 JSON 和半成品目录没有自定义构建扫描。
  await mkdir(nodePath.join(f.root, 'src/app/startup/strategyDefinitions/unfinished'));
  await mkdir(nodePath.join(f.root, 'src/config/strategy/unfinished'));
  await writeFile(
    nodePath.join(f.root, 'src/config/strategy/unfinished/config.json'),
    'broken JSON',
  );
  const result6 = await f.build();
  expect(result6.exitCode).toBe(0);
  const result7 = await f.load('alpha');
  expect(result7.exitCode).toBe(0);
  for (const id of ['bad', 'unknown']) {
    const result = await f.load(id);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Strategy:prepare');
    expect(result.stderr).not.toContain('create must remain deferred');
  }

  await rename(nodePath.join(f.root, 'src'), nodePath.join(f.root, 'source removed'));
  const result8 = await f.load('alpha');
  expect(result8.stdout.trim()).toBe('alpha');
  await rm(nodePath.join(f.root, 'dist/src/config/strategy/alpha/config.json'));
  const missing = await f.load('alpha');
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain('必需文件');
}, 120_000);

test('independent private schemas run source and clean-build dist from create to decision queue', async () => {
  const f = await fixture();
  await f.addReplaceabilityStrategies();
  const built = await f.build();
  expect(built.exitCode).toBe(0);

  for (const testCase of replaceabilityCases) {
    const sourceDefinition = nodePath.join(
      f.root,
      'src/app/startup/strategyDefinitions',
      testCase.directory,
      'definition.ts',
    );
    const distConfig = nodePath.join(
      f.root,
      'dist/src/config/strategy',
      testCase.directory,
      'config.json',
    );
    expect(await readFile(sourceDefinition, 'utf8')).not.toContain('intradayRegression');
    expect(JSON.parse(await readFile(distConfig, 'utf8'))).toEqual(
      testCase.action === 'BUYCALL'
        ? { mode: 'threshold', threshold: 7, action: 'BUYCALL', label: 'threshold' }
        : {
            authorization: 'filled-buy',
            direction: 'SHORT',
            action: 'SELLPUT',
            label: 'filled-buy',
          },
    );
    await runReplaceabilitySmoke(f.root, 'source', testCase);
  }

  await rename(nodePath.join(f.root, 'src'), nodePath.join(f.root, 'source removed'));
  for (const testCase of replaceabilityCases) {
    await runReplaceabilitySmoke(f.root, 'dist', testCase);
  }
}, 180_000);

test('clean plus noEmitOnError leaves no stale JavaScript on compiler errors or missing imported JSON', async () => {
  const f = await fixture();
  const result9 = await f.build();
  expect(result9.exitCode).toBe(0);
  await writeFile(
    nodePath.join(f.root, 'src/buildFailure.ts'),
    'export const value: number = "bad";',
  );
  const result10 = await f.build();
  expect(result10.exitCode).not.toBe(0);
  expect(await Bun.file(nodePath.join(f.root, 'dist/src/index.js')).exists()).toBe(false);
  await rm(nodePath.join(f.root, 'src/buildFailure.ts'));
  await rm(nodePath.join(f.root, 'src/config/strategy/intradayRegression/config.json'));
  const result11 = await f.build();
  expect(result11.exitCode).not.toBe(0);
  expect(await Bun.file(nodePath.join(f.root, 'dist/src/index.js')).exists()).toBe(false);
}, 120_000);
