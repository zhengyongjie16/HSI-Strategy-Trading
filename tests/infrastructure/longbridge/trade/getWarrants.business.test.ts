/**
 * getWarrants 手工查询入口业务测试。
 * 在临时 cwd 中真实执行 Bun CLI，验证原生环境转交、argv 与 warrantList 参数；
 * 仅 mock 认证和 QuoteContext 边界，空列表正常退出，认证失败按原语义报错退出。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildEnv } from '../../../setup/childEnv.js';

const probePrefix = 'GET_WARRANTS_BOUNDARY_PROBE:';

/** 离线 guard 先于边界 mock 安装，保留真实脚本输出与 process.exit 的退出码。 */
function runWarrantsCli(args: ReadonlyArray<string>, authFails = false) {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), 'warrants-native-cli-'));
  try {
    writeFileSync(path.join(isolationRoot, '.env'), 'GET_WARRANTS_ENV_SENTINEL=base-file\n');
    writeFileSync(
      path.join(isolationRoot, '.env.local'),
      'GET_WARRANTS_ENV_SENTINEL=native-warrants-file\n',
    );
    const preloadPath = path.join(isolationRoot, 'warrants-preload.ts');
    writeFileSync(
      preloadPath,
      `
        import { mock } from 'bun:test';

        const calls = { auth: [], quoteContext: [], warrantList: [] };
        mock.module(${JSON.stringify(new URL('../../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js', import.meta.url).href)}, () => ({
          createSdkConfigFromAuth: ({ env }) => {
            calls.auth.push({
              sameEnv: env === process.env,
              envSentinel: env['GET_WARRANTS_ENV_SENTINEL'] ?? null,
            });
            if (${authFails}) throw new Error('offline-warrants-auth-failed');
            return { kind: 'sdk-config' };
          },
        }));
        mock.module(${JSON.stringify(import.meta.resolve('longbridge'))}, () => ({
          QuoteContext: {
            new: (config) => {
              calls.quoteContext.push(config);
              return {
                warrantList: (...params) => {
                  calls.warrantList.push(params);
                  return [];
                },
              };
            },
          },
        }));
        process.on('exit', (exitCode) => {
          console.log(${JSON.stringify(probePrefix)} + JSON.stringify({ ...calls, exitCode }));
        });
      `,
    );
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--preload',
        fileURLToPath(new URL('offlineSdkGuard.ts', import.meta.url)),
        '--preload',
        preloadPath,
        fileURLToPath(new URL('../../../../utils/getWarrants.js', import.meta.url)),
        ...args,
      ],
      cwd: isolationRoot,
      env: { ...createChildEnv(isolationRoot), NODE_ENV: 'development' },
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 15_000,
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const probeLine = stdout.split(/\r?\n/).find((line) => line.startsWith(probePrefix));
    const outputJson = /^\{[\s\S]*?^\}/m.exec(stdout)?.[0];

    expect(probeLine, stderr).toBeDefined();

    return {
      exitCode: result.exitCode,
      stderr,
      stdout,
      probe: JSON.parse(probeLine?.slice(probePrefix.length) ?? 'null') as unknown,
      output: outputJson === undefined ? null : (JSON.parse(outputJson) as unknown),
    };
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

describe('getWarrants Bun CLI', () => {
  it.each([
    {
      args: ['hscei.hk', 'bear'],
      symbol: 'HSCEI.HK',
      type: 4,
      typeLabel: '熊证',
      distancePct: '<-2%',
    },
    {
      args: ['BuLl'],
      symbol: 'HSI.HK',
      type: 3,
      typeLabel: '牛证',
      distancePct: '>2%',
    },
  ] as const)(
    'uses native-loaded env and argv for $typeLabel and exits on an empty list',
    (scenario) => {
      const result = runWarrantsCli(scenario.args);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.probe).toEqual({
        auth: [{ sameEnv: true, envSentinel: 'native-warrants-file' }],
        quoteContext: [{ kind: 'sdk-config' }],
        warrantList: [[scenario.symbol, 4, 1, [scenario.type], null, [3], [0], [2]]],
        exitCode: 0,
      });

      expect(result.output).toEqual({
        symbol: scenario.symbol,
        typeLabel: scenario.typeLabel,
        tradingMinutes: expect.any(Number),
        totalFetched: 0,
        validCount: 0,
        skippedCount: 0,
        threshold: { distancePct: scenario.distancePct, minTurnoverPerMinute: 100000 },
        closestToThreshold: null,
        list: [],
      });
      expect(result.stdout).toContain(`没有符合条件的${scenario.typeLabel}`);
    },
    20_000,
  );

  it('prints the auth error and exits with 1 before creating a quote context', () => {
    const result = runWarrantsCli(['HSI.HK', 'bull'], true);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe('错误: offline-warrants-auth-failed');
    expect(result.probe).toEqual({
      auth: [{ sameEnv: true, envSentinel: 'native-warrants-file' }],
      quoteContext: [],
      warrantList: [],
      exitCode: 1,
    });
    expect(result.output).toBeNull();
  }, 20_000);
});
