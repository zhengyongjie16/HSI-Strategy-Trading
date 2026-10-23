/**
 * 主入口 Bun 原生环境契约测试。
 * 仅在临时 cwd 加载合成文件；先预加载离线 SDK guard，再 mock runApp，读取真实 IS_DEBUG。
 * E8 的配置拒绝与客户端工厂零调用由 app/runtime/createPreGateRuntime.minimalGate.test.ts 保护。
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChildEnv } from './setup/childEnv.js';
import type { IndexEnvironmentProbe, IndexEnvironmentScenario } from './types.js';

// 公开模板的固定基线；只验证加载语义，不代表占位凭证或整份模板通过业务校验。
const TEMPLATE_EXPECTED = {
  LONGBRIDGE_AUTH_MODE: 'apikey',
  LONGBRIDGE_APP_KEY: 'LONGBRIDGE_APP_KEY',
  LONGBRIDGE_APP_SECRET: 'LONGBRIDGE_APP_SECRET',
  LONGBRIDGE_ACCESS_TOKEN: 'LONGBRIDGE_ACCESS_TOKEN',
  LONGBRIDGE_HTTP_URL: 'https://openapi.longbridge.cn',
  LONGBRIDGE_QUOTE_WS_URL: 'wss://openapi-quote.longbridge.cn/v2',
  LONGBRIDGE_TRADE_WS_URL: 'wss://openapi-trade.longbridge.cn/v2',
  LONGBRIDGE_LANGUAGE: 'en',
  LONGBRIDGE_ENABLE_OVERNIGHT: 'false',
  LONGBRIDGE_PUSH_CANDLESTICK_MODE: 'realtime',
  LONGBRIDGE_PRINT_QUOTE_PACKAGES: 'true',
  LONGBRIDGE_LOG_PATH: 'logs/sdk',
  DEBUG: 'true',
  ACTIVE_STRATEGY_ID: 'intraday-regression',
  DOOMSDAY_PROTECTION: 'true',
  MORNING_OPENING_PROTECTION_ENABLED: 'true',
  MORNING_OPENING_PROTECTION_MINUTES: '15',
  AFTERNOON_OPENING_PROTECTION_ENABLED: 'true',
  AFTERNOON_OPENING_PROTECTION_MINUTES: '5',
  BUY_ORDER_TIMEOUT_ENABLED: 'true',
  BUY_ORDER_TIMEOUT_SECONDS: '180',
  SELL_ORDER_TIMEOUT_ENABLED: 'false',
  SELL_ORDER_TIMEOUT_SECONDS: '180',
  ORDER_MONITOR_PRICE_UPDATE_INTERVAL: '5',
  ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE: 'false',
  TRADING_ORDER_TYPE: 'ELO',
  LIQUIDATION_ORDER_TYPE: 'ELO',
  MONITOR_SYMBOL: 'HSI.HK',
  LONG_SYMBOL: 'NA',
  SHORT_SYMBOL: 'NA',
  AUTO_SEARCH_ENABLED: 'true',
  ORDER_OWNERSHIP_MAPPING: 'HSI',
  AUTO_SEARCH_MIN_DISTANCE_PCT_BULL: '2',
  AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR: '-2',
  AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL: '300000',
  AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR: '300000',
  AUTO_SEARCH_EXPIRY_MIN_MONTHS: '12',
  AUTO_SEARCH_OPEN_DELAY_MINUTES: '5',
  SWITCH_INTERVAL_MINUTES: '60',
  SWITCH_DISTANCE_RANGE_BULL: '0.8,3.5',
  SWITCH_DISTANCE_RANGE_BEAR: '-3.5,-0.8',
  TARGET_NOTIONAL: '10000',
  BUY_INTERVAL_SECONDS: '90',
  MAX_POSITION_NOTIONAL: '100000',
  MAX_UNREALIZED_LOSS_PER_SYMBOL: '2200',
  LIQUIDATION_COOLDOWN_MINUTES: 'half-day',
  LIQUIDATION_TRIGGER_LIMIT: '2',
  SMART_CLOSE_ENABLED: 'true',
  SMART_CLOSE_TIMEOUT_MINUTES: '120',
} as const;

/** 每次启动都隔离 HOME/cwd；preload 只替换 app 边界，不执行交易组装。 */
function probeEntry(scenario: IndexEnvironmentScenario = {}): IndexEnvironmentProbe {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), 'index environment '));
  try {
    const projectRoot = path.join(isolationRoot, 'project with spaces');
    mkdirSync(projectRoot);
    for (const [name, contents] of Object.entries(scenario.files ?? {})) {
      writeFileSync(path.join(projectRoot, name), contents);
    }

    const entryPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const guardPath = fileURLToPath(
      new URL('infrastructure/longbridge/trade/offlineSdkGuard.ts', import.meta.url),
    );
    const preloadPath = path.join(projectRoot, 'mock app preload.ts');
    writeFileSync(
      preloadPath,
      `import { mock } from 'bun:test';
       import { IS_DEBUG } from ${JSON.stringify(new URL('../src/constants/index.ts', import.meta.url).href)};
       const templateExpected = ${JSON.stringify(TEMPLATE_EXPECTED)};
       let calls = 0;
       mock.module(${JSON.stringify(new URL('../src/app/runApp.ts', import.meta.url).href)}, () => ({
         runApp: async ({ env }) => {
           calls += 1;
           console.log(JSON.stringify({
             calls,
             envIdentity: env === process.env,
             isDebug: IS_DEBUG,
             debug: env.DEBUG ?? null,
             nodeEnv: env.NODE_ENV ?? null,
             sentinels: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('INDEX_ENV_'))),
             templateMismatchedKeys: Object.entries(templateExpected)
               .filter(([key, expected]) => env[key] !== expected)
               .map(([key]) => key),
           }));
         },
       }));`,
    );

    const flags = [...(scenario.flags ?? [])];
    let cwd = projectRoot;
    let entry = entryPath;
    if (scenario.launch === 'external-env-file' || scenario.launch === 'external-cwd') {
      cwd = path.join(isolationRoot, 'outside with spaces');
      mkdirSync(cwd);
      writeFileSync(path.join(cwd, '.env.local'), 'INDEX_ENV_OUTSIDE_ONLY=outside');
      const spacedEntry = path.join(projectRoot, 'entry with spaces.ts');
      writeFileSync(spacedEntry, `import ${JSON.stringify(pathToFileURL(entryPath).href)};`);
      if (scenario.launch === 'external-env-file') {
        flags.push(`--env-file=${path.join(projectRoot, 'selected env file.env')}`);
        entry = spacedEntry;
      } else {
        flags.push('--cwd', projectRoot);
        entry = 'entry with spaces.ts';
      }
    }

    if (scenario.launch === 'package-start') {
      writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ private: true, scripts: { start: `bun ${JSON.stringify(entryPath)}` } }),
      );

      // 内层 Bun 自行读取临时配置；不假设外层 run 的参数能透传给脚本。
      writeFileSync(
        path.join(projectRoot, 'bunfig.toml'),
        `preload = ${JSON.stringify([guardPath, preloadPath])}\n`,
      );
    }

    const command =
      scenario.launch === 'package-start'
        ? [process.execPath, 'run', 'start']
        : [process.execPath, ...flags, '--preload', guardPath, '--preload', preloadPath, entry];
    const result = Bun.spawnSync({
      cmd: command,
      cwd,
      env: { ...createChildEnv(isolationRoot), NODE_ENV: 'development', ...scenario.env },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const lines = result.stdout.toString().trim().split(/\r?\n/u);
    expect(lines, lines.slice(0, 5).join('\n')).toHaveLength(1);
    const probe = JSON.parse(lines[0] ?? '') as IndexEnvironmentProbe;
    expect(probe.calls).toBe(1);
    expect(probe.envIdentity).toBe(true);
    return probe;
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

describe('src/index Bun native startup environment', () => {
  it('E1 根目录默认启动在 runApp 前已加载本地环境，且仅转交原 process.env 一次', () => {
    const result = probeEntry({
      files: { '.env.local': 'INDEX_ENV_LOCAL_ONLY=local\nDEBUG=true' },
      env: { NODE_ENV: undefined },
    });
    expect(result.sentinels).toEqual({ INDEX_ENV_LOCAL_ONLY: 'local' });
    expect(result.isDebug).toBe(true);
  });

  for (const mode of ['development', 'production']) {
    it(`E2 ${mode} 保留 .env、模式文件、.env.local 和模式 local 的分层优先级`, () => {
      const result = probeEntry({
        files: {
          '.env':
            'INDEX_ENV_BASE_ONLY=base\nINDEX_ENV_BASE_V_MODE=base\nINDEX_ENV_MODE_V_LOCAL=base\nINDEX_ENV_SHARED=base',
          [`.env.${mode}`]:
            'INDEX_ENV_MODE_ONLY=mode\nINDEX_ENV_BASE_V_MODE=mode\nINDEX_ENV_MODE_V_LOCAL=mode\nINDEX_ENV_SHARED=mode',
          '.env.local':
            'INDEX_ENV_LOCAL_ONLY=local\nINDEX_ENV_MODE_V_LOCAL=local\nINDEX_ENV_SHARED=local',
          [`.env.${mode}.local`]:
            'INDEX_ENV_MODE_LOCAL_ONLY=mode-local\nINDEX_ENV_SHARED=mode-local',
        },
        env: { NODE_ENV: mode },
      });
      expect(result.nodeEnv).toBe(mode);
      expect(result.sentinels).toEqual({
        INDEX_ENV_BASE_ONLY: 'base',
        INDEX_ENV_BASE_V_MODE: 'mode',
        INDEX_ENV_MODE_ONLY: 'mode',
        INDEX_ENV_MODE_V_LOCAL: 'local',
        INDEX_ENV_LOCAL_ONLY: 'local',
        INDEX_ENV_MODE_LOCAL_ONLY: 'mode-local',
        INDEX_ENV_SHARED: 'mode-local',
      });
    });
  }

  it('E3 父环境的非空值与空字符串均覆盖文件，空值不等于缺失', () => {
    const result = probeEntry({
      files: {
        '.env.local': 'INDEX_ENV_SHARED=file\nINDEX_ENV_PARENT_EMPTY=file\nINDEX_ENV_FILE_EMPTY=',
      },
      env: {
        INDEX_ENV_SHARED: 'parent',
        INDEX_ENV_PARENT_EMPTY: '',
        INDEX_ENV_PARENT_ONLY: 'external',
      },
    });
    expect(result.sentinels).toEqual({
      INDEX_ENV_SHARED: 'parent',
      INDEX_ENV_PARENT_EMPTY: '',
      INDEX_ENV_FILE_EMPTY: '',
      INDEX_ENV_PARENT_ONLY: 'external',
    });
    expect(result.sentinels['INDEX_ENV_ABSENT']).toBeUndefined();
  });

  for (const debug of ['true', 'false']) {
    it(`E4 DEBUG=${debug} 在真实常量模块静态求值时已生效`, () => {
      const result = probeEntry({ files: { '.env.local': `DEBUG=${debug}` } });
      expect(result.debug).toBe(debug);
      expect(result.isDebug).toBe(debug === 'true');
    });
  }

  it('E5 公开模板固定 49 键集合和字符串预期，不输出模板值或调用第二解析器', () => {
    const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const assignedKeys = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]);
    expect(Object.keys(TEMPLATE_EXPECTED)).toHaveLength(49);
    expect(assignedKeys).toHaveLength(49);
    expect(new Set(assignedKeys)).toEqual(new Set(Object.keys(TEMPLATE_EXPECTED)));
    const result = probeEntry({ files: { '.env.local': template } });
    expect(result.templateMismatchedKeys).toEqual([]);
    expect(result.isDebug).toBe(true);
  });

  it('E6 原生加载保留合成引号、空值、注释、多行、美元转义与变量展开语义', () => {
    const result = probeEntry({
      files: {
        '.env.local': [
          'INDEX_ENV_BASE=hk',
          'INDEX_ENV_UNQUOTED=plain # ignored comment',
          "INDEX_ENV_SINGLE='  single # value  '",
          'INDEX_ENV_DOUBLE="  double # value  "',
          'INDEX_ENV_EMPTY=',
          'INDEX_ENV_QUOTED_EMPTY=""',
          String.raw`INDEX_ENV_ESCAPED_DOLLAR=cost\$5`,
          'INDEX_ENV_REFERENCE=$INDEX_ENV_BASE/suffix',
          'INDEX_ENV_BRACED_REFERENCE="${INDEX_ENV_BASE}/braced"',
          'INDEX_ENV_MULTILINE="first',
          'second"',
          String.raw`INDEX_ENV_ESCAPED_NEWLINE="first\nsecond"`,
        ].join('\n'),
      },
    });
    expect(result.sentinels).toEqual({
      INDEX_ENV_BASE: 'hk',
      INDEX_ENV_UNQUOTED: 'plain',
      INDEX_ENV_SINGLE: '  single # value  ',
      INDEX_ENV_DOUBLE: '  double # value  ',
      INDEX_ENV_EMPTY: '',
      INDEX_ENV_QUOTED_EMPTY: '',
      INDEX_ENV_ESCAPED_DOLLAR: 'cost$5',
      INDEX_ENV_REFERENCE: 'hk/suffix',
      INDEX_ENV_BRACED_REFERENCE: 'hk/braced',
      INDEX_ENV_MULTILINE: 'first\nsecond',
      INDEX_ENV_ESCAPED_NEWLINE: 'first\nsecond',
    });
  });

  it('E7 默认文件均缺失时仍把外部环境交给 app，不新增文件必需检查', () => {
    const result = probeEntry({
      env: { ...TEMPLATE_EXPECTED, INDEX_ENV_PARENT_ONLY: 'external' },
    });
    expect(result.sentinels).toEqual({ INDEX_ENV_PARENT_ONLY: 'external' });
    expect(result.templateMismatchedKeys).toEqual([]);
  });

  it('E9 test 模式加载 .env.test 和 .env.test.local，但不补读 .env.local', () => {
    const result = probeEntry({
      files: {
        '.env': 'INDEX_ENV_BASE_ONLY=base\nINDEX_ENV_SHARED=base',
        '.env.test': 'INDEX_ENV_MODE_ONLY=test\nINDEX_ENV_SHARED=test',
        '.env.local': 'INDEX_ENV_LOCAL_ONLY=must-not-load\nINDEX_ENV_SHARED=local',
        '.env.test.local': 'INDEX_ENV_MODE_LOCAL_ONLY=test-local\nINDEX_ENV_SHARED=test-local',
      },
      env: { NODE_ENV: 'test' },
    });
    expect(result.nodeEnv).toBe('test');
    expect(result.sentinels).toEqual({
      INDEX_ENV_BASE_ONLY: 'base',
      INDEX_ENV_MODE_ONLY: 'test',
      INDEX_ENV_MODE_LOCAL_ONLY: 'test-local',
      INDEX_ENV_SHARED: 'test-local',
    });
  });

  it('E10 --env-file 只选择指定文件，入口不再补入默认文件', () => {
    const result = probeEntry({
      files: {
        '.env': 'INDEX_ENV_BASE_ONLY=must-not-load',
        '.env.development': 'INDEX_ENV_MODE_ONLY=must-not-load',
        '.env.local': 'INDEX_ENV_LOCAL_ONLY=must-not-load',
        '.env.development.local': 'INDEX_ENV_MODE_LOCAL_ONLY=must-not-load',
        'selected.env': 'INDEX_ENV_SELECTED_ONLY=selected\nDEBUG=false',
      },
      flags: ['--env-file=selected.env'],
    });
    expect(result.sentinels).toEqual({ INDEX_ENV_SELECTED_ONLY: 'selected' });
    expect(result.debug).toBe('false');
    expect(result.isDebug).toBe(false);
  });

  it('E11 --no-env-file 阻止全部临时默认文件加载，但保留父环境', () => {
    const result = probeEntry({
      files: {
        '.env': 'INDEX_ENV_BASE_ONLY=must-not-load',
        '.env.development': 'INDEX_ENV_MODE_ONLY=must-not-load',
        '.env.local': 'INDEX_ENV_LOCAL_ONLY=must-not-load',
        '.env.development.local': 'INDEX_ENV_MODE_LOCAL_ONLY=must-not-load',
      },
      env: { INDEX_ENV_PARENT_ONLY: 'external', DEBUG: 'true' },
      flags: ['--no-env-file'],
    });
    expect(result.sentinels).toEqual({ INDEX_ENV_PARENT_ONLY: 'external' });
    expect(result.isDebug).toBe(true);
  });

  it('E12 非根 cwd 使用带空格的绝对 env/script 路径，不搜索脚本旁默认文件', () => {
    const result = probeEntry({
      files: {
        '.env.local': 'INDEX_ENV_LOCAL_ONLY=must-not-load',
        'selected env file.env': 'INDEX_ENV_SELECTED_ONLY=selected\nDEBUG=true',
      },
      launch: 'external-env-file',
    });
    expect(result.sentinels).toEqual({ INDEX_ENV_SELECTED_ONLY: 'selected' });
    expect(result.isDebug).toBe(true);
  });

  it('E12 --cwd 明确切到带空格项目路径后正常加载，不读取外部 cwd 的文件', () => {
    const result = probeEntry({
      files: { '.env.local': 'INDEX_ENV_LOCAL_ONLY=project\nDEBUG=true' },
      launch: 'external-cwd',
    });
    expect(result.sentinels).toEqual({ INDEX_ENV_LOCAL_ONLY: 'project' });
    expect(result.isDebug).toBe(true);
  });

  it('E13 临时 package start 与直接源码入口结果一致，正式 start 保持不变', () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(packageJson).toHaveProperty('scripts.start', 'bun src/index.ts');
    const scenario = {
      files: {
        '.env': 'INDEX_ENV_BASE_ONLY=base',
        '.env.local': 'INDEX_ENV_LOCAL_ONLY=local\nDEBUG=true',
      },
      env: { INDEX_ENV_PARENT_ONLY: 'external' },
    };
    expect(probeEntry({ ...scenario, launch: 'package-start' })).toEqual(probeEntry(scenario));
  });
});
