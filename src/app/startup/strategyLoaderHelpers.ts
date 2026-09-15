/**
 * 策略加载边界校验模块。
 * 启动使用精确路径、真实文件边界与 unknown 模块校验，不创建策略实例。
 */
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  STRATEGY_CONFIG_FILE_NAME,
  STRATEGY_DEFINITION_EXPORT_NAME,
  STRATEGY_DEFINITION_FILE_NAME,
} from '../../constants/strategy.js';
import { strategyDirectoryNameToId } from '../../core/strategy/utils.js';
import type { PreparedStrategy, StrategyDefinition } from '../../core/strategy/types.js';
import type { StrategyFileSystem, StrategyLocation } from './types.js';

/** 拒绝链接/junction 与错误类型，并按完整相对路径验证真实文件边界。 */
export async function assertStrategyNode(
  path: string,
  kind: 'directory' | 'file',
  fs: StrategyFileSystem,
  parentPath?: string,
): Promise<void> {
  const status = await fs.lstat(path);
  if (status.isSymbolicLink() || !(kind === 'directory' ? status.isDirectory() : status.isFile())) {
    throw new Error(`[Strategy:metadata] 非普通${kind}: ${path}`);
  }

  const actualPath = await fs.realpath(path);
  if (parentPath !== undefined) {
    const actualParent = await fs.realpath(parentPath);
    if (nodePath.relative(actualParent, actualPath) !== nodePath.relative(parentPath, path)) {
      throw new Error(`[Strategy:metadata] 真实路径越界或拼写不符: ${path}`);
    }
  }
}

/** 按枚举实际名称确认固定文件，阻止大小写容错和运行器隐式扩展名解析。 */
export async function inspectStrategyLocation(
  rootPath: string,
  directoryName: string,
  extension: '.ts' | '.js',
  fs: StrategyFileSystem,
): Promise<StrategyLocation> {
  const strategyId = strategyDirectoryNameToId(directoryName);
  const directoryPath = nodePath.join(rootPath, directoryName);
  await assertStrategyNode(directoryPath, 'directory', fs, rootPath);
  const names = await fs.readDirectory(directoryPath);
  const definitionName = `${STRATEGY_DEFINITION_FILE_NAME}${extension}`;
  const requiredNames = [definitionName, STRATEGY_CONFIG_FILE_NAME];
  for (const name of requiredNames) {
    if (
      !names.includes(name) ||
      names.filter((item) => item.toLowerCase() === name.toLowerCase()).length !== 1
    ) {
      throw new Error(
        `[Strategy:metadata] 必需文件缺失或大小写冲突: ${nodePath.join(directoryPath, name)}`,
      );
    }

    await assertStrategyNode(nodePath.join(directoryPath, name), 'file', fs, directoryPath);
  }

  return {
    strategyId,
    definitionPath: nodePath.join(directoryPath, definitionName),
  };
}

/** unknown 定义结构检查；函数体仍为可信本地程序，不假称这是沙箱。 */
function isStrategyDefinition(value: unknown): value is StrategyDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'prepare' in value &&
    typeof value.prepare === 'function' &&
    !('then' in value)
  );
}

/** 拒绝 Promise/thenable，确保配置已经同步准备完成。 */
function isPreparedStrategy(value: unknown): value is PreparedStrategy {
  return (
    typeof value === 'object' &&
    value !== null &&
    'create' in value &&
    typeof value.create === 'function' &&
    !('then' in value)
  );
}

/** 导入一次并保留求值失败 cause，核对固定导出、身份。 */
export async function importStrategyDefinition(
  location: StrategyLocation,
  fs: StrategyFileSystem,
): Promise<StrategyDefinition> {
  let module: unknown;
  try {
    module = await fs.importModule(pathToFileURL(location.definitionPath).href);
  } catch (cause) {
    throw new Error(`[Strategy:import] 加载入口失败: ${location.definitionPath}`, { cause });
  }

  if (
    typeof module !== 'object' ||
    module === null ||
    !(STRATEGY_DEFINITION_EXPORT_NAME in module)
  ) {
    throw new Error(`[Strategy:definition] 缺少命名导出 ${STRATEGY_DEFINITION_EXPORT_NAME}`);
  }

  const definition: unknown = Reflect.get(module, STRATEGY_DEFINITION_EXPORT_NAME);
  if (!isStrategyDefinition(definition)) {
    throw new Error('[Strategy:definition] strategyDefinition 契约错误');
  }

  if (definition.id !== location.strategyId) {
    throw new Error(`[Strategy:definition] ID 不一致: ${definition.id} / ${location.strategyId}`);
  }

  return definition;
}

/** 同步 prepare 静态导入的配置；保持错误阶段与 cause，不接受异步结果。 */
export function prepareStrategyDefinition(definition: StrategyDefinition): PreparedStrategy {
  let prepared: unknown;
  try {
    prepared = definition.prepare();
  } catch (cause) {
    throw new Error(`[Strategy:prepare] 策略配置准备失败: ${definition.id}`, { cause });
  }

  if (!isPreparedStrategy(prepared)) {
    throw new Error(`[Strategy:prepare] prepare 必须同步返回含 create 的对象: ${definition.id}`);
  }

  return prepared;
}
