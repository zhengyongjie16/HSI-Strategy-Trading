/**
 * apiFailure 中性事实业务测试
 *
 * 场景意图：锁定真实错误身份、聚合原因与外部请求失败的分类边界。
 */
import { describe, expect, it } from 'bun:test';
import {
  createExternalApiAggregateRequestError,
  createExternalApiRequestError,
  isAllExternalApiRequestErrors,
  isExternalApiRequestError,
} from '../../../src/utils/apiFailure/index.js';

describe('apiFailure neutral facts', () => {
  it('rejects structurally similar errors with invalid operation or attempts', () => {
    const fake = Object.assign(new Error('fake'), {
      name: 'ExternalApiRequestError',
      operation: 123,
      attempts: '1',
    });

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('rejects structurally valid fake ExternalApiRequestError objects', () => {
    const fake = Object.assign(new Error('internal failure with fake fields'), {
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.accountBalance',
      attempts: 1,
    });

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('rejects fake ExternalApiRequestError objects with forged string brand', () => {
    const fake = Object.assign(new Error('internal failure with fake fields'), {
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      __externalApiRequestErrorBrand: true,
    });

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('rejects errors that copy all properties from a real ExternalApiRequestError', () => {
    const real = createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('network'),
    });
    const fake = Object.defineProperties(
      new Error('copied internal failure'),
      Object.getOwnPropertyDescriptors(real),
    );

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('classifies aggregate external API failures as ExternalApiRequestError', () => {
    const first = createExternalApiRequestError({
      operation: 'QuoteContext.unsubscribe.quote.reset',
      attempts: 2,
      cause: new Error('quote unavailable'),
    });
    const second = createExternalApiRequestError({
      operation: 'QuoteContext.unsubscribeCandlesticks.reset',
      attempts: 2,
      cause: new Error('kline unavailable'),
    });

    const aggregate = createExternalApiAggregateRequestError({
      operation: 'QuoteContext.resetRuntimeSubscriptionsAndCaches',
      attempts: 1,
      causes: [first, second],
    });

    expect(isExternalApiRequestError(aggregate)).toBeTrue();
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(isAllExternalApiRequestErrors([first, second])).toBeTrue();
    expect(isAllExternalApiRequestErrors([first, new Error('internal')])).toBeFalse();
  });
});
