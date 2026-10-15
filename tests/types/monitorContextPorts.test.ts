/**
 * monitor context ports 架构测试
 *
 * 覆盖：
 * - MonitorContext 使用共享行为端口而非在 state.ts 复制本地契约
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const stateTypesPath = path.join(process.cwd(), 'src/types/state.ts');
const configTypesPath = path.join(process.cwd(), 'src/config/types.ts');

describe('monitor context shared ports', () => {
  it('does not declare local AutoSymbolManager or DelayedSignalVerifier interfaces in state.ts', () => {
    const content = readFileSync(stateTypesPath, 'utf8');

    expect(content).not.toContain('interface AutoSymbolManager');
    expect(content).not.toContain('interface DelayedSignalVerifier');
  });

  it('exposes only strategy lifecycle, not host-owned verification or indicator state', () => {
    const content = readFileSync(stateTypesPath, 'utf8');
    expect(content).toContain('readonly strategy: TradingSignalStrategy');
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
