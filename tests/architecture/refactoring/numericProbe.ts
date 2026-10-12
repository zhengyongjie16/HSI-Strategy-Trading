/**
 * P0 字段 occurrence 保护：通过审计契约身份与 TS 类型定位直接金融输入/输出。
 * 不按全局字段名或转换函数冻结指标/结构数值；不宣称证明任意跨函数数据流。
 */
import ts from 'typescript';
import { baseline } from './baseline.js';
import { compact, occurrenceKey, STAGES } from './scanner.js';
import type { Stage } from './types.js';

function parentName(node: ts.Node): string {
  for (let parent = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent)
    )
      return parent.name?.getText() ?? '<local>';
  }

  return '<local>';
}

/** 保留原审计分类；仅补登记已有精确 producer/marketMonitor consumer 的真实字段角色。 */
const reviewedFinancialRoles = new Set(['src/types/quote.ts:Quote:prevClose']);

// 混合 closure 的换标预算只在 P3D 闭合，不提前借用 P1 的完整契约组。
const fieldClosures: Readonly<Record<string, Stage>> = {
  'src/services/autoSymbolManager/types.ts:SwitchState:sellNotional': 'P3D',
};

// Account/position 的原始 semanticClass 与实际 producer/consumer 角色一致。
// 该族 classification 的审计纠正由 baseline owner 独立应用，不扩大 occurrence。
const financialFields = baseline.fields.filter(
  (field) =>
    field.classification === 'FINANCIAL_EXACT' ||
    reviewedFinancialRoles.has(`${field.file}:${field.parent}:${field.name}`) ||
    ('family' in field &&
      field.family === 'F01_ACCOUNT_POSITION' &&
      'semanticClass' in field &&
      field.semanticClass === 'FINANCIAL_EXACT' &&
      /\bnumber\b/.test(field.type)),
);
const contractIdentities = new Set(
  financialFields
    .filter(
      (field) =>
        'kind' in field &&
        (field.kind === 'PropertySignature' || field.kind === 'PropertyDeclaration'),
    )
    .map((field) => `${field.parent}:${field.name}`),
);
const localIdentities = new Set(
  financialFields.map((field) => `${field.file}:${field.parent}:${field.name}`),
);

/** 投影身份沿用原 numericSites 的具名函数/闭包，而非最近局部变量名。 */
function projectionFunction(node: ts.Node): string {
  for (let parent = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent)
    )
      return (
        parent.name?.getText() ??
        (ts.isVariableDeclaration(parent.parent) ? parent.parent.name.getText() : '<closure>')
      );
  }

  return '<module>';
}

// 仅这些审计函数包含待删除的金融投影；额度仍逐文件/函数/表达式计数。
// 时间、指标、配置通用 Number 和 safeQuantityNumber 不得成为新金融投影的额度。
const projectionClosures: Readonly<Record<string, Stage>> = {
  'src/utils/helpers/index.ts:decimalToNumber': 'P1',
  'src/utils/numeric/index.ts:decimalToNumberValue': 'P1',
  'src/utils/numeric/index.ts:formatDecimal': 'P1',
  'src/core/trader/accountService.ts:getAccountSnapshot': 'P1',
  'src/core/trader/accountService.ts:<closure>': 'P1',
  'src/services/quoteClient/index.ts:buildQuoteFromRealtime': 'P1',
  'src/services/quoteClient/index.ts:buildQuoteFromPushEvent': 'P1',
  'src/services/quoteClient/index.ts:subscribeSymbols': 'P1',
  'src/core/orderRecorder/utils.ts:calculateOrderStatistics': 'P1',
  'src/core/orderRecorder/utils.ts:convertOrderToRecord': 'P1',
  'src/core/orderRecorder/utils.ts:assertNonZeroRebuildExecutionFact': 'P1',
  'src/core/orderRecorder/orderApiManager.ts:isFiniteDecimalLike': 'P1',
  'src/core/orderRecorder/orderApiManager.ts:orderToRawOrderFromAPI': 'P1',
  'src/core/riskController/utils.ts:sumOrderCost': 'P1',
  'src/core/riskController/dailyLossTracker.ts:calculateLossOffsetFromRecords': 'P1',
  'src/core/riskController/dailyLossTracker.ts:buildStateFromFacts': 'P1',
  'src/core/riskController/dailyLossTracker.ts:createOrderFactFromFill': 'P1',
  'src/core/riskController/dailyLossTracker.ts:createOrderFactFromRawOrder': 'P1',
  'src/core/riskController/dailyLossTracker.ts:hasValidExecution': 'P1',
  'src/core/riskController/dailyLossTracker.ts:restoreExecutionSnapshot': 'P1',
  'src/core/riskController/dailyLossTracker.ts:commitProtectionBoundary': 'P1',
  'src/core/riskController/dailyLossTracker.ts:restoreProtectionBoundary': 'P1',
  'src/core/riskController/index.ts:buildUnrealizedLossMetrics': 'P1',
  'src/core/riskController/unrealizedLossChecker.ts:calculateCostAndQuantity': 'P1',
  'src/core/riskController/unrealizedLossChecker.ts:refresh': 'P1',
  'src/core/riskController/unrealizedLossChecker.ts:check': 'P1',
  'src/core/riskController/warrantRiskChecker.ts:extractCallPrice': 'P1',
  'src/core/riskController/warrantRiskChecker.ts:checkDistanceThreshold': 'P1',
  'src/core/riskController/warrantRiskChecker.ts:buildDistanceLiquidationResult': 'P1',
  'src/core/trader/orderCacheManager.ts:toOrderNumber': 'P1',
  'src/core/trader/orderCacheManager.ts:<closure>': 'P1',
  'src/core/trader/orderMonitor/orderOps.ts:replaceOrderPriceWithRunner': 'P1',
  'src/core/trader/orderMonitor/recoveryFlow.ts:restorePendingOrderTracking': 'P1',
  'src/core/trader/orderMonitor/recoveryFlow.ts:recoverOrderTrackingFromSnapshot': 'P1',
  'src/core/trader/orderMonitor/eventFlow.ts:resolveNullableDecimalNumber': 'P1',
  'src/core/trader/orderMonitor/orderStatusQuery.ts:checkOrderState': 'P1',
  'src/core/trader/orderMonitor/routeProcessor.ts:shouldReplaceFromQuote': 'P1',
  'src/services/autoSymbolFinder/utils.ts:toWarrantCandidate': 'P3F',
};

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  noEmit: true,
};
let production: ts.Program | undefined;

