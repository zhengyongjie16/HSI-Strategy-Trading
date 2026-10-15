/**
 * Longbridge SDK 认证配置工厂。
 * config 层只读取和校验中性配置；此边界独占 OAuth、SDK enum、extra 参数与 Config 的创建。
 * 同时供真实客户端装配与直接使用 SDK 的离线工具使用，不向 app 返回 SDK 对象。
 */
import { Config, Language, OAuth, PushCandlestickMode, type ExtraConfigParams } from 'longbridge';
import { readLongbridgeAuthConfig } from '../../../../config/auth/index.js';
import { readLongbridgeExtraConfig } from '../../../../config/auth/utils.js';
import type {
  LongbridgeExtraConfig,
  ResolvedOAuthAuthConfig,
} from '../../../../config/auth/types.js';
import type { CreateSdkConfigFromAuthParams } from './types.js';

/** 将已校验的语言文本映射为 SDK enum，不将第三方数值传回 config。 */
function mapLanguage(language: NonNullable<LongbridgeExtraConfig['language']>): Language {
  if (language === 'zh-CN') return Language.ZH_CN;

  return language === 'zh-HK' ? Language.ZH_HK : Language.EN;
}

/** 将已校验的 K 线推送模式映射为 SDK enum。 */
function mapPushCandlestickMode(
  mode: NonNullable<LongbridgeExtraConfig['pushCandlestickMode']>,
): PushCandlestickMode {
  return mode === 'realtime' ? PushCandlestickMode.Realtime : PushCandlestickMode.Confirmed;
}

/** 仅在第三方边界创建官方 extra 对象，未配置的可选字段保持缺失。 */
function mapExtraConfig(config: LongbridgeExtraConfig): ExtraConfigParams {
  const { language, pushCandlestickMode, ...extra } = config;
  return {
    ...extra,
    ...(language === undefined ? {} : { language: mapLanguage(language) }),
    ...(pushCandlestickMode === undefined
      ? {}
      : { pushCandlestickMode: mapPushCandlestickMode(pushCandlestickMode) }),
  };
}

/** 保留 SDK OAuth 的 URL/error 回调与可选端口语义，不新增取消或释放协议。 */
async function buildOAuth(authConfig: ResolvedOAuthAuthConfig, onOpenUrl?: (url: string) => void) {
  return await OAuth.build(
    authConfig.clientId,
    (error: Error | null, url: string) => {
      if (error !== null) {
        throw error;
      }

      onOpenUrl?.(url);
    },
    authConfig.callbackPort ?? undefined,
  );
}

/** 先读取校验配置，再按认证模式创建一次 SDK Config。 */
export async function createSdkConfigFromAuth(
  params: CreateSdkConfigFromAuthParams,
): Promise<Config> {
  const { env, onOpenUrl } = params;
  const authConfig = readLongbridgeAuthConfig(env);
  const extraConfig = mapExtraConfig(readLongbridgeExtraConfig(env));

  if (authConfig.mode === 'oauth') {
    const oauth = await buildOAuth(authConfig, onOpenUrl);
    return Config.fromOAuth(oauth, extraConfig);
  }

  return Config.fromApikey(
    authConfig.appKey,
    authConfig.appSecret,
    authConfig.accessToken,
    extraConfig,
  );
}
