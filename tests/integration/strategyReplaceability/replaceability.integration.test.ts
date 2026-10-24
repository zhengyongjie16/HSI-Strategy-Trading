/** 源码策略替换性离线集成：独立私有 schema 经真实行情/emitter/队列执行，并隔离子进程与清理失败路径。 */
import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createChildEnv } from '../../setup/childEnv.js';
import type { StrategyReplaceabilityCase, StrategyReplaceabilitySmokeResult } from './types.js';

const roots: string[] = [];
const project = fileURLToPath(new URL('../../../', import.meta.url));
const smokeScript = fileURLToPath(new URL('smoke.ts', import.meta.url));

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

/** 只复制完整源码并提供现有依赖；策略以真实文件发现，所有子进程都从空 cwd 启动。 */
async function fixture() {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'strategy replaceability 空格 '));
  roots.push(root);
  await cp(nodePath.join(project, 'src'), nodePath.join(root, 'src'), { recursive: true });
  await symlink(
    nodePath.join(project, 'node_modules'),
    nodePath.join(root, 'node_modules'),
    'junction',
  );
  await mkdir(nodePath.join(root, 'empty cwd'));
  await Promise.all(
    replaceabilityCases.map(async (testCase) => {
      const directory = nodePath.join(root, 'src/strategies', testCase.directory);
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(
          nodePath.join(directory, 'config.json'),
          JSON.stringify(testCase.action === 'BUYCALL' ? privateBuyConfig : privateSellConfig),
        ),
        writeFile(
          nodePath.join(directory, 'definition.ts'),
          testCase.directory === 'privateBuySchema' ? privateBuyDefinition : privateSellDefinition,
        ),
      ]);
    }),
  );
  return { root };
}

/** 同时消费管道并回收退出进程；环境、preload 与 cwd 都不继承真实交易运行上下文。 */
async function runSmokeProcess(root: string, args: ReadonlyArray<string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      '--no-env-file',
      '--preload',
      fileURLToPath(new URL('../../setup/testRuntime.ts', import.meta.url)),
      smokeScript,
      root,
      ...args,
    ],
    {
      cwd: nodePath.join(root, 'empty cwd'),
      env: createChildEnv(root),
      stdout: 'pipe',
      stderr: 'pipe',
    },
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
  testCase: StrategyReplaceabilityCase,
): void {
  const definitionPath = nodePath.join(root, 'src/strategies', testCase.directory, 'definition.ts');
  expect(result).toEqual({
    id: testCase.id,
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
  // 源码求值必须发生在受控子进程，不与父进程共享策略模块缓存或 global。
  expect(result.pid).not.toBe(process.pid);

  for (const other of replaceabilityCases.filter(({ id }) => id !== testCase.id)) {
    expect(result.calls[`${other.id}:import`] ?? 0).toBe(0);
    expect(result.calls[`${other.id}:prepare`] ?? 0).toBe(0);
    expect(result.calls[`${other.id}:create`] ?? 0).toBe(0);
  }
}

test('independent private schemas run from source discovery through real decision queues and destroy', async () => {
  const f = await fixture();
  for (const testCase of replaceabilityCases) {
    const directory = nodePath.join(f.root, 'src/strategies', testCase.directory);
    expect(await readFile(nodePath.join(directory, 'definition.ts'), 'utf8')).not.toContain(
      'intradayRegression',
    );

    expect(JSON.parse(await readFile(nodePath.join(directory, 'config.json'), 'utf8'))).toEqual(
      testCase.action === 'BUYCALL' ? privateBuyConfig : privateSellConfig,
    );
    const result = await runSmokeProcess(f.root, [JSON.stringify(testCase)]);
    assert.equal(result.exitCode, 0, result.stderr);
    expectSmokeResult(parseSmokeResult(result.stdout), f.root, testCase);
  }
}, 60_000);

test.each(['source', 'dist'])(
  'rejects the removed %s CLI layout argument instead of accepting the old protocol',
  async (legacyArgument) => {
    const f = await fixture();
    const testCase = replaceabilityCases[0];
    assert.ok(testCase !== undefined);
    const result = await runSmokeProcess(f.root, [legacyArgument, JSON.stringify(testCase)]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('用法: smoke <绝对工程根> <用例 JSON>');
    expect(result.stdout).not.toContain(smokeResultMarker);
  },
  30_000,
);

test.each(['create', 'decision'] as const)(
  'failed %s smoke still drains before cleanup and destroys the registered instance exactly once',
  async (stage) => {
    const f = await fixture();
    const testCase = replaceabilityCases[0];
    assert.ok(testCase !== undefined);
    const cleanupMarker = 'STRATEGY_REPLACEABILITY_FAILURE_CLEANUP ';
    // 只给测试策略的 destroy 增加观察输出；宿主创建、行情与清理实现保持真实。
    let definition = privateBuyDefinition.replace(
      "bump('private-buy-schema:destroy');",
      `bump('private-buy-schema:destroy');\n            console.log('${cleanupMarker}' + JSON.stringify(calls));`,
    );
    if (stage === 'create') {
      definition = definition.replace(
        "strategyId: 'private-buy-schema',",
        "strategyId: 'unexpected-strategy',",
      );
    }

    await writeFile(
      nodePath.join(f.root, 'src/strategies', testCase.directory, 'definition.ts'),
      definition,
    );
    const input = stage === 'decision' ? { ...testCase, symbol: 'UNEXPECTED.HK' } : testCase;
    const result = await runSmokeProcess(f.root, [JSON.stringify(input)]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(stage === 'create' ? '[Strategy:create]' : 'UNEXPECTED.HK');
    expect(result.stdout).not.toContain(smokeResultMarker);
    const cleanupLines = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(cleanupMarker));
    expect(cleanupLines).toHaveLength(1);
    const cleanupLine = cleanupLines[0];
    assert.ok(cleanupLine !== undefined);
    const calls: unknown = JSON.parse(cleanupLine.slice(cleanupMarker.length));
    expect(calls).toEqual({
      [`${testCase.id}:import`]: 1,
      [`${testCase.id}:prepare`]: 1,
      [`${testCase.id}:create`]: 1,
      ...(stage === 'decision' ? { [`${testCase.id}:onCandlestick`]: 1 } : {}),
      [`${testCase.id}:destroy`]: 1,
    });
  },
  30_000,
);
