// Cutting in on her in a Live call (livecall.mjs): loud speech on the mic while she talks stops her playback at once,
// without waiting for Gemini's `interrupted`, and the rest of that reply's audio is dropped. Quiet or short noise
// doesn't stop her, and her next reply plays normally. Synthetic 16 kHz PCM frames, the real Live brain, a fake
// Live transport plays Gemini's side. Run: npm test
import assert from 'node:assert/strict';
import { createLiveBrain } from '../livebrain.mjs';
import { createLiveCall } from '../livecall.mjs';

const fakeTransport = () => {
  const calls = [];
  const connect = async (params) => {
    const s = {
      sent: [], closed: false,
      sendRealtimeInput: (m) => s.sent.push({ realtime: m }),
      sendClientContent: (m) => s.sent.push({ content: m }),
      sendToolResponse: (m) => s.sent.push({ tool: m }),
      close() { s.closed = true; },
      server: (msg) => params.callbacks.onmessage(msg),
    };
    calls.push(s);
    return s;
  };
  return { connect, calls };
};
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

// One helper mic frame: 21 ms of 16 kHz s16le mono, a sine at `level` of full scale, as base64 (what live_pcm carries).
const frame = (level, ms = 21) => {
  const n = Math.round(16 * ms), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * level * 32767), i * 2);
  return b.toString('base64');
};
const frames = (level, count) => Array.from({ length: count }, () => frame(level));
const her = (data) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }] } } });

const setup = async () => {
  const t = fakeTransport();
  const uis = [];
  const call = createLiveCall({
    makeBrain: async (emit) => createLiveBrain({ emit, connect: t.connect, key: 'k', tools: [], system: () => 'You are Jarvis.' }),
    ui: (m) => uis.push(m), send: () => {}, ask: async () => null, toClassic: () => {},
  });
  await call.toggle();
  await until(() => t.calls.length === 1);
  const speech = () => uis.filter((m) => m.kind === 'speech');
  return { s: t.calls[0], call, uis, speech };
};

{ // Loud speech for ~150 ms while she talks stops her at once, and the rest of that reply is dropped.
  const { s, call, speech } = await setup();
  s.server(her('AAAA'));
  for (const f of frames(0.3, 8)) call.pcm(f); // 8 × 21 ms = 168 ms
  assert.deepEqual(speech().at(-1), { kind: 'speech', stop: true }, 'she stops before Gemini says interrupted');
  const n = speech().length;
  s.server(her('BBBB')); // still the cut reply: dropped
  assert.equal(speech().length, n);
  s.server({ serverContent: { interrupted: true } }); // Gemini's backstop still works
  s.server(her('CCCC')); // her next reply plays normally
  assert.equal(speech().at(-1).pcm, 'CCCC');
  call.hangUp();
}

{ // Quiet sound, or a short loud click, doesn't stop her.
  const { s, call, speech } = await setup();
  s.server(her('AAAA'));
  for (const f of frames(0.005, 30)) call.pcm(f); // quiet room / echo residue
  for (const f of frames(0.3, 3)) call.pcm(f); // a 63 ms knock
  for (const f of frames(0.005, 3)) call.pcm(f);
  for (const f of frames(0.3, 3)) call.pcm(f); // another, not joined to the first
  assert.ok(!speech().some((m) => m.stop), 'no stop');
  s.server(her('BBBB'));
  assert.equal(speech().at(-1).pcm, 'BBBB');
  call.hangUp();
}

{ // Talking while she is silent (no reply playing) doesn't send a stop: there's nothing to cut.
  const { call, speech } = await setup();
  for (const f of frames(0.3, 20)) call.pcm(f);
  assert.equal(speech().length, 0);
  call.hangUp();
}

console.log('live cut-in tests passed');
process.exit(0);
