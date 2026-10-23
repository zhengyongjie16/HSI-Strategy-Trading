/**
 * 运行环境配置业务测试
 *
 * 功能：
 * - 验证运行时档位解析、日志根目录与进程钩子开关解析。
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildEnv } from '../../setup/childEnv.js';

import {
  resolveLogRootDir,
  shouldInstallGlobalProcessHooks,
} from '../../../src/config/runtime/index.js';

describe('runtime config business flow', () => {
  it.each([false, true])(
    'loads test runtime preload with an explicit log root: %s',
    (explicitLogRoot) => {
      const root = mkdtempSync(path.join(tmpdir(), 'test-runtime-preload-'));
      try {
        const env = createChildEnv(root);
        const expectedLogRoot = explicitLogRoot
          ? path.join(root, 'selected logs')
          : path.join(root, 'tests', 'logs');
        if (explicitLogRoot) {
          env['APP_LOG_ROOT_DIR'] = expectedLogRoot;
        } else {
          delete env['APP_LOG_ROOT_DIR'];
        }

        const result = Bun.spawnSync({
          cmd: [
            process.execPath,
            '--no-env-file',
            '--preload',
            fileURLToPath(new URL('../../setup/testRuntime.ts', import.meta.url)),
            '--eval',
            `console.log(JSON.stringify({
              profile: process.env.APP_RUNTIME_PROFILE,
              hooks: process.env.APP_ENABLE_PROCESS_HOOKS,
              logRoot: process.env.APP_LOG_ROOT_DIR,
            }));`,
          ],
          cwd: root,
          env: { ...env, APP_RUNTIME_PROFILE: 'app', APP_ENABLE_PROCESS_HOOKS: 'true' },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10_000,
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const probe: unknown = JSON.parse(result.stdout.toString());
        expect(probe).toEqual({
          profile: 'test',
          hooks: 'false',
          logRoot: expectedLogRoot,
        });
        expect(existsSync(expectedLogRoot)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('applies runtime profile rules in public behaviors', () => {
    expect(
      resolveLogRootDir({
        APP_RUNTIME_PROFILE: 'test',
      }),
    ).toBe(path.join(process.cwd(), 'tests', 'logs'));

    expect(
      resolveLogRootDir({
        APP_RUNTIME_PROFILE: 'app',
        BUN_TEST: '1',
      }),
    ).toBe(path.join(process.cwd(), 'logs'));

    expect(
      resolveLogRootDir({
        BUN_TEST: '1',
      }),
    ).toBe(path.join(process.cwd(), 'tests', 'logs'));

    expect(
      resolveLogRootDir({
        NODE_ENV: 'test',
      }),
    ).toBe(path.join(process.cwd(), 'logs'));
    expect(resolveLogRootDir({})).toBe(path.join(process.cwd(), 'logs'));
  });

  it('resolves log root dir with explicit path and profile defaults', () => {
    const explicitPath = resolveLogRootDir({
      APP_LOG_ROOT_DIR: 'tests/logs/custom',
    });
    expect(explicitPath).toBe(path.resolve(process.cwd(), 'tests/logs/custom'));

    const testDefaultPath = resolveLogRootDir({
      APP_RUNTIME_PROFILE: 'test',
    });
    expect(testDefaultPath).toBe(path.join(process.cwd(), 'tests', 'logs'));

    const appDefaultPath = resolveLogRootDir({
      APP_RUNTIME_PROFILE: 'app',
    });
    expect(appDefaultPath).toBe(path.join(process.cwd(), 'logs'));
  });

  it('resolves global process hook switch by explicit override and profile defaults', () => {
    const explicitDisabled = shouldInstallGlobalProcessHooks({
      APP_ENABLE_PROCESS_HOOKS: 'false',
      APP_RUNTIME_PROFILE: 'app',
    });
    expect(explicitDisabled).toBe(false);

    const explicitEnabled = shouldInstallGlobalProcessHooks({
      APP_ENABLE_PROCESS_HOOKS: 'true',
      APP_RUNTIME_PROFILE: 'test',
    });
    expect(explicitEnabled).toBe(true);

    const testDefault = shouldInstallGlobalProcessHooks({
      APP_RUNTIME_PROFILE: 'test',
    });
    expect(testDefault).toBe(false);

    const appDefault = shouldInstallGlobalProcessHooks({
      APP_RUNTIME_PROFILE: 'app',
    });
    expect(appDefault).toBe(true);
  });
});
