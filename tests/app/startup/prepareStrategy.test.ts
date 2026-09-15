import assert from 'node:assert/strict';

/** 单活跃加载离线测试：只操作临时目录，不运行应用入口/SDK。 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareStrategy } from '../../../src/app/startup/prepareStrategy.js';
import type { PrepareStrategyDeps } from '../../../src/app/startup/types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(extension: '.ts' | '.js' = '.ts') {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'strategy loader 空格 '));
  roots.push(root);
  const source = extension === '.ts' ? 'src' : 'dist/src';
  const strategyRoot = nodePath.join(root, source, 'core/strategy');
  const selected = nodePath.join(strategyRoot, 'firstStrategy');
  const other = nodePath.join(strategyRoot, 'brokenOther');
  await mkdir(selected, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(nodePath.join(selected, `definition${extension}`), 'fixture entry');
  await writeFile(nodePath.join(selected, 'config.json'), '{ "value": 1 }\r\n');
  await writeFile(
    nodePath.join(other, `definition${extension}`),
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
      nodePath.join(root, source, `app/startup/prepareStrategy${extension}`),
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
  return { root, strategyRoot, selected, other, definition, prepared, deps, calls };
}

const selection = { env: { ACTIVE_STRATEGY_ID: 'first-strategy' } };

describe('prepareStrategy', () => {
  for (const extension of ['.ts', '.js'] as const) {
    test(`只导入/prepare 选中项一次，${extension} 无 create`, async () => {
      const f = await fixture(extension);
      const result = await prepareStrategy(selection, f.deps);
      expect(result).toEqual({ strategyId: 'first-strategy', prepared: f.prepared });
      expect(f.calls.filter((call) => call.startsWith('read:'))).toHaveLength(0);
      expect(f.calls.filter((call) => call.startsWith('import:'))).toEqual([
        'import:' + pathToFileURL(nodePath.join(f.selected, 'definition' + extension)).href,
      ]);

      expect(f.calls.filter((call) => call === 'prepare')).toEqual(['prepare']);
      expect(f.calls).not.toContain('create');
      expect(f.calls.some((call) => call.includes(f.other))).toBe(false);
    });

    test(`${extension} 目标不存在先失败，不回退另一个扩展名`, async () => {
      const f = await fixture(extension);
      await rm(nodePath.join(f.selected, `definition${extension}`));
      await writeFile(
        nodePath.join(f.selected, extension === '.ts' ? 'definition.js' : 'definition.ts'),
        'fixture',
      );
      await assert.rejects(prepareStrategy(selection, f.deps), /必需文件/);
      expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
    });
  }

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
    ]) {
      await assert.rejects(
        prepareStrategy(selection, { ...f.deps, loaderModuleHref: href }),
        /加载器/,
      );
    }
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
    { names: ['Definition.ts', 'config.json'] },
    { names: ['definition.ts', 'Config.json'] },
    { names: ['definition.ts', 'config.json', 'CONFIG.JSON'] },
  ])('固定文件大小写不符或冲突拒绝 %j', async ({ names }) => {
    const f = await fixture();
    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        readDirectory: (path) => (path === f.selected ? Promise.resolve(names) : readdir(path)),
      }),
      /必需文件/,
    );
  });

  test('缺配置时不导入入口', async () => {
    const f = await fixture();
    await rm(nodePath.join(f.selected, 'config.json'));
    await assert.rejects(prepareStrategy(selection, f.deps), /必需文件/);
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

    expect(f.calls.some((call) => call.startsWith('read:'))).toBe(false);
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
    expect(f.calls.some((call) => call.startsWith('read:'))).toBe(false);
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
        lstat: (path) =>
          path === nodePath.join(f.selected, 'definition.ts')
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

  test('相邻 JSON 的链接元信息拒绝，入口零导入', async () => {
    const f = await fixture();
    await assert.rejects(
      prepareStrategy(selection, {
        ...f.deps,
        lstat: (path) =>
          path === nodePath.join(f.selected, 'config.json')
            ? Promise.resolve({
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => true,
              })
            : lstat(path),
      }),
      /非普通/,
    );
    expect(f.calls.some((call) => call.startsWith('import:'))).toBe(false);
  });

  test.each(['invalid-json', 'missing-dependency'])(
    '真实模块 %s 导入失败保留 cause，不执行 prepare/create',
    async (fault) => {
      const f = await fixture();
      await writeFile(
        nodePath.join(f.selected, 'definition.ts'),
        fault === 'invalid-json'
          ? "import config from './config.json'; export const strategyDefinition = { id: 'first-strategy', prepare() { throw Error('prepare ran ' + config); } };"
          : "import './missing.js'; export const strategyDefinition = { id: 'first-strategy', prepare() { throw Error('prepare ran'); } };",
      );

      if (fault === 'invalid-json')
        await writeFile(nodePath.join(f.selected, 'config.json'), 'broken JSON');

      let imports = 0;
      try {
        await prepareStrategy(selection, {
          ...f.deps,
          importModule: async (href): Promise<unknown> => {
            imports++;
            return import(href);
          },
        });
        throw new Error('expected failure');
      } catch (error) {
        expect(error instanceof Error && error.message).toContain('Strategy:import');
        expect(error instanceof Error && error.cause).toBeDefined();
        expect(error instanceof Error && String(error.cause)).not.toContain('prepare ran');
      }

      expect(imports).toBe(1);
    },
  );

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
          return import(href);
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
    expect(f.calls.filter((call) => call.startsWith('read:'))).toEqual([]);
  });
});
