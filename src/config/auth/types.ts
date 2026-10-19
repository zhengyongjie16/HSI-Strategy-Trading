/**
 * 认证模式。
 * 类型用途：约束 Longbridge SDK 认证来源，仅允许 oauth 或 apikey。
 * 数据来源：由 LONGBRIDGE_AUTH_MODE 环境变量解析得到。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type AuthMode = 'oauth' | 'apikey';

/**
 * OAuth 认证配置读取结果。
 * 类型用途：表达 OAuth 模式字段的解析结果，便于校验层与工厂层复用。
 * 数据来源：由 config/auth/utils 解析环境变量后得到。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type OAuthAuthConfig = {
  readonly clientId: string | null;
  readonly callbackPort: number | null;
};

/**
 * API Key 认证配置读取结果。
 * 类型用途：表达 API Key 模式字段的解析结果，便于校验层与工厂层复用。
 * 数据来源：由 config/auth/utils 解析环境变量后得到。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type ApiKeyAuthConfig = {
  readonly appKey: string | null;
  readonly appSecret: string | null;
  readonly accessToken: string | null;
};

/**
 * 已完成必填字段解析的 OAuth 认证配置。
 * 类型用途：向 infrastructure 认证工厂提供已校验的中性 OAuth 参数。
 * 数据来源：由 config/auth/index 在确认必填字段完整后构造。
 * 使用范围：config/auth 与 infrastructure 认证工厂。
 */
export type ResolvedOAuthAuthConfig = {
  readonly mode: 'oauth';
  readonly clientId: string;
  readonly callbackPort: number | null;
};

/**
 * 已完成必填字段解析的 API Key 认证配置。
 * 类型用途：向 infrastructure 认证工厂提供已校验的中性 API Key 参数。
 * 数据来源：由 config/auth/index 在确认必填字段完整后构造。
 * 使用范围：config/auth 与 infrastructure 认证工厂。
 */
export type ResolvedApiKeyAuthConfig = {
  readonly mode: 'apikey';
  readonly appKey: string;
  readonly appSecret: string;
  readonly accessToken: string;
};

/**
 * 已解析完成的统一认证配置联合类型。
 * 类型用途：表达已校验的认证模式及其原始文本参数，不携带 SDK 认证句柄。
 * 数据来源：由 config/auth/index 在校验通过后构造。
 * 使用范围：config/auth 与 infrastructure 认证工厂。
 */
export type ResolvedAuthConfig = ResolvedOAuthAuthConfig | ResolvedApiKeyAuthConfig;

/**
 * Longbridge 中性扩展配置。
 * 数据来源：由 config/auth/utils 读取环境变量文本、布尔值与内部模式标签。
 * 使用范围：配置读取与 infrastructure extra 参数映射，不携带 SDK enum。
 */
export type LongbridgeExtraConfig = {
  readonly httpUrl?: string;
  readonly quoteWsUrl?: string;
  readonly tradeWsUrl?: string;
  readonly language?: 'zh-CN' | 'zh-HK' | 'en';
  readonly enableOvernight?: boolean;
  readonly pushCandlestickMode?: 'realtime' | 'confirmed';
  readonly enablePrintQuotePackages?: boolean;
  readonly logPath?: string;
};

/**
 * Longbridge 认证与 SDK extra 配置校验问题。
 * 类型用途：统一表达 auth 模块内可复用的环境变量校验结果，供校验层与工厂层共享。
 * 数据来源：由 config/auth/utils 中的校验函数生成。
 * 使用范围：仅 config/auth 模块与配置校验层使用。
 */
export type LongbridgeConfigValidationIssue = Readonly<{
  message: string;
}>;
