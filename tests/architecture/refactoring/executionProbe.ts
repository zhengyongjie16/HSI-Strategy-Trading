/**
 * SDK 构造执行路径探针：只检查已调用函数的默认参数与执行体。
 * 不求值源码、不把返回对象尚未调用的方法/闭包当成已执行构造；不是通用解释器。
 */
import ts from 'typescript';

function actualSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): ts.Symbol | undefined {
  if (seen.has(node)) return undefined;

  seen.add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return actualSymbol(node.expression, checker, seen);

  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) return checker.getAliasedSymbol(symbol);

  const shorthand = symbol.declarations?.find(ts.isShorthandPropertyAssignment);
  if (shorthand !== undefined)
    return checker.getShorthandAssignmentValueSymbol(shorthand) ?? symbol;

  const variable = symbol.valueDeclaration;
  if (
    variable !== undefined &&
    ts.isVariableDeclaration(variable) &&
    variable.initializer !== undefined &&
    (ts.isIdentifier(variable.initializer) ||
      ts.isPropertyAccessExpression(variable.initializer) ||
      ts.isParenthesizedExpression(variable.initializer) ||
      ts.isAsExpression(variable.initializer))
  )
    return actualSymbol(variable.initializer, checker, seen) ?? symbol;

  return symbol;
}

function sdkSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = actualSymbol(node, checker);
  return symbol?.declarations?.some((declaration) =>
    /\/node_modules\/(?:longbridge|\.bun\/longbridge)/.test(
      declaration.getSourceFile().fileName.replaceAll('\\', '/'),
    ),
  ) === true
    ? symbol
    : undefined;
}

function sdkType(type: ts.Type): boolean {
  return (
    type
      .getSymbol()
      ?.declarations?.some((declaration) =>
        /\/node_modules\/(?:longbridge|\.bun\/longbridge)/.test(
          declaration.getSourceFile().fileName.replaceAll('\\', '/'),
        ),
      ) === true
  );
}

function sdkResult(type: ts.Type, checker: ts.TypeChecker): boolean {
  return (
    sdkType(type) ||
    ((type.flags & ts.TypeFlags.Object) !== 0 &&
      ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
      checker.getTypeArguments(type as ts.TypeReference).some(sdkType))
  );
}

function unwrapFunction(node: ts.Node | undefined): ts.FunctionLikeDeclaration | undefined {
  if (node === undefined) return undefined;

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  )
    return node;

  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isPropertyDeclaration(node)
  )
    return unwrapFunction(node.initializer);

  if (ts.isParenthesizedExpression(node)) return unwrapFunction(node.expression);

  return undefined;
}

/** fixture 维度只沿 tests/mock 实现；src 被测 owner 的 SDK 由独立 occurrence 冻结。 */
function helperImplementation(node: ts.Node): boolean {
  const file = node.getSourceFile().fileName.replaceAll('\\', '/');
  return !file.includes('/src/') && /\/(?:tests|mock)\//.test(file);
}

/** 签名无 body 时只追踪静态 factory return/局部别名，不执行未调用成员。 */
function calledFunctions(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
  resolving = new Set<ts.Node>(),
): ReadonlyArray<ts.FunctionLikeDeclaration> {
  if (resolving.has(call)) return [];

  resolving.add(call);

  const resolved = unwrapFunction(checker.getResolvedSignature(call)?.declaration);
  if (resolved?.body !== undefined) return [resolved];

  const immediate = unwrapFunction(call.expression);
  if (immediate !== undefined) return [immediate];

  const declarations = actualSymbol(call.expression, checker)?.declarations ?? [];
  const implementations = declarations
    .map(unwrapFunction)
    .filter(
      (declaration): declaration is ts.FunctionLikeDeclaration => declaration?.body !== undefined,
    );
  if (implementations.length > 0) return implementations;

  function values(expression: ts.Expression): ReadonlyArray<ts.Expression> {
    if (resolving.has(expression)) return [];

    resolving.add(expression);
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return values(expression.expression);

    if (ts.isIdentifier(expression)) {
      return (actualSymbol(expression, checker)?.declarations ?? []).flatMap((declaration) =>
        ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
          ? values(declaration.initializer)
          : [],
      );
    }

    if (!ts.isCallExpression(expression)) return [expression];

    // 当前节点交由调用解析持有；共享集合防止递归 factory/别名环。
    resolving.delete(expression);
    return calledFunctions(expression, checker, resolving).flatMap((factory) => {
      if (!helperImplementation(factory) || factory.body === undefined) return [];

      if (!ts.isBlock(factory.body)) return values(factory.body);

      const returned: ts.Expression[] = [];
      function collect(node: ts.Node): void {
        if (
          unwrapFunction(node) !== undefined ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node)
        )
          return;

        if (ts.isReturnStatement(node)) {
          if (node.expression !== undefined) returned.push(...values(node.expression));

          return;
        }

        ts.forEachChild(node, collect);
      }
      collect(factory.body);
      return returned;
    });
  }

  if (!ts.isPropertyAccessExpression(call.expression)) return [];

  const memberName = call.expression.name.text;
  return values(call.expression.expression).flatMap((value) => {
    if (!ts.isObjectLiteralExpression(value)) return [];

    return value.properties.flatMap((property) => {
      if (
        property.name === undefined ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
        property.name.text !== memberName
      )
        return [];

      const member = unwrapFunction(property);
      if (member !== undefined) return [member];

      let reference: ts.Expression | undefined;
      if (ts.isShorthandPropertyAssignment(property)) reference = property.name;

      if (ts.isPropertyAssignment(property)) reference = property.initializer;

      return reference === undefined
        ? []
        : (actualSymbol(reference, checker)?.declarations ?? [])
            .map(unwrapFunction)
            .filter(
              (declaration): declaration is ts.FunctionLikeDeclaration =>
                declaration?.body !== undefined,
            );
    });
  });
}

