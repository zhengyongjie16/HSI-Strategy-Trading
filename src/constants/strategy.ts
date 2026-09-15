/**
 * 策略发现共享常量模块
 *
 * 职责：集中维护免注册策略目录发现所需的身份规则、固定文件名和跨平台名称约束；
 * 不包含具体策略 ID、配置内容或注册表。
 */

/** 启动时按 presence 拒绝的旧策略环境键；空值也不允许，不提供兼容回退。 */
export const LEGACY_STRATEGY_ENV_KEYS: ReadonlyArray<string> = [
  'SIGNAL_BUYCALL',
  'SIGNAL_SELLCALL',
  'SIGNAL_BUYPUT',
  'SIGNAL_SELLPUT',
  'VERIFICATION_DELAY_SECONDS_BUY',
  'VERIFICATION_DELAY_SECONDS_SELL',
  'VERIFICATION_INDICATORS_BUY',
  'VERIFICATION_INDICATORS_SELL',
];

/** 严格 kebab-case 策略 ID 规则。 */
export const STRATEGY_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/;

/** 策略入口文件的固定基础名称；运行时按 source/dist 模式追加扩展名。 */
export const STRATEGY_DEFINITION_FILE_NAME = 'definition';

/** 策略配置资产的固定文件名。 */
export const STRATEGY_CONFIG_FILE_NAME = 'config.json';

/** 策略入口固定的命名导出。 */
export const STRATEGY_DEFINITION_EXPORT_NAME = 'strategyDefinition';

/** Windows 保留设备名；目录校验不依赖当前文件系统是否大小写敏感。 */
export const STRATEGY_WINDOWS_RESERVED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'AUX',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'CON',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'NUL',
  'PRN',
]);
