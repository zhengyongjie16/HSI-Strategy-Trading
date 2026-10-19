/**
 * P1 AST 保护网：解析模块、symbol alias、SDK 实际声明来源及 helper 构造链。
 * 仅读取 TypeScript 源码，不求值 SDK、不读取环境文件、不启动交易入口。
 */
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Occurrence, Scan, Stage } from './types.js';
import { constructsSdkAtCall } from './executionProbe.js';

export const STAGES: ReadonlyArray<Stage> = [
  'P0',
  'P1',
  'P2',
  'P3A',
  'P3B',
  'P3C',
  'P3D',
  'P3E',
  'P3F',
  'P4.1',
  'P4.2',
  'P4.3',
  'P4.4',
  'P4.5',
  'P5',
  'P6',
];

export function compact(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export function occurrenceKey(...parts: ReadonlyArray<unknown>): string {
  return JSON.stringify(parts);
}

export function listTypeScript(root: string): ReadonlyArray<string> {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScript(file);

    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [file] : [];
  });
}

/** 到期即拒绝；未知消费截止只允许 P0 原 occurrence，后续阶段须人工闭合。 */
export function excess(
  actual: ReadonlyArray<string>,
  frozen: ReadonlyArray<Occurrence>,
  stage: Stage,
): ReadonlyArray<string> {
  const allowance = new Map<string, number>();
  for (const row of frozen) {
    const expired =
      row.cutoff === 'UNRESOLVED'
        ? stage !== 'P0'
        : STAGES.indexOf(stage) >= STAGES.indexOf(row.cutoff as Stage) &&
          STAGES.includes(row.cutoff as Stage);
    if (!expired) allowance.set(row.key, (allowance.get(row.key) ?? 0) + 1);
  }

  return actual.filter((key) => {
    const count = allowance.get(key) ?? 0;
    if (count === 0) return true;

    allowance.set(key, count - 1);
    return false;
  });
}

/** 中性能力仍不能保活已到物理期限的旧调用方；期限来自原审计，不从能力截止反推。 */
export function expiredLegacyOwners(
  files: ReadonlyArray<string>,
  rows: ReadonlyArray<Occurrence>,
  stage: Stage,
): ReadonlyArray<string> {
  const present = new Set(files);
  const expired = new Set<string>();
  for (const row of rows) {
    const cutoff = row.sourcePhysicalStage ?? row.sourcePhysicalDeadline;
    if (
      present.has(row.file) &&
      /^src\/(core|main|services)\//.test(row.file) &&
      cutoff !== undefined &&
      STAGES.includes(cutoff as Stage) &&
      STAGES.indexOf(stage) >= STAGES.indexOf(cutoff as Stage)
    )
      expired.add(row.file);
  }

  if (stage === 'P6')
    for (const file of files) if (/^src\/(core|main|services)\//.test(file)) expired.add(file);

  return [...expired].sort((left, right) => left.localeCompare(right));
}

export function createAuditProgram(root: string, files: ReadonlyArray<string>): ts.Program {
  const config = ts.readConfigFile(path.join(process.cwd(), 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const options = {
    ...parsed.options,
    baseUrl: root,
    paths: {
      longbridge: [path.join(process.cwd(), 'node_modules/longbridge/index.d.ts')],
      '@/*': [path.join(root, 'src/*')],
    },
  };
  return ts.createProgram([...files], options);
}

function functionName(node: ts.Node): string {
  for (let parent = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent)
    ) {
      return (
        parent.name?.getText() ??
        (ts.isVariableDeclaration(parent.parent) ? parent.parent.name.getText() : '<closure>')
      );
    }
  }

  return '<module>';
}

function writeKind(node: ts.Node): string {
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'WRITE' : 'READ_WRITE';

  if (
    (ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return 'READ_WRITE';

  return 'READ';
}

function visit(node: ts.Node, action: (node: ts.Node) => void): void {
  action(node);
  ts.forEachChild(node, (child) => {
    visit(child, action);
  });
}

/**
 * 中性能力不继承调用方的物理迁移期限；只按已核对的真实目标与导出能力分类。
 * SDK/金融/层矩阵另行约束，numeric、IO 和旧 owner 内部类型不因纯函数或 type-only 获豁免。
 */
export function neutralLegacyCapability(key: string): boolean {
  const parts = JSON.parse(key) as readonly [
    string,
    string,
    string,
    { readonly imported: string; readonly typeOnly: boolean },
  ];
  const target = parts[2];
  const binding = parts[3];
  if (target === 'node_modules/longbridge/index.d.ts') return true;

  if (target.startsWith('src/types/') && binding.typeOnly) return true;

  const capabilities: Readonly<Record<string, ReadonlyArray<string>>> = {
    // 独立 exact 文本算术是目标中性工具；不豁免旧 numeric/index 的 SDK/number 能力。
    'src/utils/numeric/exact.ts': [
      'exactAdd',
      'exactSubtract',
      'exactMultiply',
      'exactCompare',
      'integerQuotient',
      'wholeLotQuantity',
      'compareRatios',
      'canonicalDecimal',
      'formatDecimal',
      'formatRatio',
      'safeQuantityNumber',
      'sumSafeQuantities',
    ],
    'src/utils/time/index.ts': [
      'toHongKongTimeIso',
      'toHongKongTimeLog',
      'getHKTime',
      'getHKDateKey',
      'getRequiredHKDateKey',
      'isInContinuousHKSession',
      'isWithinMorningOpenWindow',
      'isWithinAfternoonOpenProtection',
      'getTradingMinutesSinceOpen',
      'calculateTradingDurationMsBetween',
      'calculateTradingDurationDueAtMs',
      'resolveHKDayStartUtcMs',
    ],
    'src/utils/helpers/index.ts': ['isRecord', 'isValidPositiveNumber', 'isBuyAction'],
    'src/utils/display/index.ts': ['formatSymbolDisplay'],
    'src/utils/error/index.ts': ['formatError'],
    'src/utils/seat/guards.ts': ['isSeatActive', 'isSeatVersionMatch', 'hasSeatSymbol'],
    'src/constants/index.ts': ['TIME', 'API', 'LOG_COLORS', 'SIGNAL_ACTION_DESCRIPTIONS'],
    'src/utils/apiFailure/types.ts': ['ExternalApiRetryConfig'],
    'src/utils/helpers/types.ts': ['DecimalLike'],
    'src/utils/logger/types.ts': ['Logger'],
    'src/utils/timer/types.ts': ['BoundedOneShotTimerController'],
    'src/utils/quoteRetry/types.ts': ['QuoteReadinessStatus'],
  };
  return capabilities[target]?.includes(binding.imported) ?? false;
}

/** 固定模块的 query 仅隔离测试缓存，插值不能参与路径；所有边界仍按固定路径检查。 */
function fixedQueryModule(argument: ts.Node | undefined): string | undefined {
  if (argument === undefined) return undefined;

  if (ts.isStringLiteral(argument)) return argument.text.split('?')[0];

  if (!ts.isTemplateExpression(argument)) return undefined;

  const fixed = argument.head.text;
  return /^(?:\.\.?\/)+[^?#]+\.[cm]?[jt]s\?[^?#]+$/.test(fixed) ? fixed.split('?')[0] : undefined;
}

/** 唯一受 realpath/布局/入口白名单运行时校验的离线 fixture importer；不豁免文件中的其他 import。 */
function guardedFixtureImport(file: string, node: ts.Node): boolean {
  if (
    file !== 'tests/helpers/importFixtureModule.ts' ||
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    functionName(node) !== 'importFixtureModule' ||
    !ts.isReturnStatement(node.parent) ||
    compact(node.getText()) !== 'import(pathToFileURL(file).href)'
  )
    return false;

  const body = node.parent.parent;
  if (!ts.isBlock(body)) return false;

  const guards = new Set(
    body.statements
      .filter(ts.isIfStatement)
      .filter(
        (statement) =>
          ts.isBlock(statement.thenStatement) &&
          statement.thenStatement.statements.some(ts.isThrowStatement),
      )
      .map((statement) => compact(statement.expression.getText())),
  );
  const declarations = new Set(
    body.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) =>
        [...statement.declarationList.declarations].map((declaration) =>
          compact(declaration.getText()),
        ),
      ),
  );
  const entries = body.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'entries',
    )?.initializer;
  const entryArray =
    entries !== undefined && ts.isNewExpression(entries) && entries.expression.getText() === 'Set'
      ? entries.arguments?.[0]
      : undefined;
  const reviewedEntries = new Set([
    'app/startup/prepareStrategy',
    'app/startup/createSelectedStrategy',
    'app/shutdown/createCleanup',
    'runtime/businessEventProgram/index',
    'runtime/asyncProgram/tradeTaskQueue/index',
    'runtime/lifecycle/terminationRuntime',
    'domain/seat/symbolRegistry',
  ]);
  return (
    entryArray !== undefined &&
    ts.isArrayLiteralExpression(entryArray) &&
    entryArray.elements.length === reviewedEntries.size &&
    entryArray.elements.every(
      (entry) => ts.isStringLiteral(entry) && reviewedEntries.has(entry.text),
    ) &&
    new Set(entryArray.elements.filter(ts.isStringLiteral).map((entry) => entry.text)).size ===
      reviewedEntries.size &&
    declarations.has(
      String.raw`definition = /^strategies\/[a-z][a-zA-Z0-9]*\/definition$/.test(entry)`,
    ) &&
    declarations.has("layout = relative.startsWith('dist/src/') ? 'dist/src/' : 'src/'") &&
    declarations.has("extension = layout === 'src/' ? '.ts' : '.js'") &&
    guards.has("url.protocol !== 'file:' || url.search !== '' || url.hash !== ''") &&
    guards.has(
      '!relative.startsWith(layout) || !relative.endsWith(extension) || (!entries.has(entry) && !definition)',
    ) &&
    declarations.has(
      '[directory, file] = await Promise.all([realpath(root), realpath(fileURLToPath(url))])',
    )
  );
}

/** 新策略默认纯；仅三个精确相对路径承担装配或受控运行职责。 */
function strategyRole(file: string): 'pure' | 'definition' | 'runtime' | undefined {
  const match = /^src\/strategies\/[^/]+\/(.+)$/.exec(file);
  const role = match?.[1];
  if (role === undefined) return undefined;

  if (role === 'definition.ts') return 'definition';

  return role === 'index.ts' || role === 'verification/pendingVerification.ts' ? 'runtime' : 'pure';
}

/** domain 与全部策略禁止直接文件/网络/环境模块；os 与 fs/net 同属环境边界，共享同一清单。 */
function forbiddenDomainIo(file: string, specifier: string): boolean {
  return (
    (file.startsWith('src/domain/') || strategyRole(file) !== undefined) &&
    [
      'fs',
      'http',
      'https',
      'http2',
      'net',
      'tls',
      'dgram',
      'dns',
      'os',
      'timers',
      'child_process',
      'worker_threads',
      'cluster',
      'readline',
      'process',
      'console',
    ].includes(specifier.replace(/^node:/, '').split('/')[0] ?? '')
  );
}

/**
 * 有限能力成员身份：仅标准库/平台声明中的真实环境与高精度时钟成员。
 * 以 owner 接口、成员名与声明来源三重身份识别，不按 env/now 等拼写全局禁用。
 */
const AMBIENT_CAPABILITY_MEMBERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  Process: ['env', 'hrtime', 'uptime'],
  DateConstructor: ['now'],
  Performance: ['now'],
};

