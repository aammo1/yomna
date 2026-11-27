// draw in a Live call (livecall.mjs): each beat's line goes into the call with the tool's answer, and the marks are
// held until her voice for them starts, so they keep pace with what she says, as in Classic. If her voice never comes
// (she's cut off, the turn ends silent, the call hangs up), the rest still draws. Classic pacing is untouched.
// The real draw tool and the real Live brain; a fake Live transport plays Gemini's side. Run: npm test
import assert from 'node:assert/strict';
import { createLiveBrain } from '../livebrain.mjs';
import { createLiveCall } from '../livecall.mjs';
import { createTools } from '../tools.mjs';

const noop = () => {};
const fakeTransport = () => {
  const calls = [];
  const connect = async (params) => {
    const sent = [];
    const s = {
      sent, closed: false,
      sendRealtimeInput: (m) => sent.push({ realtime: m }),
      sendClientContent: (m) => sent.push({ content: m }),
      sendToolResponse: (m) => sent.push({ tool: m }),
      close() { s.closed = true; },
      server: (msg) => params.callbacks.onmessage(msg),
    };
    calls.push(s);
    return s;
  };
  return { connect, calls };
};
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

// Wired the way sidekick.mjs wires it: draw's lines and its overlay messages go through the call while one is open.
const setup = ({ classicSpeak = () => false } = {}) => {
  const t = fakeTransport(), overlay = [];
  let call = null;
  const made = createTools({
    allowActions: () => true, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
    speak: (line) => (call.open ? call.say(line) : classicSpeak(line)),
    ui: (m) => {
      if (call.holdDraw(m)) return;
      overlay.push(m);
      // The overlay: a segment it's given starts at once.
      if (m.e?.type === 'draw') setImmediate(() => made.ink.started(m.e.id, m.e.seg));
    },
  });
  call = createLiveCall({
    makeBrain: async (emit) => createLiveBrain({ emit, connect: t.connect, key: 'k', tools: made.tools, system: () => 'You are Jarvis.' }),
    ui: (m) => overlay.push(m), send: noop, ask: async () => null, toClassic: noop,
    inkStarted: (id, seg) => made.ink.started(id, seg),
  });
  const draws = () => overlay.filter((m) => m.e?.type === 'draw').map((m) => m.e);
  const answer = (s, id) => s.sent.find((x) => x.tool?.functionResponses?.[0]?.id === id)?.tool.functionResponses[0].response;
  return { t, call, made, overlay, draws, answer };
};
const twoBeats = { beats: [{ say: 'This is the sun.', marks: [{ kind: 'note', text: 'sun' }] }, { say: 'And this is the moon.', marks: [{ kind: 'note', text: 'moon' }] }] };
const audio = (data = 'AAAA') => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }] } } });

{ // Held until her voice for it: nothing draws while the tool answers, the answer carries the lines to say, and the
  // marks go to the overlay (voiced, so it paces them to her voice) when her audio after the answer starts.
  const { t, call, draws, answer } = setup();
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  s.server({ toolCall: { functionCalls: [{ id: 'c1', name: 'draw', args: twoBeats }] } });
  await until(() => answer(s, 'c1'));
  assert.equal(draws().length, 0, 'no marks before her voice');
  const out = answer(s, 'c1').output;
  assert.match(out, /Say these lines out loud now.*"This is the sun\." "And this is the moon\."/);
  assert.doesNotMatch(out, /Already said/);
  s.server(audio());
  assert.deepEqual(draws().map((e) => [e.id, e.seg, e.last]), [['c1', 0, false], ['c1', 1, true]], 'released in order on her first audio');
  assert.ok(draws().every((e) => e.beats.every((b) => b.voiced)), 'voiced: the overlay paces them to her voice');
  s.server(audio('BBBB'));
  assert.equal(draws().length, 2, 'released once');
  await call.toggle();
}

{ // Cut off before her voice comes: the rest still draws (on its own timing), so a drawing is never left half done.
  const { t, call, draws, answer } = setup();
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  s.server({ toolCall: { functionCalls: [{ id: 'c2', name: 'draw', args: twoBeats }] } });
  await until(() => answer(s, 'c2'));
  assert.equal(draws().length, 0);
  s.server({ serverContent: { interrupted: true } });
  assert.deepEqual(draws().map((e) => e.seg), [0, 1], 'an interrupt flushes the rest');
  assert.ok(draws().every((e) => e.beats.every((b) => !b.voiced)), 'flushed unvoiced: no voice to wait for');
  await call.toggle();
}

{ // Her turn ends with no voice for it, or the call hangs up: the held marks draw too.
  const { t, call, draws, answer } = setup();
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  s.server({ toolCall: { functionCalls: [{ id: 'c3', name: 'draw', args: twoBeats }] } });
  await until(() => answer(s, 'c3'));
  s.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(draws().map((e) => e.seg), [0, 1], 'a silent turn end flushes');
  s.server({ toolCall: { functionCalls: [{ id: 'c4', name: 'draw', args: { ...twoBeats, keep: true } }] } });
  await until(() => answer(s, 'c4'));
  assert.equal(draws().filter((e) => e.id === 'c4').length, 0);
  await call.toggle(); // hang up
  assert.deepEqual(draws().filter((e) => e.id === 'c4').map((e) => e.seg), [0, 1], 'hanging up flushes');
}

{ // Classic (no call open): draw goes straight to the overlay, paced by Classic's own voice, and says it was said.
  const spoken = [];
  const { call, made, draws } = setup({ classicSpeak: (l) => { spoken.push(l); return true; } });
  assert.equal(call.open, false);
  const draw = made.tools.find((x) => x.name === 'draw');
  const res = await draw.execute(twoBeats, { toolCallId: 'k1' });
  assert.deepEqual(draws().map((e) => e.seg), [0, 1]);
  assert.ok(draws().every((e) => e.beats.every((b) => b.voiced)));
  assert.deepEqual(spoken, ['This is the sun.', 'And this is the moon.']);
  assert.match(res, /Already said out loud as it drew: "This is the sun\." "And this is the moon\."/);
}

console.log('live draw tests passed');
process.exit(0);
