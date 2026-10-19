import { getStringConfig } from '../utils.js';
import type {
  ApiKeyAuthConfig,
  AuthMode,
  LongbridgeConfigValidationIssue,
  LongbridgeExtraConfig,
  OAuthAuthConfig,
} from './types.js';

const VALID_AUTH_MODE_VALUES = new Set(['oauth', 'apikey']);
const VALID_LONGBRIDGE_LANGUAGE_VALUES = new Set(['zh-CN', 'zh-HK', 'en']);
const VALID_LONGBRIDGE_PUSH_CANDLESTICK_MODE_VALUES = new Set(['realtime', 'confirmed']);
const VALID_BOOLEAN_CONFIG_VALUES = new Set(['true', 'false']);

/**
 * 解析布尔环境变量文本。
 *
 * @param value 原始环境变量值
 * @returns `true`、`false` 或无法识别时的 `undefined`
 */
function parseBooleanEnvValue(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

/**
 * 解析 OAuth 回调端口配置。
 *
 * @param env 进程环境变量
 * @returns 合法端口号；未配置或非法时返回 null
 */
function parseCallbackPort(env: NodeJS.ProcessEnv): number | null {
  const callbackPortValue = getStringConfig(env, 'LONGBRIDGE_CALLBACK_PORT');
  if (callbackPortValue === null) {
    return null;
  }

  const callbackPort = Number(callbackPortValue);
  if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535) {
    return null;
  }

  return callbackPort;
}

/**
 * 判断原始认证模式字符串是否属于受支持的 SDK 认证模式。
 *
 * @param value 原始认证模式字符串
 * @returns true 表示可收窄为 AuthMode
 */
function isAuthMode(value: string): value is AuthMode {
  return value === 'oauth' || value === 'apikey';
}

/**
 * 读取可选语言配置。
 *
 * @param env 进程环境变量
 * @returns 中性语言文本；未配置或非法时返回 undefined
 */
function readOptionalLanguage(env: NodeJS.ProcessEnv): LongbridgeExtraConfig['language'] {
  const languageValue = getStringConfig(env, 'LONGBRIDGE_LANGUAGE');
  return languageValue === 'zh-CN' || languageValue === 'zh-HK' || languageValue === 'en'
    ? languageValue
    : undefined;
}

/**
 * 读取可选 K 线推送模式配置。
 *
 * @param env 进程环境变量
 * @returns 中性推送模式文本；未配置或非法时返回 undefined
 */
function readOptionalPushCandlestickMode(
  env: NodeJS.ProcessEnv,
): LongbridgeExtraConfig['pushCandlestickMode'] {
  const mode = getStringConfig(env, 'LONGBRIDGE_PUSH_CANDLESTICK_MODE');
  return mode === 'realtime' || mode === 'confirmed' ? mode : undefined;
}

/**
 * 读取认证模式。
 * 默认行为：仅识别 oauth / apikey；非法值返回 null，由校验层报错。
 *
 * @param env 进程环境变量
 * @returns 认证模式，未配置或无效时返回 null
 */
export function readAuthMode(env: NodeJS.ProcessEnv): AuthMode | null {
  const authModeValue = getStringConfig(env, 'LONGBRIDGE_AUTH_MODE');
  if (authModeValue === null || !isAuthMode(authModeValue)) {
    return null;
  }

  return authModeValue;
}

/**
 * 读取 OAuth 认证配置。
 * 默认行为：仅解析 client_id 与 callback_port；非法 callback_port 返回 null，由校验层报错。
 *
 * @param env 进程环境变量
 * @returns OAuth 认证配置解析结果
 */
export function readOAuthAuthConfig(env: NodeJS.ProcessEnv): OAuthAuthConfig {
  return {
    clientId: getStringConfig(env, 'LONGBRIDGE_CLIENT_ID'),
    callbackPort: parseCallbackPort(env),
  };
}

/**
 * 读取 API Key 认证配置。
 * 默认行为：仅解析 API Key 三元组，未配置或占位值返回 null，由校验层报错。
 *
 * @param env 进程环境变量
 * @returns API Key 认证配置解析结果
 */
export function readApiKeyAuthConfig(env: NodeJS.ProcessEnv): ApiKeyAuthConfig {
  return {
    appKey: getStringConfig(env, 'LONGBRIDGE_APP_KEY'),
    appSecret: getStringConfig(env, 'LONGBRIDGE_APP_SECRET'),
    accessToken: getStringConfig(env, 'LONGBRIDGE_ACCESS_TOKEN'),
  };
}

/**
 * 读取 Longbridge 中性扩展配置。
 * 默认行为：只解析已支持的环境字段，SDK extra 对象与 enum 由 infrastructure 映射。
 *
 * @param env 进程环境变量
 * @returns 不含 SDK 类型且未配置字段保持缺失的扩展配置
 */
