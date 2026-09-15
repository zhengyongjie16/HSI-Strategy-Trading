/**
 * 单活跃策略准备模块。
 * env presence 检查 → 模块相对精确定位 → 只导入/prepare 选中项一次，不创建实例或 SDK。
 */
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_STRATEGY_ENV_KEYS } from '../../constants/strategy.js';
import { strategyIdToDirectoryName } from '../../core/strategy/utils.js';
import {
  assertStrategyNode,
  importStrategyDefinition,
  inspectStrategyLocation,
  prepareStrategyDefinition,
} from './strategyLoaderHelpers.js';
import type {
  PrepareStrategyDeps,
  PrepareStrategyParams,
  PreparedStrategySelection,
} from './types.js';

/** 在任何文件/模块读取前拒绝旧配置键，包含空值，不提供默认或兼容回退。 */
function readActiveStrategyId({ env }: PrepareStrategyParams): string {
  const presentKeys = LEGACY_STRATEGY_ENV_KEYS.filter((key) => Object.hasOwn(env, key));
  if (presentKeys.length > 0) {
    throw new Error(
      `[Strategy:selection] 请删除旧策略环境键（空值也不允许）: ${presentKeys.join(', ')}`,
    );
  }

  const strategyId = env['ACTIVE_STRATEGY_ID'];
  if (typeof strategyId !== 'string') {
    throw new TypeError('[Strategy:selection] 必须显式设置 ACTIVE_STRATEGY_ID');
  }

  return strategyId;
}

/** 准备唯一选中策略，所有模块/配置错误均先于 composition root 的 SDK 创建。 */
export async function prepareStrategy(
  params: PrepareStrategyParams,
  deps: PrepareStrategyDeps,
): Promise<PreparedStrategySelection> {
  const strategyId = readActiveStrategyId(params);
  const directoryName = strategyIdToDirectoryName(strategyId);
  const moduleUrl = new URL(deps.loaderModuleHref ?? import.meta.url);
  if (moduleUrl.protocol !== 'file:' || moduleUrl.search !== '' || moduleUrl.hash !== '') {
    throw new Error('[Strategy:location] 加载器必须使用无 query/hash 的本地模块 URL');
  }

  const extension = nodePath.extname(fileURLToPath(moduleUrl));
  if (extension !== '.ts' && extension !== '.js') {
    throw new Error('[Strategy:location] 不支持的加载器扩展名: ' + extension);
  }

  const rootPath = nodePath.resolve(fileURLToPath(new URL('../../core/strategy/', moduleUrl)));
  await assertStrategyNode(rootPath, 'directory', deps);
  const names = await deps.readDirectory(rootPath);
  if (
    !names.includes(directoryName) ||
    names.filter((name) => name.toLowerCase() === directoryName.toLowerCase()).length !== 1
  ) {
    throw new Error('[Strategy:selection] 选中目录不存在、拼写不符或大小写冲突: ' + directoryName);
  }

  const location = await inspectStrategyLocation(rootPath, directoryName, extension, deps);
  const definition = await importStrategyDefinition(location, deps);
  return { strategyId, prepared: prepareStrategyDefinition(definition) };
}
