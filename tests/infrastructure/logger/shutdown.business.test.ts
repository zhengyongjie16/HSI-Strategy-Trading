/**
 * logger 关闭与流故障验收
 *
 * 在真实 Writable / fs / 标准流边界主动释放回调，区分排队、finish、close 和总超时。
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { clockSource, fixtureImport, loggerImport, withLoggerProcess } from './processFixture.js';

describe('logger shutdown public protocol', () => {
  it('drains an immediate shutdown fully, shares one Promise and fails fast after closing starts', async () => {
    await withLoggerProcess(
      `
        ${clockSource}
        ${loggerImport}
        const listenerCounts = () => [process.stdout, process.stderr].flatMap((stream) => ['drain', 'error'].map((event) => stream.listenerCount(event)));
        const before = listenerCounts();
        for (let index = 0; index < 1000; index++) logger.info('bulk-' + index);
        const first = shutdownLogger();
        assert.equal(shutdownLogger(), first);
        for (const method of [logger.debug, logger.info, logger.warn, logger.error]) {
          assert.throws(() => method('after-close-started'));
        }
        assert.equal(await first, true);
        assert.equal(shutdownLogger(), first);
        assert.deepEqual(listenerCounts(), before, 'successful shutdown leaked standard stream listeners');
        for (const method of [logger.debug, logger.info, logger.warn, logger.error]) {
          assert.throws(() => method('after-close-completed'));
        }
      `,
      ({ stdout, stderr, logRootDir }) => {
        const expected = Array.from(
          { length: 1000 },
          (_, index) => `[INFO] 2026-02-13 23:59:59.123 bulk-${index}\n`,
        ).join('');
        expect(stdout).toBe(expected);
        expect(stderr).toBe('');
        expect(readFileSync(path.join(logRootDir, 'system', '2026-02-13.log'), 'utf8')).toBe(
          expected,
        );
      },
      { debug: 'true' },
    );
  }, 15_000);

  it('keeps file-first submission, FIFO, the common debug barrier and call-time extra snapshots', async () => {
    await withLoggerProcess(
      String.raw`
        ${fixtureImport}
        ${clockSource}
        const boundary = installControlledFiles({
          highWaterMark: 1,
          heldWrites: ['debug'],
          heldFinals: ['system', 'debug'],
        });
        const standard = installStandardBoundary();
        const { Writable } = await import('node:stream');
        const originalWrite = Writable.prototype.write;
        const standardWrite = process.stdout.write;
        const delivery = [];
        Writable.prototype.write = function(chunk, ...args) {
          if (typeof chunk === 'object' && chunk !== null && !ArrayBuffer.isView(chunk)) delivery.push('queue');
          return originalWrite.call(this, chunk, ...args);
        };
        process.stdout.write = function(...args) {
          delivery.push('console');
          return standardWrite.apply(this, args);
        };
        ${loggerImport}
        standard.blockedWrites.add('stdout');
        logger.debug('first');
        assert.deepEqual(delivery.slice(0, 3), ['queue', 'queue', 'console']);
        Writable.prototype.write = originalWrite;
        process.stdout.write = standardWrite;
        const data = { nested: { state: 'before' } };
        let conversions = 0;
        const converted = { toJSON() { conversions++; return data; } };
        logger.info('snapshot', converted);
        data.nested.state = 'after';
        logger.debug('third');
        logger.info('fourth');
        assert.equal(conversions, 1);
        await waitUntil(() => boundary.files.some((file) => file.subDir === 'debug' && file.pendingWrites.length === 1), 'debug write blocked');
        const system = boundary.files.find((file) => file.subDir === 'system');
        const debug = boundary.files.find((file) => file.subDir === 'debug');
        assert.ok(system && debug);
        assert.equal(system.writes.length, 1, 'slow debug must hold the next system record');
        assert.equal(standard.events.filter((event) => event.startsWith('stdout:')).length, 1, 'console drain must hold later console records');
        let settled = false;
        const closing = shutdownLogger();
        closing.then(() => { settled = true; });
        assert.equal(shutdownLogger(), closing);
        await nextTurn();
        assert.equal(settled, false);
        assert.equal(standard.barriers.size, 0);
        boundary.heldWrites.delete('debug');
        debug.pendingWrites.shift()();
        await waitUntil(() => system.pendingFinals.length === 1 && debug.pendingFinals.length === 1, 'both files finalizing');
        assert.equal(settled, false, 'write returning true is not file close completion');
        assert.equal(standard.barriers.size, 0, 'standard barriers must follow every owned file');
        assert.deepEqual(system.writes.map((line) => line.slice(line.indexOf('2026-02-13') + 24)), [
          'first\n', 'snapshot {"nested":{"state":"before"}}\n', 'third\n', 'fourth\n',
        ]);
        assert.equal(debug.writes.length, 2);
        assert.equal(conversions, 1);
        assert.equal(standard.events.filter((event) => event.startsWith('stdout:')).length, 1, 'console backpressure must not hold the file queue');
        standard.blockedWrites.delete('stdout');
        process.stdout.emit('drain');
        await waitUntil(() => standard.events.filter((event) => event.startsWith('stdout:')).length === 4, 'console FIFO after drain');
        const consoleLines = standard.events.filter((event) => event.startsWith('stdout:'));
        for (const [index, text] of ['first', 'snapshot {"nested":{"state":"before"}}', 'third', 'fourth'].entries()) {
          assert.ok(consoleLines[index].includes(text));
        }
        assert.equal(conversions, 1);
        system.pendingFinals.shift()();
        await nextTurn();
        assert.equal(standard.barriers.size, 0, 'other file still owns its final callback');
        debug.pendingFinals.shift()();
        await waitUntil(() => standard.barriers.size === 2, 'standard tail barriers');
        assert.equal(system.stream.closed, true);
        assert.equal(debug.stream.closed, true);
        assert.equal(settled, false);
        standard.barriers.get('stdout')();
        await nextTurn();
        assert.equal(settled, false);
        standard.barriers.get('stderr')();
        assert.equal(await closing, true);
        assert.equal(shutdownLogger(), closing);
        assert.equal(boundary.files.length, 2);
        standard.restore();
        boundary.restore();
      `,
      undefined,
      { debug: 'true' },
    );
  }, 15_000);

  it('waits for close, not only finish, when the lower file destroy callback is slow', async () => {
    await withLoggerProcess(`
      ${fixtureImport}
      const boundary = installControlledFiles({ heldWrites: ['system'], heldDestroys: ['system'] });
      const standard = installStandardBoundary();
      ${loggerImport}
      logger.info('slow-close');
      const closing = shutdownLogger();
      let settled = false;
      closing.then(() => { settled = true; });
      await waitUntil(() => boundary.files[0]?.pendingWrites.length === 1, 'write returning true is still pending');
      const file = boundary.files[0];
      assert.equal(settled, false);
      assert.equal(standard.barriers.size, 0);
      file.pendingWrites.shift()();
      await waitUntil(() => file.pendingDestroys.length === 1, 'lower file close pending');
      assert.equal(file.stream.writableFinished, true);
      assert.equal(file.stream.closed, false);
      assert.equal(standard.barriers.size, 0);
      assert.equal(settled, false);
      file.pendingDestroys.shift()();
      await waitUntil(() => standard.barriers.size === 2, 'barriers after actual close');
      standard.barriers.get('stdout')();
      standard.barriers.get('stderr')();
      assert.equal(await closing, true);
      assert.equal(file.stream.closed, true);
      standard.restore();
      boundary.restore();
    `);
  }, 15_000);

  it.each(['write', 'final', 'close'])(
    'returns false on a file %s error, closes the other file and reports before standard barriers',
    async (phase) => {
      await withLoggerProcess(
        `
          ${fixtureImport}
          const phase = '${phase}';
          const boundary = installControlledFiles({
            highWaterMark: 1,
            heldWrites: phase === 'write' ? ['system'] : [],
            heldFinals: phase === 'final' ? ['system', 'debug'] : ['debug'],
            heldDestroys: phase === 'close' ? ['system'] : [],
          });
          const standard = installStandardBoundary();
          ${loggerImport}
          logger.debug('file-error-probe');
          const closing = shutdownLogger();
          await waitUntil(() => boundary.files.length === 2, 'both file resources created');
          const system = boundary.files.find((file) => file.subDir === 'system');
          const debug = boundary.files.find((file) => file.subDir === 'debug');
          assert.ok(system && debug);
          const callbacks = phase === 'write' ? system.pendingWrites : (phase === 'final' ? system.pendingFinals : system.pendingDestroys);
          await waitUntil(() => callbacks.length === 1, 'file ' + phase + ' callback');
          callbacks.shift()(new Error('injected-file-' + phase));
          await waitUntil(() => debug.pendingFinals.length === 1 && standard.events.some((event) => event.includes('injected-file-' + phase)), 'other file finalizing after error diagnostic');
          assert.equal(standard.barriers.size, 0, 'must still close the unaffected debug file');
          debug.pendingFinals.shift()();
          await waitUntil(() => standard.barriers.size === 2, 'standard barriers after diagnostics');
          const diagnostic = standard.events.findIndex((event) => event.includes('injected-file-' + phase));
          const barrier = standard.events.findIndex((event) => event === 'stdout:' || event === 'stderr:');
          assert.ok(diagnostic >= 0 && diagnostic < barrier);
          standard.barriers.get('stdout')();
          standard.barriers.get('stderr')();
          assert.equal(await closing, false);
          assert.equal(system.stream.destroyed, true);
          assert.equal(debug.stream.closed, true);
          assert.equal(shutdownLogger(), closing);
          standard.restore();
          boundary.restore();
        `,
        undefined,
        { debug: 'true' },
      );
    },
    15_000,
  );

  it.each(['stdout', 'stderr'])(
    'waits for %s write callbacks and consumes a later error event without closing standard streams',
    async (target) => {
      await withLoggerProcess(`
        ${fixtureImport}
        const standard = installStandardBoundary();
        const originalEnd = [process.stdout.end, process.stderr.end];
        const originalDestroy = [process.stdout.destroy, process.stderr.destroy];
        for (const stream of [process.stdout, process.stderr]) {
          stream.end = () => assert.fail('logger must not end a global standard stream');
          stream.destroy = () => assert.fail('logger must not destroy a global standard stream');
        }
        ${loggerImport}
        logger.info('normal-stdout');
        logger.warn('normal-stderr');
        console.error('direct-stderr-before-close');
        const closing = shutdownLogger();
        let settled = false;
        closing.then(() => { settled = true; });
        await waitUntil(() => standard.barriers.size === 2, 'two standard barriers');
        assert.equal(settled, false);
        assert.ok(standard.events.findIndex((event) => event.includes('direct-stderr-before-close')) < standard.events.indexOf('stderr:'));
        standard.barriers.get('${target}')(new Error('standard-callback-error'));
        queueMicrotask(() => process.${target}.emit('error', new Error('late-standard-error')));
        await nextTurn();
        standard.barriers.get('${target === 'stdout' ? 'stderr' : 'stdout'}')();
        assert.equal(await closing, false);
        await nextTurn();
        assert.equal(shutdownLogger(), closing);
        process.stdout.end = originalEnd[0];
        process.stderr.end = originalEnd[1];
        process.stdout.destroy = originalDestroy[0];
        process.stderr.destroy = originalDestroy[1];
        standard.restore();
      `);
    },
    15_000,
  );
});

describe('logger real total timeout cancellation', () => {
  it.each(['drain', 'rotation', 'standard-barrier'])(
    'cancels %s within one real 5s budget and ignores late callbacks without reopening files',
    async (scenario) => {
      await withLoggerProcess(
        `
          ${fixtureImport}
          ${clockSource}
          const scenario = '${scenario}';
          const boundary = installControlledFiles({
            highWaterMark: 1,
            heldWrites: scenario === 'drain' ? ['debug'] : [],
            heldFinals: scenario === 'rotation' || scenario === 'standard-barrier' ? ['system'] : [],
            heldDestroys: scenario === 'rotation' ? ['system'] : [],
          });
          const standard = installStandardBoundary();
          const drainCounts = [process.stdout.listenerCount('drain'), process.stderr.listenerCount('drain')];
          ${loggerImport}
          if (scenario === 'rotation') {
            logger.info('old-day');
            await waitUntil(() => boundary.files[0]?.writes.length === 1, 'old day file');
            clock = NativeDate.parse('2026-02-13T16:00:00.000Z');
            logger.info('new-day-must-not-open');
            await waitUntil(() => boundary.files[0]?.pendingFinals.length === 1, 'rotation waiting for old file');
          } else if (scenario === 'drain') {
            standard.blockedWrites.add('stdout');
            logger.debug('blocked-debug');
            logger.info('queued-info');
          } else {
            logger.info('barrier-timeout');
          }
          const startedAt = performance.now();
          const closing = shutdownLogger();
          assert.equal(shutdownLogger(), closing);
          if (scenario === 'standard-barrier') {
            await waitUntil(() => boundary.files[0]?.pendingFinals.length === 1, 'slow file before standard barriers');
            assert.equal(standard.barriers.size, 0);
            // 真实跨阶段延迟证明 5s 是共享预算；若屏障阶段另开 5s，此用例将耗时约 8s 并失败。
            await new Promise((resolve) => setTimeout(() => {
              boundary.files[0].pendingFinals.shift()();
              resolve();
            }, 3000));
            await waitUntil(() => standard.barriers.size === 2, 'standard callbacks intentionally withheld');
          }
          assert.equal(await closing, false);
          const elapsed = performance.now() - startedAt;
          assert.ok(elapsed >= 4500 && elapsed < 7500, 'one real 5000ms shutdown budget, got ' + elapsed);
          assert.equal(shutdownLogger(), closing);
          assert.deepEqual([process.stdout.listenerCount('drain'), process.stderr.listenerCount('drain')], drainCounts);
          assert.ok(boundary.files.every((file) => file.stream.destroyed), 'all owned current/rotating files must be cancelled');
          if (scenario === 'rotation') assert.equal(boundary.files.length, 1, 'rotating old file must remain destroyable');
          const opened = boundary.files.length;
          const writes = boundary.files.map((file) => file.writes.length);
          for (const file of boundary.files) {
            assert.equal(file.stream.listenerCount('drain'), 0);
            for (const callback of file.pendingWrites.splice(0)) callback();
            for (const callback of file.pendingFinals.splice(0)) callback();
            for (const callback of file.pendingDestroys.splice(0)) callback();
            file.stream.emit('drain');
            file.stream.emit('error', new Error('late-file-error'));
          }
          for (const callback of standard.barriers.values()) callback();
          process.stdout.emit('drain');
          process.stderr.emit('drain');
          await nextTurn();
          await nextTurn();
          assert.equal(boundary.files.length, opened, 'late continuation reopened a file');
          assert.deepEqual(boundary.files.map((file) => file.writes.length), writes, 'late continuation resumed writing');
          standard.restore();
          boundary.restore();
        `,
        ({ elapsedMs }) => {
          expect(elapsedMs).toBeLessThan(15_000);
        },
        { debug: 'true', watchdogMs: 15_000 },
      );
    },
    20_000,
  );
});
