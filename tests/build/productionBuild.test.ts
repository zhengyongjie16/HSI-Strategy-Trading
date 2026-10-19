/** 正式 clean + tsc 离线集成：真实 src 与静态 JSON，不创建 SDK context 或运行应用。 */
import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChildEnv } from '../setup/childEnv.js';
import asset from '../../src/strategies/intradayRegression/config.json';
import type {
  StrategyReplaceabilityCase,
  StrategyReplaceabilityMode,
  StrategyReplaceabilitySmokeResult,
} from './types.js';

const roots: string[] = [];
const project = fileURLToPath(new URL('../../', import.meta.url));
const smokeScript = fileURLToPath(new URL('strategyReplaceabilitySmoke.ts', import.meta.url));

/** 与 smoke 子进程约定的结果行前缀；父进程只消费结构化回传，不共享跨进程 global。 */
const smokeResultMarker = 'STRATEGY_REPLACEABILITY_SMOKE_RESULT ';
const replaceabilityCallsKey = '__strategyReplaceabilityCalls';

const replaceabilityCases: ReadonlyArray<StrategyReplaceabilityCase> = [
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

/** 独立买入 schema 的私有配置与 definition 源码；与日内策略 parser/指标完全无关。 */
const privateBuyConfig: Readonly<Record<string, unknown>> = {
  mode: 'threshold',
  threshold: 7,
  action: 'BUYCALL',
  label: 'threshold',
};

/** 独立卖出 schema 的私有配置；authorization/direction 只在本策略 prepare 内解释。 */
const privateSellConfig: Readonly<Record<string, unknown>> = {
  authorization: 'filled-buy',
  direction: 'SHORT',
  action: 'SELLPUT',
  label: 'filled-buy',
};

const privateBuyDefinition = `import type {
  StrategyDefinition,
  StrategyDeps,
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../types/strategy.js';
import configJson from './config.json';

type PrivateBuyConfig = {
  readonly mode: 'threshold';
  readonly threshold: number;
  readonly action: 'BUYCALL';
  readonly label: 'threshold';
};

function parseConfig(value: unknown): PrivateBuyConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('private buy config must be an object');
  }

  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join(',') !== 'action,label,mode,threshold') {
    throw new Error('private buy schema was not loaded');
  }

  const mode = record['mode'];
  const threshold = record['threshold'];
  const action = record['action'];
  const label = record['label'];
  if (mode !== 'threshold' || threshold !== 7 || action !== 'BUYCALL' || label !== 'threshold') {
    throw new Error('private buy schema was not loaded');
  }

  return { mode, threshold, action, label };
}

const calls = ((globalThis as Record<string, unknown>)['${replaceabilityCallsKey}'] ??= {}) as Record<string, number>;
function bump(name: string): void {
  calls[name] = (calls[name] ?? 0) + 1;
}
bump('private-buy-schema:import');

export const strategyDefinition: StrategyDefinition = Object.freeze({
  id: 'private-buy-schema',
  prepare() {
    bump('private-buy-schema:prepare');
    const config = parseConfig(configJson);
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
`;

const privateSellDefinition = `import type {
  StrategyDefinition,
  StrategyDeps,
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../types/strategy.js';
import configJson from './config.json';

type PrivateSellConfig = {
  readonly authorization: 'filled-buy';
  readonly direction: 'SHORT';
  readonly action: 'SELLPUT';
  readonly label: 'filled-buy';
};

function parseConfig(value: unknown): PrivateSellConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('private sell config must be an object');
  }

  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join(',') !== 'action,authorization,direction,label') {
    throw new Error('private sell schema was not loaded');
  }

  const authorization = record['authorization'];
  const direction = record['direction'];
  const action = record['action'];
  const label = record['label'];
  if (
    authorization !== 'filled-buy' ||
    direction !== 'SHORT' ||
    action !== 'SELLPUT' ||
    label !== 'filled-buy'
  ) {
    throw new Error('private sell schema was not loaded');
  }

  return { authorization, direction, action, label };
}

const calls = ((globalThis as Record<string, unknown>)['${replaceabilityCallsKey}'] ??= {}) as Record<string, number>;
function bump(name: string): void {
  calls[name] = (calls[name] ?? 0) + 1;
}
bump('private-sell-schema:import');

export const strategyDefinition: StrategyDefinition = Object.freeze({
  id: 'private-sell-schema',
  prepare() {
    bump('private-sell-schema:prepare');
    const config = parseConfig(configJson);
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
`;

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

  async function add(name: string, config: unknown = fixtureConfig(name)) {
    const directory = nodePath.join(root, 'src/strategies', name);
    await mkdir(directory, { recursive: true });
    await writeFile(nodePath.join(directory, 'config.json'), JSON.stringify(config));
    await writeFile(nodePath.join(directory, 'definition.ts'), fixtureDefinition(name));
  }

  async function addReplaceabilityStrategies(): Promise<void> {
    await Promise.all(
      replaceabilityCases.map((testCase) =>
        mkdir(nodePath.join(root, 'src/strategies', testCase.directory), { recursive: true }),
      ),
    );

    await Promise.all(
      replaceabilityCases.map((testCase) => {
        const directory = nodePath.join(root, 'src/strategies', testCase.directory);
        return Promise.all([
          writeFile(
            nodePath.join(directory, 'config.json'),
            JSON.stringify(testCase.action === 'BUYCALL' ? privateBuyConfig : privateSellConfig),
          ),
          writeFile(
            nodePath.join(directory, 'definition.ts'),
            testCase.directory === 'privateBuySchema'
              ? privateBuyDefinition
              : privateSellDefinition,
          ),
        ]);
      }),
    );
  }

  const runner = nodePath.join(root, 'load.mjs');
  await writeFile(
    runner,
    `
    import { prepareStrategy } from './dist/src/app/startup/prepareStrategy.js';
    import { lstat, readdir, realpath } from 'node:fs/promises';
    import { importFixtureModule } from ${JSON.stringify(pathToFileURL(nodePath.join(project, 'tests/helpers/importFixtureModule.ts')).href)};
    const root = ${JSON.stringify(root)};
    const selection = await prepareStrategy({ env: { ACTIVE_STRATEGY_ID: process.argv[2] } }, {
      lstat, realpath, readDirectory: readdir, importModule: href => importFixtureModule(root, href)
    });
    console.log(selection.strategyId);
  `,
  );
  async function load(id: string) {
    return run([runner, id], cwd, root);
  }
  return { root, add, addReplaceabilityStrategies, build, load };
}

