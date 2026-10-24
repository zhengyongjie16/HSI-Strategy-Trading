/**
 * 订单保留集清空行为测试。
 * 验证清空后的逐标的同步通知次数、listener 重入与异常中止，不依赖内部索引实现。
 */
import { describe, expect, it } from 'bun:test';
import { createOrderHoldRegistry } from '../../../src/application/orderTracking/orderHoldRegistry.js';

describe('orderHoldRegistry.clear', () => {
  it.each([0, 1, 3])('%i 个标的清空后按原标的数通知，不按订单数通知', (symbolCount) => {
    const registry = createOrderHoldRegistry();
    const symbols: ReadonlyArray<string> = ['00001.HK', '00002.HK', '00003.HK'].slice(
      0,
      symbolCount,
    );
    for (const symbol of symbols) {
      registry.trackOrder(`ORDER-${symbol}`, symbol);
    }

    const firstSymbol = symbols[0];
    if (firstSymbol !== undefined) {
      registry.trackOrder('DUPLICATE-SYMBOL-ORDER', firstSymbol);
    }

    const observedSymbols: Array<ReadonlyArray<string>> = [];
    registry.onOrderHoldSymbolsChanged(() => {
      observedSymbols.push([...registry.getHoldSymbols()]);
    });

    registry.clear();

    expect(observedSymbols).toEqual(Array.from({ length: symbolCount }, () => []));
    expect(registry.getHoldSymbols().size).toBe(0);
    registry.clear();
    expect(observedSymbols).toHaveLength(symbolCount);
  });

  it('listener 重入新增并再次清空，不改变外层固定通知次数', () => {
    const registry = createOrderHoldRegistry();
    registry.trackOrder('FIRST', '00001.HK');
    registry.trackOrder('SECOND', '00002.HK');
    const observedSymbols: Array<ReadonlyArray<string>> = [];
    let reentered = false;
    registry.onOrderHoldSymbolsChanged(() => {
      observedSymbols.push([...registry.getHoldSymbols()]);
      if (!reentered) {
        reentered = true;
        registry.trackOrder('REENTERED', '00003.HK');
        registry.clear();
      }
    });

    registry.clear();

    // 两次外层通知，加上重入新增与重入清空各一次；全部清空都先于各自的通知。
    expect(observedSymbols).toEqual([[], ['00003.HK'], [], []]);
    expect(registry.getHoldSymbols().size).toBe(0);
  });

  it('listener 在第二次通知抛错时原样中止，已清空索引且不调用后续 listener', () => {
    const registry = createOrderHoldRegistry();
    registry.trackOrder('FIRST', '00001.HK');
    registry.trackOrder('SECOND', '00002.HK');
    registry.trackOrder('THIRD', '00003.HK');
    const failure = new Error('listener failed');
    const notificationOrder: string[] = [];
    let firstListenerCalls = 0;
    registry.onOrderHoldSymbolsChanged(() => {
      firstListenerCalls += 1;
      notificationOrder.push('first');
      if (firstListenerCalls === 2) {
        throw failure;
      }
    });

    registry.onOrderHoldSymbolsChanged(() => {
      notificationOrder.push('second');
    });

    let caught: unknown = null;
    try {
      registry.clear();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(notificationOrder).toEqual(['first', 'second', 'first']);
    expect(registry.getHoldSymbols().size).toBe(0);
  });
});
