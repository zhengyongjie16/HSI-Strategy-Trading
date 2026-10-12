/**
 * P1 snapshot owner/只读事实边界：识别实际契约与提交工厂，不按变量名放行第二 store。
 * 仅读取 AST/类型；不运行 broker、snapshot 工厂或业务回调。
 */
import path from 'node:path';
import ts from 'typescript';
import { compact, occurrenceKey } from './scanner.js';
import type { SnapshotBoundaryScan } from './types.js';

export const SNAPSHOT_OWNER = 'src/application/accountPositionSnapshot/index.ts';

const financialContracts: Readonly<Record<string, ReadonlyArray<string>>> = {
  AccountSnapshot: ['totalCash', 'netAssets', 'positionValue'],
  CashInfo: ['availableCash'],
  Position: ['costPrice'],
  Quote: ['price', 'prevClose'],
};

const factNames = new Set([
  'AccountPositionSnapshotView',
  'SnapshotToken',
  'AccountSnapshot',
  'Position',
  'CashInfo',
]);

function actualSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): ts.Symbol | undefined {
  if (seen.has(node)) return undefined;

  seen.add(node);
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    return checker.getAliasedSymbol(symbol);

  const declaration = symbol?.valueDeclaration;
  if (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined
  )
    return actualSymbol(declaration.initializer, checker, seen) ?? symbol;

  return symbol;
}

function factType(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false;

  seen.add(type);
  if (type.isUnionOrIntersection())
    return type.types.some((member) => factType(member, checker, seen));

  if (
    [type.aliasSymbol, type.getSymbol()].some((symbol) =>
      symbol?.declarations?.some(
        (declaration) =>
          (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
          factNames.has(declaration.name.text) &&
          /\/src\/types\/(?:accountPosition|account)\.ts$/.test(
            declaration.getSourceFile().fileName.replaceAll('\\', '/'),
          ),
      ),
    )
  )
    return true;

  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
    checker
      .getTypeArguments(type as ts.TypeReference)
      .some((argument) => factType(argument, checker, seen))
  );
}

function factExpression(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (factType(checker.getTypeAtLocation(node), checker)) return true;

  return (
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node)) &&
    factExpression(node.expression, checker)
  );
}

function ownerType(type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some(ownerType);

  const symbol = type.aliasSymbol ?? type.getSymbol();
  return (
    symbol?.declarations?.some(
      (declaration) =>
        ts.isInterfaceDeclaration(declaration) &&
        declaration.name.text === 'AccountPositionSnapshot',
    ) === true ||
    ['getView', 'requestRefresh', 'requestClear', 'invalidateAccount'].every(
      (name) => type.getProperty(name) !== undefined,
    )
  );
}

function assignment(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken))
  );
}

/** 事实契约递归检查，不要求合法版本/数量值改为 Decimal。 */
function writableFact(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
  seen: Set<ts.Type>,
): boolean {
  if (seen.has(type)) return false;

  seen.add(type);
  if ((type.flags & ts.TypeFlags.Any) !== 0) return true;

  if (
    type
      .getSymbol()
      ?.declarations?.some(
        (declaration) =>
          ts.isMappedTypeNode(declaration) &&
          declaration.readonlyToken?.kind === ts.SyntaxKind.MinusToken,
      )
  )
    return true;

  if (type.isUnionOrIntersection())
    return type.types.some((member) => writableFact(member, checker, location, seen));

  if ((type.flags & ts.TypeFlags.Object) === 0) return false;

  if (['Array', 'Map', 'Set'].includes(type.getSymbol()?.name ?? '')) return true;

  if (
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
    checker
      .getTypeArguments(type as ts.TypeReference)
      .some((argument) => writableFact(argument, checker, location, seen))
  )
    return true;

  return type.getProperties().some((property) => {
    const declarations = property.declarations?.filter(
      (declaration) =>
        !declaration.getSourceFile().fileName.replaceAll('\\', '/').includes('/node_modules/'),
    );
    if (declarations === undefined || declarations.length === 0) return false;

    return (
      declarations.some(
        (declaration) =>
          (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
          !declaration.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
          ),
      ) ||
      writableFact(checker.getTypeOfSymbolAtLocation(property, location), checker, location, seen)
    );
  });
}

