/**
 * 最终 Longbridge 边界：生产 SDK 只存在于 trade/market adapter。
 * 同时验证 runtime、type-only、dynamic 与 re-export 入口，不依赖历史 allowance。
 */
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { createAuditProgram, listTypeScript, scanProgram } from './refactoring/scanner.js';

/** 在独立编译根内复用正式 scanner；不求值动态模块或 SDK。 */
function scanSources(sources: Readonly<Record<string, string>>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsi-final-longbridge-'));
  try {
    const files = Object.entries(sources).map(([file, source]) => {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, source);
      return absolute;
    });
    return scanProgram(root, createAuditProgram(root, files), files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const imports = [
  "import { Decimal } from 'longbridge'; export const amount = new Decimal('1');",
  "import type { QuoteContext } from 'longbridge'; export type Input = { readonly context: QuoteContext };",
  "export const load = () => import('longbridge');",
  "type Context = import('longbridge').QuoteContext; export type Input = { readonly context: Context };",
  "export { Decimal } from 'longbridge';",
  "export const load = () => require('longbridge');",
];

describe('final Longbridge SDK boundary', () => {
  it('has no production SDK import or symbol outside trade/market adapters', () => {
    const root = process.cwd();
    const files = listTypeScript(path.join(root, 'src'));
    const scan = scanProgram(root, createAuditProgram(root, files), files);
    expect(scan.imports).toEqual([]);
    expect(scan.uses).toEqual([]);
    expect(scan.origins).toEqual([]);
    expect(
      scan.violations.filter((key) => key.includes('SDK_EXPOSURE') || key.includes('NONLITERAL')),
    ).toEqual([]);
  });

  it.each(imports)(
    'allows legal market imports but rejects the same business edge: %s',
    (source) => {
      const scan = scanSources({
        'src/infrastructure/longbridge/market/probe.ts': source,
        'src/infrastructure/longbridge/trade/probe.ts': source,
        'src/application/orderExecution/probe.ts': source,
      });
      expect(scan.imports.length).toBeGreaterThan(0);
      expect(
        scan.imports.every((row) => row.includes('src/application/orderExecution/probe.ts')),
      ).toBe(true);

      expect(
        scan.uses.every((row) => row.includes('src/application/orderExecution/probe.ts')),
      ).toBe(true);

      expect(
        scan.origins.every((row) => row.includes('src/application/orderExecution/probe.ts')),
      ).toBe(true);
    },
  );

  it.each([
    "const sdk = 'longbridge'; export const load = () => import(sdk);",
    'export const load = () => import(`longbridge`);',
  ])(
    'rejects unresolved business SDK imports instead of treating them as SDK-free: %s',
    (source) => {
      const scan = scanSources({ 'src/application/orderExecution/probe.ts': source });
      expect(scan.violations.filter((key) => key.includes('NONLITERAL'))).toHaveLength(1);
    },
  );

  it('keeps the verified selected-strategy loader legal under the final NONLITERAL gate', () => {
    const scan = scanSources({
      'src/app/startup/types.ts':
        'export type StrategyLocation = { readonly definitionPath: string }; export interface StrategyFileSystem { readonly importModule: (href: string) => Promise<unknown>; }',
      'src/app/startup/prepareStrategy.ts':
        'export function prepareStrategy(params: unknown, deps: unknown) { return [params, deps]; }',
      'src/app/startup/strategyLoaderHelpers.ts':
        "import { pathToFileURL } from 'node:url'; import type { StrategyLocation, StrategyFileSystem } from './types.js'; export async function importStrategyDefinition(location: StrategyLocation, fs: StrategyFileSystem) { return fs.importModule(pathToFileURL(location.definitionPath).href); }",
      'src/app/runAppDeps.ts':
        "import { prepareStrategy as prepare } from './startup/prepareStrategy.js'; prepare({}, { importModule: (href: string) => import(href) });",
    });
    expect(scan.imports).toEqual([]);
    expect(scan.uses).toEqual([]);
    expect(scan.origins).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
});