/** 生产目标矩阵从 P0 生效；测试装配真实 owner，不继承目录同名的生产依赖限制。 */
function forbiddenLayer(file: string, target: string): boolean {
  if (!file.startsWith('src/')) return false;

  const from = file.split('/')[1];
  const to = target.split('/')[1];
  if (!target.startsWith('src/')) return false;

  const targetOwner = /^src\/strategies\/([^/]+)\//.exec(target)?.[1];
  const owner = /^src\/strategies\/([^/]+)\//.exec(file)?.[1];
  if (targetOwner !== undefined && targetOwner !== owner) return true;

  if (
    strategyRole(file) === 'pure' &&
    ['definition', 'runtime'].includes(strategyRole(target) ?? '')
  )
    return true;

  if (owner !== undefined)
    return ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'].includes(
      to ?? '',
    );

  if (from === 'application')
    return ['app', 'runtime', 'infrastructure', 'core', 'main', 'services'].includes(to ?? '');

  if (from === 'runtime')
    return ['app', 'infrastructure', 'core', 'main', 'services'].includes(to ?? '');

  if (from === 'domain')
    return ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'].includes(
      to ?? '',
    );

  if (from === 'infrastructure')
    return ['app', 'application', 'runtime', 'core', 'main', 'services', 'domain'].includes(
      to ?? '',
    );

  if (['types', 'constants', 'config', 'utils'].includes(from ?? ''))
    return ['app', 'application', 'runtime', 'infrastructure'].includes(to ?? '');

  return false;
}

export function sdkAdapter(file: string): boolean {
  return (
    /^src\/infrastructure\/longbridge\/(trade|market)\//.test(file) ||
    /^tests\/infrastructure\/longbridge\/(trade|market)\//.test(file)
  );
}

/** 同时检查源码与编译布局；动态入口不能任意注入外部路径、private leaf 或其他策略。 */
export function selectedStrategyPath(
  root: string,
  selected: string,
  candidate: string,
  compiled: boolean,
): boolean {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(selected)) return false;

  const directory = compiled ? 'dist/src/strategies' : 'src/strategies';
  return (
    path.resolve(candidate) ===
    path.resolve(root, directory, selected, `definition.${compiled ? 'js' : 'ts'}`)
  );
}

/** 只准入真实 prepareStrategy 注入与 loader 的具名 location/文件端口连接，不批准任意动态加载。 */
function selectedStrategyLoaderCall(
  root: string,
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const file = path.relative(root, node.getSourceFile().fileName).replaceAll('\\', '/');
  const argument = node.arguments[0];
  if (node.arguments.length !== 1 || argument === undefined) return false;

  const declared = (reference: ts.Node, source: string, name: string): boolean => {
    const symbol = checker.getSymbolAtLocation(reference);
    const actual =
      symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return (
      actual?.name === name &&
      (actual.declarations?.some(
        (declaration) =>
          path.relative(root, declaration.getSourceFile().fileName).replaceAll('\\', '/') ===
          source,
      ) ??
        false)
    );
  };

  if (file === 'src/app/runAppDeps.ts' && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const callback = node.parent;
    if (
      !ts.isArrowFunction(callback) ||
      callback.body !== node ||
      callback.parameters.length !== 1 ||
      !ts.isIdentifier(argument)
    )
      return false;

    const property = callback.parent;
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isIdentifier(property.name) ||
      property.name.text !== 'importModule' ||
      property.initializer !== callback
    )
      return false;

    const object = property.parent;
    if (!ts.isObjectLiteralExpression(object)) return false;

    const call = object.parent;
    if (
      !ts.isCallExpression(call) ||
      call.arguments.length !== 2 ||
      call.arguments[1] !== object ||
      !declared(call.expression, 'src/app/startup/prepareStrategy.ts', 'prepareStrategy')
    )
      return false;

    const parameter = callback.parameters[0];
    return (
      parameter !== undefined &&
      ts.isIdentifier(parameter.name) &&
      checker.getSymbolAtLocation(argument) === checker.getSymbolAtLocation(parameter.name)
    );
  }

  if (
    file !== 'src/app/startup/strategyLoaderHelpers.ts' ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== 'importModule' ||
    !ts.isIdentifier(node.expression.expression) ||
    !ts.isPropertyAccessExpression(argument) ||
    argument.name.text !== 'href' ||
    !ts.isCallExpression(argument.expression)
  )
    return false;

  const urlCall = argument.expression;
  const location = urlCall.arguments[0];
  if (
    urlCall.arguments.length !== 1 ||
    location === undefined ||
    !ts.isPropertyAccessExpression(location) ||
    location.name.text !== 'definitionPath' ||
    !ts.isIdentifier(location.expression)
  )
    return false;

  const urlSymbol = checker.getSymbolAtLocation(urlCall.expression);
  const urlFunction =
    urlSymbol !== undefined && (urlSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(urlSymbol)
      : urlSymbol;
  if (
    urlFunction?.name !== 'pathToFileURL' ||
    !urlFunction.declarations?.some((declaration) =>
      declaration.getSourceFile().fileName.replaceAll('\\', '/').endsWith('/@types/node/url.d.ts'),
    )
  )
    return false;

  let owner: ts.Node = node.parent;
  while (!ts.isSourceFile(owner) && !ts.isFunctionLike(owner)) owner = owner.parent;

  if (
    !ts.isFunctionDeclaration(owner) ||
    owner.name?.text !== 'importStrategyDefinition' ||
    owner.parameters.length !== 2
  )
    return false;

  const [locationParameter, fileSystemParameter] = owner.parameters;
  if (locationParameter === undefined || fileSystemParameter === undefined) return false;

  const contract = (parameter: ts.ParameterDeclaration, name: string): boolean =>
    parameter.type !== undefined &&
    ts.isTypeReferenceNode(parameter.type) &&
    declared(parameter.type.typeName, 'src/app/startup/types.ts', name);
  return (
    ts.isIdentifier(locationParameter.name) &&
    ts.isIdentifier(fileSystemParameter.name) &&
    contract(locationParameter, 'StrategyLocation') &&
    contract(fileSystemParameter, 'StrategyFileSystem') &&
    checker.getSymbolAtLocation(location.expression) ===
      checker.getSymbolAtLocation(locationParameter.name) &&
    checker.getSymbolAtLocation(node.expression.expression) ===
      checker.getSymbolAtLocation(fileSystemParameter.name)
  );
}

