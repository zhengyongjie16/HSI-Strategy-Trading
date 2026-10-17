/** 测试诊断替身：由不验证诊断行为的 fixture 显式注入，不作为生产依赖的默认实现。 */
import type { DiagnosticObserver } from '../../src/types/diagnostics.js';

/** 创建无外部副作用的诊断能力；需要断言事件的测试应自行注入记录器。 */
export function createDiagnosticObserverDouble(): DiagnosticObserver {
  return { record: () => {} };
}
