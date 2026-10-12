/** P0 冻结清单加载：显式类型避免大型 JSON 的匿名联合推断吞掉架构类型检查。 */
import { readFileSync } from 'node:fs';
import type { Baseline } from './types.js';

export const baseline = JSON.parse(
  readFileSync(new URL('baseline.json', import.meta.url), 'utf8'),
) as Baseline;
