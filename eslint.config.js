import path from 'node:path';
import ts from 'typescript';
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import eslintPluginStylistic from '@stylistic/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

const restrictTemplateExpressionsRule = [
  'error',
  {
    allowAny: false,
    allowArray: false,
    allowBoolean: true,
    allowNullish: true,
    allowNumber: true,
    allowRegExp: false,
  },
];

const noImportAliasRule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      forbiddenAlias: "不允许重命名导入: '{{imported}} as {{local}}'",
    },
  },
  create(context) {
    return {
      ImportSpecifier(node) {
        const imported =
          node.imported.type === 'Identifier' ? node.imported.name : String(node.imported.value);
        const local = node.local.name;

        if (imported === local) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenAlias',
          data: {
            imported,
            local,
          },
        });
      },
    };
  },
};

const strategyPrivateBoundaryRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      privateStrategy: '宿主/公共模块不得导入私有策略，策略之间也不得相互导入。',
      selectedLoaderOnly:
        '非字面量动态 import 仅允许 runAppDeps 的 selected-strategy importModule 能力。',
      pureRole: '纯策略模块不得反向依赖装配或受控运行实现。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename)) return {};
    const strategyRoots = ['/src/strategies/'];

    function strategyDirectory(file) {
      for (const root of strategyRoots) {
        const part = file.split(root)[1];
        if (part?.includes('/')) return part.split('/')[0];
      }

      return undefined;
    }

    function isSelectedLoaderImport(node) {
      if (!filename.endsWith('/src/app/runAppDeps.ts')) return false;
      const callback = node.parent;
      const property = callback?.parent;
      const object = property?.parent;
      const call = object?.parent;
      const services = context.sourceCode.parserServices;
      const callee =
        call?.type === 'CallExpression'
          ? services.esTreeNodeToTSNodeMap.get(call.callee)
          : undefined;
      const checker = services.program.getTypeChecker();
      const binding = callee === undefined ? undefined : checker.getSymbolAtLocation(callee);
      const actual =
        binding && (binding.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(binding)
          : binding;
      const selectedPreparation = actual?.declarations?.some(
        (declaration) =>
          declaration
            .getSourceFile()
            .fileName.replaceAll('\\', '/')
            .endsWith('/src/app/startup/prepareStrategy.ts') &&
          ts.isFunctionDeclaration(declaration) &&
          declaration.name?.text === 'prepareStrategy',
      );
      return (
        selectedPreparation &&
        callback?.type === 'ArrowFunctionExpression' &&
        callback.body === node &&
        callback.params.length === 1 &&
        callback.params[0].type === 'Identifier' &&
        node.source.type === 'Identifier' &&
        node.source.name === callback.params[0].name &&
        property?.type === 'Property' &&
        !property.computed &&
        property.key.type === 'Identifier' &&
        property.key.name === 'importModule' &&
        property.value === callback &&
        object?.type === 'ObjectExpression' &&
        call?.type === 'CallExpression' &&
        call.callee.type === 'Identifier' &&
        call.callee.name === 'prepareStrategy' &&
        call.arguments.length === 2 &&
        call.arguments[1] === object
      );
    }

    function check(node, source) {
      if (typeof source?.value !== 'string') return;
      const specifier = source.value.split(/[?#]/)[0];
      const target = specifier.startsWith('@/')
        ? filename.slice(0, filename.indexOf('/src/')) + '/src/' + specifier.slice(2)
        : specifier.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier))
          : specifier;
      if (
        strategyFileRole(filename) === 'pure' &&
        ['definition', 'runtime'].includes(strategyFileRole(target))
      )
        reportNode(context, node, 'pureRole');
      const targetDirectory = strategyDirectory(target);
      if (targetDirectory === undefined) return;
      if (strategyDirectory(filename) === targetDirectory) return;
      reportNode(context, node, 'privateStrategy');
    }
    return {
      ImportDeclaration(node) {
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
      ImportExpression(node) {
        if (typeof node.source.value !== 'string' && !isSelectedLoaderImport(node)) {
          reportNode(context, node, 'selectedLoaderOnly');
          return;
        }

        check(node, node.source);
      },
      TSImportType(node) {
        check(node, node.source);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference')
          check(node, node.moduleReference.expression);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        if (typeof node.arguments[0]?.value !== 'string')
          reportNode(context, node, 'selectedLoaderOnly');
        else check(node, node.arguments[0]);
      },
    };
  },
};

