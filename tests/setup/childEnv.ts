/** 子进程离线环境：只继承运行工具所需系统键，用户目录与输出均落到调用方隔离根。 */
import fs from 'node:fs';
import path from 'node:path';

/** 为可信测试构造独立环境；不继承凭证、运行时注入参数或 DEBUG 开关。 */
export function createChildEnv(isolationRoot: string): NodeJS.ProcessEnv {
  if (!path.isAbsolute(isolationRoot)) {
    throw new Error('Child isolation root must be absolute');
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'ComSpec', 'NUMBER_OF_PROCESSORS']) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const toolPath = process.env['PATH'] ?? process.env['Path'];
  if (toolPath !== undefined) {
    env['PATH'] = toolPath;
  }

  const home = path.join(isolationRoot, 'home');
  const appData = path.join(isolationRoot, 'appdata');
  const localAppData = path.join(isolationRoot, 'localappdata');
  const temp = path.join(isolationRoot, 'tmp');
  const logs = path.join(isolationRoot, 'logs');
  for (const directory of [home, appData, localAppData, temp, logs]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: appData,
    XDG_CACHE_HOME: localAppData,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    NODE_ENV: 'test',
    APP_RUNTIME_PROFILE: 'test',
    APP_ENABLE_PROCESS_HOOKS: 'false',
    APP_LOG_ROOT_DIR: logs,
  };
}
