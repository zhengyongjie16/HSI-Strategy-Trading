/** 单活跃加载离线测试：只操作临时目录，不运行应用入口/SDK。 */
import { importFixtureModule } from '../../helpers/importFixtureModule.js';
import assert from 'node:assert/strict';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareStrategy } from '../../../src/app/startup/prepareStrategy.js';
import type { PrepareStrategyDeps } from '../../../src/app/startup/types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'strategy loader 空格 '));
  roots.push(root);
  const strategyRoot = nodePath.join(root, 'src/strategies');
  const selected = nodePath.join(strategyRoot, 'firstStrategy');
  const other = nodePath.join(strategyRoot, 'brokenOther');
  const definitionPath = nodePath.join(selected, 'definition.ts');
  const configPath = nodePath.join(selected, 'config.json');
  await mkdir(selected, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(definitionPath, 'fixture entry');
  await writeFile(configPath, '{ "value": 1 }\r\n');
  await writeFile(
    nodePath.join(other, 'definition.ts'),
    'throw new Error("unselected evaluated")',
  );
  await writeFile(nodePath.join(other, 'config.json'), 'broken JSON');
  const calls: string[] = [];
  const prepared = {
    create: () => {
      calls.push('create');
      throw new Error('must not create');
    },
  };
  const definition = {
    id: 'first-strategy',
    prepare: () => {
      calls.push('prepare');
      return prepared;
    },
  };
  const deps: PrepareStrategyDeps = {
    loaderModuleHref: pathToFileURL(
      nodePath.join(root, 'src/app/startup/prepareStrategy.ts'),
    ).href,
    lstat: (path) => {
      calls.push(`lstat:${path}`);
      return lstat(path);
    },
    realpath,
    readDirectory: (path) => {
      calls.push(`directory:${path}`);
      return readdir(path);
    },
    importModule: async (href) => {
      calls.push(`import:${href}`);
      return { strategyDefinition: definition };
    },
  };
  return {
    root,
    strategyRoot,
    selected,
    other,
    definitionPath,
    configPath,
    definition,
    prepared,
    deps,
    calls,
  };
}

const selection = { env: { ACTIVE_STRATEGY_ID: 'first-strategy' } };

