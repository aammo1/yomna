// The macOS hands helper, built the way src-tauri/build.rs builds it (hands/main.swift first, then shared/*.swift),
// passes its own --self-test. That self-test holds the helper's pure checks, among them two regressions from the
// v0.2.10 Classic session (2026-11-27): a page's "…" (U+2026) and the three dots a model writes are the same label
// (fill "Add a reply..." failed with no_field), and typing into a field with no value to read back is unconfirmed,
// never plain success (an empty YouTube reply box was submitted and Jarvis said "I replied"). Without a Swift
// toolchain (Linux, Windows CI) the source is checked instead. Run: npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../src-tauri/', import.meta.url));
const main = path.join(root, 'hands', 'main.swift');
const src = fs.readFileSync(main, 'utf8');
for (const name of ["a label's … matches three typed dots", 'a field with no value to read back is unconfirmed, not typed']) {
  assert.ok(src.includes(`check("${name}"`), `the self-test checks: ${name}`);
}
if (process.platform !== 'darwin' || spawnSync('swiftc', ['--version']).status !== 0) {
  assert.match(src, /replacingOccurrences\(of: "\\u\{2026\}", with: "\.\.\."\)/, 'fold maps … to three dots');
  console.log('hands helper: source checked (no Swift toolchain)');
} else {
  const shared = fs.readdirSync(path.join(root, 'shared')).filter((f) => f.endsWith('.swift')).sort().map((f) => path.join(root, 'shared', f));
  const extra = fs.readdirSync(path.join(root, 'hands')).filter((f) => f.endsWith('.swift') && f !== 'main.swift').sort().map((f) => path.join(root, 'hands', f));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hands-'));
  const bin = path.join(dir, 'jarvis-hands');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  try {
    const c = spawnSync('swiftc', ['-swift-version', '5', '-target', `${arch}-apple-macos11.0`, '-Xlinker', '-weak_framework', '-Xlinker', 'ScreenCaptureKit', '-o', bin, main, ...extra, ...shared], { encoding: 'utf8' });
    assert.equal(c.status, 0, `the helper builds: ${c.stderr.split('\n').filter((l) => /error:/.test(l)).slice(0, 5).join('\n')}`);
    const r = spawnSync(bin, ['--self-test'], { encoding: 'utf8' });
    const failed = r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
    assert.deepEqual(failed, [], 'every self-test check passes');
    assert.equal(r.status, 0);
    console.log(`hands helper: built and ${r.stdout.split('\n').filter((l) => l.startsWith('ok')).length} self-test checks passed`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