/** 使用真实 TS 属性声明定位金融角色；虚拟探针可使用同一已审计契约身份。 */
export function numericOccurrences(file: string, source: string): ReadonlyArray<string> {
  production ??= ts.createProgram(ts.sys.readDirectory('src', ['.ts']), options);
  const existing = production.getSourceFile(file);
  let program = production;
  if (existing?.text !== source) {
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      name.replaceAll('\\', '/') === file.replaceAll('\\', '/')
        ? ts.createSourceFile(name, source, languageVersion, true)
        : original(name, languageVersion, onError, shouldCreateNewSourceFile);
    program = ts.createProgram([file], options, host);
  }

  const ast = program.getSourceFile(file);
  if (ast === undefined) throw new Error(`Missing numeric probe source: ${file}`);

  const checker = program.getTypeChecker();
  const occurrences: string[] = [];

  function financialDeclaration(node: ts.Node): boolean {
    if (
      !(
        ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isVariableDeclaration(node)
      ) ||
      !(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    )
      return false;

    const identity = `${parentName(node)}:${node.name.text}`;
    return ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)
      ? contractIdentities.has(identity)
      : localIdentities.has(`${node.getSourceFile().fileName.replaceAll('\\', '/')}:${identity}`);
  }

  function financialValue(node: ts.Node, followInitializer = true): boolean {
    if (ts.isParenthesizedExpression(node))
      return financialValue(node.expression, followInitializer);

    const symbolNode = ts.isPropertyAccessExpression(node) ? node.name : node;
    const symbol =
      ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        ? checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text)
        : checker.getSymbolAtLocation(symbolNode);
    if (symbol?.declarations?.some(financialDeclaration)) return true;

    // 只检查直接局部别名，不追踪赋值图、跨函数返回值或任意 taint。
    if (
      followInitializer &&
      ts.isIdentifier(node) &&
      symbol?.valueDeclaration !== undefined &&
      ts.isVariableDeclaration(symbol.valueDeclaration) &&
      symbol.valueDeclaration.initializer !== undefined
    )
      return financialValue(symbol.valueDeclaration.initializer, false);

    if (ts.isBinaryExpression(node))
      return (
        financialValue(node.left, followInitializer) ||
        financialValue(node.right, followInitializer)
      );

    return false;
  }

  function financialSink(node: ts.Node): boolean {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent)) return financialDeclaration(parent);

    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return financialValue(parent.left);

    if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
      const context = checker.getContextualType(parent.parent);
      const name = parent.name.getText().replaceAll(/['"]/g, '');
      return context?.getProperty(name)?.declarations?.some(financialDeclaration) ?? false;
    }

    // Decimal 包装或 formatter 不得隐藏其内部直接投影。
    if (
      ts.isCallExpression(parent) ||
      ts.isNewExpression(parent) ||
      ts.isPropertyAccessExpression(parent)
    )
      return financialSink(parent);

    return false;
  }

  function visit(node: ts.Node): void {
    if (financialDeclaration(node) && 'type' in node) {
      const type = node.type as ts.TypeNode | undefined;
      const valueType = type === undefined ? undefined : checker.getTypeFromTypeNode(type);
      const members = valueType === undefined ? [] : [valueType];
      const numberView = valueType?.isUnion() ? valueType.types : members;
      if (
        type !== undefined &&
        numberView.some((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0)
      ) {
        const name = (node as ts.PropertySignature).name.getText().replaceAll(/['"]/g, '');
        occurrences.push(
          occurrenceKey(file, 'FINANCIAL_NUMBER', parentName(node), name, compact(type.getText())),
        );
      }
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression.getText();
      const projection =
        /^(?:Number(?:\.parseFloat)?|parseFloat|decimalToNumber(?:Value)?|toNumber)$/.test(
          expression,
        ) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'toNumber');
      const input =
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toNumber'
          ? node.expression.expression
          : node.arguments?.[0];
      const numberConstruction =
        ts.isNewExpression(node) &&
        node.arguments?.some(
          (argument) => (checker.getTypeAtLocation(argument).flags & ts.TypeFlags.NumberLike) !== 0,
        );
      if (
        (projection && ((input !== undefined && financialValue(input)) || financialSink(node))) ||
        (numberConstruction && financialSink(node))
      ) {
        occurrences.push(
          occurrenceKey(
            file,
            'PROJECTION',
            projectionFunction(node),
            compact(node.getText().slice(0, 700)),
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(ast);
  return occurrences;
}

export const frozenNumeric: ReadonlyArray<string> = [
  // 原契约文本本身就是冻结身份；类型别名中的旧 number 不从 worktree 追加。
  ...financialFields.map((field) =>
    occurrenceKey(field.file, 'FINANCIAL_NUMBER', field.parent, field.name, compact(field.type)),
  ),
  ...baseline.numericSites
    .filter((row) => {
      const [, parent, expression] = JSON.parse(row.key) as ReadonlyArray<string>;
      return (
        projectionClosures[`${row.file}:${parent}`] !== undefined &&
        /decimalToNumber|toNumber|parseFloat|^Number\(/.test(expression ?? '')
      );
    })
    .map((row) => {
      const [, parent, expression] = JSON.parse(row.key) as ReadonlyArray<string>;
      return occurrenceKey(row.file, 'PROJECTION', parent, compact(expression ?? ''));
    }),
];

// 混合 closure 的物理迁移截止不能重新开放已经闭合的金融契约。
// 此处只登记 P1 真实 reader 所需的完整契约组；换标预算/寻标候选等未闭合组仍保留原审计额度。
const p1ClosedContracts = new Set([
  'src/types/quote.ts:Quote',
  'src/types/config.ts:MonitorConfig',
  'src/types/services.ts:RiskChecker',
  'src/types/services.ts:PendingOrder',
  'src/types/services.ts:OrderStateChangedEvent',
  'src/types/risk.ts:DailyLossCumulativeExecutionInput',
  'src/types/trader.ts:OrderStateCheckResult',
  'src/core/riskController/types.ts:WarrantInfo',
  'src/core/riskController/types.ts:WarrantRiskChecker',
  'src/core/riskController/types.ts:DailyLossState',
  'src/core/riskController/types.ts:DailyLossExecutionSnapshot',
  'src/core/riskController/types.ts:DailyLossOrderFact',
  'src/core/riskController/types.ts:DailyLossOrderBaseline',
  'src/core/trader/types.ts:TrackOrderParams',
  'src/core/trader/types.ts:TrackedOrder',
  'src/core/trader/types.ts:PendingSellOrderSnapshot',
  'src/core/trader/orderMonitor/types.ts:TerminalSettlementInput',
  'src/core/trader/orderMonitor/types.ts:OrderCumulativeExecutionParams',
  'src/core/trader/orderMonitor/types.ts:OrderObservedFact',
  'src/core/trader/orderMonitor/types.ts:MonotonicOrderFact',
  'src/core/trader/orderExecutor/types.ts:QuantityResolver',
]);
const p1ClosedFields = new Set(
  financialFields
    .filter(
      (field) =>
        field.closure ===
          'P1 first financial reader, full producer/state/all consumer/display slice; later owner relocation does not defer precision' ||
        p1ClosedContracts.has(`${field.file}:${field.parent}`),
    )
    .map((field) =>
      occurrenceKey(field.file, 'FINANCIAL_NUMBER', field.parent, field.name, compact(field.type)),
    ),
);

/** 原 occurrence 多重集合只缩不增；闭合组立即到期，其余金融额度最迟在 P4.5 收尾归零。 */
export function newNumeric(
  actual: ReadonlyArray<string>,
  frozen: ReadonlyArray<string>,
  stage: Stage,
): ReadonlyArray<string> {
  const counts = new Map<string, number>();
  for (const key of frozen) {
    const [file, kind, parent, name] = JSON.parse(key) as ReadonlyArray<string>;
    let cutoff: Stage = 'P4.5';
    if (p1ClosedFields.has(key)) cutoff = 'P1';
    else if (kind === 'FINANCIAL_NUMBER')
      cutoff = fieldClosures[`${file}:${parent}:${name}`] ?? cutoff;
    else if (kind === 'PROJECTION') cutoff = projectionClosures[`${file}:${parent}`] ?? cutoff;

    if (
      (kind === 'FINANCIAL_NUMBER' || kind === 'PROJECTION') &&
      STAGES.indexOf(stage) >= STAGES.indexOf(cutoff)
    )
      continue;

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return actual.filter((key) => {
    const remaining = counts.get(key) ?? 0;
    if (remaining === 0) return true;

    counts.set(key, remaining - 1);
    return false;
  });
}
