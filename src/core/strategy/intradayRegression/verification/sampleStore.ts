/** 策略实例私有样本存储；保留窗口由两侧真实配置推导，不存在默认窗口。 */
import { createSampleQueue, findClosestEntry, pushToQueue } from './utils.js';
import type { VerificationSampleStore } from './types.js';

/** 构造本实例的样本队列，仅在 push 时裁剪；查询不按回调时钟额外过期。 */
export function createVerificationSampleStore(retentionWindowMs: number): VerificationSampleStore {
  const queue = createSampleQueue();
  return {
    push(values, timestamp) {
      pushToQueue(queue, { values, timestamp }, retentionWindowMs);
    },
    getClosest(targetTime) {
      return findClosestEntry(queue, targetTime);
    },
    clearAll() {
      queue.entries.length = 0;
    },
  };
}
