/** SDK Config 替身只供 adapter 测试注入；不创建 native 配置或真实认证能力。 */
import type { Config } from 'longbridge';

/** 创建满足 SDK 工厂注入边界的最小 Config，不向 app 测试提供 SDK 对象。 */
export function createSdkConfigDouble(): Config {
  return { refreshAccessToken: () => Promise.resolve('') };
}
