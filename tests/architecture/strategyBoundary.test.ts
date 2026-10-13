/**
 * 策略隔离架构测试。
 * 校验私有目录单向隔离、唯一选中入口加载链路及旧宿主指标/验证 owner 的彻底移除。
 */
import path from 'node:path';
import { readdir, readFile, access } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

/** 枚举生产 TS 文件，不读取认证配置或启动真实入口。 */
async function listSources(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listSources(child)));
    else if (entry.isFile() && child.endsWith('.ts')) files.push(child);
  }

  return files;
}

/** AST 遍历同时覆盖 import/export、动态 import 与 require，避免仅检查文本漏掉边界。 */
function moduleReferences(file: string, source: string): ReadonlyArray<string> {
  const references: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      references.push(node.moduleSpecifier.text);
    }

    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push(node.argument.literal.text);
    }

    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) references.push(argument.text);
    }

    ts.forEachChild(node, visit);
  }
  visit(ast);
  return references
    .filter((reference) => reference.startsWith('.'))
    .map((reference) =>
      path.posix
        .normalize(path.posix.join(path.posix.dirname(file), reference))
        .replace(/\.js$/, '.ts'),
    );
}

function privateStrategyOwner(file: string): string | null {
  for (const prefix of [
    'src/domain/strategy/',
    'src/runtime/strategy/',
    'src/config/strategy/',
    'src/app/startup/strategyDefinitions/',
  ]) {
    if (!file.startsWith(prefix)) continue;

    const tail = file.slice(prefix.length);
    return tail.includes('/') ? (tail.split('/')[0] ?? null) : null;
  }

  return null;
}

