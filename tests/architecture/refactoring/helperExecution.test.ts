/**
 * Helper SDK 执行路径回归：创建中性 factory 与类型 port 不执行返回方法/默认参数。
 * 静态临时 fixture 覆盖真实方法调用、缺省参数及显式中性参数，不求值 native SDK。
 */
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';
import { createAuditProgram, scanProgram } from './scanner.js';

function helperConsumers(
  helper: string,
  consumer: string,
  dependencies: Readonly<Record<string, string>> = {},
  checkDiagnostics = false,
): ReadonlyArray<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsi-execution-probe-'));
  try {
    const sources = {
      ...dependencies,
      'mock/broker.ts': helper,
      'tests/application/probe.test.ts': consumer,
    };
    const files = Object.entries(sources).map(([file, text]) => {
      const absolute = path.join(root, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
      return absolute;
    });
    const program = createAuditProgram(root, files);
    if (checkDiagnostics) {
      expect(
        ts
          .getPreEmitDiagnostics(program)
          .filter(
            (diagnostic) =>
              diagnostic.file !== undefined && files.includes(diagnostic.file.fileName),
          ),
      ).toEqual([]);
    }

    return scanProgram(root, program, files).helperCalls;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const lazyBroker =
  "import { Decimal } from 'longbridge'; export function broker() { function construct() { return new Decimal('1'); } return { construct, method() { return new Decimal('2'); }, callback: () => new Decimal('3') }; }";
const defaults =
  "import { Decimal } from 'longbridge'; const sdk = () => new Decimal('1'); export function wrap(value: unknown = sdk()) { return value; }";

const realBroker = `import { createTradeContextMock } from '${path.resolve(process.cwd(), 'mock/longbridge/tradeContextMock.ts').replaceAll('\\', '/')}'; export function broker() { return createTradeContextMock(); }`;

describe('SDK helper actual invocation boundaries', () => {
  it('strategy synthetic retains SDK execution detection through relocated test helpers', () => {
    const helper =
      "import { construct } from '../tests/strategies/newAlpha/factory.js'; export function broker() { return construct(); }";
    const consumer = "import { broker } from '../../mock/broker.js'; broker();";
    expect(
      helperConsumers(helper, consumer, {
        'tests/strategies/newAlpha/factory.ts':
          "import { Decimal } from 'longbridge'; export const construct = () => new Decimal('1');",
      }),
    ).toHaveLength(1);

    expect(
      helperConsumers(helper, consumer, {
        'tests/strategies/newAlpha/factory.ts':
          'export const construct = () => ({ orderId: "neutral" });',
      }),
    ).toEqual([]);
  });

  it.each([
    "const Money = Decimal; return new Money('1');",
    'const zero = Decimal.ZERO; return zero();',
    'const zero = Decimal.ZERO; const alias = zero; return alias();',
  ])(
    'rejects SDK constructor and static-factory aliases without freezing neutral calls: %s',
    (body) => {
      expect(
        helperConsumers(
          `import { Decimal } from 'longbridge'; export function make() { ${body} }`,
          "import { make } from '../../mock/broker.js'; make();",
        ),
      ).toHaveLength(1);
    },
  );

  it('keeps a locally aliased neutral helper and scalar SDK projection out of construction', () => {
    expect(
      helperConsumers(
        "import { Decimal } from 'longbridge'; function read(value: Decimal) { return value.toString(); } export function make(value: Decimal) { const neutral = () => 1; neutral(); const alias = read; return alias(value); }",
        "import { make } from '../../mock/broker.js'; declare const value: Parameters<typeof make>[0]; make(value);",
      ),
    ).toEqual([]);
  });

  it('follows an explicitly invoked callback across positional and destructured object parameters', () => {
    const wrapper =
      "import { Decimal } from 'longbridge'; function invoke(params: { action: () => unknown }) { const { action } = params; return action(); } function wrap(action: () => unknown) { return invoke({ action }); } export function make() { return wrap(() => Decimal.ZERO()); }";
    expect(
      helperConsumers(wrapper, "import { make } from '../../mock/broker.js'; make();"),
    ).toHaveLength(1);

    expect(
      helperConsumers(
        wrapper.replace('return action();', 'return action;'),
        "import { make } from '../../mock/broker.js'; make();",
      ),
    ).toEqual([]);
  });

  it('executes a default callback but respects an explicit neutral double', () => {
    const helper =
      "import { Decimal } from 'longbridge'; export function make(action: () => unknown = () => Decimal.ZERO()) { return action(); }";
    expect(
      helperConsumers(helper, "import { make } from '../../mock/broker.js'; make();"),
    ).toHaveLength(1);

    expect(
      helperConsumers(
        helper,
        "import { make } from '../../mock/broker.js'; make(() => ({ orderId: 'neutral' }));",
      ),
    ).toEqual([]);
  });

  it('keeps cached callback results separate for different explicit parameter contexts', () => {
    const calls = helperConsumers(
      "import { Decimal } from 'longbridge'; export function invoke(action: () => unknown) { return action(); } export const sdk = () => Decimal.ZERO();",
      "import { invoke, sdk } from '../../mock/broker.js'; invoke(() => 1); invoke(sdk);",
    );
    expect(calls).toHaveLength(1);
  });

  it('does not publish a recursion-cut false result to another audit root', () => {
    const calls = helperConsumers(
      "import { Decimal } from 'longbridge'; export function first() { second(); return Decimal.ZERO(); } export function second() { return first(); }",
      "import { first, second } from '../../mock/broker.js'; first(); second();",
    );
    expect(calls).toHaveLength(2);
  });

  it('keeps distinct wrapper invocations independent when only the later callback constructs SDK', () => {
    expect(
      helperConsumers(
        "import { Decimal } from 'longbridge'; function invoke(action: () => unknown) { return action(); } export function make() { invoke(() => 1); return invoke(() => Decimal.ZERO()); }",
        "import { make } from '../../mock/broker.js'; make();",
      ),
    ).toHaveLength(1);
  });

  it.each(['[1]', 'const items = [1]; items'])(
    'executes an array map callback on a nonempty static input: %s',
    (input) => {
      const consumer = input.startsWith('const')
        ? 'const items = [1]; make(items);'
        : `make(${input});`;
      expect(
        helperConsumers(
          "import { Decimal } from 'longbridge'; export function make(items: ReadonlyArray<number>) { return items.map(() => new Decimal('1')); }",
          `import { make } from '../../mock/broker.js'; ${consumer}`,
        ),
      ).toHaveLength(1);
    },
  );

  it('does not execute map callbacks for an empty input or a non-array custom map', () => {
    expect(
      helperConsumers(
        "import { Decimal } from 'longbridge'; export function make(items: ReadonlyArray<number>) { return items.map(() => new Decimal('1')); }",
        "import { make } from '../../mock/broker.js'; make([]);",
      ),
    ).toEqual([]);

    expect(
      helperConsumers(
        "import { Decimal } from 'longbridge'; export function make() { const custom = { map(callback: () => unknown) { return callback; } }; return custom.map(() => Decimal.ZERO()); }",
        "import { make } from '../../mock/broker.js'; make();",
      ),
    ).toEqual([]);
  });

  it('stops callback recursion at production owners', () => {
    expect(
      helperConsumers(
        "import { owner } from '../src/owner.js'; import { Decimal } from 'longbridge'; export function make() { return owner(() => Decimal.ZERO()); }",
        "import { make } from '../../mock/broker.js'; make();",
        { 'src/owner.ts': 'export function owner(action: () => unknown) { return action(); }' },
      ),
    ).toEqual([]);
  });

  it('rejects actual broker submitOrder SDK defaults through withCall and withMockCall', () => {
    const calls = helperConsumers(
      realBroker,
      "import { broker } from '../../mock/broker.js'; declare const options: Parameters<ReturnType<typeof broker>['submitOrder']>[0]; broker().submitOrder(options);",
      {},
      true,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('submitOrder(options)');
  });

  it('rejects actual nonempty seedTodayOrders SDK clones through map', () => {
    const calls = helperConsumers(
      realBroker,
      "import { broker } from '../../mock/broker.js'; declare const order: Parameters<ReturnType<typeof broker>['seedTodayOrders']>[0][number]; broker().seedTodayOrders([order]);",
      {},
      true,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('seedTodayOrders([order])');
  });

  it.each(['broker();', 'broker().seedTodayOrders([]);', 'broker().accountBalance();'])(
    'allows actual neutral broker initialization and empty seed/query: %s',
    (expression) => {
      expect(
        helperConsumers(realBroker, `import { broker } from '../../mock/broker.js'; ${expression}`),
      ).toEqual([]);
    },
  );

  it('does not execute an uncalled broker method or a replaced default double', () => {
    expect(
      helperConsumers(
        realBroker,
        "import { broker } from '../../mock/broker.js'; const port = broker(); void port.submitOrder;",
      ),
    ).toEqual([]);

    expect(
      helperConsumers(
        realBroker + ' export function wrap(port = broker()) { return port; }',
        "import { wrap } from '../../mock/broker.js'; declare const neutral: Parameters<typeof wrap>[0]; wrap(neutral);",
      ),
    ).toEqual([]);
  });

  it('allows neutral factory creation without invoking returned methods or callbacks', () => {
    expect(
      helperConsumers(
        lazyBroker,
        "import { broker as create } from '../../mock/broker.js'; const value = create(); void value; ",
      ),
    ).toEqual([]);
  });

  it.each(['construct', 'method', 'callback'])(
    'rejects actually invoking the returned SDK constructor method %s',
    (method) => {
      const calls = helperConsumers(
        lazyBroker,
        `import { broker } from '../../mock/broker.js'; const value = broker(); value.${method}();`,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`value.${method}()`);
    },
  );

  it.each(['make().method()', 'const port = make(); port.method()'])(
    'resolves an explicit interface factory return implementation: %s',
    (expression) => {
      expect(
        helperConsumers(
          "import { Decimal } from 'longbridge'; interface Port { method(): unknown; } export function make(): Port { return { method() { return new Decimal('1'); } }; }",
          `import { make } from '../../mock/broker.js'; ${expression};`,
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    "return { method() { return new Decimal('1'); } };",
    "const result = { method: () => new Decimal('1') }; return result;",
    "function method() { return new Decimal('1'); } return { method };",
    "const method = () => new Decimal('1'); return { method: method };",
  ])('tracks only the called implementation behind an interface: %s', (body) => {
    const helper = `import { Decimal } from 'longbridge'; interface Port { method(): unknown; } export function make(): Port { ${body} }`;
    expect(helperConsumers(helper, "import { make } from '../../mock/broker.js'; make();")).toEqual(
      [],
    );

    expect(
      helperConsumers(helper, "import { make } from '../../mock/broker.js'; make().method();"),
    ).toHaveLength(1);
  });

  it('keeps uncalled SDK methods and closures out of an executed neutral interface method', () => {
    expect(
      helperConsumers(
        "import { Decimal } from 'longbridge'; interface Port { neutral(): unknown; sdk(): unknown; } export function make(): Port { return { neutral() { return () => new Decimal('1'); }, sdk() { return new Decimal('2'); } }; }",
        "import { make } from '../../mock/broker.js'; make().neutral();",
      ),
    ).toEqual([]);
  });

  it.each(['make().method()', 'make().method(undefined)', 'make().method(void 0)'])(
    'executes interface-hidden method defaults only when omitted: %s',
    (expression) => {
      const helper =
        "import { Decimal } from 'longbridge'; interface Port { method(value?: unknown): unknown; } export function make(): Port { return { method(value: unknown = new Decimal('1')) { return value; } }; }";
      expect(
        helperConsumers(helper, `import { make } from '../../mock/broker.js'; ${expression};`),
      ).toHaveLength(1);

      expect(
        helperConsumers(
          helper,
          "import { make } from '../../mock/broker.js'; make().method({ channels: [] });",
        ),
      ).toEqual([]);
    },
  );

  it('executes factory SDK defaults but not defaults replaced by explicit neutral arguments', () => {
    const helper =
      "import { Decimal } from 'longbridge'; interface Port { method(): unknown; } export function make(value: unknown = new Decimal('1')): Port { return { method() { return value; } }; }";
    expect(
      helperConsumers(helper, "import { make } from '../../mock/broker.js'; make().method();"),
    ).toHaveLength(2);

    expect(
      helperConsumers(
        helper,
        "import { make } from '../../mock/broker.js'; make({ channels: [] }).method();",
      ),
    ).toEqual([]);
  });

  it('stops at production execution bodies and returned methods, not just their defaults', () => {
    for (const expression of ['make()', 'make().method()']) {
      expect(
        helperConsumers(
          "import { owner } from '../src/owner.js'; export function make() { return owner(); }",
          `import { make } from '../../mock/broker.js'; ${expression};`,
          {
            'src/owner.ts':
              "import { Decimal } from 'longbridge'; export function owner() { const value = new Decimal('1'); return { method() { return new Decimal('2'); }, value }; }",
          },
        ),
      ).toEqual([]);
    }
  });

  it.each(['run', 'createOfflineRecovery', 'assemblePort'])(
    'stops at the actual production target, independent of helper name: %s',
    (name) => {
      expect(
        helperConsumers(
          `import { productionOwner as owner } from '../src/owner.js'; export function ${name}() { return owner(); }`,
          `import { ${name} } from '../../mock/broker.js'; ${name}();`,
          {
            'src/owner.ts':
              "import { Decimal } from 'longbridge'; export function productionOwner(value: unknown = new Decimal('1')) { return { method() { return new Decimal('2'); }, value }; }",
          },
        ),
      ).toEqual([]);

      expect(
        helperConsumers(
          `import { productionOwner as owner } from './owner.js'; export function ${name}() { return owner(); }`,
          `import { ${name} } from '../../mock/broker.js'; ${name}();`,
          {
            'mock/owner.ts':
              "import { Decimal } from 'longbridge'; export function productionOwner(value: unknown = new Decimal('1')) { return { value }; }",
          },
        ),
      ).toHaveLength(1);
    },
  );

  it('still audits SDK construction in helper arguments passed to a production owner', () => {
    expect(
      helperConsumers(
        "import { Decimal } from 'longbridge'; import { owner } from '../src/owner.js'; export function make() { return owner(new Decimal('1')); }",
        "import { make } from '../../mock/broker.js'; make();",
        { 'src/owner.ts': 'export function owner(value: unknown) { return value; }' },
      ),
    ).toHaveLength(1);
  });

  it('distinguishes a type-only broker port double from constructing native SDK DTO', () => {
    const helper =
      "import type { TradeContext } from 'longbridge'; type ReadPort = Pick<TradeContext, 'accountBalance'>; export function broker(): ReadPort { return { accountBalance: async () => [] }; }";
    expect(
      helperConsumers(
        helper,
        "import { broker } from '../../mock/broker.js'; const value = broker(); value.accountBalance();",
      ),
    ).toEqual([]);
  });

  it.each(['wrap()', 'wrap(undefined)', 'wrap(void 0)'])(
    'rejects an executed SDK default initializer: %s',
    (expression) => {
      expect(
        helperConsumers(defaults, `import { wrap } from '../../mock/broker.js'; ${expression};`),
      ).toHaveLength(1);
    },
  );

  it('does not execute the default constructor when an explicit neutral object is supplied', () => {
    expect(
      helperConsumers(
        defaults,
        "import { wrap as alias } from '../../mock/broker.js'; alias({ channels: [] });",
      ),
    ).toEqual([]);
  });

  it('does not follow an uncalled local function declaration', () => {
    expect(
      helperConsumers(
        "import { Decimal } from 'longbridge'; export function factory() { function unused() { return new Decimal('1'); } return { quantity: 1 }; }",
        "import { factory } from '../../mock/broker.js'; factory();",
      ),
    ).toEqual([]);
  });

  it('rejects immediate invocation, SDK static factories and executed enum DTO mapping', () => {
    for (const body of [
      "return (() => new Decimal('1'))();",
      'return Decimal.ZERO();',
      'return { status: OrderStatus.New };',
    ]) {
      expect(
        helperConsumers(
          `import { Decimal, OrderStatus } from 'longbridge'; export function make() { ${body} }`,
          "import { make } from '../../mock/broker.js'; make();",
        ),
      ).toHaveLength(1);
    }
  });
});
