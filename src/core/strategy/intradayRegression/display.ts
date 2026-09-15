/** 策略指标展示投影；名称、顺序和三位小数均由本策略解释，宿主自行展示报价。 */
import type { StrategyDisplayItem } from '../types.js';
import type { IndicatorSnapshot } from './types.js';
import type { IndicatorUsageProfile } from './profile/types.js';
import { getIndicatorValue, parseIndicatorPeriod } from './indicatorHelpers/utils.js';

/** 从本轮画像生成一次显示投影；缺失指标保持旧行为：不显示。 */
export function buildStrategyDisplay(
  snapshot: IndicatorSnapshot,
  profile: IndicatorUsageProfile,
): ReadonlyArray<StrategyDisplayItem> {
  const items: StrategyDisplayItem[] = [];
  for (const indicator of profile.displayPlan) {
    if (indicator === 'price' || indicator === 'changePercent') continue;

    let value: number | null;
    if (indicator === 'MFI') value = snapshot.mfi;
    else if (indicator.startsWith('RSI:')) {
      const period = parseIndicatorPeriod({ indicatorName: indicator, prefix: 'RSI:' });
      value = period === null ? null : (snapshot.rsi?.[period] ?? null);
    } else value = getIndicatorValue(snapshot, indicator);

    if (value === null || !Number.isFinite(value)) continue;

    items.push(Object.freeze({ label: indicator.replace(':', ''), valueText: value.toFixed(3) }));
  }

  return Object.freeze(items);
}
