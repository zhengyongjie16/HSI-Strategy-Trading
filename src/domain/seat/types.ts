import type { SeatState, SeatStateChangedEvent, SymbolRegistry } from '../../types/seat.js';
import type { Signal } from '../../types/signal.js';

/** 构造 registry 所需的静态席位配置，不向 domain 传播策略/SDK 或完整交易配置。 */
export type SeatRegistryConfig = Readonly<{
  longSymbol: string;
  shortSymbol: string;
  autoSearchConfig: Readonly<{ autoSearchEnabled: boolean }>;
}>;

/**
 * 席位注册表内部条目。
 * 类型用途：存储单方向席位状态与版本号，供 SymbolRegistry 读写。
 * 数据来源：由 createSymbolRegistry 内 createSeatEntry 创建并维护。
 * 使用范围：仅 domain/seat 模块内部（SymbolRegistry 实现）使用；三个字段由 registry 同步 mutation 独占写入。
 */
export type SeatEntry = {
  state: SeatState;
  version: number;
  lastEventVersion: number;
};

/**
 * 席位状态运行时校验候选。
 * 类型用途：表达越过静态类型边界后，SymbolRegistry 写入断言需要逐字段检查的宽输入结构。
 * 数据来源：SymbolRegistry 的初始状态与 public mutation 入参。
 * 使用范围：仅 autoSymbolManager 的 SymbolRegistry 不变量校验使用。
 */
export type SeatStateCandidate = Readonly<{
  symbol: string | null;
  status: 'EMPTY' | 'SEARCHING' | 'SWITCHING' | 'ACTIVATING' | 'ACTIVE';
  lastSwitchAt: number | null;
  lastSearchAt: number | null;
  lastSeatActivatedAt: number | null;
  callPrice?: string | null;
  searchFailCountToday: number;
  frozenTradingDayKey: string | null;
}>;

/**
 * 单个监控标的的席位条目。
 * 类型用途：存储唯一 monitor 多空两个方向的 SeatEntry。
 * 数据来源：由 createSymbolRegistry 初始化并维护。
 * 使用范围：仅 domain/seat 模块内部使用。
 */
export type SymbolSeatEntry = {
  readonly long: SeatEntry;
  readonly short: SeatEntry;
};

/**
 * 席位状态变化监听器。
 * 类型用途：SymbolRegistry 内部事件发射时保存 listener 集合。
 * 数据来源：由 onSeatStateChanged 注册。
 * 使用范围：仅 autoSymbolManager 的 SymbolRegistry 实现使用。
 */
export type SeatStateChangedListener = (event: SeatStateChangedEvent) => void;

/**
 * 席位不可用原因枚举。
 * 类型用途：描述席位无法用于交易的具体状态，由 resolveSeatUnavailableReason 返回。
 * 使用范围：autoSymbolManager 模块及其调用方使用。
 */
export type SeatUnavailableReason =
  'SEAT_EMPTY' | 'SEAT_FROZEN_TODAY' | 'SEAT_SEARCHING' | 'SEAT_SWITCHING' | 'SEAT_ACTIVATING';

/**
 * 信号席位绑定校验失败原因。
 * 类型用途：统一表达交易信号与当前席位状态不一致的失败类型，供延迟验证与买卖处理器共享。
 * 使用范围：domain/seat/seatPolicy 与相关调用方使用。
 */
type SignalSeatValidationFailureReason =
  'INVALID_SIGNAL_ACTION' | 'SEAT_UNAVAILABLE' | 'SEAT_VERSION_MISMATCH' | 'SEAT_SYMBOL_MISMATCH';

/**
 * 信号席位绑定校验入参。
 * 类型用途：封装校验 signal 与当前 seat 绑定关系所需的最小依赖。
 * 使用范围：domain/seat/seatPolicy 与相关调用方使用。
 */
export type ValidateSignalSeatParams = Readonly<{
  readonly signal: Pick<Signal, 'action' | 'seatVersion' | 'symbol'>;
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
}>;

/**
 * 信号席位绑定校验结果。
 * 类型用途：表达 signal 与当前席位是否一致；席位不可用时保留状态以生成具体失败原因。
 * 使用范围：延迟验证接线、买卖处理器等需要统一过滤旧席位信号的调用方。
 */
export type SignalSeatValidationResult =
  | Readonly<{
      valid: true;
    }>
  | Readonly<{
      valid: false;
      reason: 'SEAT_UNAVAILABLE';
      seatState: SeatState;
    }>
  | Readonly<{
      valid: false;
      reason: Exclude<SignalSeatValidationFailureReason, 'SEAT_UNAVAILABLE'>;
    }>;

/** 激活任务携带的席位身份；epoch 由应用层另行校验，domain 不读取生命周期。 */
export type SeatActivationIdentity = Readonly<{
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  nextSymbol: string;
}>;

/** 周期任务固定的 ACTIVE 计时基线，由席位 producer 在入队时捕获。 */
export type SeatSnapshot = Readonly<{
  seatVersion: number;
  symbol: string;
  lastSeatActivatedAt: number;
}>;

/**
 * 换标触发模式（内部类型）。
 * 类型用途：区分距回收价触发与周期触发，供换标状态机决定阶段流。
 * 使用范围：domain/seat 与 application/seatSwitch使用。
 */