export function scanProgram(root: string, program: ts.Program, files: ReadonlyArray<string>): Scan {
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((file) => path.resolve(file).toLowerCase()));
  const relative = (file: string) => path.relative(root, file).replaceAll('\\', '/');
  const moduleTarget = (file: string, specifier: string, resolved: string | undefined): string => {
    if (resolved !== undefined) return relative(resolved);

    if (specifier.startsWith('.'))
      return path.posix
        .normalize(path.posix.join(path.posix.dirname(file), specifier))
        .replace(/\.js$/, '.ts');

    return specifier.startsWith('@/')
      ? 'src/' + specifier.slice(2).replace(/\.js$/, '.ts')
      : specifier;
  };
  const imports: string[] = [],
    uses: string[] = [],
    origins: string[] = [],
    tradeContexts: string[] = [],
    legacy: string[] = [],
    snapshot: string[] = [],
    snapshotExposures: string[] = [],
    helperCalls: string[] = [],
    violations: string[] = [];
  const neutralFixtureCalls: string[] = [];
  const actualSymbols = new WeakMap<ts.Node, ts.Symbol | undefined>();
  const actualSymbol = (node: ts.Node): ts.Symbol | undefined => {
    if (actualSymbols.has(node)) return actualSymbols.get(node);

    const symbol =
      ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    const actual =
      symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    actualSymbols.set(node, actual);
    return actual;
  };

  const sourceReferences = new WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Identifier[]>>();

  /** 全文件只索引一次引用；global owner 与普通引用共享真实 symbol 索引。 */
  function symbolReferences(
    symbol: ts.Symbol,
    source: ts.SourceFile,
  ): ReadonlyArray<ts.Identifier> {
    let index = sourceReferences.get(source);
    if (index === undefined) {
      index = new Map();
      sourceReferences.set(source, index);
      const collected = index;
      visit(source, (use) => {
        if (!ts.isIdentifier(use)) return;

        const target = actualSymbol(use);
        if (target === undefined) return;

        const foundReferences = collected.get(target) ?? [];
        foundReferences.push(use);
        collected.set(target, foundReferences);
      });
    }

    return index.get(symbol) ?? [];
  }

  function references(node: ts.Node, source = node.getSourceFile()): ReadonlyArray<ts.Identifier> {
    const symbol = actualSymbol(node);
    return symbol === undefined ? [] : symbolReferences(symbol, source);
  }

  function typeUsage(node: ts.Node): boolean {
    if (ts.isSourceFile(node)) return false;

    for (
      let parent = node.parent;
      !ts.isSourceFile(parent) && !ts.isStatement(parent);
      parent = parent.parent
    )
      if (ts.isTypeNode(parent)) return true;

    return false;
  }

  /** 只识别实际 ambient 网络/调度能力；同名纯参数/成员不会因拼写被禁。 */
  function ambientDomainIo(node: ts.Node): boolean {
    if (!(
      ts.isIdentifier(node) &&
      /^(?:fetch|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|queueMicrotask)$/.test(
        node.text,
      )
    ))
      return false;

    return (
      actualSymbol(node)?.declarations?.some((declaration) => {
        if (!declaration.getSourceFile().isDeclarationFile) return false;

        const source = declaration.getSourceFile().fileName.replaceAll('\\', '/');
        return (
          /\/node_modules\/(?:bun-types|@types\/node)\//.test(source) ||
          /\/typescript\/lib\/lib\.(?:dom|webworker)\.d\.ts$/.test(source)
        );
      }) ?? false
    );
  }

  /** 只匹配真实公共注入契约的调用签名；不因局部函数或成员同名而拒绝。 */
  function injectedStrategyCall(node: ts.CallExpression): boolean {
    const declaration = checker.getResolvedSignature(node)?.declaration;
    if (declaration === undefined) return false;

    const file = relative(declaration.getSourceFile().fileName);
    const contracts: Readonly<Record<string, ReadonlyArray<string>>> = {
      'src/types/runtime.ts': ['RuntimeClock', 'RuntimeScheduler'],
      'src/types/strategy.ts': ['StrategyEmitter'],
      'src/types/logger.ts': ['Logger'],
    };
    for (let parent: ts.Node = declaration; !ts.isSourceFile(parent); parent = parent.parent) {
      if (
        (ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) &&
        (contracts[file]?.includes(parent.name.text) ||
          (file === 'src/types/strategy.ts' &&
            parent.name.text === 'StrategyDeps' &&
            ts.isTypeAliasDeclaration(parent) &&
            ts.isTypeLiteralNode(parent.type) &&
            ts.isPropertySignature(declaration.parent) &&
            declaration.parent.parent === parent.type &&
            ts.isIdentifier(declaration.parent.name) &&
            declaration.parent.name.text === 'onFatalError'))
      )
        return true;
    }

    return false;
  }

  /** 属性符号身份必须同时命中 owner 接口、成员名与标准库/平台声明来源。 */
  function ambientCapabilityProperty(type: ts.Type, member: string | undefined): boolean {
    if (member === undefined) return false;

    return (
      checker.getPropertyOfType(type, member)?.declarations?.some((declaration) => {
        if (!declaration.getSourceFile().isDeclarationFile) return false;

        const source = declaration.getSourceFile().fileName.replaceAll('\\', '/');
        if (!/\/node_modules\/(?:@types\/node|bun-types|typescript\/lib)\//.test(source))
          return false;

        const owner = declaration.parent;
        const ownerName =
          ts.isInterfaceDeclaration(owner) ||
          ts.isClassDeclaration(owner) ||
          ts.isTypeAliasDeclaration(owner)
            ? owner.name?.text
            : undefined;
        return (
          ownerName !== undefined &&
          AMBIENT_CAPABILITY_MEMBERS[ownerName]?.includes(member) === true
        );
      }) ?? false
    );
  }

  /** 零参数 Date 构造身份来自标准库；别名 `const Clock = Date` 共享同一 DateConstructor 身份。 */
  function ambientDateConstructor(node: ts.Expression): boolean {
    const symbol = checker.getTypeAtLocation(node).getSymbol();
    return (
      symbol?.name === 'DateConstructor' &&
      (symbol.declarations?.some(
        (declaration) =>
          declaration.getSourceFile().isDeclarationFile &&
          declaration.getSourceFile().fileName.replaceAll('\\', '/').includes('/typescript/lib/'),
      ) ??
        false)
    );
  }

  /** 解构键同样支持计算属性名中的字符串字面量，避免与 ESLint 规则出现覆盖差异。 */
  function bindingMember(node: ts.BindingElement): string | undefined {
    const key = node.propertyName ?? node.name;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;

    if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression))
      return key.expression.text;

    return undefined;
  }

  /** 变量初始化与直接参数默认值的对象解构携带能力身份；不追踪嵌套数据流。 */
  function ambientDestructuredBinding(node: ts.BindingElement): boolean {
    if (!ts.isObjectBindingPattern(node.parent)) return false;

    const declaration = node.parent.parent;
    if (
      !(ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) ||
      declaration.initializer === undefined
    )
      return false;

    return ambientCapabilityProperty(
      checker.getTypeAtLocation(declaration.initializer),
      bindingMember(node),
    );
  }

  /**
   * ambient 符号身份来自标准库；显式 Date 输入、类型引用和同名局部纯值保持合法。
   * process 根标识符同时覆盖 cwd/argv/stdout/exit、赋值与默认解构；
   * `globalThis.process` 等普通根访问的属性名解析到同一 ambient 声明，无需数据流引擎。
   */
  function ambientStrategyIo(node: ts.Node): boolean {
    if (ambientDomainIo(node)) return true;

    if (
      ts.isIdentifier(node) &&
      /^(?:process|console|Bun|Deno|WebSocket|XMLHttpRequest|performance)$/.test(node.text)
    )
      return (
        actualSymbol(node)?.declarations?.some((declaration) => {
          if (!declaration.getSourceFile().isDeclarationFile) return false;

          const source = declaration.getSourceFile().fileName.replaceAll('\\', '/');
          return source.includes('/node_modules/') || source.includes('/typescript/lib/');
        }) ?? false
      );

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const argument = ts.isElementAccessExpression(node) ? node.argumentExpression : node.name;
      const member =
        ts.isIdentifier(argument) || ts.isStringLiteralLike(argument) ? argument.text : undefined;
      return ambientCapabilityProperty(checker.getTypeAtLocation(node.expression), member);
    }

    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      (node.arguments?.length ?? 0) === 0
    )
      return ambientDateConstructor(node.expression);

    if (ts.isBindingElement(node)) return ambientDestructuredBinding(node);

    return false;
  }

  const sdkSymbol = (node: ts.Node) =>
    actualSymbol(node)?.declarations?.some((declaration) =>
      /\/node_modules\/(?:longbridge|\.bun\/longbridge)/.test(
        declaration.getSourceFile().fileName.replaceAll('\\', '/'),
      ),
    ) ?? false;
  const containsSdkType = (type: ts.Type, location: ts.Node, seen: Set<ts.Type>): boolean => {
    if (seen.has(type)) return false;

    seen.add(type);
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint !== undefined && containsSdkType(constraint, location, seen)) return true;
    }

    if (
      type
        .getSymbol()
        ?.declarations?.some((declaration) =>
          /\/node_modules\/(?:longbridge|\.bun\/longbridge)/.test(
            declaration.getSourceFile().fileName.replaceAll('\\', '/'),
          ),
        ) === true
    )
      return true;

    if (
      type.isUnionOrIntersection() &&
      type.types.some((part) => containsSdkType(part, location, seen))
    )
      return true;

    if (
      (type.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.ESSymbolLike |
          ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.Never)) !==
      0
    )
      return false;

    if (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
      checker
        .getTypeArguments(type as ts.TypeReference)
        .some((argument) => containsSdkType(argument, location, seen))
    )
      return true;

    const ownedDeclaration = (declaration: ts.Declaration) =>
      !declaration.getSourceFile().fileName.replaceAll('\\', '/').includes('/node_modules/');
    if (
      type
        .getProperties()
        .filter((property) => property.declarations?.some(ownedDeclaration) === true)
        .some((property) =>
          containsSdkType(checker.getTypeOfSymbolAtLocation(property, location), location, seen),
        )
    )
      return true;

    if (
      checker.getIndexInfosOfType(type).some((index) => containsSdkType(index.type, location, seen))
    )
      return true;

    return [...type.getCallSignatures(), ...type.getConstructSignatures()]
      .filter(
        (signature) =>
          signature.declaration !== undefined && ownedDeclaration(signature.declaration),
      )
      .some(
        (signature) =>
          containsSdkType(signature.getReturnType(), location, seen) ||
          signature.parameters.some((parameter) =>
            containsSdkType(checker.getTypeOfSymbolAtLocation(parameter, location), location, seen),
          ),
      );
  };

  /** 仅单次 mutation 失败结果的原始证据可为 unknown；不能借 cause 字段输出任意能力。 */
  function mutationFailureEvidence(type: ts.Type, location: ts.Node): boolean {
    if (type.isUnion()) return false;

    const properties = type.getProperties();
    const propertyType = (name: string): ts.Type | undefined => {
      const property = type.getProperty(name);
      return property === undefined || (property.flags & ts.SymbolFlags.Optional) !== 0
        ? undefined
        : checker.getTypeOfSymbolAtLocation(property, location);
    };
    const literals = (value: ts.Type | undefined, allowed: ReadonlyArray<string>): boolean =>
      value !== undefined &&
      (value.isUnion() ? value.types : [value]).every(
        (part) => part.isStringLiteral() && allowed.includes(part.value),
      );
    const operation = propertyType('operation');
    if (!operation?.isStringLiteral()) return false;

    const kinds: Readonly<Record<string, ReadonlyArray<string>>> = {
      'TradeContext.submitOrder': ['REJECTED', 'UNKNOWN'],
      'TradeContext.replaceOrder': [
        'REJECTED',
        'ORDER_ALREADY_CLOSED',
        'RETRYABLE_EXTERNAL_ERROR',
        'UNKNOWN',
      ],
      'TradeContext.cancelOrder': [
        'STATE_CONFIRMATION_REQUIRED',
        'RETRYABLE_EXTERNAL_ERROR',
        'UNKNOWN',
      ],
    };
    const allowedKinds = kinds[operation.value];
    const kind = propertyType('kind');
    const attempted = propertyType('requestAttempted');
    const code = propertyType('code');
    const cause = propertyType('cause');
    if (
      allowedKinds === undefined ||
      !literals(kind, allowedKinds) ||
      attempted === undefined ||
      (attempted.flags & ts.TypeFlags.BooleanLiteral) === 0 ||
      checker.typeToString(attempted) !== 'true' ||
      code === undefined ||
      !(code.isUnion() ? code.types : [code]).every(
        (part) => (part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null)) !== 0,
      ) ||
      cause?.flags !== ts.TypeFlags.Unknown ||
      type.getCallSignatures().length > 0 ||
      type.getConstructSignatures().length > 0 ||
      checker.getIndexInfosOfType(type).length > 0
    )
      return false;

    const rejectedReplace =
      operation.value === 'TradeContext.replaceOrder' &&
      kind?.isStringLiteral() === true &&
      kind.value === 'REJECTED';
    const fields = ['operation', 'requestAttempted', 'kind', 'code', 'cause'];
    if (rejectedReplace) fields.push('reason');

    return (
      properties.length === fields.length &&
      properties.every((property) => fields.includes(property.name)) &&
      (!rejectedReplace ||
        literals(propertyType('reason'), ['UNSUPPORTED_BY_TYPE', 'TEMP_BLOCKED_BY_STATUS']))
    );
  }

  /** 边界类型只回答 SDK 是否泄漏；不证明金融计算、不可变性或场景真实性。 */
  function neutralType(
    type: ts.Type,
    location: ts.Node,
    seen = new Set<ts.Type>(),
    input = false,
    evidenceAllowed = true,
  ): boolean {
    if (seen.has(type)) return true;

    seen.add(type);
    if ((type.flags & ts.TypeFlags.Any) !== 0) return false;

    if ((type.flags & ts.TypeFlags.Unknown) !== 0) return input;

    if (containsSdkType(type, location, new Set())) return false;

    // 先核整个交叉分支，不能把独立 { cause: unknown } 片段也当作错误协议。
    if (mutationFailureEvidence(type, location)) return evidenceAllowed;

    if (type.isUnionOrIntersection())
      return type.types.every((part) => neutralType(part, location, seen, input, evidenceAllowed));

    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return true;

    if ((type.flags & ts.TypeFlags.Object) === 0) return true;

    if (
      (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
      !checker
        .getTypeArguments(type as ts.TypeReference)
        .every((part) => neutralType(part, location, seen, input, evidenceAllowed))
    )
      return false;

    const local = (declaration: ts.Declaration) => !declaration.getSourceFile().isDeclarationFile;
    return (
      type
        .getProperties()
        .filter((property) => property.declarations?.some(local))
        .every((property) =>
          neutralType(
            checker.getTypeOfSymbolAtLocation(property, location),
            location,
            seen,
            input,
            evidenceAllowed,
          ),
        ) &&
      [...type.getCallSignatures(), ...type.getConstructSignatures()]
        .filter((signature) => signature.declaration !== undefined && local(signature.declaration))
        .every(
          (signature) =>
            neutralType(signature.getReturnType(), location, seen, false, evidenceAllowed) &&
            signature.parameters.every((parameter) =>
              neutralType(
                checker.getTypeOfSymbolAtLocation(parameter, location),
                location,
                new Set(seen),
                true,
                evidenceAllowed,
              ),
            ),
        ) &&
      checker
        .getIndexInfosOfType(type)
        .every((index) => neutralType(index.type, location, seen, input, evidenceAllowed))
    );
  }

  function implementation(
    node: ts.Node,
    seen = new Set<ts.Node>(),
  ): ts.FunctionLikeDeclaration | undefined {
    if (seen.has(node)) return undefined;

    seen.add(node);
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node)
    )
      return node;

    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return implementation(node.expression, seen);

    const declaration = actualSymbol(node)?.valueDeclaration;
    if (declaration === undefined) return undefined;

    if (
      (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
      declaration.initializer !== undefined
    )
      return implementation(declaration.initializer, seen);

    return declaration === node ? undefined : implementation(declaration, seen);
  }

  /** 普通对象字面量的静态成员来源；与属性访问、对象解构共用，不执行 getter。 */
  function localMember(object: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
    const property = object.properties.find(
      (member) =>
        member.name !== undefined &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === name,
    );
    if (property === undefined) return undefined;

    if (ts.isPropertyAssignment(property)) return property.initializer;

    if (ts.isShorthandPropertyAssignment(property)) return property.name;

    return property;
  }

  /** 仅还原出口的局部别名、静态对象属性与本次直接调用的参数，不求值函数体。 */
  function localValue(
    node: ts.Node,
    inputs: ReadonlyMap<ts.Symbol, ts.Expression>,
    seen = new Set<ts.Node>(),
  ): ts.Node | undefined {
    if (seen.has(node)) return undefined;

    seen.add(node);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return localValue(node.expression, inputs, seen);

    if (ts.isIdentifier(node)) {
      const symbol = actualSymbol(node);
      const supplied = symbol === undefined ? undefined : inputs.get(symbol);
      if (supplied !== undefined) return localValue(supplied, inputs, seen);

      const declaration = symbol?.valueDeclaration;
      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      )
        return localValue(declaration.initializer, inputs, seen);

      if (
        declaration !== undefined &&
        ts.isBindingElement(declaration) &&
        ts.isObjectBindingPattern(declaration.parent)
      ) {
        const owner = declaration.parent.parent;
        if (ts.isParameter(owner)) return owner;

        if (ts.isVariableDeclaration(owner) && owner.initializer !== undefined) {
          const object = localValue(owner.initializer, inputs, seen);
          const key = declaration.propertyName ?? declaration.name;
          if (object !== undefined && ts.isObjectLiteralExpression(object)) {
            if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return undefined;

            const member = localMember(object, key.text);
            return member === undefined ? undefined : localValue(member, inputs, seen);
          }

          return declaration;
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = localValue(node.expression, inputs, seen);
      let name: string | undefined;
      if (ts.isPropertyAccessExpression(node)) name = node.name.text;
      else if (ts.isStringLiteral(node.argumentExpression)) name = node.argumentExpression.text;

      if (receiver !== undefined && ts.isObjectLiteralExpression(receiver)) {
        if (name === undefined) return undefined;

        const member = localMember(receiver, name);
        return member === undefined ? undefined : localValue(member, inputs, seen);
      }
    }

    return node;
  }

  /** 公开 callback 的局部别名/静态参数属性仍归原参数，不因 unknown 签名抹掉 SDK 传播。 */
  function publicCallback(node: ts.Expression, fn: ts.FunctionLikeDeclaration): boolean {
    const original = actualSymbol(node)?.declarations ?? [];
    if (
      original.length > 0 &&
      original.every((declaration) =>
        declaration.getSourceFile().fileName.replaceAll('\\', '/').includes('/node_modules/'),
      )
    )
      return false;

    const value = localValue(node, new Map());
    if (value === undefined) return false;

    if (ts.isParameter(value)) return value.parent === fn;

    if (ts.isBindingElement(value) && ts.isObjectBindingPattern(value.parent)) {
      const owner = value.parent.parent;
      if (ts.isVariableDeclaration(owner) && owner.initializer !== undefined)
        return publicCallback(owner.initializer, fn);
    }

    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      // Array.map 等标准库方法不是调用方注入的 callback 属性。
      const declarations = actualSymbol(value)?.declarations ?? [];
      if (
        declarations.length > 0 &&
        declarations.every((declaration) =>
          declaration.getSourceFile().fileName.replaceAll('\\', '/').includes('/node_modules/'),
        )
      )
        return false;

      return publicCallback(value.expression, fn);
    }

    return (
      actualSymbol(value)?.declarations?.some(
        (declaration) => ts.isParameter(declaration) && declaration.parent === fn,
      ) ?? false
    );
  }

  const reassignedBindings = new WeakMap<ts.SourceFile, ReadonlySet<ts.Symbol>>();

  /** 证据来源只信任未重赋值的绑定；按 symbol 扫描整个声明文件，不推演分支或调用时序。 */
  function stableEvidenceBinding(symbol: ts.Symbol | undefined): boolean {
    const declaration = symbol?.valueDeclaration;
    if (symbol === undefined || declaration === undefined) return false;

    const source = declaration.getSourceFile();
    let assigned = reassignedBindings.get(source);
    if (assigned === undefined) {
      const writes = new Set<ts.Symbol>();
      const target = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const binding = actualSymbol(node);
          if (binding !== undefined) writes.add(binding);
        } else if (
          ts.isParenthesizedExpression(node) ||
          ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isNonNullExpression(node) ||
          ts.isSpreadElement(node) ||
          ts.isSpreadAssignment(node)
        )
          target(node.expression);
        else if (ts.isArrayLiteralExpression(node)) {
          for (const element of node.elements) target(element);
        } else if (ts.isObjectLiteralExpression(node)) {
          for (const property of node.properties) target(property);
        } else if (ts.isPropertyAssignment(node)) target(node.initializer);
        else if (ts.isShorthandPropertyAssignment(node)) target(node.name);
        else if (ts.isBinaryExpression(node)) target(node.left);
      };
      visit(source, (node) => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          target(node.left);
        else if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken)
        )
          target(node.operand);
        else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) target(node.initializer);
      });
      assigned = writes;
      reassignedBindings.set(source, assigned);
    }

    return !assigned.has(symbol);
  }

  /** 检查实际出口，展开直接局部别名/对象/返回函数，防注解或 cast 隐藏额外 raw 字段。
   * 不解释控制流、循环、内建函数或 mapper 的业务算法。
   */
  function neutralReturn(
    expression: ts.Expression,
    seen: Set<ts.Node>,
    inputs: ReadonlyMap<ts.Symbol, ts.Expression> = new Map(),
    mutationCause = false,
    mutationFragment = false,
  ): boolean {
    if (seen.has(expression)) return true;

    const next = new Set(seen).add(expression);
    if (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isAwaitExpression(expression)
    )
      return neutralReturn(expression.expression, next, inputs, mutationCause, mutationFragment);

    const expressionType = checker.getTypeAtLocation(expression);
    if (
      ts.isIdentifier(expression) &&
      (mutationCause ||
        mutationFragment ||
        !neutralType(expressionType, expression, new Set(), false, false)) &&
      !stableEvidenceBinding(actualSymbol(expression))
    )
      return false;

    if (
      mutationCause &&
      expressionType.flags === ts.TypeFlags.Unknown &&
      ts.isIdentifier(expression)
    ) {
      const symbol = actualSymbol(expression);
      const declaration = symbol?.valueDeclaration;
      const supplied = symbol === undefined ? undefined : inputs.get(symbol);
      if (
        declaration !== undefined &&
        ts.isParameter(declaration) &&
        declaration.initializer !== undefined &&
        !neutralReturn(declaration.initializer, next, inputs, true)
      )
        return false;

      if (supplied !== undefined) return neutralReturn(supplied, next, inputs, true);

      if (declaration !== undefined && ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer !== undefined)
          return neutralReturn(declaration.initializer, next, inputs, true);

        return ts.isCatchClause(declaration.parent);
      }

      return declaration !== undefined && ts.isParameter(declaration);
    }

    // 完整失败结构内的 spread 仍逐字段核验；片段离开该结构就没有 unknown 出口资格。
    const evidenceFields =
      mutationFragment &&
      expressionType.getCallSignatures().length === 0 &&
      expressionType.getConstructSignatures().length === 0 &&
      checker.getIndexInfosOfType(expressionType).length === 0 &&
      expressionType.getProperties().length > 0 &&
      expressionType.getProperties().every((property) => {
        const value = checker.getTypeOfSymbolAtLocation(property, expression);
        return property.name === 'cause'
          ? value.flags === ts.TypeFlags.Unknown
          : ['operation', 'requestAttempted', 'kind', 'code', 'reason'].includes(property.name) &&
              neutralType(value, expression);
      });
    if (!evidenceFields && !neutralType(expressionType, expression)) return false;

    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const value = localValue(expression, inputs);
      if (value === undefined) return false;

      if (ts.isMethodDeclaration(value) || ts.isGetAccessorDeclaration(value))
        return neutralFunction(value, false, next, inputs);

      if (value !== expression && ts.isExpression(value)) return neutralReturn(value, next, inputs);

      const method = implementation(expression);
      if (method?.body !== undefined) return neutralFunction(method, false, next, inputs);
    }

    if (ts.isIdentifier(expression)) {
      const symbol = actualSymbol(expression);
      const supplied = symbol === undefined ? undefined : inputs.get(symbol);
      const declaration = symbol?.valueDeclaration;
      if (supplied !== undefined) {
        const declared =
          declaration === undefined ? undefined : checker.getTypeAtLocation(declaration);
        if (
          declared === undefined ||
          (declared.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) === 0 ||
          checker.getTypeAtLocation(expression) === declared
        )
          return neutralReturn(supplied, next, inputs);
      }

      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      ) {
        const declared = checker.getTypeAtLocation(declaration.name);
        // checker 已收窄 unknown 局部值时使用出口类型；不解释其 guard，更不把 cast 当收窄。
        if (
          (declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 &&
          checker.getTypeAtLocation(expression) !== declared &&
          !ts.isAsExpression(declaration.initializer) &&
          !ts.isTypeAssertionExpression(declaration.initializer)
        )
          return true;

        return neutralReturn(declaration.initializer, next, inputs, false, evidenceFields);
      }

      if (
        declaration !== undefined &&
        ts.isParameter(declaration) &&
        declaration.initializer !== undefined &&
        !neutralReturn(declaration.initializer, next, inputs)
      )
        return false;

      const fn = implementation(expression);
      if (fn !== undefined) return neutralFunction(fn, false, next, inputs);
    }

    if (ts.isConditionalExpression(expression))
      return (
        neutralReturn(expression.whenTrue, next, inputs) &&
        neutralReturn(expression.whenFalse, next, inputs)
      );

    if (ts.isArrayLiteralExpression(expression))
      return expression.elements.every((element) =>
        neutralReturn(ts.isSpreadElement(element) ? element.expression : element, next, inputs),
      );

    if (ts.isObjectLiteralExpression(expression))
      return expression.properties.every((property) => {
        const evidence =
          (evidenceFields || mutationFailureEvidence(expressionType, expression)) &&
          property.name !== undefined &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          property.name.text === 'cause';
        if (ts.isPropertyAssignment(property))
          return neutralReturn(property.initializer, next, inputs, evidence);

        if (ts.isShorthandPropertyAssignment(property))
          return neutralReturn(property.name, next, inputs, evidence);

        if (ts.isSpreadAssignment(property))
          return neutralReturn(
            property.expression,
            next,
            inputs,
            false,
            evidenceFields || mutationFailureEvidence(expressionType, expression),
          );

        return (
          (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) &&
          neutralFunction(property, false, next, inputs)
        );
      });

    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
      return neutralFunction(expression, false, seen, inputs);

    if (ts.isNewExpression(expression))
      return (
        // 构造器的回调输入不是已证明的失败结果来源；不推演 executor 的控制流。
        neutralType(expressionType, expression, new Set(), false, false) &&
        (expression.arguments ?? []).every((argument) => neutralReturn(argument, next, inputs))
      );

    if (ts.isCallExpression(expression)) {
      for (const argument of expression.arguments) {
        if (checker.getTypeAtLocation(argument).getCallSignatures().length === 0) continue;

        const callback = implementation(argument);
        if (callback?.body !== undefined && !neutralFunction(callback, true, next, inputs))
          return false;
      }

      const signature = checker.getResolvedSignature(expression)?.declaration;
      // 依赖 cause 例外的外部调用须有可展开的中性证据来源，且所有实参均安全。
      // 不按 built-in 名称放行，也不猜测声明文件函数的实现或合并/转换语义。
      if (signature?.getSourceFile().isDeclarationFile) {
        if (neutralType(expressionType, expression, new Set(), false, false)) return true;

        return (
          expression.arguments.some((argument) => {
            const source = checker.getTypeAtLocation(argument);
            return (
              source.getCallSignatures().length === 0 &&
              source.getConstructSignatures().length === 0 &&
              !neutralType(source, argument, new Set(), false, false)
            );
          }) &&
          expression.arguments.every((argument) => neutralReturn(argument, next, inputs)) &&
          (!(
            ts.isPropertyAccessExpression(expression.expression) ||
            ts.isElementAccessExpression(expression.expression)
          ) ||
            neutralReturn(expression.expression.expression, next, inputs))
        );
      }

      const reference = localValue(expression.expression, inputs);
      if (reference === undefined) return false;

      const target = implementation(reference);
      // 只展开出口调用的实际返回结构；不递归执行其 body 中的普通语句或调用。
      if (target?.body !== undefined) {
        const supplied = new Map(inputs);
        for (const [index, parameter] of target.parameters.entries()) {
          const symbol = actualSymbol(parameter.name);
          const argument = expression.arguments[index] ?? parameter.initializer;
          if (symbol !== undefined && argument !== undefined) supplied.set(symbol, argument);
        }

        return neutralFunction(target, true, next, supplied);
      }
    }

    return true;
  }

  function neutralFunction(
    fn: ts.FunctionLikeDeclaration,
    mapperInput: boolean,
    seen = new Set<ts.Node>(),
    inputs: ReadonlyMap<ts.Symbol, ts.Expression> = new Map(),
  ): boolean {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (seen.has(fn)) {
      // 已检查的递归标量解析器没有对象/回调出口；不能把递归本身误当 SDK 能力。
      const result = signature?.getReturnType();
      return (
        result !== undefined &&
        (result.isUnion() ? result.types : [result]).every(
          (part) =>
            (part.flags &
              (ts.TypeFlags.StringLike |
                ts.TypeFlags.NumberLike |
                ts.TypeFlags.BooleanLike |
                ts.TypeFlags.Null |
                ts.TypeFlags.Undefined |
                ts.TypeFlags.Void |
                ts.TypeFlags.Never)) !==
            0,
        )
      );
    }

    const next = new Set(seen).add(fn);
    if (signature === undefined || !neutralType(signature.getReturnType(), fn)) return false;

    if (
      !mapperInput &&
      fn.parameters.some((parameter) => {
        const input = checker.getTypeAtLocation(parameter);
        return !neutralType(input, parameter, new Set(), true);
      })
    )
      return false;

    if (fn.body === undefined) return false;

    if (!ts.isBlock(fn.body)) return neutralReturn(fn.body, next, inputs);

    let valid = true;
    const inspect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;

      // unknown 是合法输入（例如 JSON/错误），但不能用它掩盖实际传给公开 callback 的 SDK 值。
      if (ts.isCallExpression(node) && publicCallback(node.expression, fn))
        for (const argument of node.arguments) {
          let value = argument;
          while (
            ts.isAsExpression(value) ||
            ts.isTypeAssertionExpression(value) ||
            ts.isParenthesizedExpression(value)
          )
            value = value.expression;

          const actual = localValue(value, inputs);
          if (
            actual === undefined ||
            containsSdkType(checker.getTypeAtLocation(actual), actual, new Set())
          )
            valid = false;
        }

      if (ts.isReturnStatement(node) && node.expression !== undefined)
        valid = neutralReturn(node.expression, next, inputs) && valid;

      ts.forEachChild(node, inspect);
    };
    inspect(fn.body);
    return valid;
  }

  function neutralBoundary(node: ts.Node): boolean {
    const target = implementation(node);
    return (
      neutralType(checker.getTypeAtLocation(node), node) &&
      target !== undefined &&
      neutralFunction(target, false)
    );
  }

  /** 数据能力与 owner 工厂分开：不含回调/方法的结构类型不负责执行业务协作。 */
  function dataContract(
    type: ts.Type,
    location: ts.Node,
    seen = new Set<ts.Type>(),
    input = false,
  ): boolean {
    if (seen.has(type)) return true;

    seen.add(type);
    if (!neutralType(type, location, new Set(), input)) return false;

    if (type.isUnionOrIntersection())
      return type.types.every((part) => dataContract(part, location, seen, input));

    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0)
      return false;

    if ((type.flags & ts.TypeFlags.Object) === 0) return true;

    if (
      (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
      !checker
        .getTypeArguments(type as ts.TypeReference)
        .every((part) => dataContract(part, location, seen, input))
    )
      return false;

    return type
      .getProperties()
      .filter((property) =>
        property.declarations?.some(
          (declaration) => !declaration.getSourceFile().isDeclarationFile,
        ),
      )
      .every((property) =>
        dataContract(checker.getTypeOfSymbolAtLocation(property, location), location, seen, input),
      );
  }

  /** 同 owner 的默认纯数据策略可作为 domain 数据规则参数，不能承接行为或 SDK 出口。 */
  function defaultDomainDataStrategy(
    parameter: ts.ParameterDeclaration,
    targetFile: string,
  ): boolean {
    const defaultRule =
      parameter.initializer === undefined ? undefined : implementation(parameter.initializer);
    if (
      !targetFile.startsWith('src/domain/') ||
      defaultRule === undefined ||
      relative(defaultRule.getSourceFile().fileName).split('/').slice(0, 3).join('/') !==
        targetFile.split('/').slice(0, 3).join('/')
    )
      return false;

    const type = checker.getTypeAtLocation(parameter);
    const callbacks = type.getCallSignatures();
    return (
      callbacks.length === 1 &&
      type.getConstructSignatures().length === 0 &&
      callbacks.every(
        (callback) =>
          dataContract(callback.getReturnType(), parameter) &&
          callback.parameters.every((argument) =>
            dataContract(checker.getTypeOfSymbolAtLocation(argument, parameter), parameter),
          ),
      ) &&
      neutralFunction(defaultRule, false)
    );
  }

  /** 新目标 mapper/port 资格来自实际声明和出口，不由导出名、函数体 hash 或任意旧 owner 获得。 */
  function neutralCapability(node: ts.Identifier, typeOnly: boolean, caller: string): boolean {
    const symbol = actualSymbol(node);
    if (symbol === undefined) return false;

    if (typeOnly) {
      const declaration = symbol.valueDeclaration;
      const sameOwner =
        declaration !== undefined &&
        caller.split('/').slice(0, 3).join('/') ===
          relative(declaration.getSourceFile().fileName).split('/').slice(0, 3).join('/');
      const type =
        declaration !== undefined && sameOwner
          ? checker.getTypeOfSymbolAtLocation(symbol, node)
          : checker.getDeclaredTypeOfSymbol(symbol);
      return (
        neutralType(type, node) &&
        (sameOwner ||
          (type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0))
      );
    }

    const value = symbol.valueDeclaration;
    if (
      value !== undefined &&
      ts.isVariableDeclaration(value) &&
      value.initializer !== undefined &&
      relative(value.getSourceFile().fileName).startsWith('src/constants/') &&
      checker.getTypeAtLocation(node).getCallSignatures().length === 0
    )
      return (
        neutralType(checker.getTypeAtLocation(node), node) &&
        neutralReturn(value.initializer, new Set())
      );

    const target = implementation(node);
    if (target === undefined) return false;

    const targetFile = relative(target.getSourceFile().fileName);
    if (/^src\/(application|runtime)\//.test(targetFile) && !forbiddenLayer(caller, targetFile))
      return neutralBoundary(node);

    if (!sdkAdapter(targetFile)) {
      const owner = (file: string) => file.split('/').slice(0, 3).join('/');
      const sameOwner =
        /^src\/(core|main|services)\//.test(caller) && owner(caller) === owner(targetFile);
      if (!sameOwner && !/^src\/(domain|utils|constants)\//.test(targetFile)) return false;

      const signature = checker.getSignatureFromDeclaration(target);
      if (signature === undefined || !dataContract(signature.getReturnType(), target)) return false;

      if (
        target.parameters.some(
          (parameter) =>
            !dataContract(checker.getTypeAtLocation(parameter), parameter, new Set(), true) &&
            !defaultDomainDataStrategy(parameter, targetFile),
        )
      )
        return false;

      return neutralFunction(target, false);
    }

    // Mapper 的 SDK DTO 入参留在 adapter；回调中出现 SDK 则是能力传播而非数据入口。
    for (const parameter of target.parameters) {
      const type = checker.getTypeAtLocation(parameter);
      if (
        type
          .getCallSignatures()
          .some(
            (signature) =>
              containsSdkType(signature.getReturnType(), parameter, new Set()) ||
              signature.parameters.some((part) =>
                containsSdkType(
                  checker.getTypeOfSymbolAtLocation(part, parameter),
                  parameter,
                  new Set(),
                ),
              ),
          )
      )
        return false;
    }

    return neutralFunction(target, true);
  }

  const sdkReachability = new WeakMap<ts.Node, boolean>();
  const syntaxDependencies = new WeakMap<ts.Node, ReadonlyArray<ts.Node>>();

  /**
   * 每个调用 ROOT 都检查 SDK 可达性；无 SDK 的闭合引用图只计算一次。
   * 这是执行探针的保守超图（含未调用闭包/type 引用），不是 pure/业务资格。
   * 有任何 SDK 可达来源仍交原探针按实参/真实执行裁决；循环中的部分 false 不入缓存。
   */
  function sdkReachable(rootNode: ts.Node): boolean {
    const pending: ts.Node[] = [rootNode];
    const inspected = new Set<ts.Node>();
    while (pending.length > 0) {
      const node = pending.pop()!;
      const cached = sdkReachability.get(node);
      if (cached === true) {
        sdkReachability.set(rootNode, true);
        return true;
      }

      if (cached === false || inspected.has(node)) continue;

      inspected.add(node);
      if (ts.isIdentifier(node) && sdkSymbol(node)) {
        sdkReachability.set(node, true);
        sdkReachability.set(rootNode, true);
        return true;
      }

      let dependencies = syntaxDependencies.get(node);
      if (dependencies === undefined) {
        const found: ts.Node[] = [];
        ts.forEachChild(node, (child) => {
          found.push(child);
        });

        if (ts.isIdentifier(node))
          for (const declaration of actualSymbol(node)?.declarations ?? []) {
            const source = declaration.getSourceFile();
            if (
              !source.isDeclarationFile &&
              !source.fileName.replaceAll('\\', '/').includes('/node_modules/')
            )
              found.push(declaration);
          }

        dependencies = found;
        syntaxDependencies.set(node, dependencies);
      }

      pending.push(...dependencies);
    }

    // 整个可达闭包都已检查；只有此处的 negative 才可供其他 ROOT 共享。
    for (const node of inspected) sdkReachability.set(node, false);

    return false;
  }

  for (const source of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(source.fileName).toLowerCase())) continue;

    const file = relative(source.fileName);
    visit(source, (node) => {
      if (file.startsWith('src/') && ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (
          declaration !== undefined &&
          (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) &&
          declaration.name.getText() === 'new' &&
          (ts.isClassDeclaration(declaration.parent) ||
            ts.isInterfaceDeclaration(declaration.parent)) &&
          declaration.parent.name?.text === 'TradeContext' &&
          /\/node_modules\/(?:longbridge|\.bun\/longbridge)/.test(
            declaration.getSourceFile().fileName.replaceAll('\\', '/'),
          )
        )
          tradeContexts.push(file);
      }

      if (
        /^src\/(application|domain|runtime|strategies)\//.test(file) &&
        (ts.isTypeReferenceNode(node) ||
          ts.isExpressionWithTypeArguments(node) ||
          ts.isTypeQueryNode(node)) &&
        containsSdkType(checker.getTypeAtLocation(node), node, new Set())
      )
        violations.push(occurrenceKey(file, 'SDK_EXPOSURE', compact(node.getText())));

      if (file.startsWith('src/') && ts.isIdentifier(node) && sdkSymbol(node) && !sdkAdapter(file))
        origins.push(occurrenceKey(file, node.getText(), node.text));

      if (
        (file.startsWith('src/domain/') && !typeUsage(node) && ambientDomainIo(node)) ||
        (strategyRole(file) !== undefined && !typeUsage(node) && ambientStrategyIo(node))
      )
        violations.push(occurrenceKey(file, 'DOMAIN_DIRECT_IO', compact(node.getText())));

      if (
        (strategyRole(file) === 'pure' || strategyRole(file) === 'definition') &&
        ts.isCallExpression(node) &&
        injectedStrategyCall(node)
      )
        violations.push(occurrenceKey(file, 'STRATEGY_PURE_CAPABILITY', compact(node.getText())));

      if (
        strategyRole(file) === 'definition' &&
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        functionName(node) === '<module>'
      ) {
        const declaration = ts.isCallExpression(node)
          ? checker.getResolvedSignature(node)?.declaration
          : undefined;
        const freeze =
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'freeze' &&
          declaration !== undefined &&
          declaration.getSourceFile().fileName.replaceAll('\\', '/').includes('/typescript/lib/') &&
          ts.isInterfaceDeclaration(declaration.parent) &&
          declaration.parent.name.text === 'ObjectConstructor';
        if (!freeze)
          violations.push(
            occurrenceKey(file, 'STRATEGY_DEFINITION_EVALUATION', compact(node.getText())),
          );
      }

      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const module = node.moduleReference.expression;
        if (ts.isStringLiteral(module)) {
          if (forbiddenDomainIo(file, module.text))
            violations.push(occurrenceKey(file, 'DOMAIN_DIRECT_IO', module.text));

          const resolved = ts.resolveModuleName(
            module.text,
            source.fileName,
            program.getCompilerOptions(),
            ts.sys,
          ).resolvedModule;
          const target = moduleTarget(file, module.text, resolved?.resolvedFileName);
          if (forbiddenLayer(file, target)) violations.push(occurrenceKey(file, 'LAYER', target));

          if (
            (module.text === 'longbridge' || target.includes('node_modules/longbridge/')) &&
            !sdkAdapter(file)
          )
            imports.push(
              occurrenceKey(
                file,
                'IMPORT_EQUALS',
                module.text,
                '*',
                node.name.text,
                node.isTypeOnly,
              ),
            );

          if (
            (file.startsWith('src/domain/') || strategyRole(file) !== undefined) &&
            !node.isTypeOnly &&
            resolved !== undefined &&
            /^src\/(?:utils|infrastructure)\/logger\//.test(relative(resolved.resolvedFileName))
          )
            violations.push(
              occurrenceKey(file, 'DOMAIN_DIRECT_IO', relative(resolved.resolvedFileName)),
            );
        }
      }

      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const module = node.moduleSpecifier;
        if (module === undefined || !ts.isStringLiteral(module)) return;

        if (forbiddenDomainIo(file, module.text))
          violations.push(occurrenceKey(file, 'DOMAIN_DIRECT_IO', module.text));

        const resolved = ts.resolveModuleName(
          module.text,
          source.fileName,
          program.getCompilerOptions(),
          ts.sys,
        ).resolvedModule;
        const target = moduleTarget(file, module.text, resolved?.resolvedFileName);
        const kind = ts.isImportDeclaration(node) ? 'IMPORT' : 'RE_EXPORT';
        const bindings: {
          imported: string;
          local: string | null;
          typeOnly: boolean;
          node: ts.Identifier | undefined;
        }[] = [];
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          if (clause?.name !== undefined)
            bindings.push({
              imported: 'default',
              local: clause.name.text,
              typeOnly: clause.phaseModifier === ts.SyntaxKind.TypeKeyword,
              node: clause.name,
            });

          if (clause?.namedBindings !== undefined) {
            if (ts.isNamespaceImport(clause.namedBindings))
              bindings.push({
                imported: '*',
                local: clause.namedBindings.name.text,
                typeOnly: clause.phaseModifier === ts.SyntaxKind.TypeKeyword,
                node: clause.namedBindings.name,
              });
            else
              for (const item of clause.namedBindings.elements)
                bindings.push({
                  imported: item.propertyName?.text ?? item.name.text,
                  local: item.name.text,
                  typeOnly: clause.phaseModifier === ts.SyntaxKind.TypeKeyword || item.isTypeOnly,
                  node: item.name,
                });
          }
        } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
          for (const item of node.exportClause.elements)
            bindings.push({
              imported: item.propertyName?.text ?? item.name.text,
              local: item.name.text,
              typeOnly: node.isTypeOnly || item.isTypeOnly,
              node: ts.isIdentifier(item.name) ? item.name : undefined,
            });
        }

        if (
          resolved !== undefined &&
          file.startsWith('src/') &&
          (/^src\/(core|main|services)\//.test(file) || /^src\/(core|main|services)\//.test(target))
        )
          for (const { imported, local, typeOnly, node: bindingNode } of bindings)
            if (
              bindingNode === undefined ||
              forbiddenLayer(file, target) ||
              !neutralCapability(bindingNode, typeOnly, file)
            )
              legacy.push(occurrenceKey(file, kind, target, { imported, local, typeOnly }));

        if (forbiddenLayer(file, target)) violations.push(occurrenceKey(file, 'LAYER', target));

        if (
          (file.startsWith('src/domain/') || strategyRole(file) !== undefined) &&
          /^src\/(?:utils|infrastructure)\/logger\//.test(target) &&
          (bindings.length === 0 || bindings.some((binding) => !binding.typeOnly))
        )
          violations.push(occurrenceKey(file, 'DOMAIN_DIRECT_IO', target));

        // 测试只消费 SDK-free 的公开能力；caller 路径不证明或否定场景真实性。
        if (file.startsWith('tests/') && !sdkAdapter(file) && sdkAdapter(target))
          for (const binding of bindings)
            if (
              !binding.typeOnly &&
              binding.node !== undefined &&
              sdkReachable(binding.node) &&
              !neutralBoundary(binding.node)
            )
              violations.push(
                occurrenceKey(file, 'SDK_FIXTURE_BOUNDARY', target, binding.imported),
              );

        if (
          (module.text === 'longbridge' || target.includes('node_modules/longbridge/')) &&
          !sdkAdapter(file)
        ) {
          for (const binding of bindings.length === 0
            ? [{ imported: '<side-effect>', local: null, typeOnly: false, node: undefined }]
            : bindings) {
            imports.push(
              occurrenceKey(
                file,
                kind,
                module.text,
                binding.imported,
                binding.local,
                binding.typeOnly,
              ),
            );

            if (binding.node === undefined) continue;

            const boundNode = binding.node;
            const symbol = checker.getSymbolAtLocation(boundNode);
            for (const use of references(boundNode)) {
              if (
                use.getStart(source) === boundNode.getStart(source) ||
                !ts.isIdentifier(use) ||
                use.text !== binding.local ||
                checker.getSymbolAtLocation(use) !== symbol
              )
                continue;

              uses.push(
                occurrenceKey(
                  file,
                  binding.imported,
                  binding.local,
                  typeUsage(use) ? 'TYPE' : 'VALUE',
                  functionName(use),
                  compact(use.parent.getText().slice(0, 400)),
                  compact(
                    source.text.split('\n')[
                      source.getLineAndCharacterOfPosition(use.getStart(source)).line
                    ] ?? '',
                  ),
                ),
              );
            }
          }
        }
      }

      if (
        ts.isImportTypeNode(node) ||
        (ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            node.expression.getText() === 'require' ||
            node.expression.getText().endsWith('.importModule')))
      ) {
        let argument: ts.Node | undefined;
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
          argument = node.argument.literal;
        else if (ts.isCallExpression(node)) argument = node.arguments[0];

        const fixedImport =
          (argument !== undefined && ts.isStringLiteralLike(argument)) || file.startsWith('tests/');
        const specifier = fixedImport ? fixedQueryModule(argument) : undefined;
        if (specifier !== undefined) {
          if (forbiddenDomainIo(file, specifier))
            violations.push(occurrenceKey(file, 'DOMAIN_DIRECT_IO', specifier));

          const target = ts.resolveModuleName(
            specifier,
            source.fileName,
            program.getCompilerOptions(),
            ts.sys,
          ).resolvedModule;
          if (
            !ts.isImportTypeNode(node) &&
            (file.startsWith('src/domain/') || strategyRole(file) !== undefined) &&
            target !== undefined &&
            /^src\/(?:utils|infrastructure)\/logger\//.test(relative(target.resolvedFileName))
          )
            violations.push(
              occurrenceKey(file, 'DOMAIN_DIRECT_IO', relative(target.resolvedFileName)),
            );

          if (
            (specifier === 'longbridge' ||
              target?.resolvedFileName
                .replaceAll('\\', '/')
                .includes('/node_modules/longbridge/')) &&
            !sdkAdapter(file)
          )
            imports.push(
              occurrenceKey(
                file,
                ts.isImportTypeNode(node) ? 'IMPORT_TYPE' : 'DYNAMIC_IMPORT_OR_REQUIRE',
                'longbridge',
                ts.isImportTypeNode(node) ? (node.qualifier?.getText() ?? '*') : '*',
                null,
                false,
              ),
            );

          const edge = moduleTarget(file, specifier, target?.resolvedFileName);
          if (forbiddenLayer(file, edge) || /^src\/(core|main|services)\//.test(edge))
            violations.push(occurrenceKey(file, 'DYNAMIC_EDGE', edge, compact(node.getText())));
        } else if (
          !guardedFixtureImport(file, node) &&
          (!ts.isCallExpression(node) || !selectedStrategyLoaderCall(root, node, checker))
        )
          violations.push(
            occurrenceKey(file, 'NONLITERAL', functionName(node), compact(node.getText())),
          );
      }

      if (ts.isIdentifier(node) && /^(?:LastState|Trader|MonitorContext)$/.test(node.text))
        violations.push(occurrenceKey(file, 'WIDE_CONTRACT', node.text));

      if (
        file.startsWith('src/') &&
        !file.startsWith('src/app/') &&
        ts.isIdentifier(node) &&
        /^(?:MonitorContextAssembly|TradeRuntime)$/.test(node.text)
      )
        violations.push(occurrenceKey(file, 'ASSEMBLY_LOCATOR', node.text));

      if (
        file.startsWith('src/') &&
        (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
        /^(?:LastState|PositionCache|cachedAccount|cachedPositions|positionCache)$/.test(
          node.text,
        ) &&
        // P1 只收 snapshot 镜像；已无镜像的 LastState 生命周期契约留到 P6 收窄。
        (node.text !== 'LastState' ||
          ['cachedAccount', 'cachedPositions', 'positionCache'].some(
            (name) => checker.getTypeAtLocation(node).getProperty(name) !== undefined,
          ))
      )
        snapshotExposures.push(
          occurrenceKey(
            file,
            node.text,
            ts.SyntaxKind[node.parent.kind],
            compact(node.parent.getText().slice(0, 650)),
          ),
        );

      if (
        file.startsWith('src/') &&
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        /^(?:cachedAccount|cachedPositions|positionCache)$/.test(node.argumentExpression.text)
      )
        snapshot.push(
          occurrenceKey(file, writeKind(node), functionName(node), compact(node.getText())),
        );

      if (
        file.startsWith('src/') &&
        ts.isCallExpression(node) &&
        checker
          .getSymbolAtLocation(node.expression)
          ?.declarations?.some(
            (declaration) =>
              relative(declaration.getSourceFile().fileName) === 'src/types/services.ts' &&
              ts.isPropertySignature(declaration) &&
              declaration.name.getText() === 'update' &&
              ts.isInterfaceDeclaration(declaration.parent) &&
              declaration.parent.name.text === 'PositionCache',
          ) === true &&
        !/positionCache\.(?:update|get|clear|filter)/.test(node.expression.getText())
      )
        snapshot.push(
          occurrenceKey(file, 'CAPABILITY_CALL', functionName(node), compact(node.getText())),
        );

      if (
        file.startsWith('src/') &&
        ((ts.isPropertyAccessExpression(node) &&
          /cachedAccount|cachedPositions|positionCache/.test(node.name.text)) ||
          (ts.isCallExpression(node) &&
            /positionCache\.(?:update|get|clear|filter)/.test(node.expression.getText())))
      )
        snapshot.push(
          occurrenceKey(
            file,
            ts.isCallExpression(node) ? 'CAPABILITY_CALL' : writeKind(node),
            functionName(node),
            compact(node.getText().slice(0, 500)),
          ),
        );

      if (
        file.startsWith('tests/') &&
        !sdkAdapter(file) &&
        ts.isCallExpression(node) &&
        sdkReachable(node) &&
        constructsSdkAtCall(node, checker)
      ) {
        const key = occurrenceKey(file, functionName(node), compact(node.getText()));
        helperCalls.push(key);
        if (!constructsSdkAtCall(node, checker, true, (target) => neutralFunction(target, false)))
          neutralFixtureCalls.push(key);
      }
    });
  }

  return {
    imports,
    uses,
    origins,
    tradeContexts,
    legacy,
    snapshot,
    snapshotExposures,
    helperCalls,
    neutralFixtureCalls,
    violations,
  };
}

/** 中性 fixture 边界不抹掉构造记录；冻结仍按调用多重集合消费。 */
export function unclosedHelperCalls(scan: Scan): ReadonlyArray<string> {
  const neutral = new Map<string, number>();
  for (const key of scan.neutralFixtureCalls) neutral.set(key, (neutral.get(key) ?? 0) + 1);

  return scan.helperCalls.filter((key) => {
    const count = neutral.get(key) ?? 0;
    if (count === 0) return true;

    neutral.set(key, count - 1);
    return false;
  });
}

/** 读取审计文件仅供导航/测试，不依赖仓库外路径执行。 */
export function sourceText(file: string): string {
  return readFileSync(file, 'utf8');
}
