/**
 * 最小运行期诊断常量。
 * 事件由真实业务 owner 采集，通过既有结构化 logger 聚合，不引入独立指标服务。
 */
export const DIAGNOSTIC_OPERATIONS = {
  SNAPSHOT_REQUEST_STARTED: 'snapshot_request_started',
  SNAPSHOT_RESPONSE_ACCEPTED: 'snapshot_response_accepted',
  SNAPSHOT_RESPONSE_DISCARDED: 'snapshot_response_discarded',
  SNAPSHOT_COMMITTED: 'snapshot_committed',
  SNAPSHOT_REFRESH_COMPLETED: 'snapshot_refresh_completed',
  SNAPSHOT_PENDING_WAIT_COMPLETED: 'snapshot_pending_wait_completed',
  SETTLEMENT_STALE: 'settlement_stale',
  SETTLEMENT_READY: 'settlement_ready',
  SETTLEMENT_READINESS_COMPLETED: 'settlement_readiness_completed',
  SEAT_VERSION_INVALIDATED: 'seat_version_invalidated',
  SEAT_ACTIVATION_COMPLETED: 'seat_activation_completed',
  SEAT_ACTIVATION_RETAIN_RELEASED: 'seat_activation_retain_released',
  ORDER_SUBMIT_UNKNOWN_FATAL: 'order_submit_unknown_fatal',
  ORDER_TERMINAL_CONFIRMED: 'order_terminal_confirmed',
  CANCEL_ACKNOWLEDGEMENT_TO_TERMINAL: 'cancel_acknowledgement_to_terminal',
  LIQUIDATION_COMPLETION_COMMITTED: 'liquidation_completion_committed',
  QUEUE_STATE: 'queue_state',
  OPEN_REBUILD_RETRY: 'open_rebuild_retry',
  TRADING_DAY_REBUILT: 'trading_day_rebuilt',
} as const;

/** 结构化日志的固定消息；operation 及 owner 字段放在 extra 中。 */
export const DIAGNOSTIC_LOG_MESSAGE = 'runtime diagnostic';
