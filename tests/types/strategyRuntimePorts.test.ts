/**
 * strategy runtime ports 架构测试
 *
 * 覆盖：
 * - StrategyRuntime 使用共享行为端口而非在 state.ts 复制本地契约
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const stateTypesPath = path.join(process.cwd(), 'src/types/state.ts');
const configTypesPath = path.join(process.cwd(), 'src/config/types.ts');

describe('strategy runtime shared ports', () => {
  it('does not declare local AutoSymbolManager or delayed verifier interfaces in state.ts', () => {
    const content = readFileSync(stateTypesPath, 'utf8');

    expect(content.includes('interface AutoSymbolManager')).toBe(false);
    expect(content.includes('interface DelayedSignalVerifier')).toBe(false);
  });

  it('removes the legacy delayedSignalVerifier types file entirely', () => {
    const delayedVerifierTypesPath = path.join(
      process.cwd(),
      'src/main/asyncProgram/delayedSignalVerifier/types.ts',
    );

    expect(existsSync(delayedVerifierTypesPath)).toBe(false);
  });

  it('keeps cancel outcome helpers in a single utility source', () => {
    const traderUtilsPath = path.join(process.cwd(), 'src/core/trader/utils.ts');
    const traderUtilsContent = readFileSync(traderUtilsPath, 'utf8');
    const submitFlowPath = path.join(process.cwd(), 'src/core/trader/orderExecutor/submitFlow.ts');
    const submitFlowContent = readFileSync(submitFlowPath, 'utf8');

    expect(
      traderUtilsContent.includes('export function isCancelAcceptedOrTerminalNonFilledClose'),
    ).toBe(false);

    expect(traderUtilsContent.includes('export function isTerminalNonFilledCloseConfirmed')).toBe(
      false,
    );
    expect(submitFlowContent.includes('function resolveCancelFailureTag')).toBe(false);
  });

  it('keeps config/types.ts free of function implementations', () => {
    const content = readFileSync(configTypesPath, 'utf8');

    expect(content.includes('export function createConfigValidationError')).toBe(false);
    expect(content.includes('function createConfigValidationError')).toBe(false);
  });
});
