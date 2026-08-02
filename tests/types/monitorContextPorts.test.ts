/**
 * monitor context ports 架构测试
 *
 * 覆盖：
 * - MonitorContext 使用共享行为端口而非在 state.ts 复制本地契约
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const stateTypesPath = path.join(process.cwd(), 'src/types/state.ts');
const configTypesPath = path.join(process.cwd(), 'src/config/types.ts');

describe('monitor context shared ports', () => {
  it('does not declare local AutoSymbolManager or DelayedSignalVerifier interfaces in state.ts', () => {
    const content = readFileSync(stateTypesPath, 'utf8');

    expect(content).not.toContain('interface AutoSymbolManager');
    expect(content).not.toContain('interface DelayedSignalVerifier');
  });

  it('does not keep a second DelayedSignalVerifier behavior interface in delayedSignalVerifier/types.ts', () => {
    const delayedVerifierTypesPath = path.join(
      process.cwd(),
      'src/main/asyncProgram/delayedSignalVerifier/types.ts',
    );
    const content = readFileSync(delayedVerifierTypesPath, 'utf8');

    expect(content).not.toContain('export interface DelayedSignalVerifier');
  });

  it('keeps cancel outcome helpers in a single utility source', () => {
    const traderUtilsPath = path.join(process.cwd(), 'src/core/trader/utils.ts');
    const traderUtilsContent = readFileSync(traderUtilsPath, 'utf8');
    const submitFlowPath = path.join(process.cwd(), 'src/core/trader/orderExecutor/submitFlow.ts');
    const submitFlowContent = readFileSync(submitFlowPath, 'utf8');

    expect(traderUtilsContent).not.toContain(
      'export function isCancelAcceptedOrTerminalNonFilledClose',
    );

    expect(traderUtilsContent).not.toContain('export function isTerminalNonFilledCloseConfirmed');
    expect(submitFlowContent).not.toContain('function resolveCancelFailureTag');
  });

  it('keeps config/types.ts free of function implementations', () => {
    const content = readFileSync(configTypesPath, 'utf8');

    expect(content).not.toContain('export function createConfigValidationError');
    expect(content).not.toContain('function createConfigValidationError');
  });
});
