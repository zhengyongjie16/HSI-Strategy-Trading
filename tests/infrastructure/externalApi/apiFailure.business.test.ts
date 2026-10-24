/**
 * 外部 API 请求适配业务测试
 *
 * 场景意图：锁定外部 IO 的默认分类、有限重试和调用方只收窄门禁的边界。
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { wrapExternalApiRequest } from '../../../src/infrastructure/externalApi/index.js';
import { isExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';

describe('external API request boundary', () => {
  it('waits only between retry attempts and preserves the final original cause', async () => {
    const original = new Error('network unavailable');
    const timerSpy = spyOn(globalThis, 'setTimeout');
    let attempts = 0;
    let caught: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.retry-delay',
        request: async () => {
          attempts += 1;
          throw original;
        },
        retryConfig: { retries: 2, delayMs: 1 },
      });
    } catch (error) {
      caught = error;
    } finally {
      const delays = timerSpy.mock.calls.map((call) => call[1]);
      timerSpy.mockRestore();
      expect(delays).toEqual([1, 1]);
    }

    expect(attempts).toBe(3);
    expect(isExternalApiRequestError(caught)).toBe(true);
    expect(caught).toMatchObject({ attempts: 3, cause: original });
    if (caught instanceof Error) expect(caught.cause).toBe(original);
  });

  it('wraps repeated request failures as ExternalApiRequestError', async () => {
    let attempts = 0;

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.api',
        request: async () => {
          attempts += 1;
          throw new Error('network unavailable');
        },
        retryConfig: {
          retries: 1,
          delayMs: 0,
        },
      });
    } catch (error_) {
      error = error_;
    }

    expect(attempts).toBe(2);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ExternalApiRequestError');
  });

  it('does not wrap errors rejected by caller retry predicate', async () => {
    let attempts = 0;

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.business-error',
        request: async () => {
          attempts += 1;
          throw new Error('business rejection');
        },
        shouldRetry: () => false,
      });
    } catch (error_) {
      error = error_;
    }

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('Error');
    expect((error as Error).message).toBe('business rejection');
  });

  it('does not wrap TypeError as ExternalApiRequestError', async () => {
    let attempts = 0;

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.contract',
        request: async () => {
          attempts += 1;
          throw new TypeError('contract broken');
        },
      });
    } catch (error_) {
      error = error_;
    }

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('contract broken');
  });

  const assertNotRetriedExternalFailure = async (
    failureCase: Readonly<{
      operation: string;
      createError: () => Error;
      shouldRetry?: () => boolean;
    }>,
  ): Promise<void> => {
    let attempts = 0;
    const failure = failureCase.createError();
    let thrown: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: failureCase.operation,
        request: async () => {
          attempts += 1;
          throw failure;
        },
        ...(failureCase.shouldRetry === undefined ? {} : { shouldRetry: failureCase.shouldRetry }),
        retryConfig: {
          retries: 2,
          delayMs: 0,
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect(attempts).toBe(1);
  };

  it('does not retry non-transient business errors by default', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.business',
      createError: () => new Error('openapi error: code=601011: order has been cancelled'),
    }));

  it('does not retry generic business rejection errors by default', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.generic-business',
      createError: () => new Error('business rejection'),
    }));

  it('retries explicit transient status errors by default', async () => {
    let attempts = 0;

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.rate-limit',
        request: async () => {
          attempts += 1;
          throw new Error('openapi error: status=429: rate limit exceeded');
        },
        retryConfig: {
          retries: 1,
          delayMs: 0,
        },
      });
    } catch (error_) {
      error = error_;
    }

    expect(error).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'test.rate-limit',
    });
    expect(attempts).toBe(2);
  });

  it('does not let caller retry predicate widen default retry boundary', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.caller-widen',
      createError: () => new Error('openapi error: code=602012: unsupported order type'),
      shouldRetry: () => true,
    }));

  it('lets caller retry predicate narrow transient retry boundary', async () => {
    let attempts = 0;
    const transientError = new Error('openapi error: status=503: service unavailable');

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.caller-narrow',
        request: async () => {
          attempts += 1;
          throw transientError;
        },
        shouldRetry: () => false,
        retryConfig: {
          retries: 2,
          delayMs: 0,
        },
      });
    } catch (error_) {
      error = error_;
    }

    expect(error).toBe(transientError);
    expect(attempts).toBe(1);
  });

  it('keeps six-digit business codes non-retryable even when status hints look transient', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.business-code-priority',
      createError: () =>
        new Error('openapi error: 601011 status=503: order cancelled after service unavailable'),
    }));

  it('keeps structured six-digit business codes non-retryable even with transient status', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.structured-business-code-priority',
      createError: () =>
        Object.assign(new Error('service unavailable after order cancelled'), {
          code: '601011',
          status: 503,
        }),
    }));

  it('keeps structured errorCode six-digit business codes non-retryable even with transient status', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.structured-error-code-business-code-priority',
      createError: () =>
        Object.assign(new Error('service unavailable after order cancelled'), {
          errorCode: '601011',
          status: 503,
        }),
    }));

  it('keeps structured errno six-digit business codes non-retryable even with transient message hints', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.structured-errno-business-code-priority',
      createError: () =>
        Object.assign(new Error('service unavailable after order cancelled'), {
          errno: 601011,
        }),
    }));

  it('keeps nested six-digit business codes non-retryable', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.nested-business-code-priority',
      createError: () =>
        new Error('fetch failed', {
          cause: {
            code: '601011',
            status: 503,
          },
        }),
    }));

  it('retries nested structured transient network codes', async () => {
    let attempts = 0;
    const transientError = new Error('fetch failed', {
      cause: {
        code: 'ETIMEDOUT',
      },
    });

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.nested-transient-network-code',
        request: async () => {
          attempts += 1;
          throw transientError;
        },
        retryConfig: {
          retries: 1,
          delayMs: 0,
        },
      });
    } catch (error_) {
      error = error_;
    }

    expect(error).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'test.nested-transient-network-code',
    });
    expect(attempts).toBe(2);
  });

  it('does not retry ordinary unknown errors by default', async () =>
    assertNotRetriedExternalFailure({
      operation: 'test.ordinary-error',
      createError: () => new Error('unexpected upstream response'),
    }));

  it('does not retry messages that only contain bare transient-looking numbers', async () => {
    const ordinaryErrors = [
      new Error('upstream payload contains 503 but no status marker'),
      new Error('audit marker 429 without transient meaning'),
    ];

    for (const ordinaryError of ordinaryErrors) {
      let attempts = 0;
      let error: unknown = null;
      try {
        await wrapExternalApiRequest({
          operation: 'test.bare-number',
          request: async () => {
            attempts += 1;
            throw ordinaryError;
          },
          retryConfig: {
            retries: 2,
            delayMs: 0,
          },
        });
      } catch (error_) {
        error = error_;
      }

      expect(error).toBe(ordinaryError);
      expect(attempts).toBe(1);
    }
  });

  it('does not wrap ContractError or InvariantError as external API failures', async () => {
    const programErrors = [
      Object.assign(new Error('contract broken'), { name: 'ContractError' }),
      Object.assign(new Error('invariant broken'), { name: 'InvariantError' }),
    ];

    for (const programError of programErrors) {
      let attempts = 0;
      let error: unknown = null;
      try {
        await wrapExternalApiRequest({
          operation: 'test.program-error',
          request: async () => {
            attempts += 1;
            throw programError;
          },
          retryConfig: {
            retries: 2,
            delayMs: 0,
          },
        });
      } catch (error_) {
        error = error_;
      }

      expect(error).toBe(programError);
      expect(attempts).toBe(1);
    }
  });

  it('retries structured transient status fields', async () => {
    const statusErrors = [
      Object.assign(new Error('bad gateway'), { status: 502 }),
      Object.assign(new Error('service unavailable'), { statusCode: 503 }),
      Object.assign(new Error('gateway timeout'), { httpStatus: '504' }),
    ];

    for (const statusError of statusErrors) {
      let attempts = 0;
      let error: unknown = null;
      try {
        await wrapExternalApiRequest({
          operation: 'test.structured-status',
          request: async () => {
            attempts += 1;
            throw statusError;
          },
          retryConfig: {
            retries: 1,
            delayMs: 0,
          },
        });
      } catch (error_) {
        error = error_;
      }

      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'test.structured-status',
      });
      expect(attempts).toBe(2);
    }
  });

  it('retries representative transient messages and statuses', async () => {
    const transientErrors = [
      new Error('network unavailable'),
      new Error('request timed out'),
      new Error('connection reset by peer'),
      new Error('service busy'),
      new Error('openapi error: status=408: request timeout'),
      new Error('openapi error: status=425: too early'),
      new Error('openapi error: http 500 internal server error'),
    ];

    for (const transientError of transientErrors) {
      let attempts = 0;
      let error: unknown = null;
      try {
        await wrapExternalApiRequest({
          operation: 'test.transient-message',
          request: async () => {
            attempts += 1;
            throw transientError;
          },
          retryConfig: {
            retries: 1,
            delayMs: 0,
          },
        });
      } catch (error_) {
        error = error_;
      }

      expect(error).toMatchObject({
        name: 'ExternalApiRequestError',
        operation: 'test.transient-message',
      });
      expect(attempts).toBe(2);
    }
  });
});
