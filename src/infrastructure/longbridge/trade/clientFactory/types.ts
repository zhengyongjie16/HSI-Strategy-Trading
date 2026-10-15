import type { WarrantListCacheConfig } from '../../market/warrantListCache/types.js';

/**
 * SDK 认证配置创建参数。
 * 数据来源：app 或离线工具传入环境变量与 OAuth 授权 URL 回调。
 * 使用范围：仅 infrastructure 的 SDK Config 工厂，不携带 SDK 对象作为输入。
 */
export type CreateSdkConfigFromAuthParams = Readonly<{
  env: NodeJS.ProcessEnv;
  onOpenUrl?: (url: string) => void;
}>;

/**
 * Longbridge 客户端工厂参数。
 * 数据来源：app pre-gate 装配认证输入与唯一轮证缓存；创建时仅获取认证配置。
 * 使用范围：客户端工厂私有装配，行情资源与交易资源通过返回的中性能力延迟创建。
 */
export type CreateLongbridgeClientFactoryParams = CreateSdkConfigFromAuthParams &
  Readonly<{
    warrantListCacheConfig?: WarrantListCacheConfig;
  }>;
