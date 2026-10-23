/**
 * 日志公开行为验收
 *
 * 通过隔离子进程验证文本、extra 快照、DEBUG 早返回和进程钩子；不共享测试进程的 logger。
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  clockSource,
  fixtureImport,
  loggerImport,
  withLoggerProcess,
} from './processFixture.js';

const timestamp = '2026-02-13 23:59:59.123';

describe('logger public text behavior', () => {
  it.each(['false', 'true', 'TRUE'])(
    'keeps exact layout, method references, routing and duplicates with DEBUG=%s',
    async (debug) => {
      await withLoggerProcess(
        `
          ${clockSource}
          ${loggerImport}
          assert.equal(fs.existsSync(path.join(logRootDir, 'system')), true);
          assert.equal(fs.existsSync(path.join(logRootDir, 'debug')), ${String(debug === 'true')});
          const { debug, info, warn, error } = logger;
          assert.equal(debug('debug-line', 'trace'), undefined);
          assert.equal(info('info-line', { value: 7 }), undefined);
          assert.equal(warn('warn-line', ''), undefined);
          assert.equal(error('\u001B[35merror-line\u001B[0m', 'failed'), undefined);
          info('duplicate');
          info('duplicate');
          assert.equal(await shutdownLogger(), true);
        `,
        ({ stdout, stderr, logRootDir }) => {
          const debugConsole = `\u001B[90m[DEBUG] ${timestamp} debug-line\u001B[0m 'trace'\n`;
          const debugFile = `[DEBUG] ${timestamp} debug-line 'trace'\n`;
          const info = `[INFO] ${timestamp} info-line {"value":7}\n`;
          const duplicate = `[INFO] ${timestamp} duplicate\n`;
          expect(stdout).toBe((debug === 'true' ? debugConsole : '') + info + duplicate + duplicate);
          expect(stderr).toBe(
            `\u001B[33m[WARN] ${timestamp} warn-line\u001B[0m ''\n` +
              `\u001B[31m[ERROR] ${timestamp} \u001B[35merror-line\u001B[0m\u001B[0m 'failed'\n`,
          );
          const system = readFileSync(path.join(logRootDir, 'system', '2026-02-13.log'), 'utf8');
          expect(system).toBe(
            (debug === 'true' ? debugFile : '') +
              info +
              `[WARN] ${timestamp} warn-line ''\n` +
              `[ERROR] ${timestamp} error-line 'failed'\n` +
              duplicate +
              duplicate,
          );
          expect(system).not.toContain('\u001B[');
          expect(existsSync(path.join(logRootDir, 'debug'))).toBe(debug === 'true');
          if (debug === 'true') {
            expect(readFileSync(path.join(logRootDir, 'debug', '2026-02-13.log'), 'utf8')).toBe(
              debugFile,
            );
          }
        },
        { debug },
      );
    },
    15_000,
  );

  it('does not read time or extra for disabled DEBUG, including after shutdown', async () => {
    await withLoggerProcess(`
      const events = ['beforeExit', 'exit', 'uncaughtException', 'unhandledRejection'];
      const counts = events.map((event) => process.listenerCount(event));
      ${loggerImport}
      assert.deepEqual(events.map((event) => process.listenerCount(event)), counts);
      const OriginalDate = Date;
      const forbiddenDate = new Proxy(Date, {
        construct() { assert.fail('disabled DEBUG read Date'); },
        get(target, key, receiver) {
          if (key === 'now') return () => assert.fail('disabled DEBUG read Date.now');
          return Reflect.get(target, key, receiver);
        },
      });
      const forbiddenExtra = new Proxy({}, { get() { assert.fail('disabled DEBUG read extra'); } });
      globalThis.Date = forbiddenDate;
      const debug = logger.debug;
      assert.equal(debug('hidden-before-close', forbiddenExtra), undefined);
      globalThis.Date = OriginalDate;
      assert.equal(await shutdownLogger(), true);
      globalThis.Date = forbiddenDate;
      assert.equal(debug('hidden-after-close', forbiddenExtra), undefined);
      globalThis.Date = OriginalDate;
      assert.deepEqual(fs.readdirSync(path.join(logRootDir, 'system')), []);
      assert.equal(fs.existsSync(path.join(logRootDir, 'debug')), false);
    `);
  }, 15_000);

  it('formats native JSON values once without confusing shared references and cycles', async () => {
    await withLoggerProcess(`
      ${clockSource}
      ${loggerImport}
      const shared = { value: 7 };
      const circular = { first: 'preserved' };
      circular.self = circular;
      let conversions = 0;
      let failedConversions = 0;
      let getterReads = 0;
      let customInspections = 0;
      const badGetter = {
        get unsafe() { getterReads++; throw new Error('getter-failed'); },
        [Symbol.for('nodejs.util.inspect.custom')]() { customInspections++; throw new Error('inspect-failed'); },
      };
      const badToJSON = { toJSON() { failedConversions++; throw new Error('toJSON-failed'); } };
      const consoleLines = [];
      const stdoutWrite = process.stdout.write;
      process.stdout.write = (...args) => {
        consoleLines.push(String(args[0]));
        return stdoutWrite.apply(process.stdout, args);
      };
      const rows = [
        ['undefined', undefined, ''],
        ['null', null, ''],
        ['string', 'text', " 'text'"],
        ['quoted-string', "it's", " \\"it's\\""],
        ['empty-string', '', " ''"],
        ['string-null', 'null', " 'null'"],
        ['zero', 0, ' 0'],
        ['negative-zero', -0, ' 0'],
        ['false', false, ' false'],
        ['true', true, ' true'],
        ['finite', 1.25, ' 1.25'],
        ['nan', NaN, ''],
        ['infinity', Infinity, ''],
        ['negative-infinity', -Infinity, ''],
        ['function', () => {}, ''],
        ['symbol', Symbol('ignored'), ''],
        ['object', { z: 1, a: true, skipped: undefined, fn() {}, symbol: Symbol(), nan: NaN }, ' {"z":1,"a":true,"nan":null}'],
        ['array', [undefined, () => {}, Symbol(), NaN, Infinity, -Infinity, 2], ' [null,null,null,null,null,null,2]'],
        ['error', new Error('non-enumerable'), ' {}'],
        ['error-fields', Object.assign(new Error('hidden'), { code: 'BROKER', count: 1 }), ' {"code":"BROKER","count":1}'],
        ['date', new Date('2026-02-13T00:00:00.000Z'), " '2026-02-13T00:00:00.000Z'"],
        ['boxed-number', new Number(7), ' 7'],
        ['boxed-string', new String('boxed'), " 'boxed'"],
        ['boxed-boolean', new Boolean(false), ' false'],
        ['toJSON-object', { toJSON() { conversions++; return { converted: 1 }; } }, ' {"converted":1}'],
        ['toJSON-string', { toJSON() { return 'converted'; } }, " 'converted'"],
        ['toJSON-false', { toJSON() { return false; } }, ' false'],
        ['toJSON-null', { toJSON() { return null; } }, ''],
        ['toJSON-undefined', { toJSON() { return undefined; } }, ''],
        ['shared', { a: shared, b: shared }, ' {"a":{"value":7},"b":{"value":7}}'],
        ['circular', circular, ' {"first":"preserved","self":"[Circular]"}'],
        ['bigint', 9007199254740993123456789n, " '9007199254740993123456789'"],
        ['nested-bigint', { amount: 9007199254740993123456789n }, ' {"amount":"9007199254740993123456789"}'],
        ['bad-getter', badGetter, " '[Unserializable]'"],
        ['bad-toJSON', badToJSON, " '[Unserializable]'"],
        ['ansi-object', { text: '\u001B[33mvisible-json-escape\u001B[0m' }, ' {"text":"\\\\u001b[33mvisible-json-escape\\\\u001b[0m"}'],
        ['ansi-string', '\u001B[33mvisible-inspect-escape\u001B[0m', " '\\\\x1B[33mvisible-inspect-escape\\\\x1B[0m'"],
      ];
      for (const [name, extra] of rows) logger.info(name, extra);
      assert.equal(conversions, 1);
      assert.equal(failedConversions, 1);
      assert.equal(getterReads, 1);
      assert.equal(customInspections, 0);
      const expected = rows.map(([name, , suffix]) => '[INFO] ${timestamp} ' + name + suffix + '\\n').join('');
      assert.equal(await shutdownLogger(), true);
      assert.equal(conversions, 1);
      assert.equal(failedConversions, 1);
      assert.equal(getterReads, 1);
      assert.equal(customInspections, 0);
      assert.equal(fs.readFileSync(path.join(logRootDir, 'system', '2026-02-13.log'), 'utf8'), expected);
      assert.equal(consoleLines.join(''), expected);
      process.stdout.write = stdoutWrite;
    `);
  }, 15_000);

  it('does not replace a business error when its enumerable getter throws', async () => {
    await withLoggerProcess(
      `
        ${clockSource}
        ${loggerImport}
        const original = new Error('original-business-error');
        let reads = 0;
        Object.defineProperty(original, 'unsafe', {
          enumerable: true,
          get() { reads++; throw new Error('formatting-must-not-win'); },
        });
        let caught;
        try {
          try { throw original; }
          catch (error) { logger.error('preserve-original', error); throw error; }
        } catch (error) { caught = error; }
        assert.equal(caught, original);
        assert.equal(reads, 1);
        assert.equal(await shutdownLogger(), true);
      `,
      ({ stderr, logRootDir }) => {
        expect(stderr).toContain("preserve-original\u001B[0m '[Unserializable]'");
        expect(readFileSync(path.join(logRootDir, 'system', '2026-02-13.log'), 'utf8')).toContain(
          "preserve-original '[Unserializable]'",
        );
        expect(stderr).not.toContain('formatting-must-not-win');
      },
    );
  }, 15_000);

  it.each(['false', 'true'])(
    'does not create empty daily files when shutting down an unused logger with DEBUG=%s',
    async (debug) => {
      await withLoggerProcess(
        `
          ${loggerImport}
          assert.equal(await shutdownLogger(), true);
          assert.deepEqual(fs.readdirSync(path.join(logRootDir, 'system')), []);
          if (${String(debug === 'true')}) assert.deepEqual(fs.readdirSync(path.join(logRootDir, 'debug')), []);
        `,
        ({ stdout, stderr }) => {
          expect(stdout).toBe('');
          expect(stderr).toBe('');
        },
        { debug },
      );
    },
    15_000,
  );
});

describe('logger process hook semantics', () => {
  it('reports unhandled rejection without closing the logger or exiting', async () => {
    await withLoggerProcess(
      `
        ${loggerImport}
        const reason = Object.assign(new Error('original-rejection'), { marker: 'original-rejection' });
        process.emit('unhandledRejection', reason, Promise.resolve());
        logger.info('after-rejection');
        assert.equal(await shutdownLogger(), true);
      `,
      ({ stdout, stderr }) => {
        expect(stdout).toContain('after-rejection');
        expect(stderr).toContain('未处理的 Promise 拒绝');
        expect(stderr).toContain('original-rejection');
      },
      { enableProcessHooks: true },
    );
  }, 15_000);

  it('reports uncaught exception and exits synchronously before the next statement', async () => {
    await withLoggerProcess(
      `
        ${loggerImport}
        const original = Object.assign(new Error('original-uncaught'), { marker: 'original-uncaught' });
        process.emit('uncaughtException', original);
        logger.info('unreachable');
      `,
      ({ stdout, stderr }) => {
        expect(stdout).not.toContain('unreachable');
        expect(stderr).toContain('未捕获的异常');
        expect(stderr).toContain('original-uncaught');
      },
      { enableProcessHooks: true, expectedExitCode: 1 },
    );
  }, 15_000);

  it.each(['unhandledRejection', 'uncaughtException'])(
    'keeps independent reporting after shutdown for %s',
    async (event) => {
      await withLoggerProcess(
        `
          ${loggerImport}
          assert.equal(await shutdownLogger(), true);
          const original = new Error('closed-hook-original');
          process.emit('${event}', original, Promise.resolve());
          console.log('after-closed-hook');
        `,
        ({ stdout, stderr }) => {
          expect(stderr).toContain('closed-hook-original');
          expect(stderr).toContain(
            event === 'unhandledRejection' ? '未处理的 Promise 拒绝' : '未捕获的异常',
          );
          expect(stdout.includes('after-closed-hook')).toBe(event === 'unhandledRejection');
        },
        {
          enableProcessHooks: true,
          expectedExitCode: event === 'uncaughtException' ? 1 : 0,
        },
      );
    },
    15_000,
  );

  it('preserves exitCode when natural beforeExit shutdown fails externally', async () => {
    await withLoggerProcess(
      `
        ${fixtureImport}
        const boundary = installControlledFiles();
        ${loggerImport}
        logger.info('natural-failed-close');
        await waitUntil(() => boundary.files[0]?.writes.length === 1, 'natural close file exists');
        boundary.files[0].stream._final = (callback) => callback(new Error('natural-file-close-error'));
        process.exitCode = 9;
      `,
      ({ stdout, stderr }) => {
        expect(stdout).toContain('natural-failed-close');
        expect(stderr).toContain('natural-file-close-error');
      },
      { enableProcessHooks: true, expectedExitCode: 9 },
    );
  }, 15_000);

  it('uses one beforeExit hook to close naturally, without an asynchronous exit hook', async () => {
    await withLoggerProcess(
      `
        ${clockSource}
        const events = ['beforeExit', 'exit', 'uncaughtException', 'unhandledRejection'];
        const before = events.map((event) => process.listenerCount(event));
        ${loggerImport}
        assert.deepEqual(events.map((event, index) => process.listenerCount(event) - before[index]), [1, 0, 1, 1]);
        for (let index = 0; index < 200; index++) logger.info('natural-' + index);
      `,
      ({ stdout, stderr, logRootDir }) => {
        const expected = Array.from(
          { length: 200 },
          (_, index) => `[INFO] ${timestamp} natural-${index}\n`,
        ).join('');
        expect(stdout).toBe(expected);
        expect(stderr).toBe('');
        expect(readdirSync(path.join(logRootDir, 'system'))).toEqual(['2026-02-13.log']);
        expect(readFileSync(path.join(logRootDir, 'system', '2026-02-13.log'), 'utf8')).toBe(expected);
      },
      { enableProcessHooks: true },
    );
  }, 15_000);
});
