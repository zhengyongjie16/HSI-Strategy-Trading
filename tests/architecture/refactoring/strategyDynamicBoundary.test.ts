/**
 * 非字面量 selected-strategy 路径保护：执行真实准备器，但只注入元信息/模块对象。
 * 覆盖 definition/config 分根、源码与 compiled 布局、越界、链接和大小写，不求值策略或 SDK。
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { prepareStrategy } from '../../../src/app/startup/prepareStrategy.js';
import { selectedStrategyPath } from './scanner.js';

function loaderFixture(
  compiled: boolean,
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
  const prefix = compiled ? 'dist/src' : 'src';
  const extension = compiled ? 'js' : 'ts';
  const strategyRoot = path.join(root, prefix, 'app/startup/strategyDefinitions');
  const configRoot = path.join(root, prefix, 'config/strategy');
  const owner = path.join(strategyRoot, 'intradayRegression');
  const configOwner = path.join(configRoot, 'intradayRegression');
  const definition = path.join(owner, `definition.${extension}`);
  const config = path.join(configOwner, 'config.json');
  const directories = new Set([strategyRoot, configRoot, owner, configOwner]);
  const loaderModuleHref = pathToFileURL(
    path.join(root, prefix, `app/startup/prepareStrategy.${extension}`),
  ).href;
  const imported: string[] = [];
  let prepared = 0;
  return {
    imported,
    getPrepareCount: () => prepared,
    deps: {
      loaderModuleHref,
      readDirectory: async (directory: string) => {
        if (directory === strategyRoot)
          return mode === 'case'
            ? ['intradayRegression', 'IntradayRegression']
            : ['intradayRegression'];

        if (directory === configRoot)
          return mode === 'configCase'
            ? ['intradayRegression', 'IntradayRegression']
            : ['intradayRegression'];

        if (directory === owner) return [`definition.${extension}`];

        if (directory === configOwner) return mode === 'missingConfig' ? [] : ['config.json'];

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
        if (!selectedStrategyPath(root, 'intradayRegression', fileURLToPath(href), compiled))
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
  it.each([false, true])(
    'imports and prepares only the selected definition with separate config (%s)',
    async (compiled) => {
      const probe = loaderFixture(compiled, 'valid');
      await prepareStrategy({ env: { ACTIVE_STRATEGY_ID: 'intraday-regression' } }, probe.deps);
      expect(probe.imported).toHaveLength(1);
      expect(probe.getPrepareCount()).toBe(1);
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
    for (const compiled of [false, true]) {
      const probe = loaderFixture(compiled, mode);
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
    }
  });

  it.each(['../outside', 'intraday-regression/runtime/ema', 'intradayRegression'])(
    'refuses unselected/private/arbitrary strategy path %s',
    async (id) => {
      const probe = loaderFixture(false, 'valid');
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
