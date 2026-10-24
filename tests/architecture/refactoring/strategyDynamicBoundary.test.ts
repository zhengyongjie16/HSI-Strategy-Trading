/**
 * 非字面量 selected-strategy 路径保护：执行真实准备器，但只注入元信息/模块对象。
 * 覆盖源码 definition/config 同根、越界、链接和大小写，并拒绝旧 JS/dist 加载器，不求值策略或 SDK。
 */
import { rejects } from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { prepareStrategy } from '../../../src/app/startup/prepareStrategy.js';
import { selectedStrategyPath } from './scanner.js';

function loaderFixture(
  mode:
    | 'valid'
    | 'link'
    | 'escape'
    | 'case'
    | 'configLink'
    | 'configEscape'
    | 'configCase'
    | 'missingConfig',
) {
  const root = path.join(os.tmpdir(), 'hsi-static-strategy-fixture');
  const strategyRoot = path.join(root, 'src/strategies');
  const owner = path.join(strategyRoot, 'intradayRegression');

  const definition = path.join(owner, 'definition.ts');
  const config = path.join(owner, 'config.json');
  const directories = new Set([strategyRoot, owner]);
  const loaderModuleHref = pathToFileURL(
    path.join(root, 'src/app/startup/prepareStrategy.ts'),
  ).href;
  const imported: string[] = [];
  let prepared = 0;
  return {
    root,
    imported,
    getPrepareCount: () => prepared,
    deps: {
      loaderModuleHref,
      readDirectory: async (directory: string) => {
        if (directory === strategyRoot)
          return mode === 'case'
            ? ['intradayRegression', 'IntradayRegression']
            : ['intradayRegression'];

        if (directory === owner) {
          if (mode === 'missingConfig') return ['definition.ts'];

          return mode === 'configCase'
            ? ['definition.ts', 'config.json', 'Config.json']
            : ['definition.ts', 'config.json'];
        }

        return [];
      },
      lstat: async (file: string) => ({
        isSymbolicLink: () =>
          (mode === 'link' && file === definition) || (mode === 'configLink' && file === config),
        isDirectory: () => directories.has(file),
        isFile: () => file === definition || file === config,
      }),
      realpath: async (file: string) =>
        (mode === 'escape' && file === definition) || (mode === 'configEscape' && file === config)
          ? path.join(root, 'outside.ts')
          : file,
      importModule: async (href: string): Promise<unknown> => {
        imported.push(href);
        if (!selectedStrategyPath(root, 'intradayRegression', fileURLToPath(href)))
          throw new Error('unexpected module path');

        return {
          strategyDefinition: {
            id: 'intraday-regression',
            prepare: () => {
              prepared++;
              return { create: () => {} };
            },
          },
        };
      },
    },
  };
}

describe('selected dynamic strategy boundary', () => {
  it('imports and prepares only the selected source TS definition with colocated config', async () => {
    const probe = loaderFixture('valid');
    await prepareStrategy({ env: { ACTIVE_STRATEGY_ID: 'intraday-regression' } }, probe.deps);
    expect(probe.imported).toEqual([
      pathToFileURL(path.join(probe.root, 'src/strategies/intradayRegression/definition.ts')).href,
    ]);
    expect(probe.getPrepareCount()).toBe(1);
  });

  it.each(['src/app/startup/prepareStrategy.js', 'dist/src/app/startup/prepareStrategy.js'])(
    'rejects the former JS loader %s before dynamic evaluation',
    async (entry) => {
      const probe = loaderFixture('valid');
      await rejects(
        prepareStrategy(
          { env: { ACTIVE_STRATEGY_ID: 'intraday-regression' } },
          {
            ...probe.deps,
            loaderModuleHref: pathToFileURL(path.join(probe.root, entry)).href,
          },
        ),
        /\[Strategy:location\]/,
      );
      expect(probe.imported).toEqual([]);
      expect(probe.getPrepareCount()).toBe(0);
    },
  );

  it.each([
    'link',
    'escape',
    'case',
    'configLink',
    'configEscape',
    'configCase',
    'missingConfig',
  ] as const)('rejects %s before any dynamic evaluation', async (mode) => {
    const probe = loaderFixture(mode);
    const rejected = await prepareStrategy(
      { env: { ACTIVE_STRATEGY_ID: 'intraday-regression' } },
      probe.deps,
    ).then(
      () => false,
      () => true,
    );
    expect(rejected).toBe(true);
    expect(probe.imported).toEqual([]);
    expect(probe.getPrepareCount()).toBe(0);
  });

  it.each(['../outside', 'intraday-regression/runtime/ema', 'intradayRegression'])(
    'refuses unselected/private/arbitrary strategy path %s',
    async (id) => {
      const probe = loaderFixture('valid');
      const rejected = await prepareStrategy({ env: { ACTIVE_STRATEGY_ID: id } }, probe.deps).then(
        () => false,
        () => true,
      );
      expect(rejected).toBe(true);
      expect(probe.imported).toEqual([]);
      expect(probe.getPrepareCount()).toBe(0);
    },
  );
});
