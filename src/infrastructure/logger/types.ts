import type { LOG_LEVELS } from '../../constants/index.js';

/** 调用时准备的文本快照；仅在 logger 的两个 objectMode 队列之间传递，不持有原始 extra。 */
export type PreparedLogRecord = {
  readonly level: (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];
  readonly consoleLine: string;
  readonly fileLine: string;
};

/** 标准流写回调的观察状态；待完成回调及其迟到 error 事件落定前保留唯一错误监听。 */
export type StandardStreamObserver = {
  readonly stream: NodeJS.WriteStream;
  readonly name: 'stdout' | 'stderr';
  readonly onError: (error: Error) => void;
  readonly onClose: () => void;
  pendingWrites: number;
  errorEvents: number;
  awaitingError: boolean;
  listening: boolean;
  releaseRequested: boolean;
  reportedFailure: boolean;
};
