import type { Unsubscribe } from './events.js';

/**
 * 席位状态枚举。
 * 类型用途：表示做多/做空席位的生命周期（EMPTY 空席、SEARCHING 寻标中、SWITCHING 换标中、ACTIVATING 激活中、ACTIVE 可消费），用于 getSeatState/updateSeatState 等返回值及换标流程判断。
 * 数据来源：由 SymbolRegistry 内部状态维护。
 * 使用范围：SymbolRegistry、席位换标、启动恢复等；全项目可引用。
 */
export type SeatStatus = 'EMPTY' | 'SEARCHING' | 'SWITCHING' | 'ACTIVATING' | 'ACTIVE';

/**
 * 席位生命周期公共元数据。
 * 类型用途：统一描述运行期状态共享的换标、寻标、回收价、失败与冻结事实。
 * 数据来源：由 SymbolRegistry 及自动寻标、换标、生命周期链路维护。
 * 使用范围：仅用于组成各个 SeatState 判别联合成员。
 */
type SeatLifecycleMetadata = {
  /** 上次换标时间戳（毫秒） */
  readonly lastSwitchAt: number | null;

  /** 上次寻标时间戳（毫秒） */
  readonly lastSearchAt: number | null;

  /** 回收价（从 warrantList 透传，做多/做空标的换标后用于 setWarrantInfoFromCallPrice） */
  readonly callPrice?: string | null;

  /** 当日连续寻标失败次数 */
  readonly searchFailCountToday: number;

  /** 当日冻结标记（值为 HK 日期 key，非 null 时表示冻结，midnight clear 重置） */
  readonly frozenTradingDayKey: string | null;
};

/**
 * 无标的归属的席位状态。
 * 类型用途：表达 EMPTY 或 SEARCHING；午夜清理允许保留历史激活时间，但不得携带 symbol。
 * 数据来源：自动寻标失败/进行中与生命周期午夜清理。
 * 使用范围：SeatState 判别联合。
 */
type EmptySeatState = SeatLifecycleMetadata & {
  readonly symbol: null;
  readonly status: 'EMPTY';
  readonly lastSeatActivatedAt: number | null;
};

/**
 * 自动寻标进行中的席位状态。
 * 类型用途：表达尚无标的归属的 SEARCHING，允许保留前一生命周期的历史激活时间。
 * 数据来源：自动寻标与启动恢复寻标链路。
 * 使用范围：SeatState 判别联合。
 */
type SearchingSeatState = SeatLifecycleMetadata & {
  readonly symbol: null;
  readonly status: 'SEARCHING';
  readonly lastSeatActivatedAt: number | null;
};

/**
 * 已绑定但尚不可交易的席位状态。
 * 类型用途：表达 SWITCHING 或 ACTIVATING，必须携带当前由状态机负责的 symbol。
 * 数据来源：换标状态机与席位激活刷新链路。
 * 使用范围：SeatState 判别联合。
 */
type SwitchingSeatState = SeatLifecycleMetadata & {
  readonly symbol: string;
  readonly status: 'SWITCHING';
  readonly lastSeatActivatedAt: number | null;
};

/**
 * 激活等待席位状态。
 * 类型用途：表达已绑定新标的、等待行情准入与缓存重建完成的席位。
 * 数据来源：自动寻标、换标完成与启动恢复链路。
 * 使用范围：SeatState 判别联合。
 */
type ActivatingSeatState = SeatLifecycleMetadata & {
  readonly symbol: string;
  readonly status: 'ACTIVATING';
  readonly lastSeatActivatedAt: number | null;
};

/**
 * 运行时已激活席位状态。
 * 类型用途：表达已完成行情准入与缓存重建、可参与交易和周期换标计时的席位。
 * 数据来源：席位刷新或开盘重建完成阶段。
 * 使用范围：SeatState 判别联合。
 */
type RuntimeActiveSeatState = SeatLifecycleMetadata & {
  readonly symbol: string;
  readonly status: 'ACTIVE';
  readonly lastSeatActivatedAt: number;
};

/**
 * 静态配置启动席位状态。
 * 类型用途：仅表达 autoSearch 关闭时注册表刚创建、尚未经历运行时重建的窄 bootstrap 状态。
 * 数据来源：createSymbolRegistry 静态标的初始化。
 * 使用范围：SeatState 判别联合；任何历史运行态字段出现后都必须转换为 RuntimeActiveSeatState。
 */
type StaticBootstrapActiveSeatState = {
  readonly symbol: string;
  readonly status: 'ACTIVE';
  readonly lastSwitchAt: null;
  readonly lastSearchAt: null;
  readonly lastSeatActivatedAt: null;
  readonly callPrice?: null;
  readonly searchFailCountToday: 0;
  readonly frozenTradingDayKey: null;
};

