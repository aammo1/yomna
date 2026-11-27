import assert from 'node:assert/strict';
import { createSpeaker, DEFAULT_TTS_PROVIDER, PROVIDERS, trimSilence, voiceProblemText } from '../speaker.mjs';

class FakeVoice {
  constructor(o) { Object.assign(this, o); this.said = []; this.ended = false; this.aborted = false; FakeVoice.made.push(this); }
  open() { return this; }
  say(s) { this.said.push(s); }
  end() { this.ended = true; }
  abort() { this.aborted = true; }
  rebind(cbs) { Object.assign(this, cbs); return true; }
}
FakeVoice.made = [];
const tick = () => new Promise((r) => setTimeout(r, 0));

assert.equal(DEFAULT_TTS_PROVIDER, 'local');
assert.deepEqual(Object.keys(PROVIDERS), ['local', 'edge', 'voicestudio', 'gemini']);

// Local TTS (default): keyless, ready immediately, emits { kind: 'speech' } audio chunks & end.
{
  FakeVoice.made = [];
  const out = [];
  const sp = createSpeaker({ emit: (m) => out.push(m), LocalVoiceImpl: FakeVoice, beatPhrases: [] });
  assert.equal(sp.provider, 'local');
  assert.equal(sp.on, true);
  const r = sp.start();
  assert.ok(r);
  assert.deepEqual(out.at(-1), { kind: 'speech', stop: true });
  r.say('Hello.'); r.end();
  const v = FakeVoice.made[0];
  assert.deepEqual(v.said, ['Hello.']);
  assert.equal(v.ended, true);
  v.onAudio(new Uint8Array([1, 0, 2, 0]));
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: PROVIDERS.local.rate, pcm: Buffer.from([1, 0, 2, 0]).toString('base64') });
  v.onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 6 });
}

// Gemini requires a key; without one sp.start() is null; with one it works.
{
  FakeVoice.made = [];
  const out = [], problems = [];
  const sp = createSpeaker({
    provider: 'gemini',
    emit: (m) => out.push(m),
    onProblem: (p) => problems.push(p),
    providers: { gemini: { Voice: FakeVoice, account: async () => ({ ok: true }) } },
    beatPhrases: [],
  });
  assert.equal(sp.on, false);
  assert.equal(sp.start(), null);
  sp.setKey('AIza-test'); await tick();
  assert.equal(sp.on, true);
  const r = sp.start(); r.say('Hi.'); r.end();
  assert.deepEqual(FakeVoice.made[0].said, ['Hi.']);
  sp.stop();
  assert.equal(FakeVoice.made[0].aborted, true);
  assert.deepEqual(out.at(-1), { kind: 'speech', stop: true });
}

// Edge TTS falls back to local if it errors before hearing audio.
{
  FakeVoice.made = [];
  const out = [];
  const sp = createSpeaker({
    provider: 'edge',
    emit: (m) => out.push(m),
    LocalVoiceImpl: FakeVoice,
    EdgeVoiceImpl: FakeVoice,
    beatPhrases: [],
  });
  const r = sp.start(); r.say('Test.'); r.end();
  await FakeVoice.made[0].onError(Object.assign(new Error('Edge TTS: offline'), { heard: false }));
  assert.equal(FakeVoice.made.length, 2, 'fell back to LocalVoice');
  assert.deepEqual(FakeVoice.made[1].said, ['Test.']);
  FakeVoice.made[1].onAudio(new Uint8Array([0, 0])); FakeVoice.made[1].onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 5 });
}

// Helpers: trimSilence and voiceProblemText.
{
  const buf = Buffer.from(new Int16Array([0, 0, 1000, -1000, 0, 0]).buffer);
  const trimmed = trimSilence(buf, 100);
  assert.ok(trimmed.length <= buf.length);
  assert.match(voiceProblemText('key', 'Gemini'), /Gemini key isn't working/);
  assert.match(voiceProblemText('Gemini: rate limited', 'Gemini'), /rate limited/);
}

console.log('speaker tests: passed');
