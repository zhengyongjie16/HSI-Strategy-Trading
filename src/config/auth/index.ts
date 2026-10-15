/**
 * Longbridge 中性认证配置读取模块。
 * 统一校验环境变量并收窄 OAuth/API Key 必填字段；不创建或持有 SDK Config、OAuth 或 enum。
 */
import {
  readApiKeyAuthConfig,
  readAuthMode,
  readOAuthAuthConfig,
  validateLongbridgeConfig,
} from './utils.js';
import type {
  ResolvedApiKeyAuthConfig,
  ResolvedAuthConfig,
  ResolvedOAuthAuthConfig,
} from './types.js';

function resolveOAuthAuthConfig(env: NodeJS.ProcessEnv): ResolvedOAuthAuthConfig {
  const oauthAuthConfig = readOAuthAuthConfig(env);
  if (oauthAuthConfig.clientId === null) {
    throw new Error('LONGBRIDGE_CLIENT_ID 未配置，无法创建 Longbridge OAuth Config');
  }

  return {
    mode: 'oauth',
    clientId: oauthAuthConfig.clientId,
    callbackPort: oauthAuthConfig.callbackPort,
  };
}

function resolveApiKeyAuthConfig(env: NodeJS.ProcessEnv): ResolvedApiKeyAuthConfig {
  const apiKeyAuthConfig = readApiKeyAuthConfig(env);
  if (
    apiKeyAuthConfig.appKey === null ||
    apiKeyAuthConfig.appSecret === null ||
    apiKeyAuthConfig.accessToken === null
  ) {
    throw new Error('LONGBRIDGE API Key 认证配置未完整填写，无法创建 Longbridge API Key Config');
  }

  return {
    mode: 'apikey',
    appKey: apiKeyAuthConfig.appKey,
    appSecret: apiKeyAuthConfig.appSecret,
    accessToken: apiKeyAuthConfig.accessToken,
  };
}

/** 校验全部认证/扩展配置后返回已收窄的中性认证字段，错误仍使用首个校验问题。 */
export function readLongbridgeAuthConfig(env: NodeJS.ProcessEnv): ResolvedAuthConfig {
  const validationIssues = validateLongbridgeConfig(env);
  if (validationIssues.length > 0) {
    throw new Error(validationIssues[0]?.message ?? 'Longbridge 配置无效');
  }

  const authMode = readAuthMode(env);
  if (authMode === null) {
    throw new Error('LONGBRIDGE_AUTH_MODE 未配置或无效，无法创建 Longbridge SDK Config');
  }

  return authMode === 'oauth' ? resolveOAuthAuthConfig(env) : resolveApiKeyAuthConfig(env);
}
