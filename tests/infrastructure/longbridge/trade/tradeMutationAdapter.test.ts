/**
 * Longbridge mutation adapter 的真实 SDK Decimal 出站证据。
 * SDK context 方法使用离线注入替身；验证文本原值、容量拒绝、数量证明、身份与原错误透传。
 * 不创建真实 SDK context，不证明自然成交、交易授权、readiness 或 cancel/query drain。
 */
import { describe, expect, it } from 'bun:test';
import {
  Decimal,
  OrderSide,
  OrderType,
  TimeInForceType,
  type ReplaceOrderOptions,
  type SubmitOrderOptions,
  type TradeContext,
} from 'longbridge';
import { createTradeMutationAdapter } from '../../../../src/infrastructure/longbridge/trade/tradeMutationAdapter.js';
import type {
  TradeReplaceCommand,
  TradeSubmitCommand,
} from '../../../../src/types/tradeMutationPorts.js';
import { exactCompare } from '../../../../src/utils/numeric/exact.js';

const priceText = '123.45678901234567890123456789';

function submitCommand(): Extract<TradeSubmitCommand, { orderType: 'LO' | 'ELO' }> {
  return {
    symbol: 'BULL.HK',
    side: 'BUY',
    orderType: 'ELO',
    timeInForce: 'DAY',
    submittedQuantity: 100,
    submittedPrice: priceText,
    remark: 'original remark',
  };
}

function replaceCommand(): TradeReplaceCommand {
  return { orderId: 'BROKER-REPLACE', quantity: 200, price: priceText };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected mutation rejection');
}

function harness() {
  const submits: SubmitOrderOptions[] = [];
  const replaces: ReplaceOrderOptions[] = [];
  const ctx: Pick<TradeContext, 'submitOrder' | 'replaceOrder'> = {
    async submitOrder(command) {
      expect(this).toBe(ctx);
      submits.push(command);
      return {
        orderId: 'BROKER-ORDER-001',
        toString: () => 'SDK response',
        toJSON: () => ({ orderId: 'BROKER-ORDER-001' }),
      };
    },
    async replaceOrder(command): Promise<undefined> {
      expect(this).toBe(ctx);
      replaces.push(command);
    },
  };
  const adapter = createTradeMutationAdapter(ctx);
  const issued: string[] = [];
  const port = {
    submitOrder: (command: TradeSubmitCommand) =>
      adapter.submitOrder(command, () => {
        issued.push('SUBMIT');
      }),
    replaceOrder: (command: TradeReplaceCommand) =>
      adapter.replaceOrder(command, () => {
        issued.push('REPLACE');
      }),
  };
  return { port, submits, replaces, issued };
}

