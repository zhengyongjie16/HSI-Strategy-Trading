/**
 * 类型组织架构测试
 *
 * 覆盖：
 * - types.ts 只能承载类型声明
 * - utils.ts 不声明本地类型
 * - 生产代码不暴露 test-only hook
 * - strategy 契约类型整合到 core/strategy/types.ts
 * - 内部实现符号不穿透公共 surface
 */
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

const projectRoot = process.cwd();

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(projectRoot, relativePath), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectTypeScriptFiles(relativeDir: string): Promise<ReadonlyArray<string>> {
  const absoluteDir = path.join(projectRoot, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const childRelativePath = path.join(relativeDir, entry.name).replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(childRelativePath)));
      continue;
    }

    if (entry.isFile() && childRelativePath.endsWith('.ts')) {
      files.push(childRelativePath);
    }
  }

  return files;
}

function parseSourceFile(relativePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function formatNodeLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${location.line + 1}:${location.character + 1}`;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function collectNamedExports(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const exportedNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      hasExportModifier(statement) &&
      statement.name !== undefined
    ) {
      exportedNames.add(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exportedNames.add(declaration.name.text);
        }
      }

      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportedNames.add(element.name.text);
      }
    }
  }

  return exportedNames;
}

function expectNoNamedExport(relativePath: string, source: string, symbolName: string): void {
  const exportedNames = collectNamedExports(parseSourceFile(relativePath, source));
  expect([...exportedNames]).not.toContain(symbolName);
}

function isPureTypeModuleStatement(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) {
    return statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
  }

  return (
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  );
}

function collectNonTypeModuleStatements(
  relativePath: string,
  source: string,
): ReadonlyArray<string> {
  const sourceFile = parseSourceFile(relativePath, source);
  return sourceFile.statements
    .filter((statement) => !isPureTypeModuleStatement(statement))
    .map(
      (statement) =>
        `${formatNodeLocation(sourceFile, statement)} ${ts.SyntaxKind[statement.kind]}`,
    );
}

function collectLocalTypeDeclarations(relativePath: string, source: string): ReadonlyArray<string> {
  const sourceFile = parseSourceFile(relativePath, source);
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      violations.push(`${formatNodeLocation(sourceFile, node)} ${ts.SyntaxKind[node.kind]}`);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function collectProjectImports(relativePath: string, source: string): ReadonlyArray<string> {
  const sourceFile = parseSourceFile(relativePath, source);
  const imports: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) {
        continue;
      }

      imports.push(
        path.posix
          .normalize(path.posix.join(path.posix.dirname(relativePath), specifier))
          .replace(/\.js$/, '.ts'),
      );
    }
  }

  return imports;
}

function collectForbiddenIdentifierUsages(
  relativePath: string,
  source: string,
  forbiddenNames: ReadonlySet<string>,
): ReadonlyArray<string> {
  const sourceFile = parseSourceFile(relativePath, source);
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && forbiddenNames.has(node.text)) {
      violations.push(`${formatNodeLocation(sourceFile, node)} ${node.text}`);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function collectForbiddenLocalDeclarations(
  relativePath: string,
  source: string,
  forbiddenNames: ReadonlySet<string>,
): ReadonlyArray<string> {
  const sourceFile = parseSourceFile(relativePath, source);
  const violations: string[] = [];

  function checkName(node: ts.Node, name: string): void {
    if (forbiddenNames.has(name)) {
      violations.push(`${formatNodeLocation(sourceFile, node)} ${name}`);
    }
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      checkName(node, node.name.text);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      checkName(node, node.name.text);
    }

    if (ts.isExportSpecifier(node)) {
      checkName(node, node.name.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('type organization regressions', () => {
  it('keeps every types.ts file type-only', async () => {
    const typeFiles = [
      ...(await collectTypeScriptFiles('src')),
      ...(await collectTypeScriptFiles('tests')),
    ].filter((relativePath) => path.posix.basename(relativePath) === 'types.ts');
    const violations: string[] = [];

    for (const relativePath of typeFiles) {
      violations.push(
        ...collectNonTypeModuleStatements(relativePath, await readProjectFile(relativePath)),
      );
    }

    expect(violations).toEqual([]);
  });

  it('keeps every utils.ts file free of local type declarations', async () => {
    const utilsFiles = [
      ...(await collectTypeScriptFiles('src')),
      ...(await collectTypeScriptFiles('tests')),
    ].filter((relativePath) => path.posix.basename(relativePath) === 'utils.ts');
    const violations: string[] = [];

    for (const relativePath of utilsFiles) {
      violations.push(
        ...collectLocalTypeDeclarations(relativePath, await readProjectFile(relativePath)),
      );
    }

    expect(violations).toEqual([]);
  });

  it('keeps production modules free of test-only hooks', async () => {
    const productionFiles = await collectTypeScriptFiles('src');
    const forbiddenNames = new Set([
      '__test',
      'forTesting',
      'setHandleOrderChanged',
      'testHooks',
      'testOnly',
    ]);
    const violations: string[] = [];

    for (const relativePath of productionFiles) {
      violations.push(
        ...collectForbiddenIdentifierUsages(
          relativePath,
          await readProjectFile(relativePath),
          forbiddenNames,
        ),
      );
    }

    expect(violations).toEqual([]);
  });

  it('stores strategy contracts in core/strategy/types.ts and keeps factory naming neutral', async () => {
    const strategyTypesSource = await readProjectFile('src/core/strategy/types.ts');
    const strategySource = await readProjectFile('src/core/strategy/index.ts');
    const monitorContextSource = await readProjectFile('src/app/context/createMonitorContext.ts');
    const strategyTypesExports = collectNamedExports(
      parseSourceFile('src/core/strategy/types.ts', strategyTypesSource),
    );
    const strategyExports = collectNamedExports(
      parseSourceFile('src/core/strategy/index.ts', strategySource),
    );

    expect([...strategyTypesExports]).toContain('TradingSignalStrategy');
    expect([...strategyTypesExports]).toContain('TradingSignalStrategyFactory');
    expect([...strategyExports]).toContain('createMultiIndicatorTradingStrategy');
    expect(strategySource).not.toMatch(/HangSeng|hangseng/);
    expect(monitorContextSource).not.toMatch(/HangSeng|hangseng/);
  });

  it('keeps config module internal helpers non-exported', async () => {
    const tradingUtilsSource = await readProjectFile('src/config/trading/utils.ts');
    const validatorUtilsSource = await readProjectFile('src/config/validator/utils.ts');

    expectNoNamedExport(
      'src/config/trading/utils.ts',
      tradingUtilsSource,
      'parseFailFastMinimumNumberConfig',
    );

    expectNoNamedExport(
      'src/config/validator/utils.ts',
      validatorUtilsSource,
      'validateCriticalMinimumNumberConfig',
    );
  });

  it('keeps routingIndex internal state helpers non-exported', async () => {
    const relativePath = 'src/core/trader/orderMonitor/routingIndex.ts';
    const routingIndexSource = await readProjectFile(relativePath);

    expectNoNamedExport(relativePath, routingIndexSource, 'ensureRouteState');
  });

  it('keeps nested helper contracts private at public type boundaries', async () => {
    const publicBoundaryChecks: ReadonlyArray<{
      readonly relativePath: string;
      readonly privateSymbols: ReadonlyArray<string>;
    }> = [
      {
        relativePath: 'src/types/services.ts',
        privateSymbols: [
          'MarketWarrantListItem',
          'MarketWarrantListRequest',
          'MarketWarrantQuote',
          'OrderRecorderPendingSellAndSellable',
        ],
      },
      {
        relativePath: 'src/types/data.ts',
        privateSymbols: ['CandleValue'],
      },
      {
        relativePath: 'src/types/quote.ts',
        privateSymbols: ['QuoteStaticInfo'],
      },
      {
        relativePath: 'src/utils/quoteRetry/types.ts',
        privateSymbols: ['QuoteRetryRequirement'],
      },
      {
        relativePath: 'src/core/trader/types.ts',
        privateSymbols: ['IsExecutionAllowed'],
      },
      {
        relativePath: 'src/main/monitorQuoteEventRuntime/types.ts',
        privateSymbols: ['MonitorQuoteFreshnessStatus', 'SwitchWakeupFreshnessDeps'],
      },
      {
        relativePath: 'src/main/tradingRiskEventRuntime/types.ts',
        privateSymbols: ['TradingRiskConsistencyPort'],
      },
      {
        relativePath: 'src/main/lifecycle/cacheDomains/types.ts',
        privateSymbols: ['SignalRuntimePostTradeConsistencyRuntime'],
      },
      {
        relativePath: 'src/core/trader/orderMonitor/types.ts',
        privateSymbols: ['OrderMonitorTimerRegistration', 'PendingSellDisposition'],
      },
    ];

    for (const check of publicBoundaryChecks) {
      const source = await readProjectFile(check.relativePath);
      for (const privateSymbol of check.privateSymbols) {
        expectNoNamedExport(check.relativePath, source, privateSymbol);
      }
    }
  });

  it('keeps orderRecorder internal implementation files behind the public boundary', async () => {
    const productionFiles = await collectTypeScriptFiles('src');
    const privateOrderRecorderFiles = new Set([
      'src/core/orderRecorder/orderApiManager.ts',
      'src/core/orderRecorder/orderFilteringEngine.ts',
      'src/core/orderRecorder/orderOwnershipParser.ts',
      'src/core/orderRecorder/orderStorage.ts',
      'src/core/orderRecorder/utils.ts',
    ]);
    const violations: string[] = [];

    for (const relativePath of productionFiles) {
      if (relativePath.startsWith('src/core/orderRecorder/')) {
        continue;
      }

      for (const importedPath of collectProjectImports(
        relativePath,
        await readProjectFile(relativePath),
      )) {
        if (privateOrderRecorderFiles.has(importedPath)) {
          violations.push(`${relativePath} -> ${importedPath}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps orderRecorder factory deps out of shared public types', async () => {
    const sharedOrderRecorderTypesSource = await readProjectFile('src/types/orderRecorder.ts');
    const sharedOrderRecorderExports = collectNamedExports(
      parseSourceFile('src/types/orderRecorder.ts', sharedOrderRecorderTypesSource),
    );

    expect([...sharedOrderRecorderExports]).not.toContain('OrderRecorderFactoryDeps');
    expect(sharedOrderRecorderTypesSource).not.toContain('TradeContext');
    expect(sharedOrderRecorderTypesSource).not.toContain('RateLimiter');
  });

  it('keeps seat symbol helpers local, config-free, and typed through readonly contracts', async () => {
    const symbolsSource = await readProjectFile('src/utils/seat/symbols.ts');
    const seatTypesSource = await readProjectFile('src/types/seat.ts');
    const symbolHelperExports = collectNamedExports(
      parseSourceFile('src/utils/seat/symbols.ts', symbolsSource),
    );
    const symbolHelperImports = collectProjectImports('src/utils/seat/symbols.ts', symbolsSource);

    expect([...symbolHelperExports]).toContain('resolveBoundSeatSymbol');
    expect([...symbolHelperExports]).toContain('collectBoundSeatSymbols');
    expect(symbolHelperImports.some((importedPath) => importedPath.startsWith('src/config/'))).toBe(
      false,
    );

    expect(seatTypesSource).toMatch(
      /resolveSeatBySymbol:\s*\(symbol:\s*string\)\s*=>\s*Readonly<\{/,
    );
  });

  it('keeps seat symbol helpers out of recovery-only modules', async () => {
    expect(await exists('src/utils/seat/symbols.ts')).toBe(true);

    const appFiles = await collectTypeScriptFiles('src/app');
    const recoveryFiles = await collectTypeScriptFiles('src/main/recovery');
    const recoveryImportViolations: string[] = [];
    const recoveryHelperViolations: string[] = [];
    const forbiddenRecoveryHelperNames = new Set([
      'collectBoundSeatSymbols',
      'collectSeatSymbols',
      'resolveBoundSeatSymbol',
    ]);

    for (const relativePath of appFiles) {
      for (const importedPath of collectProjectImports(
        relativePath,
        await readProjectFile(relativePath),
      )) {
        if (importedPath.startsWith('src/main/recovery/')) {
          recoveryImportViolations.push(`${relativePath} -> ${importedPath}`);
        }
      }
    }

    for (const relativePath of recoveryFiles) {
      recoveryHelperViolations.push(
        ...collectForbiddenLocalDeclarations(
          relativePath,
          await readProjectFile(relativePath),
          forbiddenRecoveryHelperNames,
        ),
      );
    }

    expect(recoveryImportViolations).toEqual([]);
    expect(recoveryHelperViolations).toEqual([]);
  });

  it('removes catch-all utils and queue protocol from the shared public surface', async () => {
    expect(await exists('src/utils/utils.ts')).toBe(false);
    expect(await exists('src/types/queue.ts')).toBe(false);

    const productionFiles = await collectTypeScriptFiles('src');
    const forbiddenSharedFiles = new Set(['src/types/queue.ts', 'src/utils/utils.ts']);
    const importViolations: string[] = [];

    for (const relativePath of productionFiles) {
      for (const importedPath of collectProjectImports(
        relativePath,
        await readProjectFile(relativePath),
      )) {
        if (forbiddenSharedFiles.has(importedPath)) {
          importViolations.push(`${relativePath} -> ${importedPath}`);
        }
      }
    }

    const snapshotExports = collectNamedExports(
      parseSourceFile(
        'src/utils/seat/snapshots.ts',
        await readProjectFile('src/utils/seat/snapshots.ts'),
      ),
    );

    expect(importViolations).toEqual([]);
    expect([...snapshotExports]).toContain('resolveMonitorContextSeatSnapshot');
    expect([...snapshotExports]).toContain('resolveMonitorContextRuntimeSnapshot');
  });
});