describe('prepareStrategy', () => {
  test('只导入/prepare 同一源码策略目录的选中项一次，无 create', async () => {
    const f = await fixture();
    const result = await prepareStrategy(selection, f.deps);
    expect(result).toEqual({ strategyId: 'first-strategy', prepared: f.prepared });
    expect(f.calls.filter((call) => call.startsWith('import:'))).toEqual([
      'import:' + pathToFileURL(f.definitionPath).href,
    ]);
    expect(f.calls.filter((call) => call === 'prepare')).toEqual(['prepare']);
    expect(f.calls).not.toContain('create');
    expect(f.calls.some((call) => call.includes(f.other))).toBe(false);
    expect(f.calls.some((call) => call.includes('strategyDefinitions'))).toBe(false);
  });

  test('源码 definition.ts 缺失时在元信息阶段失败，不尝试 definition.js', async () => {
    const f = await fixture();
    await rm(f.definitionPath);
    await writeFile(
      nodePath.join(f.selected, 'definition.js'),
      'throw new Error("legacy JS evaluated")',
    );
    await assert.rejects(prepareStrategy(selection, f.deps), /Strategy:metadata.*必需文件/);
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
    expect(f.calls.some((call) => call.includes('definition.js'))).toBe(false);
    expect(f.calls).not.toContain('prepare');
    expect(f.calls).not.toContain('create');
  });

  for (const id of [
    undefined,
    '',
    ' ',
    'first-strategy ',
    'First-strategy',
    'foo-1',
    'foo--bar',
    'foo-',
    '../first',
    'foo/bar',
    '%66oo',
    'con',
    'nul',
    'com1',
  ]) {
    test(`非法 ID ${String(id)} 拒绝`, async () => {
      const f = await fixture();
      await assert.rejects(prepareStrategy({ env: { ACTIVE_STRATEGY_ID: id } }, f.deps));
      expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
    });
  }

  for (const key of [
    'SIGNAL_BUYCALL',
    'SIGNAL_SELLCALL',
    'SIGNAL_BUYPUT',
    'SIGNAL_SELLPUT',
    'VERIFICATION_DELAY_SECONDS_BUY',
    'VERIFICATION_DELAY_SECONDS_SELL',
    'VERIFICATION_INDICATORS_BUY',
    'VERIFICATION_INDICATORS_SELL',
  ]) {
    test(`旧键 ${key} 空值 presence 在 I/O 前失败`, async () => {
      const f = await fixture();
      await assert.rejects(
        prepareStrategy({ env: { ACTIVE_STRATEGY_ID: 'first-strategy', [key]: '' } }, f.deps),
        /旧策略环境键/,
      );
      expect(f.calls).toEqual([]);
    });
  }

  test('非法加载器扩展名/URL 拒绝', async () => {
    const f = await fixture();
    for (const href of [
      pathToFileURL(nodePath.join(f.root, 'prepareStrategy.mjs')).href,
      'https://example.com/prepareStrategy.ts',
      `${f.deps.loaderModuleHref}?fresh=1`,
      `${f.deps.loaderModuleHref}#fragment`,
    ]) {
      await assert.rejects(
        prepareStrategy(selection, { ...f.deps, loaderModuleHref: href }),
        /Strategy:location.*加载器/,
      );
    }

    expect(f.calls).toEqual([]);
  });

  test.each(['src', 'dist/src'])('旧 %s JS 加载器在任何 I/O 或求值前拒绝', async (layout) => {
    const f = await fixture();
    const directory = nodePath.join(f.root, layout, 'strategies/firstStrategy');
    await mkdir(directory, { recursive: true });
    await writeFile(
      nodePath.join(directory, 'definition.js'),
      'throw new Error("legacy JS evaluated")',
    );
    await writeFile(nodePath.join(directory, 'config.json'), '{}');
    const loaderModuleHref = pathToFileURL(
      nodePath.join(f.root, layout, 'app/startup/prepareStrategy.js'),
    ).href;
    await assert.rejects(
      prepareStrategy(selection, { ...f.deps, loaderModuleHref }),
      /Strategy:location.*加载器扩展名: \.js/,
    );
    expect(f.calls).toEqual([]);
  });

  test('根目录精确拼写及相关大小写冲突拒绝，不检查无关坏名字', async () => {
    const f = await fixture();
    for (const names of [['FirstStrategy'], ['firstStrategy', 'firststrategy']]) {
      await assert.rejects(
        prepareStrategy(selection, { ...f.deps, readDirectory: async () => names }),
        /大小写/,
      );
    }

    const result = await prepareStrategy(selection, {
      ...f.deps,
      readDirectory: (path) =>
        path === f.strategyRoot
          ? Promise.resolve(['firstStrategy', 'INVALID-unselected'])
          : readdir(path),
    });
    expect(result.prepared).toBe(f.prepared);
  });

  test.each([
    { target: 'definition', names: ['Definition.ts'] },
    { target: 'definition', names: ['definition.ts', 'DEFINITION.TS'] },
    { target: 'config', names: ['definition.ts', 'Config.json'] },
    { target: 'config', names: ['definition.ts', 'config.json', 'CONFIG.JSON'] },
  ])('同目录固定文件大小写不符或冲突拒绝 %j', async ({ names }) => {
    const f = await fixture();
    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        readDirectory: (path) => (path === f.selected ? Promise.resolve(names) : readdir(path)),
      }),
      /必需文件/,
    );
  });

  test('同目录缺 config.json 时不导入入口', async () => {
    const f = await fixture();
    await rm(f.configPath);
    await assert.rejects(prepareStrategy(selection, f.deps), /必需文件/);
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });

  test('同目录缺 config.json 时，旧 config/strategy 根存在的 JSON 不被采用', async () => {
    const f = await fixture();
    await rm(f.configPath);
    const legacyConfig = nodePath.join(
      f.root,
      'src/config/strategy/firstStrategy/config.json',
    );
    await mkdir(nodePath.dirname(legacyConfig), { recursive: true });
    await writeFile(legacyConfig, '{ "value": 1 }');
    await assert.rejects(prepareStrategy(selection, f.deps), /必需文件/);
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
    expect(f.calls.some((call) => call.includes('config/strategy'))).toBe(false);
  });

  test('旧 app/startup/strategyDefinitions 布局不再被发现', async () => {
    const f = await fixture();
    const legacy = nodePath.join(f.root, 'src/app/startup/strategyDefinitions/legacyOnly');
    await mkdir(legacy, { recursive: true });
    await writeFile(nodePath.join(legacy, 'definition.ts'), 'throw new Error("legacy evaluated")');
    await writeFile(nodePath.join(legacy, 'config.json'), '{}');
    await assert.rejects(
      prepareStrategy({ env: { ACTIVE_STRATEGY_ID: 'legacy-only' } }, f.deps),
      /选中目录/,
    );
    expect(f.calls.some((call) => call.includes('strategyDefinitions'))).toBe(false);
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });

  test('不接受 default/错误身份/thenable 定义', async () => {
    const f = await fixture();
    const wrongModules = [
      { default: f.definition },
      null,
      { strategyDefinition: { ...f.definition, id: 'other' } },
      { strategyDefinition: { ...f.definition, prepare: null } },
      { strategyDefinition: Object.assign(Promise.resolve(), f.definition) },
    ];
    for (const module of wrongModules) {
      await assert.rejects(
        prepareStrategy(selection, { ...f.deps, importModule: async () => module }),
        /Strategy:definition/,
      );
    }

    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });

  test('prepare 错误/Promise/无 create 拒绝并保留真实 cause', async () => {
    const f = await fixture();
    for (const prepared of [
      null,
      {},
      { create: 1 },
      Promise.resolve({ create() {} }),
      Object.assign(Promise.resolve(), { create() {} }),
    ]) {
      await assert.rejects(
        prepareStrategy(selection, {
          ...f.deps,
          importModule: async () => ({
            strategyDefinition: { ...f.definition, prepare: () => prepared },
          }),
        }),
        /同步/,
      );
    }

    const cause = new Error('private parser');
    try {
      await prepareStrategy(selection, {
        ...f.deps,
        importModule: async () => ({
          strategyDefinition: {
            ...f.definition,
            prepare: () => {
              throw cause;
            },
          },
        }),
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error && error.message).toContain('Strategy:prepare');
      expect(error instanceof Error && error.cause).toBe(cause);
    }
  });

  test('传递依赖错误保留 cause 与 import 阶段，不假报未知策略', async () => {
    const f = await fixture();
    const cause = new Error('missing transitive dependency');
    let imports = 0;
    try {
      await prepareStrategy(selection, {
        ...f.deps,
        importModule: async () => {
          imports++;
          throw cause;
        },
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error instanceof Error && error.cause).toBe(cause);
      expect(error instanceof Error && error.message).toContain('Strategy:import');
    }

    expect(imports).toBe(1);
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });

  test('junction 目录拒绝', async () => {
    const f = await fixture();
    await rm(f.selected, { recursive: true });
    await symlink(f.other, f.selected, 'junction');
    await assert.rejects(prepareStrategy(selection, f.deps), /非普通/);
  });

  test('真实路径前缀陷阱与入口链接元信息拒绝', async () => {
    const f = await fixture();
    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        realpath: (path) =>
          path === f.selected
            ? Promise.resolve(`${f.strategyRoot}-outside/firstStrategy`)
            : realpath(path),
      }),
      /真实路径/,
    );

    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        realpath: (path) =>
          path === f.definitionPath
            ? Promise.resolve(nodePath.join(f.root, 'outside-definition.ts'))
            : realpath(path),
      }),
      /真实路径/,
    );

    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        lstat: (path) =>
          path === f.definitionPath
            ? Promise.resolve({
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => true,
              })
            : lstat(path),
      }),
      /非普通/,
    );
  });

  test('同目录 config.json 的链接元信息与真实路径越界拒绝，入口零导入', async () => {
    const f = await fixture();
    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        lstat: (path) =>
          path === f.configPath
            ? Promise.resolve({
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => true,
              })
            : lstat(path),
      }),
      /非普通/,
    );

    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        realpath: (path) =>
          path === f.configPath
            ? Promise.resolve(nodePath.join(f.root, 'outside-config.json'))
            : realpath(path),
      }),
      /真实路径/,
    );
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });

  test.each(['invalid-json', 'missing-dependency'])(
    '真实模块 %s 导入失败保留 cause，不执行 prepare/create',
    async (fault) => {
      const f = await fixture();
      await writeFile(
        f.definitionPath,
        fault === 'invalid-json'
          ? "import config from './config.json'; export const strategyDefinition = { id: 'first-strategy', prepare() { throw Error('prepare ran ' + config); } };"
          : "import './missing.js'; export const strategyDefinition = { id: 'first-strategy', prepare() { throw Error('prepare ran'); } };",
      );

      if (fault === 'invalid-json') await writeFile(f.configPath, 'broken JSON');

      let imports = 0;
      try {
        await prepareStrategy(selection, {
          ...f.deps,
          importModule: async (href): Promise<unknown> => {
            imports++;
            return importFixtureModule(f.root, href);
          },
        });
        throw new Error('expected failure');
      } catch (error) {
        expect(error instanceof Error && error.message).toContain('Strategy:import');
        expect(error instanceof Error && error.cause).toBeDefined();
        expect(error instanceof Error && String(error.cause)).not.toContain('prepare ran');
      }

      expect(imports).toBe(1);
      expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
    },
  );

  test.each([
    { fault: 'invalid-dsl', signal: '(ADX>1)', extra: {}, causeMessage: /无效信号表达式/ },
    {
      fault: 'extra-field',
      signal: '(K>0)',
      extra: { extra: true },
      causeMessage: /配置字段必须精确包含/,
    },
  ])('真实私有 parser 拒绝 %j，保留 prepare 阶段和 cause', async ({ signal, extra, causeMessage }) => {
    const f = await fixture();
    const sourceRoot = fileURLToPath(new URL('../../../src/', import.meta.url));
    // 使用真实策略入口及其私有 parser；只复制源码依赖，不复制环境文件或运行应用入口。
    for (const relative of ['strategies/intradayRegression', 'utils']) {
      await cp(nodePath.join(sourceRoot, relative), nodePath.join(f.root, 'src', relative), {
        recursive: true,
      });
    }

    await symlink(
      fileURLToPath(new URL('../../../node_modules/', import.meta.url)),
      nodePath.join(f.root, 'node_modules'),
      'junction',
    );
    const directory = nodePath.join(f.strategyRoot, 'intradayRegression');
    await writeFile(
      nodePath.join(directory, 'config.json'),
      JSON.stringify({
        signals: { BUYCALL: signal, SELLCALL: '(K>0)', BUYPUT: '(K>0)', SELLPUT: '(K>0)' },
        verification: {
          buy: { delaySeconds: 0, indicators: [] },
          sell: { delaySeconds: 0, indicators: [] },
        },
        ...extra,
      }),
    );
    const imported: string[] = [];
    await assert.rejects(
      prepareStrategy(
        { env: { ACTIVE_STRATEGY_ID: 'intraday-regression' } },
        {
          ...f.deps,
          importModule: async (href): Promise<unknown> => {
            imported.push(fileURLToPath(href));
            return importFixtureModule(f.root, href);
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        expect(error.message).toContain('Strategy:prepare');
        expect(error.message).not.toContain('Strategy:import');
        assert.ok(error.cause instanceof Error);
        expect(error.cause.message).toMatch(causeMessage);
        return true;
      },
    );
    expect(imported).toEqual([nodePath.join(directory, 'definition.ts')]);
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
    expect(f.calls).not.toContain('create');
  });

  test('同一根内两个独立 schema 策略各自准备，互不导入', async () => {
    const f = await fixture();
    const schemas = [
      {
        id: 'alpha-schema',
        directory: 'alphaSchema',
        config: '{ "threshold": 3 }',
        check: 'config.threshold !== 3',
      },
      {
        id: 'beta-schema',
        directory: 'betaSchema',
        config: '{ "levels": [1, 2] }',
        check: 'config.levels.length !== 2',
      },
    ];
    for (const schema of schemas) {
      const directory = nodePath.join(f.strategyRoot, schema.directory);
      await mkdir(directory);
      await writeFile(nodePath.join(directory, 'config.json'), schema.config);
      await writeFile(
        nodePath.join(directory, 'definition.ts'),
        `import config from './config.json';
export const strategyDefinition = {
  id: '${schema.id}',
  prepare() {
    if (${schema.check}) throw new Error('${schema.directory} schema');
    return { create() { throw new Error('must not create ${schema.directory}'); } };
  }
};`,
      );
    }

    for (const schema of schemas) {
      const imported: string[] = [];
      const result = await prepareStrategy(
        { env: { ACTIVE_STRATEGY_ID: schema.id } },
        {
          ...f.deps,
          importModule: async (href): Promise<unknown> => {
            imported.push(href);
            return importFixtureModule(f.root, href);
          },
        },
      );
      expect(result.strategyId).toBe(schema.id);
      expect(typeof result.prepared.create).toBe('function');
      expect(imported).toEqual([
        pathToFileURL(nodePath.join(f.strategyRoot, schema.directory, 'definition.ts')).href,
      ]);
    }

    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });

  test('无需登记不同 schema 策略，真实模块求值仍隔离', async () => {
    const f = await fixture();
    const directory = nodePath.join(f.strategyRoot, 'newSchema');
    await mkdir(directory);
    await writeFile(nodePath.join(directory, 'config.json'), '{"privateIndicator":"unique"}');
    await writeFile(
      nodePath.join(directory, 'definition.ts'),
      `import config from './config.json';
export const strategyDefinition = {
      id: 'new-schema',
      prepare() {
        if (config.privateIndicator !== 'unique') throw Error('schema');
        return { create(deps) {
          deps.logger.info('created');
          return { strategyId: 'new-schema', onCandlestick() { return null; },
            invalidateDirection() {}, invalidateAll() {}, resetForTradingDay() {},
            destroy() { deps.logger.info('destroyed'); } };
        } };
      }
    };`,
    );
    const imported: string[] = [];
    const result = await prepareStrategy(
      { env: { ACTIVE_STRATEGY_ID: 'new-schema' } },
      {
        ...f.deps,
        importModule: async (href): Promise<unknown> => {
          imported.push(fileURLToPath(href));
          return importFixtureModule(f.root, href);
        },
      },
    );
    expect(result.strategyId).toBe('new-schema');
    const lifecycle: string[] = [];
    expect(lifecycle).toEqual([]);
    const instance = result.prepared.create({
      clock: { now: () => new Date(0) },
      scheduler: {
        scheduleTimer: () => {
          throw new Error('unexpected timer');
        },
        clearTimer: () => {},
      },
      logger: {
        info: (message) => {
          lifecycle.push(message);
        },
        debug: () => {},
        warn: () => {},
        error: () => {},
      },
      onFatalError: () => {
        throw new Error('unexpected fatal');
      },
    });
    expect(instance.strategyId).toBe('new-schema');
    expect(lifecycle).toEqual(['created']);
    instance.destroy();
    expect(lifecycle).toEqual(['created', 'destroyed']);
    expect(imported).toEqual([nodePath.join(directory, 'definition.ts')]);
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });
});