function omittedArgument(argument: ts.Expression | undefined, checker: ts.TypeChecker): boolean {
  if (argument === undefined || ts.isVoidExpression(argument)) return true;

  return (
    ts.isIdentifier(argument) &&
    argument.text === 'undefined' &&
    (checker.getTypeAtLocation(argument).flags & ts.TypeFlags.Undefined) !== 0
  );
}

/** 仅解析调用参数、局部别名及对象字段，以连接显式 callback 调用；不计算业务表达式。 */
function staticMemberName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker?: ts.TypeChecker,
  bindings?: ReadonlyMap<ts.Symbol, ts.Expression>,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;

  const key =
    checker !== undefined && bindings !== undefined
      ? invocationInput(node.argumentExpression, checker, bindings)
      : node.argumentExpression;
  if (key !== undefined && ts.isStringLiteral(key)) return key.text;

  if (
    key !== undefined &&
    ts.isBinaryExpression(key) &&
    key.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    ts.isStringLiteral(key.right) &&
    checker !== undefined &&
    bindings !== undefined
  ) {
    const left = invocationInput(key.left, checker, bindings);
    if (
      left?.kind === ts.SyntaxKind.NullKeyword ||
      (left !== undefined && ts.isIdentifier(left) && left.text === 'undefined')
    )
      return key.right.text;

    if (ts.isPropertyAccessExpression(key.left) || ts.isElementAccessExpression(key.left)) {
      const receiver = invocationInput(key.left.expression, checker, bindings),
        field = staticMemberName(key.left, checker, bindings);
      if (
        receiver !== undefined &&
        ts.isObjectLiteralExpression(receiver) &&
        field !== undefined &&
        receiver.properties.every(
          (member) =>
            ts.isPropertyAssignment(member) &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
            member.name.text !== field,
        )
      )
        return key.right.text;
    }
  }

  return undefined;
}

function invocationInput(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
  resolving = new Set<ts.Node>(),
): ts.Expression | undefined {
  if (resolving.has(expression)) return undefined;

  resolving.add(expression);
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return invocationInput(expression.expression, checker, bindings, resolving);

  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const field = staticMemberName(expression, checker, bindings);
    if (field === undefined) return undefined;

    const object = invocationInput(expression.expression, checker, bindings, resolving);
    if (object !== undefined && ts.isObjectLiteralExpression(object)) {
      const property = object.properties.find(
        (member) =>
          member.name !== undefined &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
          member.name.text === field,
      );
      if (property !== undefined && ts.isPropertyAssignment(property))
        return invocationInput(property.initializer, checker, bindings, resolving);

      if (property !== undefined && ts.isShorthandPropertyAssignment(property))
        return invocationInput(property.name, checker, bindings, resolving);
    }

    return expression;
  }

  if (!ts.isIdentifier(expression)) return expression;

  const symbol = actualSymbol(expression, checker);
  if (symbol === undefined) return expression;

  const supplied = bindings.get(symbol);
  if (supplied !== undefined) return invocationInput(supplied, checker, bindings, resolving);

  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
      return invocationInput(declaration.initializer, checker, bindings, resolving);

    if (
      ts.isBindingElement(declaration) &&
      ts.isObjectBindingPattern(declaration.parent) &&
      ts.isVariableDeclaration(declaration.parent.parent) &&
      declaration.parent.parent.initializer !== undefined
    ) {
      const object = invocationInput(
        declaration.parent.parent.initializer,
        checker,
        bindings,
        resolving,
      );
      const name = declaration.propertyName ?? declaration.name;
      if (object !== undefined && ts.isObjectLiteralExpression(object) && ts.isIdentifier(name)) {
        const property = object.properties.find(
          (member) =>
            member.name !== undefined &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
            member.name.text === name.text,
        );
        if (property !== undefined && ts.isPropertyAssignment(property))
          return invocationInput(property.initializer, checker, bindings, resolving);

        if (property !== undefined && ts.isShorthandPropertyAssignment(property))
          return invocationInput(property.name, checker, bindings, resolving);
      }
    }
  }

  return expression;
}