/** 默认 fixture 配置与定义只服务构建/加载边界，不引用日内策略实现。 */
function fixtureConfig(name: string): Readonly<Record<string, unknown>> {
  return { action: 'BUYCALL', label: name, threshold: 7, rule: '(ADX>1)' };
}

/** 可独立编译的策略定义：prepare 内校验本目录静态 JSON，create 保持延迟。 */
function fixtureDefinition(name: string): string {
  return `import type { StrategyDefinition } from '../../types/strategy.js';
import configJson from './config.json';

type PrivateConfig = {
  readonly action: 'BUYCALL' | 'SELLPUT';
  readonly label: string;
  readonly threshold: number;
  readonly rule: string;
};

function parseConfig(value: unknown): PrivateConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture config must be an object');
  }

  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join(',') !== 'action,label,rule,threshold') {
    throw new Error('fixture config fields mismatch');
  }

  const action = record['action'];
  const label = record['label'];
  const threshold = record['threshold'];
  const rule = record['rule'];
  if (action !== 'BUYCALL' && action !== 'SELLPUT') {
    throw new Error('fixture action invalid');
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('fixture label invalid');
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new Error('fixture threshold invalid');
  }
  if (typeof rule !== 'string' || !rule.startsWith('(') || !rule.endsWith(')') || rule.length < 3) {
    throw new Error('fixture rule DSL invalid');
  }

  return { action, label, threshold, rule };
}

export const strategyDefinition: StrategyDefinition = Object.freeze({
  id: '${name}',
  prepare() {
    parseConfig(configJson);
    return Object.freeze({
      create() {
        throw new Error('create must remain deferred');
      },
    });
  },
});
`;
}

/**
 * 同时收集两个管道，避免大编译诊断堵塞子进程；退出后仍在本函数内回收子进程。
 */
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
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }

    await child.exited;
  }
}

/** 以独立子进程运行 source/dist smoke；源码求值进程完全退出后父进程才移动 src。 */
async function runReplaceabilitySmoke(
  root: string,
  mode: StrategyReplaceabilityMode,
  testCase: StrategyReplaceabilityCase,
): Promise<StrategyReplaceabilitySmokeResult> {
  const result = await run(
    [smokeScript, root, mode, JSON.stringify(testCase)],
    nodePath.join(root, 'empty cwd'),
    root,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return parseSmokeResult(result.stdout);
}

/** 只解析 smoke 的约定结果行；其他 stdout 保持诊断用途，不参与断言。 */
function parseSmokeResult(stdout: string): StrategyReplaceabilitySmokeResult {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(smokeResultMarker));
  assert.ok(line !== undefined, '替换性 smoke 子进程未回传结构化结果');
  const parsed: unknown = JSON.parse(line.slice(smokeResultMarker.length));
  return parsed as StrategyReplaceabilitySmokeResult;
}