function strategyFileRole(filename) {
  const role = /\/src\/strategies\/[^/]+\/(.+)$/.exec(filename)?.[1]?.replace(/\.js$/, '.ts');
  if (role === undefined) return undefined;
  if (role === 'definition.ts') return 'definition';
  return role === 'index.ts' || role === 'verification/pendingVerification.ts' ? 'runtime' : 'pure';
}

/**
 * 有限能力成员身份：仅标准库/平台声明中的真实环境与高精度时钟成员。
 * 以 owner 接口、成员名与声明来源三重身份识别，不按 env/now 等拼写全局禁用。
 */
const ambientCapabilityMembers = {
  Process: ['env', 'hrtime', 'uptime'],
  DateConstructor: ['now'],
  Performance: ['now'],
};

/** 策略角色规则复用真实 TS 签名身份，不以成员名猜测注入能力。 */
const strategyCapabilitiesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      ambient: '所有策略角色禁止直接 I/O、环境、原生时间/调度和 SDK。',
      injected:
        '纯策略与 definition 角色不得调用 clock、scheduler、logger、emitter 或 onFatalError 注入能力。',
      evaluation: 'definition 模块求值不得启动运行；仅允许声明及 Object.freeze 装配。',
    },
  },
  create(context) {
    const role = strategyFileRole(getNormalizedFilename(context));
    if (role === undefined) return {};
    const services = context.sourceCode.parserServices;
    const checker = services.program.getTypeChecker();
    const sourcePath = (node) => node.getSourceFile().fileName.replaceAll('\\', '/');
    const symbol = (node) => {
      const found = checker.getSymbolAtLocation(node);
      return found && (found.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(found)
        : found;
    };
    const tsNode = (node) => services.esTreeNodeToTSNodeMap.get(node);
    const ambientSymbol = (node) =>
      symbol(tsNode(node))?.declarations?.some(
        (declaration) =>
          declaration.getSourceFile().isDeclarationFile &&
          /\/node_modules\//.test(sourcePath(declaration)),
      );
    const typePosition = (node) => {
      for (let parent = node.parent; parent && parent.type !== 'Program'; parent = parent.parent)
        if (
          parent.type.startsWith('TS') &&
          !['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(parent.type)
        )
          return true;
      return false;
    };
    const ambientSource = (declaration) =>
      declaration.getSourceFile().isDeclarationFile &&
      /\/node_modules\/(?:@types\/node|bun-types|typescript\/lib)\//.test(sourcePath(declaration));
    const literalName = (value) => {
      if (value?.type === 'Literal')
        return typeof value.value === 'string' ? value.value : undefined;
      if (value?.type === 'TemplateLiteral' && value.expressions.length === 0)
        return value.quasis[0]?.value.cooked ?? undefined;
      return undefined;
    };
    const memberName = (node) =>
      node.computed
        ? literalName(node.property)
        : (node.property.name ?? literalName(node.property));
    const bindingName = (node) =>
      node.computed ? literalName(node.key) : (node.key.name ?? literalName(node.key));
    /** 属性符号身份必须同时命中 owner 接口、成员名与标准库/平台声明来源。 */
    function ambientCapabilityMember(type, name) {
      const property = typeof name === 'string' ? checker.getPropertyOfType(type, name) : undefined;
      if (!property) return false;
      return (
        property.declarations?.some((declaration) => {
          if (!ambientSource(declaration)) return false;
          const owner = declaration.parent;
          const ownerName =
            owner &&
            (ts.isInterfaceDeclaration(owner) ||
              ts.isClassDeclaration(owner) ||
              ts.isTypeAliasDeclaration(owner))
              ? owner.name?.text
              : undefined;
          return (
            ownerName !== undefined && ambientCapabilityMembers[ownerName]?.includes(name) === true
          );
        }) ?? false
      );
    }
    /** 零参数 Date 构造身份来自标准库；别名 `const Clock = Date` 共享同一 DateConstructor 身份。 */
    function ambientDateConstructor(expression) {
      const found = checker.getTypeAtLocation(tsNode(expression)).getSymbol();
      return (
        found?.name === 'DateConstructor' &&
        (found.declarations?.some(
          (declaration) =>
            declaration.getSourceFile().isDeclarationFile &&
            /\/typescript\/lib\//.test(sourcePath(declaration)),
        ) ??
          false)
      );
    }
    function moduleEdge(node, source, typeOnly) {
      if (typeof source?.value !== 'string') return;
      const value = source.value;
      if (
        /** os 与 fs/net 同属环境/文件系统边界；策略角色不按调用点区分读取用途。 */
        /^(?:longbridge(?:\/|$)|(?:node:)?(?:fs(?:\/promises)?|https?|http2|net|tls|dgram|dns(?:\/promises)?|os|timers(?:\/promises)?|child_process|worker_threads|cluster|readline(?:\/promises)?|process|console)$)/.test(
          value,
        ) ||
        (!typeOnly && /(?:utils|infrastructure)\/logger\//.test(value))
      )
        reportNode(context, node, 'ambient');
    }
    function call(node) {
      const original = tsNode(node);
      const declaration = checker.getResolvedSignature(original)?.declaration;
      if (role !== 'runtime' && declaration) {
        const file = sourcePath(declaration);
        for (let parent = declaration; parent && !ts.isSourceFile(parent); parent = parent.parent) {
          if (!(ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent))) continue;
          const name = parent.name.text;
          if (
            (file.endsWith('/src/types/runtime.ts') &&
              ['RuntimeClock', 'RuntimeScheduler'].includes(name)) ||
            (file.endsWith('/src/types/strategy.ts') &&
              (name === 'StrategyEmitter' ||
                (name === 'StrategyDeps' &&
                  ts.isTypeAliasDeclaration(parent) &&
                  ts.isTypeLiteralNode(parent.type) &&
                  ts.isPropertySignature(declaration.parent) &&
                  declaration.parent.parent === parent.type &&
                  ts.isIdentifier(declaration.parent.name) &&
                  declaration.parent.name.text === 'onFatalError'))) ||
            (file.endsWith('/src/types/logger.ts') && name === 'Logger')
          ) {
            reportNode(context, node, 'injected');
            break;
          }
        }
      }
      if (node.arguments.length === 0 && ambientDateConstructor(node.callee))
        reportNode(context, node, 'ambient');
      if (role !== 'definition') return;
      for (let parent = node.parent; parent; parent = parent.parent)
        if (
          ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
            parent.type,
          )
        )
          return;
      if (
        declaration &&
        ts.isInterfaceDeclaration(declaration.parent) &&
        declaration.parent.name.text === 'ObjectConstructor' &&
        /\/typescript\/lib\//.test(sourcePath(declaration)) &&
        node.callee.type === 'MemberExpression' &&
        node.callee.property.name === 'freeze'
      )
        return;
      reportNode(context, node, 'evaluation');
    }
    return {
      ImportDeclaration(node) {
        moduleEdge(
          node,
          node.source,
          node.importKind === 'type' ||
            (node.specifiers.length > 0 &&
              node.specifiers.every((specifier) => specifier.importKind === 'type')),
        );
      },
      ExportNamedDeclaration(node) {
        moduleEdge(node, node.source, node.exportKind === 'type');
      },
      ExportAllDeclaration(node) {
        moduleEdge(node, node.source, node.exportKind === 'type');
      },
      TSImportType(node) {
        moduleEdge(node, node.source, true);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference')
          moduleEdge(node, node.moduleReference.expression, node.importKind === 'type');
      },
      ImportExpression(node) {
        moduleEdge(node, node.source, false);
      },
      Identifier(node) {
        if (
          !typePosition(node) &&
          /**
           * 名单只收环境/原生调度/平台根对象；命中仍要求标准库声明身份，同名局部声明不受影响。
           * 普通根访问 `globalThis.console`/`globalThis.process`/`globalThis.performance` 的属性名
           * 解析到同一 ambient 声明，因此有限闭合这三类 dot 访问；计算字符串根访问不在闭合范围。
           */
          /^(?:process|fetch|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|queueMicrotask|console|Bun|Deno|WebSocket|XMLHttpRequest|performance)$/.test(
            node.name,
          ) &&
          ambientSymbol(node)
        )
          reportNode(context, node, 'ambient');
      },
      Property(node) {
        if (node.parent.type !== 'ObjectPattern') return;
        const declarator = node.parent.parent;
        let initializer;
        if (declarator.type === 'VariableDeclarator') initializer = declarator.init;
        else if (
          declarator.type === 'AssignmentPattern' &&
          ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
            declarator.parent.type,
          ) &&
          declarator.parent.params.includes(declarator)
        )
          initializer = declarator.right;
        if (initializer == null) return;
        const name = bindingName(node);
        if (ambientCapabilityMember(checker.getTypeAtLocation(tsNode(initializer)), name))
          reportNode(context, node, 'ambient');
      },
      MemberExpression(node) {
        if (typePosition(node)) return;
        const name = memberName(node);
        if (ambientCapabilityMember(checker.getTypeAtLocation(tsNode(node.object)), name))
          reportNode(context, node, 'ambient');
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          moduleEdge(node, node.arguments[0], false);
        call(node);
      },
      NewExpression: call,
    };
  },
};

const redundantTypeAliasRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      redundantNamedAlias: '不允许定义仅指向另一个命名类型的重复类型别名，请直接使用原类型。',
      redundantPrimitiveAlias: '不允许为基础类型定义等价类型别名，请直接使用原始基础类型。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename)) {
      return {};
    }

    return {
      TSTypeAliasDeclaration(node) {
        const { typeAnnotation } = node;

        if (
          typeAnnotation.type === 'TSTypeReference' &&
          typeAnnotation.typeArguments === undefined
        ) {
          reportNode(context, node, 'redundantNamedAlias');
          return;
        }

        if (
          typeAnnotation.type === 'TSStringKeyword' ||
          typeAnnotation.type === 'TSNumberKeyword' ||
          typeAnnotation.type === 'TSBooleanKeyword' ||
          typeAnnotation.type === 'TSBigIntKeyword' ||
          typeAnnotation.type === 'TSSymbolKeyword'
        ) {
          reportNode(context, node, 'redundantPrimitiveAlias');
        }
      },
    };
  },
};

function getNormalizedFilename(context) {
  return (context.filename ?? context.physicalFilename).replaceAll('\\', '/');
}

function isSrcFile(filename) {
  return filename.includes('/src/') && filename.endsWith('.ts');
}

function isTypesFile(filename) {
  return filename.endsWith('/types.ts') || filename.includes('/src/types/');
}

