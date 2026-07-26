/**
 * 指标缓存模块
 *
 * 功能/职责：
 * - 维护唯一监控标的的时间窗口样本队列，存储真实时间轴上的延迟验证最小样本
 * - 为 DelayedSignalVerifier 提供按目标时间回溯的稳定三态值（value/missing/invalid）
 *
 * 执行流程：
 * - 上游采样方在产生延迟验证样本时 push(values, sampleTimestampMs)
 * - 延迟验证器在验证时 getClosest(targetTime)
 */
import { INDICATOR_CACHE } from '../../../constants/index.js';
import type {
  IndicatorCache,
  IndicatorCacheEntry,
  IndicatorCacheOptions,
  VerificationSampleValues,
} from './types.js';
import { createSampleQueue, pushToQueue, findClosestEntry } from './utils.js';

/**
 * 创建延迟验证样本缓存。未传 options 或 retentionWindowMs 时使用默认时间窗口。
 *
 * @param options 可选配置，retentionWindowMs 为单标的样本保留时间窗口
 * @returns 延迟验证样本缓存实例（push、getClosest、clearAll）
 */
export const createIndicatorCache = (options: IndicatorCacheOptions = {}): IndicatorCache => {
  const retentionWindowMs =
    options.retentionWindowMs ?? INDICATOR_CACHE.DEFAULT_RETENTION_WINDOW_MS;
  const queue = createSampleQueue();

  return {
    /**
     * 推送单个采样时刻的延迟验证样本到唯一监控标的队列。
     *
     * @param values 当前采样时刻的延迟验证三态样本
     * @param sampleTimestampMs 采样时间戳（毫秒）
     */
    push(values: VerificationSampleValues, sampleTimestampMs: number): void {
      const entry: IndicatorCacheEntry = {
        timestamp: sampleTimestampMs,
        values,
      };
      pushToQueue(queue, entry, retentionWindowMs);
    },

    /**
     * 查询唯一监控标的最接近目标时间的延迟验证样本。
     */
    getClosest(targetTime: number): IndicatorCacheEntry | null {
      if (queue.entries.length === 0) {
        return null;
      }

      return findClosestEntry(queue, targetTime);
    },

    /**
     * 清空唯一监控标的样本队列，用于跨日重置。
     */
    clearAll(): void {
      queue.entries.length = 0;
    },
  };
};
