/** 策略配置准备：静态 JSON 对象精确校验、旧 DSL 编译与递归冻结；不读取文件。 */
import { compileIndicatorUsageProfile } from './profile/index.js';
import { isSupportedVerificationIndicator, parseProfileIndicator } from './profile/utils.js';
import { parseSignalConfig } from './dsl.js';
import type { SignalConfig, SingleVerificationConfig, StrategyConfig } from './types.js';

/** 按精确键集合收窄 JSON 对象，拒绝 null、数组和未知字段。 */
function exactObject(value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('配置字段必须为对象');
  }

  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new Error(`配置字段必须精确包含 ${keys.join(', ')}`);
  }

  // Object.entries 只用于已经通过精确键检查的 JSON 普通对象。
  return Object.fromEntries(Object.entries(value));
}

/** 解析显式 BUY/SELL 验证政策，保留小数延迟及名称规范化和首次出现顺序。 */
function parseVerification(value: unknown): SingleVerificationConfig {
  const object = exactObject(value, ['delaySeconds', 'indicators']);
  const delaySeconds = object['delaySeconds'];
  const source = object['indicators'];
  if (
    typeof delaySeconds !== 'number' ||
    !Number.isFinite(delaySeconds) ||
    delaySeconds < 0 ||
    delaySeconds > 120
  ) {
    throw new Error('delaySeconds 必须为 0–120 的有限数字');
  }

  if (!Array.isArray(source)) throw new Error('indicators 必须为显式字符串数组');

  const indicators: string[] = [];
  for (const item of source) {
    if (typeof item !== 'string') throw new Error('验证指标必须为字符串');

    const indicator = parseProfileIndicator(item.trim());
    if (indicator === null || !isSupportedVerificationIndicator(indicator)) {
      throw new Error(`不支持的验证指标: ${item}`);
    }

    if (!indicators.includes(indicator)) indicators.push(indicator);
  }

  return { delaySeconds, indicators };
}

/** 读取显式非空表达式，保留原文，不从日志格式反向序列化。 */
function expression(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('signals 必须为非空字符串');

  return value;
}

/** 以原 parser 接受集合编译表达式，无 null 禁用和默认规则。 */
function compileExpression(text: string): SignalConfig {
  const result = parseSignalConfig(text);
  if (result === null) throw new Error(`无效信号表达式: ${text}`);

  return result;
}

/** 递归冻结新建的普通数据值；配置中没有可变 Map/Set。 */
function freezeTree(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeTree(child);

    Object.freeze(value);
  }
}

/** 同步纯解析与编译，所有结构错误直接暴露给准备边界。 */
export function parseStrategyConfig(value: unknown): StrategyConfig {
  const top = exactObject(value, ['signals', 'verification']);
  const rawSignals = exactObject(top['signals'], ['BUYCALL', 'SELLCALL', 'BUYPUT', 'SELLPUT']);
  const rawVerification = exactObject(top['verification'], ['buy', 'sell']);
  const signals = {
    BUYCALL: expression(rawSignals['BUYCALL']),
    SELLCALL: expression(rawSignals['SELLCALL']),
    BUYPUT: expression(rawSignals['BUYPUT']),
    SELLPUT: expression(rawSignals['SELLPUT']),
  };
  const signalConfig = {
    buycall: compileExpression(signals.BUYCALL),
    sellcall: compileExpression(signals.SELLCALL),
    buyput: compileExpression(signals.BUYPUT),
    sellput: compileExpression(signals.SELLPUT),
  };
  const verification = {
    buy: parseVerification(rawVerification['buy']),
    sell: parseVerification(rawVerification['sell']),
  };
  const profile = compileIndicatorUsageProfile({ signalConfig, verificationConfig: verification });
  const config = { signals, signalConfig, verification, profile };
  freezeTree(config);
  return config;
}
