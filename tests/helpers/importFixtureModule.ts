/** 临时构建工程的离线模块加载边界：只求值显式 source/dist 入口或测试策略定义，拒绝路径注入。 */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 加载真实临时工程中的既有装配入口；先解析实际文件再验证根目录、入口和布局。
 * 不接受 query/fragment、私有 leaf、越界路径或指向工程外的符号链接。
 * @param root 临时工程根目录
 * @param href 该工程内待加载模块的 file URL
 * @returns 模块原始导出，由调用场景核对其契约
 */
export async function importFixtureModule(root: string, href: string): Promise<unknown> {
  const url = new URL(href);
  if (url.protocol !== 'file:' || url.search !== '' || url.hash !== '') {
    throw new Error('Fixture import requires an unqualified local file URL');
  }

  const [directory, file] = await Promise.all([realpath(root), realpath(fileURLToPath(url))]);
  const relative = path.relative(directory, file).replaceAll('\\', '/');
  const layout = relative.startsWith('dist/src/') ? 'dist/src/' : 'src/';
  const extension = layout === 'src/' ? '.ts' : '.js';
  const entry = relative.slice(layout.length, -extension.length);
  const entries = new Set([
    'app/startup/prepareStrategy',
    'app/startup/createSelectedStrategy',
    'app/shutdown/createCleanup',
    'runtime/businessEventProgram/index',
    'runtime/asyncProgram/tradeTaskQueue/index',
    'runtime/lifecycle/terminationRuntime',
    'domain/seat/symbolRegistry',
  ]);
  const definition = /^app\/startup\/strategyDefinitions\/[a-z][a-zA-Z0-9]*\/definition$/.test(
    entry,
  );
  if (
    !relative.startsWith(layout) ||
    !relative.endsWith(extension) ||
    (!entries.has(entry) && !definition)
  ) {
    throw new Error('Fixture import is outside the reviewed source/dist entry boundary');
  }

  return import(pathToFileURL(file).href);
}