export function readLongbridgeExtraConfig(env: NodeJS.ProcessEnv): LongbridgeExtraConfig {
  const enableOvernight = parseBooleanEnvValue(getStringConfig(env, 'LONGBRIDGE_ENABLE_OVERNIGHT'));
  const enablePrintQuotePackages = parseBooleanEnvValue(
    getStringConfig(env, 'LONGBRIDGE_PRINT_QUOTE_PACKAGES'),
  );
  const httpUrl = getStringConfig(env, 'LONGBRIDGE_HTTP_URL');
  const quoteWsUrl = getStringConfig(env, 'LONGBRIDGE_QUOTE_WS_URL');
  const tradeWsUrl = getStringConfig(env, 'LONGBRIDGE_TRADE_WS_URL');
  const language = readOptionalLanguage(env);
  const pushCandlestickMode = readOptionalPushCandlestickMode(env);
  const logPath = getStringConfig(env, 'LONGBRIDGE_LOG_PATH');

  return {
    ...(httpUrl === null ? {} : { httpUrl }),
    ...(quoteWsUrl === null ? {} : { quoteWsUrl }),
    ...(tradeWsUrl === null ? {} : { tradeWsUrl }),
    ...(language === undefined ? {} : { language }),
    ...(enableOvernight === undefined ? {} : { enableOvernight }),
    ...(pushCandlestickMode === undefined ? {} : { pushCandlestickMode }),
    ...(enablePrintQuotePackages === undefined ? {} : { enablePrintQuotePackages }),
    ...(logPath === null ? {} : { logPath }),
  };
}

/**
 * 校验 Longbridge 认证与 SDK extra 配置。
 *
 * @param env 进程环境变量
 * @returns 当前 env 中所有认证/extra 配置问题；为空表示校验通过
 */
export function validateLongbridgeConfig(
  env: NodeJS.ProcessEnv,
): ReadonlyArray<LongbridgeConfigValidationIssue> {
  const issues: LongbridgeConfigValidationIssue[] = [];
  const authModeValue = getStringConfig(env, 'LONGBRIDGE_AUTH_MODE');
  const authMode = readAuthMode(env);

  if (authModeValue === null) {
    issues.push({
      message: 'LONGBRIDGE_AUTH_MODE 未配置',
    });
  } else if (!VALID_AUTH_MODE_VALUES.has(authModeValue) || authMode === null) {
    issues.push({
      message: 'LONGBRIDGE_AUTH_MODE 无效（仅支持 oauth / apikey）',
    });
  }

  if (authMode === 'oauth') {
    const oauthAuthConfig = readOAuthAuthConfig(env);
    if (oauthAuthConfig.clientId === null) {
      issues.push({
        message: 'LONGBRIDGE_CLIENT_ID 未配置',
      });
    }

    const callbackPortValue = getStringConfig(env, 'LONGBRIDGE_CALLBACK_PORT');
    if (callbackPortValue !== null && oauthAuthConfig.callbackPort === null) {
      issues.push({
        message: 'LONGBRIDGE_CALLBACK_PORT 无效（必须为 1-65535 的整数端口）',
      });
    }
  }

  if (authMode === 'apikey') {
    const apiKeyAuthConfig = readApiKeyAuthConfig(env);
    const requiredApiKeyFields = [
      {
        envKey: 'LONGBRIDGE_APP_KEY',
        value: apiKeyAuthConfig.appKey,
      },
      {
        envKey: 'LONGBRIDGE_APP_SECRET',
        value: apiKeyAuthConfig.appSecret,
      },
      {
        envKey: 'LONGBRIDGE_ACCESS_TOKEN',
        value: apiKeyAuthConfig.accessToken,
      },
    ] as const;

    for (const field of requiredApiKeyFields) {
      if (field.value !== null) {
        continue;
      }

      issues.push({
        message: `${field.envKey} 未配置`,
      });
    }
  }

  const urlConfigKeys = [
    'LONGBRIDGE_HTTP_URL',
    'LONGBRIDGE_QUOTE_WS_URL',
    'LONGBRIDGE_TRADE_WS_URL',
  ] as const;
  for (const urlConfigKey of urlConfigKeys) {
    const urlValue = getStringConfig(env, urlConfigKey);
    if (urlValue !== null && !URL.canParse(urlValue)) {
      issues.push({
        message: `${urlConfigKey} 无效（必须为合法 URL）`,
      });
    }
  }

  const languageValue = getStringConfig(env, 'LONGBRIDGE_LANGUAGE');
  if (languageValue !== null && !VALID_LONGBRIDGE_LANGUAGE_VALUES.has(languageValue)) {
    issues.push({
      message: 'LONGBRIDGE_LANGUAGE 无效（仅支持 zh-CN / zh-HK / en）',
    });
  }

  const pushCandlestickModeValue = getStringConfig(env, 'LONGBRIDGE_PUSH_CANDLESTICK_MODE');
  if (
    pushCandlestickModeValue !== null &&
    !VALID_LONGBRIDGE_PUSH_CANDLESTICK_MODE_VALUES.has(pushCandlestickModeValue)
  ) {
    issues.push({
      message: 'LONGBRIDGE_PUSH_CANDLESTICK_MODE 无效（仅支持 realtime / confirmed）',
    });
  }

  const booleanConfigKeys = [
    'LONGBRIDGE_ENABLE_OVERNIGHT',
    'LONGBRIDGE_PRINT_QUOTE_PACKAGES',
  ] as const;
  for (const booleanConfigKey of booleanConfigKeys) {
    const booleanValue = getStringConfig(env, booleanConfigKey);
    if (booleanValue !== null && !VALID_BOOLEAN_CONFIG_VALUES.has(booleanValue)) {
      issues.push({
        message: `${booleanConfigKey} 无效（仅支持 true / false）`,
      });
    }
  }

  return issues;
}
