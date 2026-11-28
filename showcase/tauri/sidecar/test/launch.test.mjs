// Unit tests for launch() in tools.mjs (Linux launcher grace period and error handling).
import assert from 'node:assert/strict';
import test from 'node:test';
import { launch } from '../tools.mjs';

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