export type SwitchMode = 'DISTANCE' | 'PERIODIC';

/**
 * 换标状态机的运行时状态。
 * 类型用途：记录换标流程各阶段的中间数据，存储于 switchStates Map，由 switchStateMachine 读写。
 * 使用范围：seatSwitch 模块及其调用方使用；identity/计划字段不可变，只有原 application owner 写阶段、实绩与有限重试进度。
 */
export type SwitchState = {
  readonly direction: 'LONG' | 'SHORT';
  readonly switchMode: SwitchMode;
  readonly seatVersion: number;
  stage: SwitchStage;
  readonly oldSymbol: string;
  readonly nextSymbol: string | null;
  readonly nextCallPrice: string | null;
  sellSubmitted: boolean;
  sellOrderId: string | null;
  sellNotional: string | null;
  shouldRebuy: boolean;
  quoteRetryAttempts: number;
  quoteRetryNextAt: number | null;
  quoteRetryExhausted: boolean;
  cancelRequestSubmitted: boolean;
};

/**
 * 周期换标本地阻塞来源。
 * 类型用途：表达当前席位为何仍不能执行周期换标；EMPTY 表示已满足换标条件。
 * 数据来源：由周期换标入口基于 orderRecorder、本地 in-flight 订单与 broker pending orders 联合判定。
 * 使用范围：domain/seat 与 application/seatSwitch使用。
 */
export type PeriodicSeatBlockSource =
  'ORDER_RECORDER' | 'LOCAL_PENDING_ORDER' | 'BROKER_PENDING_ORDER' | 'EMPTY';

/**
 * 换标流程阶段枚举（内部类型）。
 * 类型用途：描述状态机从撤单到完成的各个步骤。
 * 使用范围：domain/seat 与 application/seatSwitch使用。
 */
export type SwitchStage =
  'CANCEL_PENDING' | 'SELL_OUT' | 'BIND_NEW' | 'WAIT_QUOTE' | 'REBUY' | 'COMPLETE' | 'FAILED';

/**
 * 换标触发类型。
 * 类型用途：区分周期换标与距离换标的安全侧/危险侧触发语义。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type SwitchTriggerKind = 'PERIODIC' | 'DISTANCE_SAFE_SIDE' | 'DISTANCE_DANGER_SIDE';

/**
 * 可写入日内抑制的换标触发类型。
 * 类型用途：约束 suppression 数据模型与 API，只允许周期换标和距离换标安全侧写入抑制记录。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type SuppressibleSwitchTriggerKind = Exclude<SwitchTriggerKind, 'DISTANCE_DANGER_SIDE'>;

/**
 * 日内换标抑制记录。
 * 类型用途：防止同一标的在同一交易日内，对同一 suppressible trigger kind 重复触发换标。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type SwitchSuppression = {
  readonly symbol: string;
  readonly dateKey: string;
  readonly suppressedTriggerKinds: ReadonlySet<SuppressibleSwitchTriggerKind>;
};

/**
 * 换标状态 Map（内部类型）。
 * 类型用途：以方向为键存储当前换标状态。
 * 使用范围：domain/seat 与 application/seatSwitch使用。
 */
export type SwitchStateMap = Map<'LONG' | 'SHORT', SwitchState>;

/**
 * 换标抑制 Map（内部类型）。
 * 类型用途：以方向为键存储日内抑制记录。
 * 使用范围：domain/seat 与 application/seatSwitch使用。
 */
export type SwitchSuppressionMap = Map<'LONG' | 'SHORT', SwitchSuppression>;

/** 周期换标状态机内部等待状态。 */
export type PeriodicSwitchInternalPendingState = Readonly<{
  pending: boolean;
  pendingSinceMs: number | null;
  blockedBy?: Exclude<PeriodicSeatBlockSource, 'EMPTY'>;
}>;

/**
 * 周期换标等待状态 Map（内部类型）。
 * 类型用途：以方向为键存储 pending 状态。
 * 使用范围：domain/seat 与 application/seatSwitch使用。
 */
export type PeriodicSwitchPendingMap = Map<'LONG' | 'SHORT', PeriodicSwitchInternalPendingState>;

/** 具名换标 policy；判别联合显式限制旧席位处理、候选缺失与回补阶段，不隐藏成布尔配置。 */
export type SeatSwitchPolicy =
  | Readonly<{
      kind: 'PERIODIC_REPLACE';
      oldSeatHandling: 'REQUIRE_EMPTY';
      noCandidate: 'CLEAR_AND_COUNT_FAILURE';
      stageAfterCancellation: 'BIND_NEW';
      rebuy: 'NONE';
      orderTypeOverride: null;
    }>
  | Readonly<{
      kind: 'DISTANCE_MOVE';
      oldSeatHandling: 'SELL_AVAILABLE_AND_WAIT_EMPTY';
      noCandidate: 'UNWIND_THEN_FAIL_AND_COUNT_FAILURE';
      stageAfterCancellation: 'SELL_OUT';
      rebuy: 'ACTUAL_SELL_AMOUNT_IN_SWITCHING';
      orderTypeOverride: 'ELO';
    }>;