describe('trade mutation adapter', () => {
  it('serializes high-precision price and safe quantity only at the injected SDK IO edge', async () => {
    const { port, submits } = harness();
    const input = Object.freeze(submitCommand());
    const result = await port.submitOrder(input);
    expect(result).toEqual({ orderId: 'BROKER-ORDER-001' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(submits).toHaveLength(1);
    const native = submits[0];
    if (native === undefined) {
      throw new Error('expected captured native submit');
    }

    expect(native.submittedPrice).toBeInstanceOf(Decimal);
    expect(native.submittedPrice?.toString()).toBe('123.45678901234567890123456789');
    expect(native.submittedQuantity).toBeInstanceOf(Decimal);
    expect(native.submittedQuantity.toString()).toBe('100');
    expect(native.symbol).toBe('BULL.HK');
    expect(native.side).toBe(OrderSide.Buy);
    expect(native.orderType).toBe(OrderType.ELO);
    expect(native.timeInForce).toBe(TimeInForceType.Day);
    expect(native.remark).toBe('original remark');
    expect(input.submittedPrice).toBe(priceText);
  });

  it('maps only the actual LO/ELO/MO semantics and omits market price without inventing policy', async () => {
    const { port, submits } = harness();
    await port.submitOrder({ ...submitCommand(), orderType: 'LO', submittedPrice: '1.2300' });
    await port.submitOrder({
      symbol: 'BEAR.HK',
      side: 'SELL',
      orderType: 'MO',
      timeInForce: 'DAY',
      submittedQuantity: Number.MAX_SAFE_INTEGER,
    });
    expect(submits).toHaveLength(2);
    expect(submits[0]?.orderType).toBe(OrderType.LO);
    expect(submits[0]?.submittedPrice?.toString()).toBe('1.23');
    expect(submits[1]?.orderType).toBe(OrderType.MO);
    expect(submits[1]?.side).toBe(OrderSide.Sell);
    expect(submits[1]?.submittedQuantity.toString()).toBe('9007199254740991');
    expect(submits[1]).not.toHaveProperty('submittedPrice');
    expect(submits[1]).not.toHaveProperty('outsideRth');
    expect(submits[1]).not.toHaveProperty('remark');
  });

  it('preserves replace identity and exact numeric value while returning only void', async () => {
    const { port, replaces } = harness();
    const input = Object.freeze(replaceCommand());
    await port.replaceOrder(input).then((result) => {
      expect(result).toBeUndefined();
    });
    expect(replaces).toHaveLength(1);
    expect(replaces[0]?.orderId).toBe('BROKER-REPLACE');
    expect(replaces[0]?.quantity.toString()).toBe('200');
    expect(replaces[0]?.price?.toString()).toBe('123.45678901234567890123456789');
    expect(input.price).toBe(priceText);
  });

  it('rejects native capacity truncation using independent text comparison before remote IO', async () => {
    const { port, submits, replaces, issued } = harness();
    const original = '18800.12345678901234567890123456';
    const native = new Decimal(original);
    expect(native.toString()).toBe('18800.123456789012345678901235');
    expect(exactCompare(original, native.toString())).not.toBe(0);
    const submitError = await rejectionOf(
      port.submitOrder({ ...submitCommand(), submittedPrice: original }),
    );
    const replaceError = await rejectionOf(
      port.replaceOrder({ ...replaceCommand(), price: original }),
    );
    expect(submitError).toBeInstanceOf(RangeError);
    expect(submitError).toHaveProperty('message', expect.stringContaining('capacity'));
    expect(replaceError).toBeInstanceOf(RangeError);
    expect(replaceError).toHaveProperty('message', expect.stringContaining('capacity'));
    expect(issued).toEqual([]);
    expect(submits).toHaveLength(0);
    expect(replaces).toHaveLength(0);
  });

  it('rejects SDK overflow and nonzero underflow instead of changing a financial value', async () => {
    const { port, submits, replaces } = harness();
    for (const price of ['79228162514264337593543950336', '0.00000000000000000000000000001']) {
      expect(
        await rejectionOf(port.submitOrder({ ...submitCommand(), submittedPrice: price })),
      ).toBeInstanceOf(Error);

      expect(await rejectionOf(port.replaceOrder({ ...replaceCommand(), price }))).toBeInstanceOf(
        Error,
      );
    }

    expect(submits).toHaveLength(0);
    expect(replaces).toHaveLength(0);
  });

  it('rejects malformed or nonpositive price text before remote IO, including native signed-zero limitations', async () => {
    const { port, submits, replaces } = harness();
    expect(new Decimal('-0').toString()).toBe('0');
    for (const price of ['', 'NaN', 'Infinity', '1e2', ' 1', '1.2.3', '0', '-0', '-1']) {
      expect(
        await rejectionOf(port.submitOrder({ ...submitCommand(), submittedPrice: price })),
      ).toBeInstanceOf(Error);

      expect(await rejectionOf(port.replaceOrder({ ...replaceCommand(), price }))).toBeInstanceOf(
        Error,
      );
    }

    expect(submits).toHaveLength(0);
    expect(replaces).toHaveLength(0);
  });

  it('does not accept runtime number or Decimal-like price bridges or coerce their value', async () => {
    const { port, submits, replaces } = harness();
    let coerced = 0;
    const decimalLike = {
      toString: () => {
        coerced += 1;
        return '1';
      },
    };
    for (const price of [1, Number.NaN, decimalLike]) {
      const submit = submitCommand();
      const replace = replaceCommand();
      Reflect.set(submit, 'submittedPrice', price);
      Reflect.set(replace, 'price', price);
      expect(await rejectionOf(port.submitOrder(submit))).toBeInstanceOf(TypeError);
      expect(await rejectionOf(port.replaceOrder(replace))).toBeInstanceOf(TypeError);
    }

    expect(coerced).toBe(0);
    expect(submits).toHaveLength(0);
    expect(replaces).toHaveLength(0);
  });

  it('proves quantity is a positive safe integer rather than a general numeric or text bridge', async () => {
    const { port, submits, replaces } = harness();
    for (const quantity of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '100',
    ]) {
      const submit = submitCommand();
      const replace = replaceCommand();
      Reflect.set(submit, 'submittedQuantity', quantity);
      Reflect.set(replace, 'quantity', quantity);
      expect(await rejectionOf(port.submitOrder(submit))).toHaveProperty(
        'message',
        expect.stringContaining('positive safe integer'),
      );

      expect(await rejectionOf(port.replaceOrder(replace))).toHaveProperty(
        'message',
        expect.stringContaining('positive safe integer'),
      );
    }

    expect(submits).toHaveLength(0);
    expect(replaces).toHaveLength(0);
  });

  it('rejects unknown side/type/timeInForce and market price instead of defaulting semantics', async () => {
    const { port, submits } = harness();
    for (const [field, value] of [
      ['side', 'UNKNOWN'],
      ['orderType', 'AO'],
      ['timeInForce', 'GTC'],
      ['symbol', ''],
    ] as const) {
      const command = submitCommand();
      Reflect.set(command, field, value);
      expect(await rejectionOf(port.submitOrder(command))).toBeInstanceOf(TypeError);
    }

    const pricedMarket = submitCommand();
    Reflect.set(pricedMarket, 'orderType', 'MO');
    expect(await rejectionOf(port.submitOrder(pricedMarket))).toHaveProperty(
      'message',
      expect.stringContaining('must omit submittedPrice'),
    );
    expect(submits).toHaveLength(0);
  });

  it('preserves internal getter failure and native SDK rejection identity without retry or wrapping', async () => {
    const { port, submits } = harness();
    const internal = new TypeError('internal primitive contract failed');
    const command = submitCommand();
    Object.defineProperty(command, 'submittedPrice', {
      get: () => {
        throw internal;
      },
    });
    expect(await rejectionOf(port.submitOrder(command))).toBe(internal);
    expect(submits).toHaveLength(0);
    const remote = new Error('native broker failure');
    let submitCalls = 0;
    let replaceCalls = 0;
    const failing = createTradeMutationAdapter({
      submitOrder: async () => {
        submitCalls += 1;
        throw remote;
      },
      replaceOrder: async () => {
        replaceCalls += 1;
        throw remote;
      },
    });
    const issued: string[] = [];
    expect(
      await rejectionOf(
        failing.submitOrder(submitCommand(), () => {
          issued.push('SUBMIT');
        }),
      ),
    ).toBe(remote);

    expect(
      await rejectionOf(
        failing.replaceOrder(replaceCommand(), () => {
          issued.push('REPLACE');
        }),
      ),
    ).toBe(remote);
    expect(issued).toEqual(['SUBMIT', 'REPLACE']);
    expect(submitCalls).toBe(1);
    expect(replaceCalls).toBe(1);
  });
});
