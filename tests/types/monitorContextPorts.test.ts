/**
 * monitor context ports 架构测试
 *
 * 覆盖：
 * - 唯一 app 装配契约使用共享行为端口，不恢复已删除的共享 state 契约
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const assemblyTypesPath = path.join(process.cwd(), 'src/app/context/types.ts');
const configTypesPath = path.join(process.cwd(), 'src/config/types.ts');

describe('monitor context shared ports', () => {
  it('keeps the deleted shared state contract absent and avoids local verifier port copies', () => {
    expect(existsSync(path.join(process.cwd(), 'src/types/state.ts'))).toBeFalse();
    const content = readFileSync(assemblyTypesPath, 'utf8');

    expect(content).not.toContain('interface AutoSymbolManager');
    expect(content).not.toContain('interface DelayedSignalVerifier');
  });

  it('exposes only strategy lifecycle, not host-owned verification or indicator state', () => {
    const content = readFileSync(assemblyTypesPath, 'utf8');
    expect(content).toContain('MonitorSymbolNames &');
    expect(content).toContain('Readonly<{');
    expect(content).toMatch(/strategy:\s*TradingSignalStrategy/);
    expect(content).not.toMatch(
      /DelayedSignalVerifier|indicatorProfile|MonitorState|IndicatorIncrementalRuntime/,
    );
  });

  it('keeps cancel outcome helpers in a single utility source', () => {
    const trackingOpsPath = path.join(
      process.cwd(),
      'src/application/orderTracking/orderMonitor/orderOps.ts',
    );
    const trackingOpsContent = readFileSync(trackingOpsPath, 'utf8');
    const submitFlowPath = path.join(process.cwd(), 'src/application/orderExecution/submitFlow.ts');
    const submitFlowContent = readFileSync(submitFlowPath, 'utf8');

    expect(trackingOpsContent).not.toContain(
      'export function isCancelAcceptedOrTerminalNonFilledClose',
    );

    expect(trackingOpsContent).not.toContain('export function isTerminalNonFilledCloseConfirmed');
    expect(submitFlowContent).not.toContain('function resolveCancelFailureTag');
  });

  it('keeps config/types.ts free of function implementations', () => {
    const content = readFileSync(configTypesPath, 'utf8');

    expect(content).not.toContain('export function createConfigValidationError');
    expect(content).not.toContain('function createConfigValidationError');
  });
});