/** 复核结构化回传，并保留所有原队列字段、对侧空、无 fatal 与精确调用次数断言。 */
function expectSmokeResult(
  result: StrategyReplaceabilitySmokeResult,
  root: string,
  mode: StrategyReplaceabilityMode,
  testCase: StrategyReplaceabilityCase,
): void {
  const definitionPath = nodePath.join(
    root,
    mode === 'source' ? 'src' : 'dist/src',
    'strategies',
    testCase.directory,
    `definition${mode === 'source' ? '.ts' : '.js'}`,
  );
  expect(result).toEqual({
    id: testCase.id,
    mode,
    pid: result.pid,
    definitionPath,
    importedPaths: [definitionPath],
    calls: {
      [`${testCase.id}:import`]: 1,
      [`${testCase.id}:prepare`]: 1,
      [`${testCase.id}:create`]: 1,
      [`${testCase.id}:onCandlestick`]: 1,
      [`${testCase.id}:destroy`]: 1,
    },
    nowMs: result.nowMs,
    task: {
      type: testCase.action === 'BUYCALL' ? 'STRATEGY_BUY' : 'STRATEGY_SELL',
      action: testCase.action,
      symbol: testCase.symbol,
      symbolName: testCase.symbolName,
      seatVersion: 1,
      triggerTimeMs: result.nowMs,
      reason: testCase.reason,
    },
    oppositeQueueEmpty: true,
    contextCount: 1,
    displayCount: 1,
    hasFilledBuyOrders: true,
    terminated: false,
  });
  // 结构化回传的 PID 必须不是当前测试进程，证明 source/dist 求值都发生在受控子进程。
  expect(result.pid).not.toBe(process.pid);

  for (const other of replaceabilityCases.filter(({ id }) => id !== testCase.id)) {
    expect(result.calls[`${other.id}:import`] ?? 0).toBe(0);
    expect(result.calls[`${other.id}:prepare`] ?? 0).toBe(0);
    expect(result.calls[`${other.id}:create`] ?? 0).toBe(0);
  }
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
  const output = nodePath.join(f.root, 'dist/src/strategies/intradayRegression/config.json');
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(asset);
  const outputs = await files(nodePath.join(f.root, 'dist'));
  expect(outputs.every((name) => name.startsWith('src/') && /\.(js|json)$/.test(name))).toBe(true);
  const changed = {
    ...asset,
    verification: { ...asset.verification, buy: { delaySeconds: 0.5, indicators: ['D'] } },
  };
  await writeFile(
    nodePath.join(f.root, 'src/strategies/intradayRegression/config.json'),
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
  const alpha = nodePath.join(f.root, 'dist/src/strategies/alpha');
  expect(JSON.parse(await readFile(nodePath.join(alpha, 'config.json'), 'utf8'))).toEqual(
    fixtureConfig('alpha'),
  );

  await rm(nodePath.join(f.root, 'src/strategies/alpha'), { recursive: true });
  const result5 = await f.build();
  expect(result5.exitCode).toBe(0);
  await assert.rejects(readFile(nodePath.join(alpha, 'definition.js')));
}, 180_000);

test('build never prepares: invalid DSL/schema compile, only selected startup fails before create', async () => {
  const f = await fixture();
  await f.add('alpha');
  await f.add('bad', { ...fixtureConfig('bad'), rule: '(ADX>1' });
  await f.add('unknown', { ...fixtureConfig('unknown'), extra: true });
  // 未导入的坏 JSON 和半成品目录没有自定义构建扫描。
  await mkdir(nodePath.join(f.root, 'src/strategies/unfinished'));
  await writeFile(nodePath.join(f.root, 'src/strategies/unfinished/config.json'), 'broken JSON');
  const result6 = await f.build();
  expect(result6.exitCode).toBe(0);
  const result7 = await f.load('alpha');
  expect(result7.exitCode).toBe(0);
  for (const id of ['bad', 'unknown']) {
    const result = await f.load(id);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Strategy:prepare');
    expect(result.stderr).not.toContain('Strategy:import');
    expect(result.stderr).not.toContain('Strategy:create');
  }

  await rename(nodePath.join(f.root, 'src'), nodePath.join(f.root, 'source removed'));
  const result8 = await f.load('alpha');
  expect(result8.stdout.trim()).toBe('alpha');
  await rm(nodePath.join(f.root, 'dist/src/strategies/alpha/config.json'));
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
      'src/strategies',
      testCase.directory,
      'definition.ts',
    );
    const distConfig = nodePath.join(
      f.root,
      'dist/src/strategies',
      testCase.directory,
      'config.json',
    );
    expect(await readFile(sourceDefinition, 'utf8')).not.toContain('intradayRegression');
    expect(JSON.parse(await readFile(distConfig, 'utf8'))).toEqual(
      testCase.action === 'BUYCALL' ? privateBuyConfig : privateSellConfig,
    );
    const sourceResult = await runReplaceabilitySmoke(f.root, 'source', testCase);
    expectSmokeResult(sourceResult, f.root, 'source', testCase);
  }

  // source 子进程全部退出后父进程才移动源码，dist 子进程仍要求原 src 路径不存在。
  await rename(nodePath.join(f.root, 'src'), nodePath.join(f.root, 'source removed'));
  for (const testCase of replaceabilityCases) {
    const distResult = await runReplaceabilitySmoke(f.root, 'dist', testCase);
    expectSmokeResult(distResult, f.root, 'dist', testCase);
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
  await rm(nodePath.join(f.root, 'src/strategies/intradayRegression/config.json'));
  const result11 = await f.build();
  expect(result11.exitCode).not.toBe(0);
  expect(await Bun.file(nodePath.join(f.root, 'dist/src/index.js')).exists()).toBe(false);
}, 120_000);
