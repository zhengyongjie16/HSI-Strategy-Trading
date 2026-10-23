import type { Writable } from 'node:stream';

/** logger 独立验收进程的输出；日志目录仅在断言回调期间有效。 */
export type LoggerProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly logRootDir: string;
  readonly elapsedMs: number;
};

/** 每项验收仅显式选择公开运行开关、期望退出码和父级 watchdog 预算。 */
export type LoggerProcessOptions = {
  readonly debug?: string;
  readonly enableProcessHooks?: boolean;
  readonly watchdogMs?: number;
  readonly expectedExitCode?: number;
};

/** 可控 IO 边界保存的完成回调，用于主动释放写入或关闭而非固定 sleep。 */
export type WriteCallback = (error?: Error | null) => void;

/** fake 文件流仅控制既有 IO 边界的三个生命周期阶段。 */
export type FileBoundaryOptions = {
  readonly heldWrites?: ReadonlyArray<string>;
  readonly heldFinals?: ReadonlyArray<string>;
  readonly heldDestroys?: ReadonlyArray<string>;
  readonly highWaterMark?: number;
};

/** 一次 createWriteStream 的公开边界观察，不读取 logger 内部状态。 */
export type ControlledFile = {
  readonly name: string;
  readonly subDir: string;
  readonly writes: ReadonlyArray<string>;
  readonly pendingWrites: WriteCallback[];
  readonly pendingFinals: WriteCallback[];
  readonly pendingDestroys: WriteCallback[];
  readonly stream: Writable;
  readonly writeOptions: unknown;
};

/** 受控 fs 边界由当前子进程独占，测试结束后恢复原生方法。 */
export type ControlledFileBoundary = {
  readonly files: ReadonlyArray<ControlledFile>;
  readonly heldWrites: Set<string>;
  readonly heldFinals: Set<string>;
  readonly heldDestroys: Set<string>;
  readonly restore: () => void;
};

/** 标准流写入和屏障由测试主动释放；不 end / destroy 全局流。 */
export type StandardBoundary = {
  readonly events: ReadonlyArray<string>;
  readonly barriers: Map<string, WriteCallback>;
  readonly blockedWrites: Set<string>;
  readonly restore: () => void;
};
