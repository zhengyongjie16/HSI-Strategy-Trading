/**
 * P1 多重集合收缩：到期 occurrence 必须删除，P2+ 精确旧例外不可增殖或搬进新层。
 * 临时 fixtures 只用于静态编译器检查，不写入生产树、不连接 SDK。
 */
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { baseline } from './baseline.js';
import {
  createAuditProgram,
  excess,
  expiredLegacyOwners,
  listTypeScript,
  occurrenceKey,
  neutralLegacyCapability,
  scanProgram,
  selectedStrategyPath,
  unclosedHelperCalls,
  STAGES,
} from './scanner.js';
import { SNAPSHOT_OWNER, snapshotBoundaries } from './snapshotProbe.js';
import type { Scan, SnapshotBoundaryScan } from './types.js';

function fixture(
  sources: Readonly<Record<string, string>>,
  diagnostics?: number[],
  snapshotScan?: SnapshotBoundaryScan[],
): Scan {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsi-architecture-'));
  try {
    const files = Object.entries(sources).map(([file, text]) => {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
      return absolute;
    });
    const program = createAuditProgram(root, files);
    if (diagnostics !== undefined)
      diagnostics.push(...program.getSemanticDiagnostics().map((diagnostic) => diagnostic.code));

    snapshotScan?.push(snapshotBoundaries(root, program, files));
    return scanProgram(root, program, files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 失败按维度展示计数及少量实际来源；完整 occurrence 仍由 scanner 返回，不打印整段 fixture。 */
function debtSummary(
  groups: Readonly<Record<string, ReadonlyArray<string>>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(groups)
      .filter(([, rows]) => rows.length > 0)
      .map(([category, rows]) => [
        category,
        {
          count: rows.length,
          examples: rows.slice(0, 3).map((row) => row.slice(0, 220)),
        },
      ]),
  );
}

const root = process.cwd();
const files = [
  ...listTypeScript(path.join(root, 'src')),
  ...listTypeScript(path.join(root, 'tests')),
];
const program = createAuditProgram(root, files);
const actual = scanProgram(root, program, files);

describe('P1 frozen occurrence architecture', () => {
  it.each([
    "import { readFileSync } from 'node:fs'; void readFileSync;",
    "import type { Stats } from 'node:fs'; export type Stat = Stats;",
    "export { readFile } from 'fs/promises';",
    "import 'node:https';",
    "import 'node:http2';",
    "const file = import('node:fs/promises'); void file;",
    "const network = require('node:net'); void network;",
    "type Stat = import('fs').Stats;",
    "import file = require('node:fs'); void file;",
    "import network = require('http'); void network;",
    "import 'node:tls';",
    "import 'node:dgram';",
    "import 'node:dns/promises';",
    "export const load = () => fetch('https://example.invalid');",
    "export const load = () => globalThis.fetch('https://example.invalid');",
    'export const load = fetch;',
    "import { setTimeout } from 'node:timers'; void setTimeout;",
    "const timer = import('node:timers/promises'); void timer;",
    'export const schedule = () => setTimeout(() => undefined, 1);',
    'export const schedule = () => globalThis.setTimeout(() => undefined, 1);',
    'export const schedule = () => setInterval(() => undefined, 1);',
    'export const schedule = setImmediate;',
    'export const schedule = queueMicrotask;',
  ])('rejects direct domain IO modules and ambient IO without evaluating them: %s', (source) => {
    const scan = fixture({ 'src/domain/order/rule.ts': source });
    expect(scan.violations.some((key) => key.includes('DOMAIN_DIRECT_IO'))).toBe(true);
  });

  it('allows pure modules and adapter IO without a caller-wide proof engine', () => {
    const scan = fixture({
      'src/domain/order/rule.ts':
        "import { basename } from 'node:path'; import { inspect } from 'node:util'; export const name = inspect(basename('order')); const fetch = (value: string) => value; export const pure = fetch('order'); const setTimeout = (value: number) => value; export const count = setTimeout(1); const port = { fetch: () => 'order' }; void port.fetch();",
      'src/infrastructure/persistence/read.ts':
        "import { readFileSync } from 'node:fs'; export const read = readFileSync;",
    });
    expect(scan.violations).toEqual([]);
  });

  it.each([
    "import { logger } from '../../utils/logger/index.js'; void logger;",
    "import '../../utils/logger/index.js';",
    "const logger = import('../../utils/logger/index.js'); void logger;",
    "import logger = require('../../utils/logger/index.js'); void logger;",
  ])('rejects a direct logger IO capability in domain: %s', (source) => {
    const scan = fixture({
      'src/domain/order/rule.ts': source,
      'src/utils/logger/index.ts':
        'export const logger = { info: (text: string) => { void text; } };',
    });
    expect(scan.violations.some((key) => key.includes('DOMAIN_DIRECT_IO'))).toBe(true);
  });

  it('allows a logger type contract without granting its runtime IO', () => {
    const scan = fixture({
      'src/domain/order/rule.ts':
        "import type { Logger } from '../../utils/logger/types.js'; export type Input = { readonly log: Logger };",
      'src/utils/logger/types.ts': 'export interface Logger { info(text: string): void; }',
    });
    expect(scan.violations).toEqual([]);
  });

  it.each([
    [
      'options: { cb: (value: unknown) => void }',
      'const { cb: invoke } = options; invoke(PAYLOAD);',
    ],
    ['{ cb }: { cb: (value: unknown) => void }', 'cb(PAYLOAD);'],
  ])(
    'tracks a destructured public callback without evaluating the fixture: %s',
    (parameter, body) => {
      for (const leaking of [false, true]) {
        const diagnostics: number[] = [];
        const scan = fixture(
          {
            'tests/infrastructure/longbridge/trade/fixture.ts': `import { Decimal } from 'longbridge'; export function build(${parameter}) { const raw = new Decimal('1'); ${body.replace('PAYLOAD', leaking ? 'raw' : 'raw.toString()')} return 'ok'; }`,
            'tests/application/flow.test.ts':
              "import { build } from '../infrastructure/longbridge/trade/fixture.js'; build({ cb: () => {} });",
          },
          diagnostics,
        );
        expect(diagnostics).toEqual([]);
        expect(scan.helperCalls.length).toBeGreaterThan(0);
        expect(unclosedHelperCalls(scan).length > 0).toBe(leaking);
        expect(scan.violations.some((key) => key.includes('SDK_FIXTURE_BOUNDARY'))).toBe(leaking);
      }
    },
  );

  it.each([
    'const invoke = cb; invoke(PAYLOAD); return { amount: "1" };',
    'options.cb(PAYLOAD); return { amount: "1" };',
    'const box: { fact: Fact } = { fact: value }; return box.fact;',
    'function expose(v: Fact): Fact { return v; } return expose(value);',
    'const box: { hidden(): Fact } = { hidden() { return value; } }; return { read: box.hidden };',
    'const box: { fact: Fact } = { fact: value }; return box["fact"];',
  ])('checks ordinary typed exit aliases without executing the fixture: %s', (body) => {
    for (const leaking of [false, true]) {
      const diagnostics: number[] = [];
      const scan = fixture(
        {
          'tests/infrastructure/longbridge/trade/fixture.ts': `import { Decimal } from 'longbridge'; export type Fact = { amount: string }; export function build(cb: (value: unknown) => void, options: { cb: (value: unknown) => void }) { void cb; void options; const raw = new Decimal('1'); const value = { amount: raw.toString()${leaking ? ', raw' : ''} }; void value; ${body.replace('PAYLOAD', leaking ? 'raw' : 'raw.toString()')} }`,
          'tests/application/flow.test.ts':
            "import { build } from '../infrastructure/longbridge/trade/fixture.js'; build(() => {}, { cb: () => {} });",
        },
        diagnostics,
      );
      expect(diagnostics).toEqual([]);
      expect(scan.helperCalls.length).toBeGreaterThan(0);
      expect(unclosedHelperCalls(scan).length > 0).toBe(leaking);
      expect(scan.violations.some((key) => key.includes('SDK_FIXTURE_BOUNDARY'))).toBe(leaking);
    }
  });

  it.each([
    'return { amount: raw.toString(), raw };',
    'return { amount: raw.toString(), nested: { raw } };',
    'return { amount: raw.toString(), callback: () => raw };',
    'return { amount: raw.toString(), get hidden() { return raw; } };',
    'return { amount: raw as any };',
    'return raw as unknown as Fact;',
    'const result: Fact = { amount: raw.toString(), raw }; return result;',
    'function hidden(): Fact { return { amount: raw.toString(), raw }; } return hidden();',
    'function hidden(): Fact { return { amount: raw.toString(), raw }; } return { amount: "1", callback: hidden };',
    'return { amount: "1", rows: [raw].map((item): Fact => ({ amount: item.toString(), raw: item })) };',
  ])('rejects actual mapper exits hidden by annotations or casts: %s', (body) => {
    const scan = fixture({
      'src/infrastructure/longbridge/trade/mapper.ts': `import type { Decimal } from 'longbridge'; type Fact = { readonly amount: string }; export function map(raw: Decimal): Fact { ${body} }`,
      'src/core/reader.ts':
        "import { map } from '../infrastructure/longbridge/trade/mapper.js'; void map;",
    });
    expect(scan.legacy).toHaveLength(1);
  });

  it.each([
    'return { amount: raw.toString(), nested: { revision: 1 }, callback: () => raw.toString() };',
    'let revision = 0; for (const item of [1, 2]) revision += item; return { amount: raw.toString(), revision };',
    'return { amount: raw.add("1").toString() };',
  ])('leaves mapper calculation and control-flow correctness to behavior tests: %s', (body) => {
    const scan = fixture({
      'src/infrastructure/longbridge/trade/mapper.ts': `import type { Decimal } from 'longbridge'; export function arbitraryName(raw: Decimal) { ${body} }`,
      'src/core/reader.ts':
        "import { arbitraryName as map } from '../infrastructure/longbridge/trade/mapper.js'; void map;",
    });
    expect(scan.legacy).toEqual([]);
  });

  it('allows a domain data rule with a same-owner default data strategy, not arbitrary callbacks', () => {
    const scan = fixture({
      'src/domain/order/policy.ts':
        'function keep(values: ReadonlyArray<string>): ReadonlyArray<string> { return values; } export function rule(values: ReadonlyArray<string>, deduct: (values: ReadonlyArray<string>) => ReadonlyArray<string> = keep): ReadonlyArray<string> { return deduct(values); } export function otherRule(deduct: (value: string) => string) { return deduct("x"); }',
      'src/core/orderRecorder/index.ts':
        "import { rule, otherRule } from '../../domain/order/policy.js'; void rule; void otherRule;",
    });
    expect(scan.legacy).toHaveLength(1);
    expect(scan.legacy[0]).toContain('"otherRule"');
  });

  it('does not approve a default strategy with SDK input or a behavior return', () => {
    const scan = fixture({
      'src/domain/order/policy.ts':
        'import type { Decimal } from "longbridge"; function hidden(value: Decimal): string { return value.toString(); } export function sdkRule(value: Decimal, deduct: (value: Decimal) => string = hidden): string { return deduct(value); } function owner() { return { submit: () => undefined }; } export function ownerRule(deduct: () => { submit(): void } = owner) { return deduct(); }',
      'src/core/orderRecorder/index.ts':
        "import { sdkRule, ownerRule } from '../../domain/order/policy.js'; void sdkRule; void ownerRule;",
    });
    expect(scan.legacy).toHaveLength(2);
    expect(scan.violations.some((key) => key.includes('SDK_EXPOSURE'))).toBe(true);
  });

  it('allows same-owner data helpers and shared predicates without authorizing business factories', () => {
    const scan = fixture({
      'src/core/recorder/data.ts':
        'export function merge(left: { amount: string }, right: { amount: string }) { return { amount: right.amount || left.amount }; } export function owner() { return { submit: () => undefined }; }',
      'src/utils/errors/index.ts':
        'export function isFailure(error: unknown): boolean { return error instanceof Error; }',
      'src/core/recorder/index.ts':
        "import { merge, owner } from './data.js'; import { isFailure } from '../../utils/errors/index.js'; void merge; void owner; void isFailure;",
    });
    expect(scan.legacy).toHaveLength(1);
    expect(scan.legacy[0]).toContain('"owner"');
  });

  it('accepts a migrated SDK-free application factory without inheriting the old owner allowance', () => {
    const scan = fixture({
      'src/application/query/index.ts':
        'export function createQuery(read: () => string) { return { read }; }',
      'src/core/consumer.ts':
        "import { createQuery } from '../application/query/index.js'; void createQuery;",
      'src/domain/consumer.ts':
        "import { createQuery } from '../application/query/index.js'; void createQuery;",
    });
    expect(scan.legacy).toEqual([]);
    expect(scan.violations.some((key) => key.includes('LAYER'))).toBe(true);
  });

  it('retains old business owner dependencies even when their function signatures are neutral', () => {
    const scan = fixture({
      'src/core/policy.ts': 'export function decide(value: string) { return { value }; }',
      'src/services/reader.ts': "import { decide } from '../core/policy.js'; void decide;",
    });
    expect(scan.legacy).toHaveLength(1);
  });

  it.each(['tests/integration/flow.test.ts', 'tests/application/module.test.ts'])(
    'checks an infra fixture neutral port independently of caller directory: %s',
    (caller) => {
      const scan = fixture({
        'tests/infrastructure/longbridge/trade/fixture.ts': `import { Decimal } from 'longbridge'; export function build(frame: { readonly amount: string }) { const raw = new Decimal(frame.amount); return { read: () => ({ amount: raw.toString() }) }; }`,
        [caller]:
          "import { build } from '../infrastructure/longbridge/trade/fixture.js'; build({ amount: '1' }).read();",
      });
      expect(scan.helperCalls.length).toBeGreaterThan(0);
      expect(unclosedHelperCalls(scan)).toEqual([]);
      expect(scan.violations).toEqual([]);
    },
  );

  it.each([
    'export function build(action: (raw: Decimal) => string) { return action(new Decimal("1")); }',
    'export function build() { const raw = new Decimal("1"); return { read: () => raw }; }',
    'export function build(): { amount: string } { return { amount: "1", raw: new Decimal("1") }; }',
    'export function build(): { amount: string } { return new Decimal("1") as any; }',
    'export function build(action: (config: Config) => string) { return action(Config.fromApikey("offline", "offline", "offline")); }',
    'export function build(action: (value: unknown) => string) { return action(new Decimal("1")); }',
    'export function build(action: (value: unknown) => string) { return action(new Decimal("1") as unknown); }',
  ])('does not approve SDK callbacks or raw/any fixture exports: %s', (body) => {
    const scan = fixture({
      'tests/infrastructure/longbridge/trade/fixture.ts': `import { Decimal, Config } from 'longbridge'; ${body}`,
      'tests/integration/flow.test.ts':
        "import { build } from '../infrastructure/longbridge/trade/fixture.js'; build(undefined!);",
    });
    expect(scan.violations.some((key) => key.includes('SDK_FIXTURE_BOUNDARY'))).toBe(true);
    expect(unclosedHelperCalls(scan).length).toBeGreaterThan(0);
  });

  it.each(['import', 'type', 'require'])(
    'resolves SDK dynamic/type aliases to their actual declaration: %s',
    (kind) => {
      const target = path
        .join(process.cwd(), 'node_modules/longbridge/index.js')
        .replaceAll('\\', '/');
      const source =
        kind === 'type'
          ? `type Hidden = import('${target}').Decimal;`
          : `const load = () => ${kind}('${target}');`;
      const scan = fixture({ 'src/application/reader.ts': source });
      expect(scan.imports).toHaveLength(1);
    },
  );

  it('checks the native seam, not every enclosing test assembly or observer signature', () => {
    const scan = fixture({
      'tests/infrastructure/longbridge/trade/fixture.ts':
        "import { Decimal } from 'longbridge'; export function build() { const raw = new Decimal('1'); return { read: () => raw.toString() }; }",
      'tests/application/flow.test.ts':
        "import { build } from '../infrastructure/longbridge/trade/fixture.js'; function assemble(): unknown { return { port: build(), observe: (error: unknown) => error }; } assemble();",
    });
    expect(scan.helperCalls.length).toBeGreaterThan(0);
    expect(unclosedHelperCalls(scan)).toEqual([]);
  });

  it('keeps a hidden SDK callback seam rejected through a neutral outer wrapper', () => {
    const scan = fixture({
      'tests/infrastructure/longbridge/trade/fixture.ts':
        "import { Decimal } from 'longbridge'; export function build(action: (raw: Decimal) => string) { return action(new Decimal('1')); }",
      'tests/application/flow.test.ts':
        "import { build } from '../infrastructure/longbridge/trade/fixture.js'; function assemble() { return build(raw => raw.toString()); } assemble();",
    });
    expect(unclosedHelperCalls(scan).length).toBeGreaterThan(0);
    expect(scan.violations.some((key) => key.includes('SDK_FIXTURE_BOUNDARY'))).toBe(true);
  });

  it('accepts an unknown JSON input without treating it as an unknown public output', () => {
    const scan = fixture({
      'tests/infrastructure/longbridge/trade/fixture.ts': `import { Decimal } from 'longbridge'; export function build() { const raw = new Decimal('1'); return { read: () => ({ amount: raw.toString() }), receive: (json: unknown): void => { void json; } }; }`,
      'tests/application/flow.test.ts':
        "import { build } from '../infrastructure/longbridge/trade/fixture.js'; build();",
    });
    expect(unclosedHelperCalls(scan)).toEqual([]);
    expect(scan.violations).toEqual([]);
  });

  it('keeps SDK-free nested business facts legal without opening an old business owner', () => {
    const scan = fixture({
      'src/core/types.ts':
        'export type Fact = { readonly nested: ReadonlyArray<{ readonly amount: string; readonly time: Date }> };',
      'src/services/reader.ts':
        "import type { Fact } from '../core/types.js'; export type View = Fact;",
    });
    expect(scan.legacy).toEqual([]);
  });

  it('keeps illegal construction in a neutral integration wrapper frozen', () => {
    const scan = fixture({
      'tests/integration/helper.ts':
        "import { Decimal } from 'longbridge'; export function build() { return { amount: new Decimal('1').toString() }; }",
      'tests/integration/flow.test.ts': "import { build } from './helper.js'; build();",
    });
    expect(unclosedHelperCalls(scan).length).toBeGreaterThan(0);
    expect(scan.imports).toHaveLength(1);
  });

  it('requires the P1 stage without granting any P2+ or final-directory exception', () => {
    expect(baseline.stage).toBe('P1');
    const later = baseline.imports.find((row) => row.cutoff === 'P4.5');
    expect(later).toBeDefined();
    if (later !== undefined) {
      expect(excess([later.key], [later], 'P1')).toEqual([]);
      expect(excess([later.key], [later], 'P4.5')).toEqual([later.key]);
    }
  });

  it('keeps exactly one actual TradeContext creator in the production trade adapter', () => {
    expect(actual.tradeContexts).toHaveLength(1);
    expect(actual.tradeContexts[0]?.startsWith('src/infrastructure/longbridge/trade/')).toBe(true);
    const creator = fixture({
      'src/infrastructure/longbridge/trade/context.ts':
        "import { TradeContext } from 'longbridge'; export const create = () => TradeContext.new(undefined!);",
    });
    expect(creator.tradeContexts).toEqual(['src/infrastructure/longbridge/trade/context.ts']);
    expect([...actual.tradeContexts, ...creator.tradeContexts]).not.toHaveLength(1);
  });

  it('tracks TradeContext creation through constructor and static-method aliases', () => {
    const aliased = fixture({
      'src/infrastructure/longbridge/trade/context.ts':
        "import { TradeContext } from 'longbridge'; const Broker = TradeContext; const create = Broker.new; export const first = () => Broker.new(undefined!); export const second = () => create(undefined!);",
    });
    expect(aliased.tradeContexts).toEqual([
      'src/infrastructure/longbridge/trade/context.ts',
      'src/infrastructure/longbridge/trade/context.ts',
    ]);
  });

  it('has concrete reviewed cutoffs for every staged role and no fabricated observation deadline', () => {
    for (const rows of [baseline.imports, baseline.uses, baseline.legacy, baseline.helperCalls])
      expect(rows.filter((row) => row.cutoff === 'UNRESOLVED')).toEqual([]);

    expect(baseline.legacyObservations.every((row) => row.cutoff === 'OBSERVATION')).toBe(true);

    const stages: ReadonlyArray<string> = STAGES;
    for (const row of [...baseline.legacy, ...baseline.legacyObservations]) {
      if (/^src\/(core|main|services)\//.test(row.file))
        expect(stages.includes(row.sourcePhysicalStage ?? row.sourcePhysicalDeadline ?? '')).toBe(
          true,
        );
    }
  });

  it('keeps corrected numeric classifications attached to the actual field identities', () => {
    const field = (file: string, parent: string, name: string) =>
      baseline.fields.filter(
        (row) => row.file === file && row.parent === parent && row.name === name,
      );
    expect(
      field('src/types/account.ts', 'AccountSnapshot', 'positionValue').map(
        (row) => row.classification,
      ),
    ).toEqual(['FINANCIAL_EXACT']);

    expect(
      field('src/services/liquidationCooldown/utils.ts', 'resolveHongKongTimeMs', 'offsetMs').map(
        (row) => row.classification,
      ),
    ).toEqual(['STRUCTURAL_NUMBER']);

    for (const name of ['min', 'max'])
      expect(
        field('src/types/config.ts', 'NumberRange', name).map((row) => row.classification),
      ).toEqual(['FINANCIAL_EXACT']);
  });

  it('freezes non-infra SDK import symbols, aliases, type-only and exact multiplicities', () => {
    expect(
      debtSummary({
        imports: excess(actual.imports, baseline.imports, baseline.stage),
        uses: excess(actual.uses, baseline.uses, baseline.stage),
        origins: excess(actual.origins, baseline.origins, baseline.stage),
      }),
    ).toEqual({});
  });

  it('freezes resolved legacy capabilities, snapshot readers/writers and dynamic edges', () => {
    const eligible = actual.legacy.filter((key) => !neutralLegacyCapability(key));
    const staged = baseline.legacy;
    expect(staged.every((row) => !neutralLegacyCapability(row.key))).toBe(true);
    expect(baseline.legacyObservations.every((row) => neutralLegacyCapability(row.key))).toBe(true);
    expect(
      debtSummary({
        legacy: excess(eligible, staged, baseline.stage),
        owners: expiredLegacyOwners(
          files.map((file) => path.relative(root, file).replaceAll('\\', '/')),
          [...baseline.legacy, ...baseline.legacyObservations],
          baseline.stage,
        ),
        snapshot: excess(actual.snapshot, baseline.snapshot, baseline.stage),
        snapshotExposures: excess(
          actual.snapshotExposures,
          baseline.snapshotExposures,
          baseline.stage,
        ),
        violations: excess(actual.violations, baseline.stagedViolations, baseline.stage),
      }),
    ).toEqual({});
  });

  it('does not expire neutral aliases but retains real business capabilities and layer checks', () => {
    const neutral = fixture({
      'src/utils/time/index.ts': 'export const getHKTime = () => 1;',
      'src/core/old.ts': "import { getHKTime as clock } from '../utils/time/index.js'; void clock;",
    });
    expect(neutral.legacy.every(neutralLegacyCapability)).toBe(true);
    const owner = {
      file: 'src/core/old.ts',
      key: neutral.legacy[0]!,
      owner: 'old business owner',
      cutoff: 'OBSERVATION',
      sourcePhysicalDeadline: 'P3E',
      evidence: 'fixture',
    };
    expect(expiredLegacyOwners(['src/core/old.ts'], [owner], 'P0')).toEqual([]);
    expect(expiredLegacyOwners(['src/core/old.ts'], [owner], 'P3E')).toEqual(['src/core/old.ts']);
    expect(expiredLegacyOwners(['src/core/old.ts'], [], 'P6')).toEqual(['src/core/old.ts']);
    expect(
      excess(
        neutral.legacy.filter((key) => !neutralLegacyCapability(key)),
        [],
        'P3E',
      ),
    ).toEqual([]);
    const mixed = fixture({
      'src/utils/helpers/index.ts':
        'export const isRecord = () => true; export const decimalToNumber = () => ({ execute: () => 1 });',
      'src/core/old.ts':
        "import { isRecord as predicate, decimalToNumber as amount } from '../utils/helpers/index.js'; void predicate; void amount;",
      'src/domain/probe.ts':
        "import type { Fact } from '../core/types.js'; export type Public = Fact;",
      'src/core/types.ts': 'export type Fact = { readonly revision: number };',
    });
    expect(mixed.legacy.filter(neutralLegacyCapability)).toHaveLength(0);
    expect(mixed.legacy.filter((key) => !neutralLegacyCapability(key))).toHaveLength(2);
    expect(mixed.violations.some((key) => key.includes('LAYER'))).toBe(true);
  });

  it('does not invent legacy cutoffs for target exact tools or genuine P1 mapper capabilities', () => {
    const legal = fixture({
      'src/utils/numeric/exact.ts':
        'export const exactCompare = (left: string, right: string) => left === right ? 0 : 1;',
      'src/infrastructure/longbridge/trade/accountMapper.ts':
        'export const mapAccountBalance = (input: string) => ({ cash: input });',
      'src/core/consumer.ts':
        "import { exactCompare } from '../utils/numeric/exact.js'; import { mapAccountBalance } from '../infrastructure/longbridge/trade/accountMapper.js'; void exactCompare; void mapAccountBalance;",
    });
    expect(legal.legacy.every(neutralLegacyCapability)).toBe(true);
    expect(legal.violations).toEqual([]);
    const reverse = fixture({
      'src/infrastructure/longbridge/trade/accountMapper.ts':
        'export const mapAccountBalance = () => 1;',
      'src/application/reader.ts':
        "import { mapAccountBalance } from '../infrastructure/longbridge/trade/accountMapper.js'; void mapAccountBalance;",
    });
    expect(reverse.violations.some((key) => key.includes('LAYER'))).toBe(true);
    expect(
      neutralLegacyCapability(
        occurrenceKey('src/core/consumer.ts', 'IMPORT', 'src/utils/numeric/index.ts', {
          imported: 'exactCompare',
          local: 'compare',
          typeOnly: false,
        }),
      ),
    ).toBe(false);

    expect(
      neutralLegacyCapability(
        occurrenceKey(
          'src/core/consumer.ts',
          'IMPORT',
          'src/infrastructure/longbridge/trade/accountMapper.ts',
          { imported: 'submitOrder', local: 'submit', typeOnly: false },
        ),
      ),
    ).toBe(false);
  });

  it('checks resolved mapper outputs and data types without granting a symbol-name allowance', () => {
    const mapper = fixture({
      'src/core/reader.ts':
        "import { differentlyNamed as map } from '../infrastructure/longbridge/market/mapper.js'; void map;",
      'src/infrastructure/longbridge/market/mapper.ts':
        "import type { Decimal } from 'longbridge'; type Data = { readonly price: string; readonly category: number }; function text(value: Decimal): string { return value.toString(); } export function differentlyNamed(value: { price: Decimal; category: number }): Data { return { price: text(value.price), category: value.category }; }",
    });
    expect(mapper.legacy).toEqual([]);
    expect(mapper.violations).toEqual([]);
    const nativeFields = fixture({
      'src/core/reader.ts':
        "import { read } from '../infrastructure/longbridge/trade/mapper.js'; void read;",
      'src/infrastructure/longbridge/trade/mapper.ts':
        "import type { AccountBalance } from 'longbridge'; export function read(value: AccountBalance): { readonly currency: string; readonly cash: string } { return { currency: value.currency, cash: value.totalCash.toString() }; }",
    });
    expect(nativeFields.legacy).toEqual([]);
    expect(nativeFields.violations).toEqual([]);
    const data = fixture({
      'src/core/types.ts':
        'export type LocalDisplay = { readonly priceText: string; readonly labels: ReadonlyArray<string> };',
      'src/services/reader.ts':
        "import type { LocalDisplay as View } from '../core/types.js'; export const read = (view: View) => view.priceText;",
    });
    expect(data.legacy).toEqual([]);
  });

  it('keeps scan-local reachability memo separate from supplied SDK callbacks and fresh programs', () => {
    const helper =
      'export function invoke(callback: () => unknown): unknown { return callback(); }';
    const neutral = fixture({
      'tests/helper.ts': helper,
      'tests/reader.ts': "import { invoke } from './helper.js'; invoke(() => ({}));",
    });
    expect(neutral.helperCalls).toEqual([]);
    const constructing = fixture({
      'tests/helper.ts': helper,
      'tests/reader.ts':
        "import { Decimal } from 'longbridge'; import { invoke } from './helper.js'; invoke(() => ({})); invoke(() => new Decimal('1'));",
    });
    expect(
      constructing.helperCalls.filter((key) => JSON.parse(key)[0] === 'tests/reader.ts'),
    ).toEqual([occurrenceKey('tests/reader.ts', '<module>', "invoke(() => new Decimal('1'))")]);
    const cyclic = fixture({
      'tests/helper.ts':
        "import { Decimal } from 'longbridge'; function sibling() { return loop(); } export function loop(): unknown { if (true) return sibling(); return new Decimal('1'); }",
      'tests/reader.ts': "import { loop } from './helper.js'; loop();",
    });
    expect(cyclic.helperCalls.some((key) => JSON.parse(key)[0] === 'tests/reader.ts')).toBe(true);
  });

  it('freezes HEAD-existing fixture helper consumers without admitting new business tests', () => {
    expect(
      debtSummary({
        helperCalls: excess(unclosedHelperCalls(actual), baseline.helperCalls, baseline.stage),
      }),
    ).toEqual({});
  });

  it('rejects SDK fixture helper construction in new business tests, including transitive helpers', () => {
    const probe = fixture({
      'mock/helper.ts':
        "import { Decimal } from 'longbridge'; export function sdkFixture() { return new Decimal('1'); } export function indirect() { return sdkFixture(); }",
      'tests/application/new.test.ts':
        "import { indirect as alias } from '../../mock/helper.js'; alias();",
    });
    expect(probe.imports).toEqual([
      occurrenceKey('mock/helper.ts', 'IMPORT', 'longbridge', 'Decimal', 'Decimal', false),
    ]);
    expect(probe.helperCalls.length).toBeGreaterThan(0);
    expect(excess(probe.helperCalls, [], 'P0').length).toBeGreaterThan(0);
  });

  it('checks mock factory execution behind a src/types port without traversing a production owner', () => {
    const probe = fixture({
      'src/types/port.ts': 'export interface Port { construct(): unknown; }',
      'mock/factory.ts':
        "import { Decimal } from 'longbridge'; import type { Port } from '../src/types/port.js'; export const factory = (): Port => ({ construct: () => new Decimal('1') });",
      'src/core/owner.ts':
        "import { Decimal } from 'longbridge'; export const production = () => new Decimal('2');",
      'tests/application/probe.test.ts':
        "import { factory } from '../../mock/factory.js'; import { production } from '../../src/core/owner.js'; const port = factory(); port.construct(); production();",
    });
    expect(probe.helperCalls).toEqual([
      occurrenceKey('tests/application/probe.test.ts', '<module>', 'port.construct()'),
    ]);
    expect(excess(probe.helperCalls, [], 'P0')).toEqual(probe.helperCalls);
    const allowance = probe.helperCalls.map((key) => ({
      file: 'tests/application/probe.test.ts',
      key,
      owner: 'actual mock constructor',
      cutoff: 'P1',
      evidence: 'fixture',
    }));
    expect(excess(probe.helperCalls, allowance, 'P0')).toEqual([]);
    expect(excess([...probe.helperCalls, ...probe.helperCalls], allowance, 'P0')).toEqual(
      probe.helperCalls,
    );
    expect(excess(probe.helperCalls, allowance, 'P1')).toEqual(probe.helperCalls);
  });

  it.each([
    "import type { Decimal as Amount } from 'longbridge'; export type Fact = { readonly amount: Amount };",
    "export { Decimal as Amount } from 'longbridge';",
    "type Amount = import('longbridge').Decimal;",
    "const load = () => import('longbridge');",
    'const load = (path: string) => import(path);',
  ])('rejects every new SDK/module bypass without executing it', (source) => {
    const probe = fixture({ 'src/application/probe.ts': source });
    expect(probe.imports.length + probe.origins.length + probe.violations.length).toBeGreaterThan(
      0,
    );
  });

  it('detects indirect public SDK alias exposure and distinguishes type-only aliases', () => {
    const indirect = fixture({
      'src/types/indirect.ts':
        "import type { Decimal } from 'longbridge'; export type Wrapper = { readonly hidden: Decimal };",
      'src/application/public.ts':
        "import type { Wrapper as Innocent } from '../types/indirect.js'; export type Public = Innocent;",
    });
    expect(indirect.violations.some((key) => key.includes('SDK_EXPOSURE'))).toBe(true);
    const probe = fixture({
      'src/infrastructure/longbridge/trade/types.ts':
        "import type { Decimal } from 'longbridge'; export type Amount = Decimal;",
      'src/application/probe.ts':
        "import type { Amount as Hidden } from '../infrastructure/longbridge/trade/types.js'; export type Fact = Hidden;",
    });
    expect(probe.origins.length + probe.violations.length).toBeGreaterThan(0);
    const direct = fixture({
      'src/domain/probe.ts':
        "import type { Decimal as Hidden } from 'longbridge'; export type Fact = Hidden;",
    });
    expect(direct.imports).toEqual([
      occurrenceKey('src/domain/probe.ts', 'IMPORT', 'longbridge', 'Decimal', 'Hidden', true),
    ]);
  });

  it('allows genuine adapter mapping and adapter-exclusive SDK fixtures', () => {
    const probe = fixture({
      'src/infrastructure/longbridge/trade/mapper.ts':
        "import { Decimal } from 'longbridge'; export const map = (value: Decimal) => value.toString();",
      'tests/infrastructure/longbridge/trade/mapper.test.ts':
        "import { Decimal } from 'longbridge'; new Decimal('1');",
    });
    expect(probe.imports).toEqual([]);
    expect(probe.origins).toEqual([]);
    expect(probe.violations).toEqual([]);
    expect(probe.helperCalls).toEqual([]);
  });

  it('allows actual trade/market adapters but not SDK barrels, heritage or fixture helpers', () => {
    const approved = fixture({
      'src/infrastructure/longbridge/trade/accountMapper.ts':
        "import { Decimal as BrokerDecimal } from 'longbridge'; export const text = (value: BrokerDecimal) => value.toString();",
      'src/infrastructure/longbridge/market/quoteFinancialMapper.ts':
        "import type { Decimal } from 'longbridge'; export const text = (value: Decimal) => value.toString();",
      'tests/infrastructure/longbridge/trade/account.test.ts':
        "import { Decimal } from 'longbridge'; const value = new Decimal('1');",
    });
    expect(approved.imports).toEqual([]);
    expect(approved.origins).toEqual([]);
    expect(approved.helperCalls).toEqual([]);
    expect(approved.violations).toEqual([]);
    const rejected = fixture({
      'src/infrastructure/longbridge/trade/sdkBarrel.ts':
        "export { Decimal as BrokerMoney } from 'longbridge';",
      'src/application/contract.ts':
        "import type { BrokerMoney } from '../infrastructure/longbridge/trade/sdkBarrel.js'; export interface Bad extends BrokerMoney {} export type Wrapped = Readonly<{ readonly value: BrokerMoney }>;",
      'tests/helpers/money.ts':
        "import { Decimal } from 'longbridge'; export const create = () => new Decimal('1');",
      'tests/integration/neutral.test.ts':
        "import { create as money } from '../helpers/money.js'; export const fixture = () => money();",
    });
    expect(rejected.violations.some((key) => key.includes('SDK_EXPOSURE'))).toBe(true);
    expect(rejected.violations.some((key) => key.includes('LAYER'))).toBe(true);
    expect(rejected.helperCalls.some((key) => key.includes('money()'))).toBe(true);
    expect(excess(rejected.helperCalls, baseline.helperCalls, 'P1')).not.toEqual([]);
    const neutral = fixture({
      'tests/integration/neutral.test.ts':
        "type Fact = { readonly price: string; readonly quantity: number }; const create = (): Fact => ({ price: '1.01', quantity: 100 }); const input = create();",
    });
    expect(neutral.imports).toEqual([]);
    expect(neutral.helperCalls).toEqual([]);
    const mislocated = fixture({
      'tests/infrastructure/longbridge/helpers/fixture.ts':
        "import { Decimal } from 'longbridge'; export const create = () => new Decimal('1');",
    });
    expect(mislocated.imports).toHaveLength(1);
    expect(excess(mislocated.imports, baseline.imports, 'P1')).not.toEqual([]);
  });

  it('rejects extra use of an existing import rather than checking a file total', () => {
    const first = fixture({
      'src/core/old.ts':
        "import { Decimal } from 'longbridge'; export const amount = new Decimal('1');",
    });
    const second = fixture({
      'src/core/old.ts':
        "import { Decimal } from 'longbridge'; export const amount = new Decimal('1'); export const other = new Decimal('2');",
    });
    const allowance = first.uses.map((key) => ({
      file: 'src/core/old.ts',
      key,
      owner: 'adapter migration',
      cutoff: 'P4.5',
      evidence: 'fixture',
    }));
    expect(excess(first.uses, allowance, 'P0')).toEqual([]);
    expect(excess(second.uses, allowance, 'P0').length).toBeGreaterThan(0);
  });

  it('expires old assembly capabilities and never inherits them after moving into application', () => {
    const edge = baseline.legacy.find(
      (row) =>
        row.file === 'src/app/runtime/createPostGateRuntime.ts' &&
        row.key.includes('doomsdayProtection/index.ts'),
    );
    expect(edge).toBeDefined();
    if (edge === undefined) return;

    expect(excess([edge.key], [edge], 'P0')).toEqual([]);
    expect(excess([edge.key], [edge], 'P3E')).toEqual([edge.key]);
    const probe = fixture({
      'src/application/probe.ts': "import { create } from '../core/old.js'; void create;",
      'src/core/old.ts': 'export const create = () => 1;',
    });
    expect(probe.violations.length).toBeGreaterThan(0);
    expect(excess(probe.legacy, [edge], 'P0').length).toBeGreaterThan(0);
  });

  it('allows neutral local shared types and refuses a second snapshot writer immediately', () => {
    const probe = fixture({
      'src/domain/shared.ts': 'export type Fact = { readonly revision: number };',
      'src/domain/probe.ts':
        "import type { Fact } from './shared.js'; export const read = (fact: Fact) => fact.revision;",
    });
    expect(probe.violations).toEqual([]);
    const writer = fixture({
      'src/application/bypass.ts':
        'export const write = (state: { cachedPositions: unknown[] }) => { state.cachedPositions = []; };',
    });
    expect(excess(writer.snapshot, baseline.snapshot, baseline.stage).length).toBeGreaterThan(0);
    const capability = fixture({
      'src/application/reader.ts':
        'type Reader = { readonly cachedPositions: ReadonlyArray<unknown> }; const read = (reader: Reader) => reader.cachedPositions;',
    });
    expect(
      excess(capability.snapshotExposures, baseline.snapshotExposures, baseline.stage).length,
    ).toBeGreaterThan(0);
    const hiddenWriter = fixture({
      'src/application/writer.ts':
        "const write = (state: { cachedPositions: unknown[] }) => { state['cachedPositions'] = []; };",
    });
    expect(excess(hiddenWriter.snapshot, baseline.snapshot, baseline.stage).length).toBeGreaterThan(
      0,
    );
  });

  it('does not impose P6 LastState removal after its P1 snapshot mirrors have been retired', () => {
    const lifecycle = fixture({
      'src/types/state.ts':
        'export type LastState = { canTrade: boolean; readonly dayEpoch: number };',
      'src/runtime/lifecycle.ts':
        "import type { LastState } from '../types/state.js'; export const read = (state: Pick<LastState, 'canTrade'>) => state.canTrade;",
    });
    expect(lifecycle.snapshot).toEqual([]);
    expect(lifecycle.snapshotExposures).toEqual([]);
    const mirror = fixture({
      'src/types/state.ts':
        'export type LastState = { canTrade: boolean; cachedAccount: unknown };',
      'src/runtime/lifecycle.ts':
        "import type { LastState } from '../types/state.js'; export const read = (state: LastState) => state.canTrade;",
    });
    expect(mirror.snapshotExposures.some((key) => key.includes('LastState'))).toBe(true);
    expect(excess(mirror.snapshotExposures, baseline.snapshotExposures, 'P1')).not.toEqual([]);
  });

  it('requires zero P1 old snapshot occurrences and the sole actual canonical owner', () => {
    expect(excess(actual.snapshot, baseline.snapshot, 'P1')).toEqual([]);
    expect(excess(actual.snapshotExposures, baseline.snapshotExposures, 'P1')).toEqual([]);
    expect(snapshotBoundaries(root, program, files)).toEqual({
      owners: [SNAPSHOT_OWNER],
      creations: ['src/app/runtime/createPostGateRuntime.ts'],
      violations: [],
    });
  });

  it('checks actual P1 reader parameters, nested facts and withheld update capabilities', () => {
    const contracts = {
      'src/types/accountPosition.ts': readFileSync('src/types/accountPosition.ts', 'utf8'),
      'src/types/account.ts': readFileSync('src/types/account.ts', 'utf8'),
      'src/utils/apiFailure/types.ts':
        'export type ExternalApiRetryConfig = { readonly retries?: number };',
    };
    const rejected: number[] = [];
    const rejectedSnapshot: SnapshotBoundaryScan[] = [];
    fixture(
      {
        ...contracts,
        'src/application/reader.ts':
          "import type { AccountPositionSnapshotReader } from '../types/accountPosition.js'; const illegal = (reader: AccountPositionSnapshotReader) => { const view = reader.getView(); view.token.positionRevision = 2; view.positions.push(view.positions[0]!); view.positions[0]!.quantity = 0; if (view.account) { view.account.cashInfos[0]!.availableCash = '0'; } reader.update([]); reader.requestRefresh({}); reader.invalidateAccount(); };",
      },
      rejected,
      rejectedSnapshot,
    );
    expect(rejected).toContain(2540);
    expect(rejected).toContain(2339);
    expect(rejectedSnapshot[0]?.violations.some((key) => key.includes('SNAPSHOT_FACT_WRITE'))).toBe(
      true,
    );
    const accepted: number[] = [];
    const acceptedSnapshot: SnapshotBoundaryScan[] = [];
    fixture(
      {
        ...contracts,
        'src/application/reader.ts':
          "import type { AccountPositionSnapshotReader } from '../types/accountPosition.js'; export const read = (reader: AccountPositionSnapshotReader) => { const view = reader.getView(); return { revision: view.token.positionRevision, quantities: view.positions.map((position) => position.quantity), cash: view.account?.cashInfos.map((item) => item.availableCash) }; };",
      },
      accepted,
      acceptedSnapshot,
    );
    expect(accepted).toEqual([]);
    expect(acceptedSnapshot[0]?.violations).toEqual([]);
  });

  it('requires P1 account/position/needed quote financial text without banning integer quantities', () => {
    const accepted: SnapshotBoundaryScan[] = [];
    fixture(
      {
        'src/types/account.ts':
          'export type Position = { readonly quantity: number; readonly availableQuantity: number; readonly costPrice: string }; export type AccountSnapshot = { readonly netAssets: string; readonly positionValue: string; readonly totalCash: string };',
        'src/types/quote.ts':
          'export type Quote = { readonly price: string; readonly prevClose: string; readonly lotSize: number; readonly timestamp: number };',
      },
      undefined,
      accepted,
    );
    expect(accepted[0]?.violations).toEqual([]);
    const rejected: SnapshotBoundaryScan[] = [];
    fixture(
      {
        'src/types/account.ts':
          'type Hidden = number; export type Position = { readonly quantity: number; readonly costPrice: Hidden }; export type CashInfo = { readonly availableCash: string | number };',
        'src/types/quote.ts':
          'export type Quote = { readonly price: { toNumber(): number }; readonly prevClose: unknown };',
      },
      undefined,
      rejected,
    );

    expect(
      rejected[0]?.violations.filter((key) => key.includes('P1_FINANCIAL_CONTRACT')),
    ).toHaveLength(4);
  });

  it('refuses a second snapshot factory or consumer creation without banning P1 app assembly', () => {
    const contract =
      'export type AccountPositionSnapshotView = { readonly positions: ReadonlyArray<{ readonly quantity: number }> };';
    const owner =
      "import type { AccountPositionSnapshotView } from '../../types/accountPosition.js'; export function createAccountPositionSnapshot(): AccountPositionSnapshotView { return { positions: [] }; }";
    const accepted: SnapshotBoundaryScan[] = [];
    fixture(
      {
        'src/types/accountPosition.ts': contract,
        [SNAPSHOT_OWNER]: owner,
        'src/app/create.ts':
          "import { createAccountPositionSnapshot } from '../application/accountPositionSnapshot/index.js'; export const assemble = () => createAccountPositionSnapshot();",
      },
      undefined,
      accepted,
    );

    expect(accepted[0]).toEqual({
      owners: [SNAPSHOT_OWNER],
      creations: ['src/app/create.ts'],
      violations: [],
    });
    const rejected: SnapshotBoundaryScan[] = [];
    fixture(
      {
        'src/types/accountPosition.ts': contract,
        [SNAPSHOT_OWNER]: owner,
        'src/application/other.ts':
          "import { createAccountPositionSnapshot as create } from './accountPositionSnapshot/index.js'; export const bypass = () => create(); export function createAccountPositionSnapshot() { return { positions: [] }; }",
      },
      undefined,
      rejected,
    );
    expect(rejected[0]?.owners).toHaveLength(2);
    expect(rejected[0]?.violations.some((key) => key.includes('SNAPSHOT_OWNER_CREATION'))).toBe(
      true,
    );
  });

  it('rejects an independently named snapshot implementation and writable fact casts', () => {
    const scanned: SnapshotBoundaryScan[] = [];
    fixture(
      {
        'src/types/accountPosition.ts':
          'export type AccountPositionSnapshotView = { readonly positions: ReadonlyArray<{ readonly quantity: number }> }; export interface AccountPositionSnapshot { getView(): AccountPositionSnapshotView; requestRefresh(): void; requestClear(): void; invalidateAccount(): void; }',
        'src/application/other.ts':
          "import type { AccountPositionSnapshot, AccountPositionSnapshotView } from '../types/accountPosition.js'; export const other = (): AccountPositionSnapshot => ({ getView: () => ({ positions: [] }), requestRefresh() {}, requestClear() {}, invalidateAccount() {} }); const mutate = (view: AccountPositionSnapshotView) => (view as { positions: Array<{ quantity: number }> }).positions.push({ quantity: 1 });",
      },
      undefined,
      scanned,
    );

    expect(
      scanned[0]?.violations.some((key) => key.includes('SECOND_SNAPSHOT_IMPLEMENTATION')),
    ).toBe(true);
    expect(scanned[0]?.violations.some((key) => key.includes('WRITABLE_SNAPSHOT_CAST'))).toBe(true);
    const mutable: SnapshotBoundaryScan[] = [];
    fixture(
      {
        'src/types/accountPosition.ts':
          'export type AccountPositionSnapshotView = { readonly positions: ReadonlyArray<{ quantity: number }> };',
      },
      undefined,
      mutable,
    );
    expect(mutable[0]?.violations.some((key) => key.includes('WRITABLE_SNAPSHOT_FACT'))).toBe(true);
    const laundering: SnapshotBoundaryScan[] = [];
    fixture(
      {
        'src/types/accountPosition.ts':
          'export type AccountPositionSnapshotView = { readonly revision: number };',
        'src/application/casts.ts':
          "import type { AccountPositionSnapshotView } from '../types/accountPosition.js'; const cast = (view: AccountPositionSnapshotView) => view as any; const mutate = (view: AccountPositionSnapshotView) => Object.assign(view, { revision: 0 });",
      },
      undefined,
      laundering,
    );

    expect(laundering[0]?.violations.some((key) => key.includes('WRITABLE_SNAPSHOT_CAST'))).toBe(
      true,
    );
    expect(laundering[0]?.violations.some((key) => key.includes('SNAPSHOT_FACT_WRITE'))).toBe(true);
  });

  it('constrains selected strategy entry paths in both source and compiled layouts', () => {
    for (const compiled of [false, true]) {
      const directory = compiled ? 'dist/core/strategy' : 'src/core/strategy';
      const extension = compiled ? 'js' : 'ts';
      expect(
        selectedStrategyPath(
          root,
          'intradayRegression',
          path.join(root, directory, 'intradayRegression', `definition.${extension}`),
          compiled,
        ),
      ).toBe(true);

      for (const tail of [
        `other/definition.${extension}`,
        `intradayRegression/runtime/ema.${extension}`,
        `intradayRegression/definition.${compiled ? 'ts' : 'js'}`,
        '../outside.js',
      ]) {
        expect(
          selectedStrategyPath(
            root,
            'intradayRegression',
            path.join(root, directory, tail),
            compiled,
          ),
        ).toBe(false);
      }
    }

    expect(
      selectedStrategyPath(root, '../outside', path.join(root, 'outside/definition.ts'), false),
    ).toBe(false);
  });
});
