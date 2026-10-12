/**
 * 非字面量 selected-strategy 路径保护：执行真实准备器，但只注入元信息/模块对象。
 * 覆盖源码与 compiled 布局、越界路径、链接和大小写；不求值策略或 SDK。
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { prepareStrategy } from '../../../src/app/startup/prepareStrategy.js';
import { selectedStrategyPath } from './scanner.js';

function loaderFixture(compiled: boolean, mode: 'valid' | 'link' | 'escape' | 'case') {
  const root = path.join(os.tmpdir(), 'hsi-static-strategy-fixture');
  const prefix = compiled ? 'dist' : 'src';
  const extension = compiled ? 'js' : 'ts';
  const strategyRoot = path.join(root, prefix, 'core/strategy');
  const owner = path.join(strategyRoot, 'intradayRegression');
  const definition = path.join(owner, `definition.${extension}`);
  const loaderModuleHref = pathToFileURL(
    path.join(root, prefix, `app/startup/prepareStrategy.${extension}`),
  ).href;
  const imported: string[] = [];
  return {
    imported,
    deps: {
      loaderModuleHref,
      readDirectory: async (directory: string) => {
        if (directory !== strategyRoot) return [`definition.${extension}`, 'config.json'];

        return mode === 'case'
          ? ['intradayRegression', 'IntradayRegression']
          : ['intradayRegression'];
      },
      lstat: async (file: string) => ({
        isSymbolicLink: () => mode === 'link' && file === definition,
        isDirectory: () => file === strategyRoot || file === owner,
        isFile: () => file !== strategyRoot && file !== owner,
      }),
      realpath: async (file: string) =>
        mode === 'escape' && file === definition ? path.join(root, 'outside.ts') : file,
      importModule: async (href: string): Promise<unknown> => {
        imported.push(href);
        if (!selectedStrategyPath(root, 'intradayRegression', fileURLToPath(href), compiled))
          throw new Error('unexpected module path');

        return {
          strategyDefinition: {
            id: 'intraday-regression',
            prepare: () => ({ create: () => {} }),
          },
        };
      },
    },
  };
}

describe('P0.3 selected dynamic strategy boundary', () => {
  it.each([false, true])(
    'uses only the selected definition in source/compiled layout (%s)',
    async (compiled) => {
      const probe = loaderFixture(compiled, 'valid');
      await prepareStrategy({ env: { ACTIVE_STRATEGY_ID: 'intraday-regression' } }, probe.deps);
      expect(probe.imported).toHaveLength(1);
    },
  );

  it.each(['link', 'escape', 'case'] as const)(
    'rejects %s before any dynamic evaluation',
    async (mode) => {
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
      }
    },
  );

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
    },
  );
});
