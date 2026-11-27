// An area to ask about in Classic (a ⌃⌥A crop, or a circle drawn with the highlight keys while nothing was said):
// the mic listens hands-free for the question for up to 12 s, and with nothing said the "What about this?" field
// opens. Words that come take the area with them, which ends the wait. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LISTEN_MS, listenThenAsk } from '../areaask.mjs';

const image = { type: 'image', data: 'x' };
const run = ({ voice = true, answer = 'what is this button', speakAfter = null, ms = 60 } = {}) => {
  let snap = { image, at: Date.now() };
  const listens = [], asks = [], sent = [];
  if (speakAfter != null) setTimeout(() => { snap = null; }, speakAfter); // onSpoken took the area with the words
  const done = listenThenAsk({
    pending: () => snap, drop: () => { snap = null; }, voice, ms, step: 5,
    listen: () => listens.push('listen'),
    ask: async (o) => { asks.push(o); return answer; },
    enqueue: (text, o) => sent.push([text, o]),
  });
  return { done, listens, asks, sent, get snap() { return snap; } };
};

assert.equal(LISTEN_MS, 12_000, 'the mic waits 12 s for the question, as after ⌃⌥A');
{ // Nothing said: listens once, then asks by typing, and the typed question goes with the area.
  const r = run();
  assert.equal(await r.done, 'typed');
  assert.deepEqual(r.listens, ['listen'], 'the mic opened hands-free straight away');
  assert.deepEqual(r.asks, [{ placeholder: 'What about this?' }]);
  assert.deepEqual(r.sent, [['what is this button', { image }]]);
  assert.equal(r.snap, null, 'the area is used up');
}
{ // Said something while it listened: the words took the area, so no field opens.
  const r = run({ speakAfter: 10, ms: 2000 });
  assert.equal(await r.done, 'spoken');
  assert.deepEqual(r.asks, []);
  assert.deepEqual(r.sent, []);
}
{ // Escape in the field: the area is dropped. An empty answer asks the plain question.
  const r = run({ answer: null });
  assert.equal(await r.done, 'dropped');
  assert.deepEqual(r.sent, []);
  assert.equal(r.snap, null);
  const blank = run({ answer: '  ' });
  await blank.done;
  assert.deepEqual(blank.sent, [['What is this? Explain it simply.', { image }]]);
}
{ // Voice off: straight to the field, no listening.
  const r = run({ voice: false });
  await r.done;
  assert.deepEqual(r.listens, []);
  assert.equal(r.asks.length, 1);
}
{ // sidekick.mjs: ⌃⌥A and the helper's highlight (Classic, circled, no words) both go through it.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const snapFn = src.slice(src.indexOf('async function areaSnap()'), src.indexOf('let snapping = false'));
  assert.match(snapFn, /await askAboutSnap\(\);/);
  assert.match(src, /const askAboutSnap = \(\) => listenThenAsk\(\{[^]{0,200}listen: \(\) => send\(\{ type: 'listen' \}\), ask, enqueue,/);
  assert.match(src, /else if \(m\.type === 'highlight'\) \{ if \(voiceModeOf\(config\) !== 'live'\) onHighlight\(m\.area\);/);
  const hl = src.slice(src.indexOf('async function onHighlight('));
  assert.match(hl, /^[^]{0,600}await askAboutSnap\(\);/, 'a circle with no words listens, then asks');
}
console.log('area ask tests: passed');
