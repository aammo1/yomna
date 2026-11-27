// A background agent's long run: once its messages outgrow the budget, old tool results shrink, while the brief
// (the first two messages) and the latest 12 stay whole. trimRun is pure; importing agentrun.mjs starts its idle
// heartbeat (no IPC channel here, so nothing is sent), so this file exits itself at the end. Run: npm test
import assert from 'node:assert/strict';
import { trimRun } from '../agentrun.mjs';

const big = 'x'.repeat(2000);
const toolMsg = (text) => ({ role: 'tool', content: [{ id: 't', content: text }] });
const msgs = [
  { role: 'user', content: 'brief' },
  toolMsg(big), // index 1: part of the brief, kept whole
  ...Array.from({ length: 6 }, () => toolMsg(big)), // old results: trimmed
  { role: 'assistant', content: big }, // not a tool result: kept whole
  ...Array.from({ length: 12 }, () => toolMsg(big)), // latest 12: kept whole
];

// Under budget: the same array back, untouched.
assert.equal(trimRun(msgs, 1e9), msgs, 'under budget the run is returned as is');

const out = trimRun(msgs, 10_000);
assert.equal(out.length, msgs.length, 'trimming drops no message');
assert.equal(out[1].content[0].content, big, 'the brief tool result stays whole');
for (let i = 2; i < 8; i++) {
  const c = out[i].content[0].content;
  assert.ok(c.startsWith('x'.repeat(300)) && c.includes('trimmed to save space') && c.length < 400, `old result ${i} shrank`);
}
assert.equal(out[8].content, big, 'an assistant message is never trimmed');
for (let i = msgs.length - 12; i < msgs.length; i++) assert.equal(out[i].content[0].content, big, `latest result ${i} stays whole`);
assert.equal(msgs[2].content[0].content, big, 'the original run is not mutated');

// Images count toward the budget (about 6,000 each) and a short text part is left as it is.
const img = { role: 'tool', content: [{ id: 'i', content: [{ type: 'image' }, { type: 'text', text: 'ok' }] }] };
const withImg = [{ role: 'user', content: 'b' }, img, img, img, ...Array.from({ length: 12 }, () => ({ role: 'user', content: 'u' }))];
assert.equal(trimRun(withImg, 20_000), withImg, 'three images and short text fit 20k');
const t = trimRun(withImg, 10_000);
assert.equal(t[2].content[0].content, 'ok', 'an old image result collapses to its text');

console.log('regress-trim: ok');
process.exit(0);
