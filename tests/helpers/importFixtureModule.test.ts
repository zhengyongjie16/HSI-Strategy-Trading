import { rejects } from 'node:assert/strict';

/** 离线 fixture importer：允许真实 source/dist 入口，拒绝协议、私有 leaf、旧策略根、路径注入及符号链接越界。 */
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { importFixtureModule } from './importFixtureModule.js';

describe('reviewed fixture module boundary', () => {
  it('loads only exact source/dist entries inside the real fixture root', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'fixture imports 空格 '));
    const root = path.join(parent, 'project');
    try {
      for (const [directory, extension] of [
        ['src', 'ts'],
        ['dist/src', 'js'],
      ] as const) {
        const entry = path.join(root, directory, 'strategies/probe/definition.' + extension);
        await mkdir(path.dirname(entry), { recursive: true });
        await writeFile(entry, 'export const strategyDefinition = { id: "probe" };');
        expect(await importFixtureModule(root, pathToFileURL(entry).href)).toEqual({
          strategyDefinition: { id: 'probe' },
        });
      }

      const privateLeaf = path.join(root, 'src/strategies/probe/index.ts');
      await mkdir(path.dirname(privateLeaf), { recursive: true });
      await writeFile(privateLeaf, 'throw new Error("must not evaluate private leaf");');
      const nestedDefinition = path.join(root, 'src/strategies/probe/internal/definition.ts');
      await mkdir(path.dirname(nestedDefinition), { recursive: true });
      await writeFile(nestedDefinition, 'throw new Error("must not evaluate nested leaf");');
      const legacyDefinition = path.join(
        root,
        'src/app/startup/strategyDefinitions/probe/definition.ts',
      );
      await mkdir(path.dirname(legacyDefinition), { recursive: true });
      await writeFile(legacyDefinition, 'throw new Error("must not evaluate legacy layout");');
      const outside = path.join(parent, 'outside/src/app/startup/prepareStrategy.ts');
      await mkdir(path.dirname(outside), { recursive: true });
      await writeFile(outside, 'throw new Error("must not evaluate outside module");');
      const entry = path.join(root, 'src/strategies/probe/definition.ts');
      for (const href of [
        'https://example.invalid/definition.ts',
        pathToFileURL(entry).href + '?cache=1',
        pathToFileURL(entry).href + '#fragment',
        pathToFileURL(privateLeaf).href,
        pathToFileURL(nestedDefinition).href,
        pathToFileURL(legacyDefinition).href,
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
