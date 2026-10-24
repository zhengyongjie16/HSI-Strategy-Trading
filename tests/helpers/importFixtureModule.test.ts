/** 离线 fixture importer：只允许源码 TS 入口，拒绝旧布局、路径注入、非法 URL 与符号链接越界。 */
import { rejects } from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { importFixtureModule } from './importFixtureModule.js';

describe('reviewed fixture module boundary', () => {
  it('loads exactly the seven source TS host entries and strategy definitions inside the real root', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'fixture imports 空格 '));
    const root = path.join(parent, 'project');
    try {
      for (const name of [
        'app/startup/prepareStrategy',
        'app/startup/createSelectedStrategy',
        'app/shutdown/createCleanup',
        'runtime/businessEventProgram/index',
        'runtime/asyncProgram/tradeTaskQueue/index',
        'runtime/lifecycle/terminationRuntime',
        'domain/seat/symbolRegistry',
      ]) {
        const entry = path.join(root, 'src', name + '.ts');
        await mkdir(path.dirname(entry), { recursive: true });
        await writeFile(entry, `export const fixtureEntry = ${JSON.stringify(name)};`);
        expect(await importFixtureModule(root, pathToFileURL(entry).href)).toEqual({
          fixtureEntry: name,
        });
      }

      const entry = path.join(root, 'src/strategies/probe/definition.ts');
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, 'export const strategyDefinition = { id: "probe" };');
      expect(await importFixtureModule(root, pathToFileURL(entry).href)).toEqual({
        strategyDefinition: { id: 'probe' },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects private, legacy, dist and JS modules before evaluation and preserves URL/realpath gates', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'fixture imports 空格 '));
    const root = path.join(parent, 'project');
    try {
      const denied = [
        'src/strategies/probe/index.ts',
        'src/strategies/probe/internal/definition.ts',
        'src/strategies/probe/Definition.ts',
        'src/app/startup/strategyDefinitions/probe/definition.ts',
        'src/app/runAppDeps.ts',
        'src/strategies/probe/definition.js',
        'src/app/startup/prepareStrategy.js',
        'dist/src/strategies/probe/definition.js',
        'dist/src/strategies/probe/definition.ts',
        'dist/src/app/startup/prepareStrategy.js',
      ].map((relative) => path.join(root, relative));
      const outside = path.join(parent, 'project-extra/src/app/startup/prepareStrategy.ts');
      for (const file of [...denied, outside]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'throw new Error("must not evaluate rejected module");');
      }

      const entry = path.join(root, 'src/strategies/probe/definition.ts');
      await writeFile(entry, 'throw new Error("must not evaluate qualified URL");');
      for (const href of [
        'https://example.invalid/definition.ts',
        pathToFileURL(entry).href + '?cache=1',
        pathToFileURL(entry).href + '#fragment',
        ...denied.map((file) => pathToFileURL(file).href),
        pathToFileURL(outside).href,
      ]) {
        await rejects(importFixtureModule(root, href), /Fixture import/);
      }

      const outsideStrategy = path.join(parent, 'outside/src/strategies/linked');
      await mkdir(outsideStrategy, { recursive: true });
      await writeFile(
        path.join(outsideStrategy, 'definition.ts'),
        'throw new Error("must not evaluate linked module");',
      );
      const link = path.join(root, 'src/strategies/linked');
      await symlink(outsideStrategy, link, 'junction');
      await rejects(
        importFixtureModule(root, pathToFileURL(path.join(link, 'definition.ts')).href),
        /Fixture import/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
