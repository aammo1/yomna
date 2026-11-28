// Unit tests for launch() in tools.mjs (Linux launcher grace period and error handling).
import assert from 'node:assert/strict';
import test from 'node:test';
import { launch, runShell } from '../tools.mjs';

test('launch resolves with err: null when launcher exits 0', async () => {
  const r = await launch(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(r.err, null);
});

test('launch returns error and stderr on non-zero exit', async () => {
  const r = await launch(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']);
  assert.ok(r.err);
  assert.equal(r.err.code, 3);
  assert.match(r.stderr, /boom/);
});

test('launch treats a launcher still running past grace as success without waiting for it to exit', async () => {
  const t0 = Date.now();
  const r = await launch(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { grace: 200 });
  const elapsed = Date.now() - t0;
  assert.equal(r.err, null);
  assert.ok(elapsed < 1000, `expected resolve < 1000 ms, took ${elapsed} ms`);
});

test('launch supports numeric third argument as grace period for backwards compatibility', async () => {
  const t0 = Date.now();
  const r = await launch(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], 200);
  const elapsed = Date.now() - t0;
  assert.equal(r.err, null);
  assert.ok(elapsed < 1000, `expected resolve < 1000 ms, took ${elapsed} ms`);
});

test('launch returns ENOENT when launcher binary does not exist', async () => {
  const r = await launch('/nonexistent/launcher-xyz', []);
  assert.ok(r.err);
  assert.equal(r.err.code, 'ENOENT');
});

test('runShell returns output and exit code like run()', async () => {
  const ok = await runShell('/bin/sh', ['-c', 'echo hi; echo oops >&2']);
  assert.equal(ok.err, null);
  assert.equal(ok.stdout.trim(), 'hi');
  assert.match(ok.stderr, /oops/);
  const bad = await runShell('/bin/sh', ['-c', 'exit 4']);
  assert.equal(bad.err.code, 4);
});

test('runShell does not hang on a background app that keeps the output open', { skip: process.platform === 'win32' }, async () => {
  const t0 = Date.now();
  const r = await runShell('/bin/sh', ['-c', `echo started; "${process.execPath}" -e "setTimeout(() => {}, 3000)" &`]);
  const elapsed = Date.now() - t0;
  assert.equal(r.err, null);
  assert.equal(r.stdout.trim(), 'started');
  assert.ok(elapsed < 1500, `expected resolve < 1500 ms, took ${elapsed} ms`);
});

test('runShell still times out a foreground command', { skip: process.platform === 'win32' }, async () => {
  const r = await runShell('/bin/sh', ['-c', 'sleep 5'], { timeout: 200 });
  assert.equal(r.err.code, 'ETIMEDOUT');
});