/** 列出真实 owner 和越界事实写入；只豁免固定 owner 的私有实现，不豁免同目录新文件。 */
export function snapshotBoundaries(
  root: string,
  program: ts.Program,
  files: ReadonlyArray<string>,
): SnapshotBoundaryScan {
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((file) => path.resolve(file).toLowerCase()));
  const owners: string[] = [];
  const creations: string[] = [];
  const violations: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(source.fileName).toLowerCase())) continue;

    const file = path.relative(root, source.fileName).replaceAll('\\', '/');
    if (!file.startsWith('src/')) continue;

    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'createAccountPositionSnapshot')
        owners.push(file);

      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        factNames.has(node.name.text) &&
        ['src/types/accountPosition.ts', 'src/types/account.ts'].includes(file) &&
        writableFact(checker.getTypeAtLocation(node), checker, node, new Set())
      )
        violations.push(occurrenceKey(file, 'WRITABLE_SNAPSHOT_FACT', node.name.text));

      if (
        ts.isPropertySignature(node) &&
        ['src/types/account.ts', 'src/types/quote.ts'].includes(file) &&
        (ts.isTypeLiteralNode(node.parent) || ts.isInterfaceDeclaration(node.parent))
      ) {
        const contract = ts.isTypeLiteralNode(node.parent) ? node.parent.parent : node.parent;
        if (
          (ts.isTypeAliasDeclaration(contract) || ts.isInterfaceDeclaration(contract)) &&
          financialContracts[contract.name.text]?.includes(node.name.getText()) === true
        ) {
          const type = checker.getTypeAtLocation(node);
          const members = type.isUnion() ? type.types : [type];
          if (
            members.some(
              (member) =>
                (member.flags &
                  (ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) ===
                0,
            )
          )
            violations.push(
              occurrenceKey(file, 'P1_FINANCIAL_CONTRACT', contract.name.text, node.name.getText()),
            );
        }
      }

      if (file !== SNAPSHOT_OWNER) {
        if (
          ts.isObjectLiteralExpression(node) &&
          ownerType(checker.getContextualType(node) ?? checker.getTypeAtLocation(node))
        )
          violations.push(
            occurrenceKey(file, 'SECOND_SNAPSHOT_IMPLEMENTATION', compact(node.getText())),
          );

        if (
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          assignment(node) &&
          factType(checker.getTypeAtLocation(node.expression), checker)
        )
          violations.push(occurrenceKey(file, 'SNAPSHOT_FACT_WRITE', compact(node.getText())));

        if (
          (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
          factExpression(node.expression, checker) &&
          writableFact(checker.getTypeAtLocation(node), checker, node, new Set())
        )
          violations.push(occurrenceKey(file, 'WRITABLE_SNAPSHOT_CAST', compact(node.getText())));

        if (ts.isCallExpression(node)) {
          if (
            node.expression.getText() === 'Object.assign' &&
            node.arguments[0] !== undefined &&
            factExpression(node.arguments[0], checker)
          )
            violations.push(occurrenceKey(file, 'SNAPSHOT_FACT_WRITE', compact(node.getText())));

          const symbol = actualSymbol(node.expression, checker);
          if (
            symbol?.declarations?.some(
              (declaration) =>
                ts.isFunctionDeclaration(declaration) &&
                declaration.name?.text === 'createAccountPositionSnapshot',
            )
          ) {
            creations.push(file);
            if (!file.startsWith('src/app/'))
              violations.push(
                occurrenceKey(file, 'SNAPSHOT_OWNER_CREATION', compact(node.getText())),
              );
          }
        }
      }

      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  return { owners, creations, violations };
}