/**
 * 席位状态信息。
 * 类型用途：以 status 为判别字段，使标的归属与 ACTIVE 激活时间成为编译期可信不变量。
 * 数据来源：由 SymbolRegistry 维护；callPrice 等来自配置 warrantList 透传。
 * 使用范围：SymbolRegistry、换标/寻标、恢复、生命周期与交易门禁链路。
 */
export type SeatState =
  | EmptySeatState
  | SearchingSeatState
  | SwitchingSeatState
  | ActivatingSeatState
  | RuntimeActiveSeatState
  | StaticBootstrapActiveSeatState;

/**
 * SymbolRegistry public mutation 可写入的运行时席位状态。
 * 类型用途：排除仅允许在注册表构造期出现的静态 bootstrap ACTIVE/null 成员。
 * 数据来源：自动寻标、换标、恢复、激活与生命周期运行时转换。
 * 使用范围：SymbolRegistry public mutation 与上层席位状态更新函数。
 */
export type RuntimeWritableSeatState = Exclude<
  SeatState,
  { readonly status: 'ACTIVE'; readonly lastSeatActivatedAt: null }
>;

/**
 * 席位状态变化事件。
 * 类型用途：表达 SymbolRegistry 权威席位状态在运行期发生的状态写入，供自动寻标、席位激活与订阅 runtime 消费。
 * 数据来源：由 SymbolRegistry.updateSeatState 在状态写入完成后发布。
 * 使用范围：事件驱动自动换标链路与 quote 订阅维护链路。
 */
export type SeatStateChangedEvent = Readonly<{
  /** 席位方向 */
  direction: 'LONG' | 'SHORT';

  /** 写入前席位状态 */
  previousState: SeatState;

  /** 写入后席位状态 */
  nextState: SeatState;

  /** 上一次已发布席位状态事件对应的 nextVersion */
  previousVersion: number;

  /** 写入完成后的当前版本号 */
  nextVersion: number;
}>;

/**
 * 席位 truth 变化事件。
 * 类型用途：表达 SymbolRegistry 已完成一次席位权威状态 mutation，监听方可同步读取最新 state/version 快照。
 * 数据来源：由 SymbolRegistry 的 public mutation 在本次对应的状态或版本事件发布完成后发布。
 * 使用范围：依赖完整席位 truth 重投影的事件驱动链路。
 */
type SeatTruthChangedEvent = Readonly<{
  /** 席位方向 */
  direction: 'LONG' | 'SHORT';
}>;

/**
 * 席位 truth 变化监听器。
 * 类型用途：订阅 SymbolRegistry 每次 public mutation 完成后的统一 truth 变化信号。
 * 数据来源：由 onSeatTruthChanged 注册并由 SymbolRegistry 内部同步调用。
 * 使用范围：需要按 seat truth 完整变更重投影派生状态的模块。
 */
export type SeatTruthChangedListener = (event: SeatTruthChangedEvent) => void;

/** 同一席位 truth 的只读能力；普通授权、display 与 runtime 只读取原 state/version/归属。 */
interface SeatReader {
  /** 获取席位状态 */
  readonly getSeatState: (direction: 'LONG' | 'SHORT') => SeatState;

  /** 获取席位版本号 */
  readonly getSeatVersion: (direction: 'LONG' | 'SHORT') => number;

  /** 根据标的代码解析所属席位 */
  readonly resolveSeatBySymbol: (symbol: string) => Readonly<{
    direction: 'LONG' | 'SHORT';
    seatVersion: number;
  }> | null;
}

/** 既有席位状态机的同步 mutation 能力；寻标、换标、激活与日切共享同一 SymbolRegistry。 */
interface SeatWriter {
  /** 更新席位状态 */
  readonly updateSeatState: (
    direction: 'LONG' | 'SHORT',
    nextState: RuntimeWritableSeatState,
  ) => void;

  /** 原子更新席位状态并递增席位版本号 */
  readonly updateSeatStateWithVersionBump: (
    direction: 'LONG' | 'SHORT',
    nextState: RuntimeWritableSeatState,
  ) => {
    readonly seatVersion: number;
  };
}

/** 权威席位 mutation 完成后的事件订阅；不向 runtime 暴露 state 集合或更新入口。 */
interface SeatEvents {
  /** 订阅席位状态变化事件 */
  readonly onSeatStateChanged: (listener: (event: SeatStateChangedEvent) => void) => Unsubscribe;

  /** 订阅席位 truth 变化事件 */
  readonly onSeatTruthChanged: (listener: SeatTruthChangedListener) => Unsubscribe;
}

/** 唯一席位 owner 的工厂产物；业务按读、写或事件能力注入，不另建席位缓存。 */
export interface SymbolRegistry extends SeatReader, SeatWriter, SeatEvents {}
