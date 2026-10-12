/**
 * SDK 模块 mock 生命周期：私有保存 preload 保护后的 exports，不向业务测试泄漏 SDK。
 * install 只覆盖现有具名导出；恢复及 fresh-import identity 检查均不调用 SDK 工厂。
 */
import { expect, mock } from 'bun:test';
import * as sdk from 'longbridge';

/** 在调用方首次 SDK hook 前创建；只返回中性的安装、恢复及断言能力。 */
export function createSdkModuleMock(): Readonly<{
  install: (overrides: Readonly<Record<string, unknown>>) => void;
  restore: () => void;
  assertRestored: () => Promise<void>;
}> {
  const originalExports = { ...sdk };
  const originalEntries = new Map<string, unknown>(Object.entries(originalExports));
  const originalQuoteFactory = sdk.QuoteContext.new;
  const originalTradeFactory = sdk.TradeContext.new;
  const originalOAuthFactory = sdk.OAuth.build;

  return {
    install(overrides: Readonly<Record<string, unknown>>): void {
      for (const key of Object.keys(overrides)) {
        if (key === 'default' || !originalEntries.has(key)) {
          throw new Error('SDK mock requires a known named export: ' + key);
        }
      }

      const installedExports: Record<string, unknown> = { ...originalExports, ...overrides };
      delete installedExports['default'];
      void mock.module('longbridge', () => ({
        ...installedExports,
        default: installedExports,
      }));
    },
    restore(): void {
      void mock.module('longbridge', () => originalExports);
    },
    async assertRestored(): Promise<void> {
      const restored = await import('longbridge');
      const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(restored);
      expect(entries).toHaveLength(originalEntries.size);
      for (const [name, value] of entries) {
        expect(originalEntries.has(name)).toBeTrue();
        expect(value).toBe(originalEntries.get(name));
      }

      // 不仅检查对象 identity；保留原工具测试对工厂成员 identity 的精确断言。
      expect(restored.QuoteContext.new).toBe(originalQuoteFactory);
      expect(restored.TradeContext.new).toBe(originalTradeFactory);
      expect(restored.OAuth.build).toBe(originalOAuthFactory);
    },
  };
}
