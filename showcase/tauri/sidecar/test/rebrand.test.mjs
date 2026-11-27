// The sign-in pages a browser shows come from GG Coder's libraries and named GG Coder ("You're signed in to GG
// Coder."). bundle.sh runs rebrand.mjs over the bundle so they say Jarvis, and fails the build when a page's words
// are no longer there (a library update changed them), so it can't quietly go back. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REBRAND, rebrandFiles } from '../rebrand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Every .js file in a library's dist folder (its chunk names change with each release).
const distJs = (pkg) => {
  const dir = path.join(here, '..', 'node_modules', '@kenkaiiii', pkg, 'dist');
  return fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(c|m)?js$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
};

// Each page's words are still in the libraries as installed (else the build would fail; this says why sooner).
const libs = distJs('gg-core') + distJs('ggcoder');
for (const [from] of REBRAND) assert.ok(libs.includes(from), `still in the library: ${from}`);
assert.ok(REBRAND.some(([from, to]) => /signed in to GG Coder/.test(from) && /signed in to Jarvis\./.test(to)), 'the ChatGPT sign-in page');
assert.ok(REBRAND.some(([from, to]) => /return to GG Coder/.test(from) && /return to Jarvis\./.test(to)), 'a connection\'s sign-in page');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rebrand-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const a = path.join(tmp, 'a.mjs'), b = path.join(tmp, 'b.mjs');
{ // Every page is rebranded across the files, wherever it landed; the rest of the file is left as it was.
  fs.writeFileSync(a, `x("${REBRAND[0][0]}"); const AGENT_NAME = "GG Coder";`);
  fs.writeFileSync(b, REBRAND.slice(1).map(([f]) => `y(\`${f}\`)`).join('\n'));
  rebrandFiles([a, b]);
  const out = fs.readFileSync(a, 'utf8') + fs.readFileSync(b, 'utf8');
  for (const [from, to] of REBRAND) { assert.ok(!out.includes(from)); assert.ok(out.includes(to)); }
  assert.match(out, /AGENT_NAME = "GG Coder"/, 'only the pages change');
}
{ // A page missing from every file fails, naming it.
  fs.writeFileSync(a, 'nothing here'); fs.writeFileSync(b, 'nor here');
  assert.throws(() => rebrandFiles([a, b]), /signed in to GG Coder/);
  // And as bundle.sh runs it: a non-zero exit.
  const r = spawnSync(process.execPath, [path.join(here, '..', 'rebrand.mjs'), a, b], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
}
// bundle.sh runs it over both bundles, after esbuild.
assert.match(fs.readFileSync(path.join(here, '..', 'bundle.sh'), 'utf8'), /node rebrand\.mjs dist\/sidekick\.mjs dist\/agentrun\.mjs/);
console.log('rebrand ok');
