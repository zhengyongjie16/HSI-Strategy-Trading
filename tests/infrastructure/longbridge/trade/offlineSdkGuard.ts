/**
 * 离线测试 SDK 基线：保留原生 Decimal、枚举和 Config，仅拒绝网络工厂。
 * 必须由 preload 在业务测试首次 SDK hook 前安装；不是 NAPI 或 OS 防火墙。
 * fixture 可同步替换 context 工厂，并用 hook 前捕获的 exports 恢复此受保护基线。
 */
import { mock } from 'bun:test';
import sdk from 'longbridge';

function refuseNetworkFactory(): never {
  throw new Error('[OfflineSdkGuard] Real SDK network factories are disabled in offline tests');
}

// SDK 是 CommonJS：固化原 exports 的值，并同时保护 default 与具名导入。
const protectedSdkExports = {
  ...sdk,
  TradeContext: { new: refuseNetworkFactory },
  QuoteContext: { new: refuseNetworkFactory },
  OAuth: { build: refuseNetworkFactory },
};

// 不用 spyOn：mock.restore() 不应把网络工厂恢复为原生实现。
mock.module('longbridge', () => ({ ...protectedSdkExports, default: protectedSdkExports }));