function isUtilsFile(filename) {
  return filename.endsWith('/utils.ts');
}

function isDeclarationFile(filename) {
  return filename.endsWith('.d.ts');
}

function reportNode(context, node, messageId) {
  context.report({
    node,
    messageId,
  });
}

const typeDefinitionsLocationRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      invalidTypeLocation: '类型定义只能放在 src/types 或相邻 types.ts 中，且禁止 .d.ts 与 enum。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename)) {
      return {};
    }

    const isAllowedTypeLocation = isTypesFile(filename) && !isDeclarationFile(filename);

    return {
      TSEnumDeclaration(node) {
        reportNode(context, node, 'invalidTypeLocation');
      },
      TSInterfaceDeclaration(node) {
        if (!isAllowedTypeLocation) {
          reportNode(context, node, 'invalidTypeLocation');
        }
      },
      TSModuleDeclaration(node) {
        reportNode(context, node, 'invalidTypeLocation');
      },
      TSTypeAliasDeclaration(node) {
        if (!isAllowedTypeLocation) {
          reportNode(context, node, 'invalidTypeLocation');
        }
      },
      TSDeclareFunction(node) {
        reportNode(context, node, 'invalidTypeLocation');
      },
      VariableDeclaration(node) {
        if (node.declare === true) {
          reportNode(context, node, 'invalidTypeLocation');
        }
      },
    };
  },
};

const typesFileOnlyTypesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      runtimeInTypesFile: 'types.ts 只能包含 import type、type 与 interface 定义。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename) || !isTypesFile(filename)) {
      return {};
    }

    function reportRuntimeNode(node) {
      reportNode(context, node, 'runtimeInTypesFile');
    }

    return {
      ExportAllDeclaration: reportRuntimeNode,
      ExportNamedDeclaration(node) {
        if (
          node.source === null &&
          (node.declaration?.type === 'TSTypeAliasDeclaration' ||
            node.declaration?.type === 'TSInterfaceDeclaration')
        ) {
          return;
        }

        reportRuntimeNode(node);
      },
      ImportDeclaration(node) {
        if (node.importKind === 'type') {
          return;
        }

        reportRuntimeNode(node);
      },
      Program(node) {
        for (const statement of node.body) {
          if (
            statement.type === 'ImportDeclaration' ||
            statement.type === 'ExportNamedDeclaration' ||
            statement.type === 'TSTypeAliasDeclaration' ||
            statement.type === 'TSInterfaceDeclaration'
          ) {
            continue;
          }

          reportRuntimeNode(statement);
        }
      },
    };
  },
};

const utilsFileNoTypesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      typeInUtilsFile: 'utils.ts 只能包含工具函数实现，不能定义类型。',
    },
  },
  create(context) {
    const filename = getNormalizedFilename(context);
    if (!isSrcFile(filename) || !isUtilsFile(filename)) {
      return {};
    }

    return {
      TSDeclareFunction(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      TSInterfaceDeclaration(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      TSModuleDeclaration(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      TSTypeAliasDeclaration(node) {
        reportNode(context, node, 'typeInUtilsFile');
      },
      VariableDeclaration(node) {
        if (node.declare === true) {
          reportNode(context, node, 'typeInUtilsFile');
        }
      },
    };
  },
};

export default defineConfig(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  eslintPluginUnicorn.configs.recommended,
  {
    plugins: {
      '@stylistic': eslintPluginStylistic,
      local: {
        rules: {
          'no-import-alias': noImportAliasRule,
          'strategy-private-boundary': strategyPrivateBoundaryRule,
          'strategy-capabilities': strategyCapabilitiesRule,
          'no-redundant-type-alias': redundantTypeAliasRule,
          'type-definitions-location': typeDefinitionsLocationRule,
          'types-file-only-types': typesFileOnlyTypesRule,
          'utils-file-no-types': utilsFileNoTypesRule,
        },
      },
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // 基础可靠性
      // 允许 console（日志系统需要）
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-void-return': 'error',
      '@typescript-eslint/consistent-return': 'error',
      '@typescript-eslint/no-use-before-define': [
        'error',
        {
          functions: false,
          classes: true,
          variables: true,
          typedefs: true,
          enums: true,
        },
      ],

      // TypeScript 语义与边界
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/explicit-member-accessibility': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: true,
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/restrict-template-expressions': restrictTemplateExpressionsRule,
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-useless-empty-export': 'error',

      // 项目规范对齐（关闭与规范冲突的 stylistic/风格规则）
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',

      // TypeScript 额外质量约束
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/no-dupe-class-members': 'error',
      '@typescript-eslint/no-invalid-this': 'error',
      '@typescript-eslint/no-redeclare': 'error',
      '@typescript-eslint/no-unnecessary-parameter-property-assignment': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unused-private-class-members': 'error',
      '@typescript-eslint/prefer-enum-initializers': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/method-signature-style': 'error',
      '@typescript-eslint/class-methods-use-this': 'error',
      '@typescript-eslint/member-ordering': 'error',
      '@typescript-eslint/max-params': [
        'error',
        {
          max: 7,
          countVoidThis: true,
        },
      ],

      // 变量与赋值
      'no-const-assign': 'error',
      'no-import-assign': 'error',
      eqeqeq: ['error', 'always'],
      'no-implicit-coercion': 'error',

      // 循环与控制流
      'default-case': 'error',
      'default-case-last': 'error',
      'no-loop-func': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'max-depth': ['error', { max: 5 }],

      // 调试与全局
      'no-debugger': 'error',
      'no-caller': 'error',

      // 注释与代码卫生
      'no-warning-comments': ['error', { terms: ['todo', 'fixme'], location: 'anywhere' }],

      // 对象与数组
      'no-dupe-keys': 'error',
      'no-object-constructor': 'error',
      'array-callback-return': 'error',
      'no-return-assign': ['error', 'always'],

      // 作用域与命名
      'no-inner-declarations': ['error', 'both'],
      'no-labels': 'error',

      // new 语法约束
      'no-new': 'error',

      // SonarJS 策略调整
      'sonarjs/cognitive-complexity': 'off',

      // ESLint 与 @typescript-eslint 同名规则冲突消解
      'no-unused-private-class-members': 'off',

      // SonarJS 冲突消解（避免与 ESLint / @typescript-eslint 重复报错）
      'sonarjs/no-unused-vars': 'off',
      'sonarjs/no-labels': 'off',
      'sonarjs/no-fallthrough': 'off',

      // 项目风格约束
      'no-duplicate-imports': 'error',
      'no-nested-ternary': 'error',
      'prefer-arrow-callback': 'error',
      'local/no-import-alias': 'error',
      'local/strategy-private-boundary': 'error',
      'local/strategy-capabilities': 'error',
      'local/no-redundant-type-alias': 'error',
      'local/type-definitions-location': 'error',
      'local/types-file-only-types': 'error',
      'local/utils-file-no-types': 'error',

      // Unicorn 规则兼容性调整
      'unicorn/prefer-string-slice': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/numeric-separators-style': 'off',
      'unicorn/catch-error-name': 'off',
      'unicorn/no-null': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/prefer-switch': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-array-sort': 'off',

      // 索引访问表达优化
      'unicorn/prefer-at': [
        'error',
        {
          checkAllIndexAccess: false,
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'unicorn/consistent-function-scoping': [
        'error',
        {
          checkArrowFunctions: true,
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'tools/**/*.ts'],
    rules: {
      // 测试和工具文件统一放宽部分规则，减少实现噪音
      'unicorn/consistent-function-scoping': 'off',
      'local/no-import-alias': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'sonarjs/void-use': 'off',
    },
  },
  ...Object.entries({
    strategies: ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'],
    application: ['app', 'runtime', 'infrastructure', 'core', 'main', 'services'],
    runtime: ['app', 'infrastructure', 'core', 'main', 'services'],
    domain: ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'],
    infrastructure: ['app', 'application', 'runtime', 'domain', 'core', 'main', 'services'],
    types: ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'],
    constants: ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'],
    config: ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'],
    utils: ['app', 'application', 'runtime', 'infrastructure', 'core', 'main', 'services'],
  }).map(([layer, targets]) => ({
    files: [`src/${layer}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(?:(?:../)+|@/)(?:${targets.join('|')})/.+`,
              message: `${layer} 层不得依赖高层或旧 owner，改用最近共同父级窄契约`,
            },
          ],
        },
      ],
    },
  })),
  {
    files: ['src/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            './app/*',
            '!./app/runApp.js',
            './config/*',
            './constants/*',
            './core/*',
            './main/*',
            './services/*',
            './types/*',
            './utils/*',
            '!./utils/error/index.js',
            './infrastructure/*',
            '!./infrastructure/logger/index.js',
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
  {
    // 以下规则须在 Prettier 之后以覆盖其对该规则的关闭
    rules: {
      '@stylistic/lines-around-comment': [
        'error',
        {
          // 行注释（//）上方不强制空行
          beforeLineComment: false,
          // 行注释下方不强制空行
          afterLineComment: false,
          // 块注释（/* */、/** */）上方需空行
          beforeBlockComment: true,
          // 块注释下方不强制空行
          afterBlockComment: false,
          // 块/函数体/switch 等开头处的注释上方无需空行
          allowBlockStart: true,
          // interface 体开头处的注释上方无需空行
          allowInterfaceStart: true,
          // 对象字面量/解构开头处的注释上方无需空行
          allowObjectStart: true,
          // class 体开头处的注释上方无需空行
          allowClassStart: true,
          // 类型字面体（type X = { ... }）开头处的注释上方无需空行
          allowTypeStart: true,
        },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        // import 与顶层其他语句之间必须有空行
        { blankLine: 'always', prev: 'import', next: '*' },
        // 相邻 import 之间不强制空行
        { blankLine: 'any', prev: 'import', next: 'import' },
        // block-like 之间（如 function 与 function）必须有空行
        { blankLine: 'always', prev: 'block-like', next: 'block-like' },
        // 多行表达式之间（如 it 与 it）必须有空行
        { blankLine: 'always', prev: 'multiline-expression', next: 'multiline-expression' },
        // if 语句前：仅当前一条是多行表达式/多行块状语句时才强制空行（块顶部的 if 不会触发）
        { blankLine: 'always', prev: 'multiline-expression', next: 'if' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'if' },
        // if 语句后必须有空行（块尾部的 if 不会触发）
        { blankLine: 'always', prev: 'if', next: '*' },
        // for / while / do / switch / try 前：仅当上一条是多行表达式/多行块状语句时才强制空行（块顶部不触发）
        { blankLine: 'always', prev: 'multiline-expression', next: 'for' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'for' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'while' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'while' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'do' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'do' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'switch' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'switch' },
        { blankLine: 'always', prev: 'multiline-expression', next: 'try' },
        { blankLine: 'always', prev: 'multiline-block-like', next: 'try' },
        // for / while / do / switch / try 后必须有空行（块尾部不触发）
        { blankLine: 'always', prev: 'for', next: '*' },
        { blankLine: 'always', prev: 'while', next: '*' },
        { blankLine: 'always', prev: 'do', next: '*' },
        { blankLine: 'always', prev: 'switch', next: '*' },
        { blankLine: 'always', prev: 'try', next: '*' },
      ],
    },
  },
  {
    ignores: [
      // 构建与依赖产物
      'dist/**',
      'benchmark/**',
      'node_modules/**',

      // 运行日志
      'logs/**',

      // 脚本目录
      'utils/**',
      '*.config.js',
      'scripts/**',

      // 工作目录
      '.worktrees/**',
      '.claude/**',
    ],
  },
);
