/**
 * logger 日文件验收
 *
 * 覆盖香港午夜、实际消费日轮转、追加写入，以及 system / debug 各自的七文件保留规则。
 */
import { describe, it } from 'bun:test';
import { clockSource, fixtureImport, loggerImport, withLoggerProcess } from './processFixture.js';

describe('logger daily files', () => {
  it('appends existing files and keeps seven daily files independently across Hong Kong midnight', async () => {
    await withLoggerProcess(
      String.raw`
        ${fixtureImport}
        ${clockSource}
        for (const subDir of ['system', 'debug']) {
          const directory = path.join(logRootDir, subDir);
          fs.mkdirSync(directory, { recursive: true });
          for (let day = 6; day <= 13; day++) {
            fs.writeFileSync(path.join(directory, '2026-02-' + String(day).padStart(2, '0') + '.log'), subDir + '-existing-' + day + '\n');
          }
          fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep unrelated extension');
          fs.mkdirSync(path.join(directory, 'not-a-file.log'));
        }
        ${loggerImport}
        logger.debug('before-midnight');
        await waitUntil(() => ['system', 'debug'].every((subDir) => fs.readFileSync(path.join(logRootDir, subDir, '2026-02-13.log'), 'utf8').includes('before-midnight')), 'append to both existing files');
        for (const subDir of ['system', 'debug']) {
          assert.deepEqual(fs.readdirSync(path.join(logRootDir, subDir)).filter((name) => /^2026-/.test(name)).sort(),
            Array.from({ length: 7 }, (_, index) => '2026-02-' + String(index + 7).padStart(2, '0') + '.log'));
        }
        clock = NativeDate.parse('2026-02-13T16:00:00.456Z');
        logger.debug('after-midnight');
        assert.equal(await shutdownLogger(), true);
        for (const subDir of ['system', 'debug']) {
          const directory = path.join(logRootDir, subDir);
          assert.deepEqual(fs.readdirSync(directory).filter((name) => /^2026-/.test(name)).sort(),
            Array.from({ length: 7 }, (_, index) => '2026-02-' + String(index + 8).padStart(2, '0') + '.log'));
          assert.equal(fs.readFileSync(path.join(directory, '2026-02-13.log'), 'utf8'),
            subDir + '-existing-13\n[DEBUG] 2026-02-13 23:59:59.123 before-midnight\n');
          assert.equal(fs.readFileSync(path.join(directory, '2026-02-14.log'), 'utf8'),
            '[DEBUG] 2026-02-14 00:00:00.456 after-midnight\n');
          assert.equal(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8'), 'keep unrelated extension');
          assert.equal(fs.statSync(path.join(directory, 'not-a-file.log')).isDirectory(), true);
        }
      `,
      undefined,
      { debug: 'true' },
    );
  }, 15_000);

  it('uses consumption day for a queued file, while retaining its original log timestamp', async () => {
    await withLoggerProcess(
      String.raw`
        ${fixtureImport}
        ${clockSource}
        const boundary = installControlledFiles({ highWaterMark: 1, heldWrites: ['debug'] });
        ${loggerImport}
        logger.debug('old-day-blocker');
        logger.info('queued-before-midnight');
        await waitUntil(() => boundary.files.some((file) => file.subDir === 'debug' && file.pendingWrites.length === 1), 'debug holds the common file barrier');
        clock = NativeDate.parse('2026-02-13T16:00:00.000Z');
        const debug = boundary.files.find((file) => file.subDir === 'debug');
        boundary.heldWrites.delete('debug');
        debug.pendingWrites.shift()();
        assert.equal(await shutdownLogger(), true);
        const system = boundary.files.filter((file) => file.subDir === 'system');
        assert.equal(system.length, 2);
        assert.equal(path.basename(system[0].name), '2026-02-13.log');
        assert.equal(path.basename(system[1].name), '2026-02-14.log');
        assert.equal(system[0].writes.join(''), '[DEBUG] 2026-02-13 23:59:59.123 old-day-blocker\n');
        assert.equal(system[1].writes.join(''), '[INFO] 2026-02-13 23:59:59.123 queued-before-midnight\n');
        assert.ok(boundary.files.every((file) => file.stream.closed));
        assert.ok(boundary.files.every((file) => file.writeOptions.flags === 'a'));
        boundary.restore();
      `,
      undefined,
      { debug: 'true' },
    );
  }, 15_000);
});
