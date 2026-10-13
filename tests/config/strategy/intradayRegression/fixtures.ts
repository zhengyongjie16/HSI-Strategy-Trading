/** 策略配置测试数据：全显式配置，非法边界只由测试参数注入。 */
import type { ConfigFixture } from './types.js';

/** 产生全显式离线配置，测试参数不写入正式 config.json。 */
export function configObject(
  buyDelay = 0,
  sellDelay = 0,
  buyIndicators: ReadonlyArray<string> = [],
  sellIndicators: ReadonlyArray<string> = [],
): ConfigFixture {
  return {
    signals: {
      BUYCALL: '(K>-1000)',
      SELLCALL: '(K>-1000)',
      BUYPUT: '(K>-1000)',
      SELLPUT: '(K>-1000)',
    },
    verification: {
      buy: { delaySeconds: buyDelay, indicators: buyIndicators },
      sell: { delaySeconds: sellDelay, indicators: sellIndicators },
    },
  };
}
