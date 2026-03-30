/**
 * 趋势策略展示辅助模块
 *
 * 职责：
 * - 将 factor snapshot 压缩为可读的日志字符串
 * - 让策略层与展示层共享同一套 factor 语义输出
 */
import type { FactorSnapshot } from '../../types/factor.js';

/**
 * 将趋势因子快照格式化为简洁的展示字符串。
 *
 * @param snapshot 因子快照
 * @returns factor 展示字符串；快照缺失时返回空字符串
 */
export function buildIndicatorDisplayString(snapshot: FactorSnapshot | null): string {
  if (!snapshot) {
    return '';
  }

  const parts: string[] = [];
  parts.push(`SESSION=${snapshot.session}`);

  if (snapshot.volatilityRegime) {
    parts.push(`REGIME=${snapshot.volatilityRegime}`);
  }

  if (snapshot.trendClassification) {
    parts.push(`TREND=${snapshot.trendClassification}`);
  }

  if (snapshot.trendScore !== null) {
    parts.push(`SCORE=${snapshot.trendScore.toFixed(3)}`);
  }

  if (snapshot.er15 !== null) {
    parts.push(`ER15=${snapshot.er15.toFixed(3)}`);
  }

  if (snapshot.er30 !== null) {
    parts.push(`ER30=${snapshot.er30.toFixed(3)}`);
  }

  parts.push(snapshot.readiness.overallReady ? 'READY=Y' : 'READY=N');

  if (!snapshot.readiness.overallReady && snapshot.readiness.reasons.length > 0) {
    parts.push(`REASON=${snapshot.readiness.reasons.join('|')}`);
  }

  return parts.join('、');
}
