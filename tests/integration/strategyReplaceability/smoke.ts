/**
 * 源码策略替换性 smoke 子进程入口。
 * 从临时工程的 src 加载真实宿主入口，执行
 * prepare → create → 行情事件 → emitter → 决策队列 → destroy，并在本子进程内核对
 * 全局调用计数、队列字段与未选策略零执行，最后以单行 JSON 回传观察值。
 * 成功和失败都先停止并排空行情程序，再由原 cleanup owner 释放已登记实例。
 */
import assert from 'node:assert/strict';
import { lstat, readdir, realpath } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importFixtureModule } from '../../helpers/importFixtureModule.js';
import { createEventHarness } from '../../runtime/businessEventProgram/fixtures.js';
import type { PrepareStrategyDeps } from '../../../src/app/startup/types.js';
import type { TradingSignalStrategy } from '../../../src/types/strategy.js';
import type { EventHarness } from '../../runtime/businessEventProgram/types.js';
import type {
  StrategyReplaceabilityCase,
  StrategyReplaceabilityObservation,
  StrategyReplaceabilityRuntime,
  StrategyReplaceabilitySmokeResult,
} from './types.js';

/** 策略 definition 求值时写入的全局计数键；子进程独占，父进程只消费结构化回传。 */
const callsKey = '__strategyReplaceabilityCalls';

/** 结果行前缀；父进程只解析带此前缀的行，避免其他输出干扰。 */
const resultMarker = 'STRATEGY_REPLACEABILITY_SMOKE_RESULT ';

/** 校验父进程传入的用例 JSON，拒绝缺字段或非预期动作。 */
function isStrategyReplaceabilityCase(value: unknown): value is StrategyReplaceabilityCase {
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['directory'] === 'string' &&
    /^[a-z][a-zA-Z0-9]*$/.test(record['directory']) &&
    (record['action'] === 'BUYCALL' || record['action'] === 'SELLPUT') &&
    typeof record['symbol'] === 'string' &&
    typeof record['symbolName'] === 'string' &&
    typeof record['reason'] === 'string'
  );
}

/** 读取严格的两参数协议；拒绝多余参数，避免旧运行布局参数被静默忽略。 */
function readArguments(): {
  readonly root: string;
  readonly testCase: StrategyReplaceabilityCase;
} {
  const args = process.argv.slice(2);
  const [root, rawCase] = args;
  if (
    args.length !== 2 ||
    root === undefined ||
    rawCase === undefined ||
    !nodePath.isAbsolute(root)
  ) {
    throw new Error('用法: smoke <绝对工程根> <用例 JSON>');
  }

  const parsed: unknown = JSON.parse(rawCase);
  if (!isStrategyReplaceabilityCase(parsed)) {
    throw new Error('替换性 smoke 用例 JSON 无效');
  }

  return { root, testCase: parsed };
}