describe('single active strategy architecture', () => {
  it('identifies same-strategy ownership across four roots without granting host access', () => {
    for (const prefix of [
      'src/domain/strategy/',
      'src/runtime/strategy/',
      'src/config/strategy/',
      'src/app/startup/strategyDefinitions/',
    ]) {
      expect(privateStrategyOwner(prefix + 'intradayRegression/index.ts')).toBe(
        'intradayRegression',
      );
      expect(privateStrategyOwner(prefix + 'otherStrategy/index.ts')).toBe('otherStrategy');
      expect(privateStrategyOwner(prefix + 'utils.ts')).toBeNull();
    }

    expect(privateStrategyOwner('src/app/runApp.ts')).toBeNull();
    expect(privateStrategyOwner('src/types/strategy.ts')).toBeNull();
  });

  it('isolates every private strategy from host, public modules and other strategies', async () => {
    const violations: string[] = [];
    for (const file of await listSources('src')) {
      for (const target of moduleReferences(file, await readFile(file, 'utf8'))) {
        const targetOwner = privateStrategyOwner(target);
        if (targetOwner !== null && targetOwner !== privateStrategyOwner(file))
          violations.push(file + ' -> ' + target);
      }
    }

    expect(violations).toEqual([]);
  });

  it('removes the old physical directory and source import edges', async () => {
    const oldRoots = [
      ['src', 'services', 'indicators'].join('/'),
      ['src', 'core', 'strategy'].join('/'),
    ] as const;
    expect(
      await access(oldRoots[0]).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    // P3 删除旧实现与引用；未入版本的空目录由 P6 物理清理，不代表仍有旧业务 owner。
    if (
      await access(oldRoots[1]).then(
        () => true,
        () => false,
      )
    )
      expect(await listSources(oldRoots[1])).toEqual([]);

    const violations: string[] = [];
    for (const root of ['src', 'tools', 'tests', 'mock']) {
      for (const file of await listSources(root)) {
        for (const target of moduleReferences(file, await readFile(file, 'utf8'))) {
          if (oldRoots.some((oldRoot) => target === oldRoot || target.startsWith(oldRoot + '/')))
            violations.push(file + ' -> ' + target);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('does not mistake comments and ordinary strings for module edges', () => {
    const target = ['..', 'src', 'services', 'indicators', 'runtime', 'ema.js'].join('/');
    expect(
      moduleReferences(
        'tools/probe.ts',
        '// import "' + target + '";\nconst note = "' + target + '";',
      ),
    ).toEqual([]);

    for (const source of [
      'import type { Probe } from "' + target + '";',
      'type Probe = import("' + target + '").Probe;',
      'export { probe } from "' + target + '";',
      'const probe = import("' + target + '");',
      'const probe = require("' + target + '");',
    ])
      expect(moduleReferences('tools/probe.ts', source)).toEqual([
        path.posix.normalize(path.posix.join('tools', target)).replace(/\.js$/, '.ts'),
      ]);
  });

  it('keeps actual analysis consumers on direct private mathematical leaves and types', async () => {
    const indicators = 'src/domain/strategy/intradayRegression/indicators/';
    for (const [file, expected] of [
      [
        'tools/dailyIndicatorAnalysis/indicatorCalculators.ts',
        ['ema', 'kdj', 'mfi', 'rsi', 'indicatorMath', 'types'],
      ],
      ['tools/dailyIndicatorAnalysis/types.ts', ['types']],
    ] as const) {
      const targets = moduleReferences(file, await readFile(file, 'utf8'));
      expect(
        targets
          .filter((target) => privateStrategyOwner(target) !== null)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(
        expected
          .map((name) => indicators + name + '.ts')
          .sort((left, right) => left.localeCompare(right)),
      );
    }
  });

  it('keeps leaf evaluation declaration-only across runtime imports without executing SDK', async () => {
    const indicators = 'src/domain/strategy/intradayRegression/indicators/';
    const leaves = ['ema', 'kdj', 'mfi', 'rsi', 'indicatorMath'].map(
      (name) => indicators + name + '.ts',
    );
    const pending = [...leaves];
    const visited = new Set<string>();
    const violations: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;

      visited.add(file);
      const ast = ts.createSourceFile(
        file,
        await readFile(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of ast.statements) {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;

          const bindings = clause?.namedBindings;
          if (
            clause?.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly)
          )
            continue;

          const targets = moduleReferences(file, statement.getText(ast));
          if (clause === undefined || targets.length !== 1 || !targets[0]?.startsWith('src/')) {
            violations.push(file + ': non-leaf runtime import');
          } else pending.push(...targets);
        } else if (
          !ts.isFunctionDeclaration(statement) &&
          !ts.isTypeAliasDeclaration(statement) &&
          !ts.isInterfaceDeclaration(statement)
        ) {
          violations.push(file + ': module evaluation ' + ts.SyntaxKind[statement.kind]);
        }
      }
    }

    expect(violations).toEqual([]);
    expect([...visited].sort((left, right) => left.localeCompare(right))).toEqual(
      [...leaves, 'src/utils/helpers/index.ts'].sort((left, right) => left.localeCompare(right)),
    );
  });

  it('keeps selected definition loading behind prepareStrategy only', async () => {
    const loadingSites: string[] = [];
    const dynamicImports: string[] = [];
    const helperConsumers: string[] = [];
    for (const file of await listSources('src')) {
      const source = await readFile(file, 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          dynamicImports.push(file);

        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'importModule'
        )
          loadingSites.push(file);

        ts.forEachChild(node, visit);
      }
      visit(ast);
      if (moduleReferences(file, source).includes('src/app/startup/strategyLoaderHelpers.ts'))
        helperConsumers.push(file);
    }

    expect(loadingSites).toEqual(['src/app/startup/strategyLoaderHelpers.ts']);
    expect(dynamicImports).toEqual(['src/app/runAppDeps.ts']);
    expect(helperConsumers).toEqual(['src/app/startup/prepareStrategy.ts']);
    const loader = await readFile('src/app/startup/prepareStrategy.ts', 'utf8');
    expect(loader).toContain('strategyIdToDirectoryName');
    expect(loader).toContain('inspectStrategyLocation');
    expect(loader).toContain('prepareStrategyDefinition');

    const ast = ts.createSourceFile('prepareStrategy.ts', loader, ts.ScriptTarget.Latest, true);
    const owner = ast.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'prepareStrategy',
    );
    if (owner === undefined || !ts.isFunctionDeclaration(owner) || owner.body === undefined)
      throw new Error('Missing actual selected-strategy preparation owner');

    const preparedLocation = owner.body.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find(
        (declaration) =>
          declaration.initializer !== undefined &&
          ts.isAwaitExpression(declaration.initializer) &&
          ts.isCallExpression(declaration.initializer.expression) &&
          declaration.initializer.expression.expression.getText(ast) === 'inspectStrategyLocation',
      );
    if (preparedLocation === undefined || !ts.isIdentifier(preparedLocation.name))
      throw new Error('Selected loader must consume its validated local location');

    const definitionImports: ts.CallExpression[] = [];
    function collect(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'importStrategyDefinition')
        definitionImports.push(node);

      ts.forEachChild(node, collect);
    }
    collect(owner.body);
    expect(definitionImports).toHaveLength(1);
    expect(definitionImports[0]?.arguments[0]?.getText(ast)).toBe(preparedLocation.name.text);
    expect(definitionImports[0]?.arguments[1]?.getText(ast)).toBe(
      owner.parameters[1]?.name.getText(ast),
    );
  });

  it('removes old owners, registries and opaque conversion chains rather than retaining adapters', async () => {
    for (const file of [
      'src/core/strategy/index.ts',
      'src/core/strategy/registry.ts',
      'src/core/strategy/generatedRegistry.ts',
      'src/main/asyncProgram/indicatorCache',
      'src/main/asyncProgram/delayedSignalVerifier',
      'src/app/wiring/registerDelayedSignalHandlers.ts',
      'src/types/indicatorRuntime.ts',
      'src/types/indicatorProfile.ts',
    ]) {
      expect(
        await access(file).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }

    const violations: string[] = [];
    for (const file of await listSources('src')) {
      const source = await readFile(file, 'utf8');
      const forbidden =
        privateStrategyOwner(file) === null
          ? new Set([
              'IndicatorIncrementalRuntime',
              'TradingSignalStrategyFactory',
              'createMultiIndicatorTradingStrategy',
              'delayedSignalVerifier',
              'indicatorProfile',
            ])
          : new Set([
              'IndicatorIncrementalRuntime',
              'unwrapIndicatorRuntime',
              'toOpaqueIndicatorRuntime',
            ]);
      function visit(node: ts.Node): void {
        if (ts.isIdentifier(node) && forbidden.has(node.text))
          violations.push(file + ': ' + node.text);

        ts.forEachChild(node, visit);
      }
      visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
    }

    expect(violations).toEqual([]);
  });
});