/** compiler program 内的完成结果缓存；表达式/参数 symbol 身份限定静态调用上下文。 */
const executionCaches = new WeakMap<
  ts.TypeChecker,
  {
    readonly identities: WeakMap<ts.Node | ts.Symbol, number>;
    nextIdentity: number;
    readonly targets: WeakMap<ts.FunctionLikeDeclaration, Map<string, boolean>>;
    readonly roots: WeakMap<ts.CallExpression, boolean>;
  }
>();

/**
 * 判断一次调用是否沿实际被调用的本地执行体构造 SDK 值。
 * 显式参数跳过默认 initializer；函数声明、方法与未调用 callback 不执行。
 * @param call 正在审计的调用表达式
 * @param checker 同一 compiler program 的 TypeChecker
 * @returns 是否找到 SDK constructor、SDK class factory 或 enum DTO 值的执行路径
 */
const outsideAdapterCaches: typeof executionCaches = new WeakMap();

export function constructsSdkAtCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  outsideAdapters = false,
  neutralBoundary?: (target: ts.FunctionLikeDeclaration) => boolean,
): boolean {
  const caches = outsideAdapters ? outsideAdapterCaches : executionCaches;
  const legalSite = (node: ts.Node): boolean =>
    outsideAdapters &&
    /\/tests\/infrastructure\/longbridge\/(trade|market)\//.test(
      node.getSourceFile().fileName.replaceAll('\\', '/'),
    );
  let cache = caches.get(checker);
  if (cache === undefined) {
    cache = {
      identities: new WeakMap(),
      nextIdentity: 0,
      targets: new WeakMap(),
      roots: new WeakMap(),
    };
    caches.set(checker, cache);
  }

  const completed = cache.roots.get(call);
  if (completed !== undefined) return completed;

  const results = cache;
  const identity = (node: ts.Node | ts.Symbol): number => {
    const existing = results.identities.get(node);
    if (existing !== undefined) return existing;

    const value = results.nextIdentity++;
    results.identities.set(node, value);
    return value;
  };
  const contextKey = (bindings: ReadonlyMap<ts.Symbol, ts.Expression>): string =>
    [...bindings]
      .map(([symbol, expression]) => [identity(symbol), identity(expression)] as const)
      .sort((left, right) => left[0] - right[0])
      .map(([symbol, expression]) => `${symbol}:${expression}`)
      .join(',');
  const active = new Map<ts.Node, Set<string>>();
  let cycleCuts = 0;

  function executeTarget(
    target: ts.FunctionLikeDeclaration,
    args: ReadonlyArray<ts.Expression>,
    bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
  ): boolean {
    if (!helperImplementation(target) || target.body === undefined) return false;

    const supplied = new Map(bindings);
    for (const [index, parameter] of target.parameters.entries()) {
      const argument = args[index];
      const usesDefault = omittedArgument(argument, checker);
      if (
        usesDefault &&
        parameter.initializer !== undefined &&
        execute(parameter.initializer, supplied)
      )
        return true;

      const value = usesDefault
        ? parameter.initializer
        : invocationInput(argument!, checker, bindings);
      const symbol = actualSymbol(parameter.name, checker);
      if (symbol !== undefined) {
        if (value === undefined) supplied.delete(symbol);
        else supplied.set(symbol, value);
      }
    }

    const key = contextKey(supplied);
    const previous = results.targets.get(target)?.get(key);
    if (previous !== undefined) return previous;

    const cutsBefore = cycleCuts;
    const found = execute(target.body, supplied);
    // 循环截断的 false 不跨根缓存；显式 callback 参数属于不同上下文。
    if (found || cycleCuts === cutsBefore) {
      let contexts = results.targets.get(target);
      if (contexts === undefined) {
        contexts = new Map();
        results.targets.set(target, contexts);
      }

      contexts.set(key, found);
    }

    return found;
  }

  function callbacks(
    reference: ts.Expression,
    bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
  ): ReadonlyArray<ts.FunctionLikeDeclaration> {
    const input = invocationInput(reference, checker, bindings);
    const immediate = unwrapFunction(input);
    if (immediate?.body !== undefined) return [immediate];

    if (input === undefined) return [];

    return (actualSymbol(input, checker)?.declarations ?? [])
      .map(unwrapFunction)
      .filter((target): target is ts.FunctionLikeDeclaration => target?.body !== undefined);
  }

  function executeInvocation(
    invocation: ts.CallExpression | ts.NewExpression,
    bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
    inspectArguments = true,
  ): boolean {
    const key = `${inspectArguments ? 1 : 0}:${contextKey(bindings)}`;
    let contexts = active.get(invocation);
    if (contexts?.has(key)) {
      cycleCuts += 1;
      return false;
    }

    if (contexts === undefined) {
      contexts = new Set();
      active.set(invocation, contexts);
    }

    contexts.add(key);
    try {
      const native = sdkSymbol(invocation.expression, checker);
      if (ts.isNewExpression(invocation) && native !== undefined && !legalSite(invocation))
        return true;

      const result = checker.getResolvedSignature(invocation)?.getReturnType();
      if (
        native?.declarations?.some(
          (declaration) =>
            ts.isMethodDeclaration(declaration) &&
            declaration.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
            ),
        ) &&
        result !== undefined &&
        sdkResult(result, checker) &&
        !legalSite(invocation)
      )
        return true;

      if (ts.isPropertyAccessExpression(invocation.expression)) {
        const owner = sdkSymbol(invocation.expression.expression, checker);
        if (
          owner !== undefined &&
          (owner.flags & ts.SymbolFlags.Class) !== 0 &&
          result !== undefined &&
          sdkResult(result, checker) &&
          !legalSite(invocation)
        )
          return true;
      }

      if (execute(invocation.expression, bindings, false)) return true;

      if (
        inspectArguments &&
        invocation.arguments?.some((argument) => execute(argument, bindings, false))
      )
        return true;

      if (
        ts.isCallExpression(invocation) &&
        ts.isPropertyAccessExpression(invocation.expression) &&
        invocation.expression.name.text === 'map'
      ) {
        const receiver = invocation.expression.expression;
        const type = checker.getTypeAtLocation(receiver);
        if (checker.isArrayType(type) || checker.isTupleType(type)) {
          const input = invocationInput(receiver, checker, bindings);
          if (
            input !== undefined &&
            ts.isArrayLiteralExpression(input) &&
            input.elements.length === 0
          )
            return false;

          const callback = invocation.arguments[0];
          const argument =
            input !== undefined && ts.isArrayLiteralExpression(input)
              ? input.elements[0]
              : receiver;
          if (
            callback !== undefined &&
            callbacks(callback, bindings).some((target) =>
              executeTarget(target, [argument ?? receiver], bindings),
            )
          )
            return true;
        }
      }

      const bound = ts.isCallExpression(invocation)
        ? callbacks(invocation.expression, bindings)
        : [];
      const targets = bound.length > 0 ? bound : calledFunctions(invocation, checker);
      if (
        outsideAdapters &&
        !legalSite(invocation) &&
        targets.some((target) => legalSite(target) && neutralBoundary?.(target) === false)
      )
        return true;

      return targets.some((target) => executeTarget(target, invocation.arguments ?? [], bindings));
    } finally {
      contexts.delete(key);
      if (contexts.size === 0) active.delete(invocation);
    }
  }

  function execute(
    node: ts.Node,
    bindings: ReadonlyMap<ts.Symbol, ts.Expression>,
    enumMapping = true,
  ): boolean {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      return false;

    if (ts.isCallExpression(node) || ts.isNewExpression(node))
      return executeInvocation(node, bindings);

    if (enumMapping && ts.isPropertyAccessExpression(node)) {
      const owner = sdkSymbol(node.expression, checker);
      if (owner !== undefined && (owner.flags & ts.SymbolFlags.Enum) !== 0 && !legalSite(node))
        return true;
    }

    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && execute(child, bindings, enumMapping)) found = true;
    });
    return found;
  }
  const found = executeInvocation(call, new Map(), false);
  results.roots.set(call, found);
  return found;
}