/** 从临时工程加载七个真实宿主入口；每个模块都经受控 importer 边界。 */
async function loadRuntime(root: string): Promise<StrategyReplaceabilityRuntime> {
  const sourceRoot = nodePath.join(root, 'src');
  const load = async <TModule extends object>(relativePath: string): Promise<TModule> => {
    const href = pathToFileURL(nodePath.join(sourceRoot, relativePath + '.ts')).href;
    const module: unknown = await importFixtureModule(root, href);
    return module as TModule;
  };
  const [startup, selected, cleanup, business, queue, termination, registry] = await Promise.all([
    load<Pick<StrategyReplaceabilityRuntime, 'prepareStrategy'>>('app/startup/prepareStrategy'),
    load<Pick<StrategyReplaceabilityRuntime, 'createSelectedStrategy'>>(
      'app/startup/createSelectedStrategy',
    ),
    load<Pick<StrategyReplaceabilityRuntime, 'createCleanup'>>('app/shutdown/createCleanup'),
    load<Pick<StrategyReplaceabilityRuntime, 'createBusinessEventProgram'>>(
      'runtime/businessEventProgram/index',
    ),
    load<Pick<StrategyReplaceabilityRuntime, 'createBuyTaskQueue' | 'createSellTaskQueue'>>(
      'runtime/asyncProgram/tradeTaskQueue/index',
    ),
    load<Pick<StrategyReplaceabilityRuntime, 'createTerminationRuntime'>>(
      'runtime/lifecycle/terminationRuntime',
    ),
    load<Pick<StrategyReplaceabilityRuntime, 'createSymbolRegistry'>>('domain/seat/symbolRegistry'),
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

/** 通过源码 loader 跑通真实策略链；实例创建失败也由同一排空与清理边界收口。 */
async function runSmoke(
  root: string,
  testCase: StrategyReplaceabilityCase,
): Promise<StrategyReplaceabilitySmokeResult> {
  const runtime = await loadRuntime(root);
  const moduleRoot = nodePath.join(root, 'src');
  const definitionDirectory = nodePath.join(moduleRoot, 'strategies', testCase.directory);
  const imported: string[] = [];
  const calls: Record<string, number> = Object.create(null) as Record<string, number>;
  (globalThis as Record<string, unknown>)[callsKey] = calls;
  const strategyFileSystem: PrepareStrategyDeps = {
    loaderModuleHref: pathToFileURL(nodePath.join(moduleRoot, 'app/startup/prepareStrategy.ts'))
      .href,
    lstat,
    realpath,
    readDirectory: (path: string) => readdir(path),
    importModule: async (href: string): Promise<unknown> => {
      imported.push(fileURLToPath(href));
      return importFixtureModule(root, href);
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
  // 五个宿主实现全部显式取临时工程源码，避免回退仓库内默认实现。
  const harness = createEventHarness({
    strategy: strategySlot,
    createBusinessEventProgram: runtime.createBusinessEventProgram,
    createBuyTaskQueue: runtime.createBuyTaskQueue,
    createSellTaskQueue: runtime.createSellTaskQueue,
    createSymbolRegistry: runtime.createSymbolRegistry,
    createTerminationRuntime: runtime.createTerminationRuntime,
  });
  const cleanup = runtime.createCleanup();
  let drained = false;
  // 在同阶段的实例 destroy 之前确认排空已完成；成功和失败子进程都必须经过该断言。
  cleanup.register({
    phase: 'DESTROY_STRATEGY',
    step: '确认行情事件已停止并排空',
    handler: () => {
      assert.equal(drained, true, 'stopAndDrain 必须先于 cleanup');
      assert.equal(harness.mutable.unsubscriptions, harness.mutable.subscriptions);
    },
  });
  let observation: StrategyReplaceabilityObservation;
  try {
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
    observation = await observeDecision(harness, testCase);
  } finally {
    try {
      await harness.program.stopAndDrain();
      drained = true;
    } finally {
      await cleanup.execute();
    }
  }

  assert.deepEqual(imported, [nodePath.join(definitionDirectory, 'definition.ts')]);
  const expectedCalls = {
    [`${testCase.id}:import`]: 1,
    [`${testCase.id}:prepare`]: 1,
    [`${testCase.id}:create`]: 1,
    [`${testCase.id}:onCandlestick`]: 1,
    [`${testCase.id}:destroy`]: 1,
  };
  assert.deepEqual({ ...calls }, expectedCalls);

  return {
    id: testCase.id,
    pid: process.pid,
    definitionPath: nodePath.join(definitionDirectory, 'definition.ts'),
    importedPaths: imported,
    calls: { ...calls },
    nowMs: harness.mutable.nowMs,
    ...observation,
  };
}

/** 启动真实行情事件并冻结清理前的决策、上下文与展示观察值。 */
async function observeDecision(
  harness: EventHarness,
  testCase: StrategyReplaceabilityCase,
): Promise<StrategyReplaceabilityObservation> {
  harness.program.start();
  harness.publish();
  await Promise.resolve();
  const contextCount = harness.contexts.length;
  const displayCount = harness.displays.length;
  const terminated = harness.termination.isTerminated();
  assert.equal(contextCount, 1);
  assert.equal(terminated, false);
  assert.equal(displayCount, 1);
  const hasFilledBuyOrders =
    harness.contexts[0]?.seats.find((seat) => seat.direction === 'SHORT')?.hasFilledBuyOrders ===
    true;
  assert.equal(hasFilledBuyOrders, true);

  const decision =
    testCase.action === 'BUYCALL' ? harness.buyTaskQueue.pop() : harness.sellTaskQueue.pop();
  assert.ok(decision !== null, '决策队列必须包含选中动作');
  assert.equal(decision.type, testCase.action === 'BUYCALL' ? 'STRATEGY_BUY' : 'STRATEGY_SELL');
  const signal = decision.data;
  const triggerTime = signal.triggerTime;
  assert.ok(triggerTime instanceof Date, '决策队列任务必须携带 triggerTime');
  assert.equal(triggerTime.getTime(), harness.mutable.nowMs);
  assert.equal(signal.action, testCase.action);
  assert.equal(signal.symbol, testCase.symbol);
  assert.equal(signal.symbolName, testCase.symbolName);
  assert.equal(signal.seatVersion, 1);
  assert.equal(signal.reason, testCase.reason);
  const oppositeQueueEmpty =
    testCase.action === 'BUYCALL'
      ? harness.sellTaskQueue.isEmpty()
      : harness.buyTaskQueue.isEmpty();
  assert.equal(oppositeQueueEmpty, true);

  return {
    task: {
      type: decision.type,
      action: testCase.action,
      symbol: testCase.symbol,
      symbolName: testCase.symbolName,
      seatVersion: signal.seatVersion,
      triggerTimeMs: triggerTime.getTime(),
      reason: testCase.reason,
    },
    oppositeQueueEmpty,
    hasFilledBuyOrders,
    contextCount,
    displayCount,
    terminated,
  };
}

const input = readArguments();
const result = await runSmoke(input.root, input.testCase);
console.log(resultMarker + JSON.stringify(result));
