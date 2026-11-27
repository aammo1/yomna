// The panel's Effort slider says how slow the top levels are. Regression (v0.2.10, Classic, 2026-11-27): Max on GPT-6.2
// Sol took 37-52 s before the first word, and nothing on the slider warned of it. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const js = fs.readFileSync(new URL('../../../panel/panel.js', import.meta.url), 'utf8');
const line = js.split('\n').find((l) => /^\s*const effortNote = /.test(l));
assert.ok(line, 'panel.js has effortNote');
const ctx = { EFFORT_HINT: 'Higher is smarter but slower.' };
vm.runInNewContext(`${line.trim().replace(/^const /, 'var ')}`, ctx);
for (const level of ['max', 'ultra']) assert.match(ctx.effortNote(level), /much slower: answers can take a minute/i, `${level} warns`);
for (const level of ['off', 'low', 'medium', 'high', 'xhigh', '']) assert.equal(ctx.effortNote(level), ctx.EFFORT_HINT, `${level || 'automatic'} keeps the usual hint`);
// The slider updates the hint as it moves (show), so the note is there before letting go.
assert.match(js, /const show = \(i\) => \{[^}]*hintEl\.textContent = effortNote\(stops\[i\]\)/, 'moving the slider updates the hint');
console.log('effort hint tests: passed');
