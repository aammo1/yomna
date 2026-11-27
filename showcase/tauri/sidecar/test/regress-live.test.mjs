// Regression tests for the Live stack (live.mjs, livebrain.mjs, livecall.mjs, voicemode.mjs): the edges a Live call
// hits in real use that the per-module tests don't pin down. A fake Live transport plays Gemini's side; tools are small
// fakes with zod schemas, so nothing touches the network, the screen or a real key. Run: npm test
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createLive, geminiConnect, reasonFor, val } from '../live.mjs';
import { createLiveBrain, langLine } from '../livebrain.mjs';
import { createLiveCall, liveErrorText, SWITCH_TO_CLASSIC, CUT_IN } from '../livecall.mjs';
import { voiceModeOf, setVoiceMode, liveVoiceOf, setLiveVoice, DEFAULT_VOICE_MODE } from '../voicemode.mjs';

const fakeTransport = () => {
  const calls = [];
  const connect = async (params) => {
    const sent = [];
    const s = {
      params, sent, closed: false,
      sendRealtimeInput: (m) => sent.push({ realtime: m }),
      sendClientContent: (m) => sent.push({ content: m }),
      sendToolResponse: (m) => sent.push({ tool: m }),
      close() { s.closed = true; },
      server: (msg) => params.callbacks.onmessage(msg),
      drop: (e) => params.callbacks.onclose(e),
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
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const responses = (s) => s.sent.filter((m) => m.tool).flatMap((m) => m.tool.functionResponses);
const notes = (s) => s.sent.filter((m) => m.realtime?.text).map((m) => m.realtime.text);
const callTools = (s, calls) => s.server({ toolCall: { functionCalls: calls } });
const brainSetup = ({ tools, ...more } = {}) => {
  const t = fakeTransport();
  const out = [];
  const brain = createLiveBrain({ connect: t.connect, emit: (e) => out.push(e), key: 'k', tools, system: () => 'You are Jarvis.', ...more });
  return { t, out, brain };
};
const tool = (name, execute, parameters = z.object({})) => ({ name, description: `${name} tool.`, parameters, execute });

// ---------- Critical paths (Live, unit level): run first, tagged CP-<n> ----------
// A CP test that fails names its path, so the critical paths can be read off the output on their own.
const cp = async (name, fn) => {
  try { await fn(); } catch (err) { err.message = `${name}: ${err.message}`; throw err; }
  console.log(`ok ${name}`);
};
// A Live call wired the way sidekick wires it: createLiveCall over a real createLiveBrain over the fake Gemini socket.
const liveCall = ({ tools = [], anim = () => null, holdMs, inkStarted } = {}) => {
  const t = fakeTransport();
  const uis = [], sends = [], logs = [];
  let turns = 0;
  const call = createLiveCall({
    makeBrain: async (emit) => createLiveBrain({ emit, connect: t.connect, key: 'k', tools, system: () => 'You are Jarvis.' }),
    ui: (m) => uis.push(m), send: (m) => sends.push(m), ask: async () => null, toClassic: () => {},
    log: (...a) => logs.push(a), anim, newTurn: () => `req-${++turns}`,
    hangUpHint: 'Tap to hang up', ...(holdMs ? { holdMs } : {}), ...(inkStarted ? { inkStarted } : {}),
  });
  const open = async () => { await call.toggle(); await until(() => t.calls.length >= 1 && sends.some((m) => m.on === true)); return t.calls.at(-1); };
  return { t, call, uis, sends, logs, open };
};
const agentEvents = (uis) => uis.filter((m) => m.kind === 'agent').map((m) => m.e);

await cp('CP-1 Live call opens, answers a text turn with text and voice, and hangs up cleanly (tap)', async () => {
  const { t, call, uis, sends, logs, open } = liveCall();
  const s = await open();
  assert.equal(call.open, true);
  assert.deepEqual(uis[0], { kind: 'live', state: 'connecting', hint: 'Live · Connecting…' });
  assert.deepEqual(uis.find((m) => m.state === 'listening'), { kind: 'live', state: 'listening', hint: 'Live · Listening… Tap to hang up' });
  assert.deepEqual(sends, [{ type: 'live_capture', on: true }], 'the mic starts once the call is listening');
  assert.equal(s.params.config.systemInstruction.startsWith('You are Jarvis.'), true, 'her prompt is Jarvis\'s');
  // Their turn (typed as text into the call), then her reply: caption text and a chunk of voice, then turn complete.
  s.server({ serverContent: { inputTranscription: { text: 'what time is it' } } });
  assert.deepEqual(uis.find((m) => m.heard), { kind: 'live', heard: 'what time is it' });
  s.server({ serverContent: { outputTranscription: { text: 'It is ' } } });
  s.server({ serverContent: { outputTranscription: { text: 'noon.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } });
  s.server({ serverContent: { turnComplete: true } });
  const ev = agentEvents(uis);
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'text', 'done']);
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'It is noon.');
  assert.equal(ev.at(-1).speech, 'live-0', 'the reply bubble is tied to her voice');
  assert.deepEqual(uis.find((m) => m.kind === 'speech' && m.pcm), { kind: 'speech', id: 'live-0', rate: 24000, pcm: 'AAAA' });
  assert.ok(uis.some((m) => m.kind === 'speech' && m.id === 'live-0' && m.end), 'her voice ends with the turn');
  assert.ok(uis.some((m) => m.turn === true), 'the listening bubble makes way for her reply');
  // Tap hangs up: socket closed, mic off, overlay closed, logged with the turn count.
  assert.equal(call.hangUp('tap'), true);
  assert.equal(s.closed, true);
  assert.equal(call.open, false);
  assert.deepEqual(sends.at(-1), { type: 'live_capture', on: false });
  assert.deepEqual(uis.at(-1), { kind: 'live', state: 'closed' });
  const end = logs.find(([k]) => k === 'live_end')[1];
  assert.equal(end.why, 'tap');
  assert.equal(end.turns, 1);
  assert.equal(call.hangUp('tap'), false, 'nothing left to hang up');
  assert.equal(t.calls.length, 1);
});

await cp('CP-1 Live call hangs up cleanly on Esc and on a second toggle', async () => {
  { const { call, logs, open } = liveCall(); const s = await open(); call.hangUp('esc'); assert.equal(s.closed, true); assert.equal(logs.find(([k]) => k === 'live_end')[1].why, 'esc'); }
  { const { call, logs, open } = liveCall(); const s = await open(); await call.toggle(); assert.equal(s.closed, true); assert.equal(call.open, false); assert.equal(logs.find(([k]) => k === 'live_end')[1].why, 'tap'); }
});

await cp('CP-3 Live tool call round trip: the real execute runs and its answer goes back under the matching id', async () => {
  const got = [];
  const showList = tool('show_list', async (a) => { got.push(a); return 'Shown 2 items.'; }, z.object({ title: z.string(), items: z.array(z.string()) }));
  const { call, uis, logs, open } = liveCall({ tools: [showList], anim: (n) => (n === 'show_list' ? 'list' : null) });
  const s = await open();
  assert.ok(s.params.config.tools[0].functionDeclarations.some((d) => d.name === 'show_list'), 'the tool is declared to Gemini');
  s.server({ serverContent: { inputTranscription: { text: 'list my errands' } } });
  callTools(s, [{ id: 'call-77', name: 'show_list', args: { title: 'Errands', items: ['milk', 'mail'] } }]);
  await until(() => responses(s).length === 1);
  assert.deepEqual(got, [{ title: 'Errands', items: ['milk', 'mail'] }]);
  assert.deepEqual(responses(s), [{ id: 'call-77', name: 'show_list', response: { output: 'Shown 2 items.' } }]);
  const ev = agentEvents(uis);
  assert.deepEqual(ev.find((e) => e.type === 'tool'), { type: 'tool', id: 'call-77', anim: 'list' }, 'the tool tag shows as in Classic');
  assert.deepEqual(ev.find((e) => e.type === 'tool_end'), { type: 'tool_end', id: 'call-77', isError: false });
  const [, logged] = logs.find(([k]) => k === 'tool');
  assert.deepEqual({ turn: logged.turn, id: logged.id, name: logged.name }, { turn: 'req-1', id: 'call-77', name: 'show_list' }, 'logged under the turn that asked');
  call.hangUp();
});

await cp('CP-5 Live see the screen: a screenshot\'s image goes into the call as video, its text as the answer', async () => {
  const shot = tool('take_screenshot', async () => ({ content: [{ type: 'text', text: 'Screenshot of the main display.' }, { type: 'image', data: 'iVBORw0K', mediaType: 'image/png' }] }));
  const win = tool('read_window', async () => 'Notes: Groceries\n- milk');
  const { call, open } = liveCall({ tools: [shot, win] });
  const s = await open();
  callTools(s, [{ id: 'ss1', name: 'take_screenshot', args: {} }]);
  await until(() => responses(s).length === 1);
  const vids = s.sent.filter((m) => m.realtime?.video).map((m) => m.realtime.video);
  assert.deepEqual(vids, [{ data: 'iVBORw0K', mimeType: 'image/png' }]);
  assert.deepEqual(responses(s)[0], { id: 'ss1', name: 'take_screenshot', response: { output: 'Screenshot of the main display.' } });
  const imgAt = s.sent.findIndex((m) => m.realtime?.video), ansAt = s.sent.findIndex((m) => m.tool);
  assert.ok(imgAt < ansAt, 'the picture is in the call before the answer that describes it');
  callTools(s, [{ id: 'rw1', name: 'read_window', args: {} }]);
  await until(() => responses(s).length === 2);
  assert.deepEqual(responses(s)[1].response, { output: 'Notes: Groceries\n- milk' });
  call.hangUp();
});

await cp('CP-8 Live news desk: a finished agent\'s answer goes into the open call as a note', async () => {
  const { call, open } = liveCall();
  const s = await open();
  assert.equal(call.news('Agent "research" finished: the answer is 42.'), true);
  assert.deepEqual(notes(s), ['Agent "research" finished: the answer is 42.']);
  // While she's talking it waits, and goes in when she's back to listening.
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } });
  call.news('Agent "mail" finished.');
  assert.equal(notes(s).length, 1, 'held while she speaks');
  s.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(notes(s).at(-1), 'Agent "mail" finished.');
  call.hangUp();
});

await cp('CP-9 Live draw: the overlay is held until her voice after the answer, then drawn voiced', async () => {
  const inks = [];
  const draw = tool('draw', async () => 'Drew a flow diagram with 2 steps.');
  const { call, uis, open } = liveCall({ tools: [draw], holdMs: 2000, inkStarted: (id, seg) => inks.push([id, seg]) });
  const s = await open();
  assert.equal(call.say(), 'later', 'her lines are said after the tool answers');
  const seg = { kind: 'agent', e: { type: 'draw', id: 'dr1', seg: 0, beats: [{ text: 'Plan', voiced: true }, { text: 'Build', voiced: true }] } };
  assert.equal(call.holdDraw(seg), true);
  await until(() => inks.length === 1);
  assert.deepEqual(inks, [['dr1', 0]], 'draw is told its ink started, so it can answer');
  callTools(s, [{ id: 'dr1', name: 'draw', args: {} }]);
  await until(() => responses(s).length === 1);
  const drawn = () => uis.filter((m) => m.e?.type === 'draw' && m.e.id === 'dr1');
  assert.equal(drawn().length, 0, 'answered, but not drawn before her voice');
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } });
  assert.equal(drawn().length, 1, 'her voice releases it');
  assert.deepEqual(drawn()[0], seg, 'drawn as sent, voiced beats kept');
  call.hangUp();
});

await cp('CP-10 Live mode switch, crop and mic: voiceMode flips, a look opens the call and lands once listening, mic PCM reaches the session', async () => {
  const config = {};
  assert.equal(voiceModeOf(config), 'classic');
  assert.equal(setVoiceMode(config, 'live'), true);
  assert.equal(voiceModeOf(config), 'live');
  assert.equal(setVoiceMode(config, 'classic'), true);
  assert.equal(voiceModeOf(config), 'classic');
  setVoiceMode(config, 'live');
  // A crop with no call open opens one, and the crop goes in once it's up (not lost while connecting).
  const { t, call, sends } = liveCall();
  await call.look('CROPDATA', 'image/jpeg');
  await until(() => t.calls.length === 1 && sends.some((m) => m.on === true));
  const s = t.calls[0];
  await until(() => s.sent.some((m) => m.realtime?.video));
  assert.deepEqual(s.sent.filter((m) => m.realtime?.video).map((m) => m.realtime.video), [{ data: 'CROPDATA', mimeType: 'image/jpeg' }]);
  // A second look on the open call goes straight in.
  await call.look('CROP2', 'image/png');
  assert.equal(s.sent.filter((m) => m.realtime?.video).length, 2);
  // Mic frames (base64 16 kHz PCM from the helper) go into the session as audio.
  const frame = Buffer.alloc(320).toString('base64');
  call.pcm(frame);
  assert.deepEqual(s.sent.filter((m) => m.realtime?.audio).map((m) => m.realtime.audio), [{ data: frame, mimeType: 'audio/pcm;rate=16000' }]);
  call.hangUp();
  call.pcm(frame); // after hang-up: dropped, no throw
  assert.equal(s.sent.filter((m) => m.realtime?.audio).length, 1);
  assert.equal(setVoiceMode(config, 'classic'), true, 'and back to Classic');
});

// ---------- live.mjs ----------

{ // geminiConnect loads the SDK lazily, makes a client on the user's key with the v1alpha API (v1 has no Live
  // endpoint), and opens the call with the params it was given.
  const made = [];
  class GoogleGenAI {
    constructor(opts) { made.push(opts); this.live = { connect: async (p) => ({ opened: p }) }; }
  }
  let loads = 0;
  const connect = geminiConnect('KEY-1', async () => { loads++; return { GoogleGenAI }; });
  assert.equal(loads, 0, 'the SDK is not loaded until a call is made');
  const s = await connect({ model: 'm' });
  assert.equal(loads, 1);
  assert.deepEqual(made, [{ apiKey: 'KEY-1', httpOptions: { apiVersion: 'v1alpha' } }]);
  assert.deepEqual(s, { opened: { model: 'm' } });
}

{ // reasonFor sorts Google's close reasons: bad key and quota are told apart, anything else is not named.
  for (const s of ['API key not valid. Please pass a valid API key.', 'PERMISSION_DENIED', 'Unauthorized', 'got response: 401', 'response: 403 Forbidden'])
    assert.equal(reasonFor(s), 'key', s);
  for (const s of ['You exceeded your current quota', 'RESOURCE_EXHAUSTED', 'rate limit hit', 'Rate-limit'])
    assert.equal(reasonFor(s), 'quota', s);
  for (const s of ['socket hang up', '', undefined, null, 'response: 500']) assert.equal(reasonFor(s), null, String(s));
  assert.equal(val(() => 3), 3);
  assert.equal(val(4), 4);
}

{ // A tool call with no args or no list still reaches the caller in shape (args {} and [] ids), and Live shows thinking.
  const t = fakeTransport();
  const out = [];
  const live = createLive({ emit: (e) => out.push(e), key: 'k', connect: t.connect });
  await live.start();
  await live.start(); // a second start on an open call opens nothing new
  assert.equal(t.calls.length, 1);
  t.calls[0].server({ toolCall: { functionCalls: [{ id: 'a', name: 'take_screenshot' }] } });
  t.calls[0].server({ toolCall: {} });
  t.calls[0].server({ toolCallCancellation: {} });
  assert.deepEqual(out.filter((e) => e.type === 'toolCall').map((e) => e.calls), [[{ id: 'a', name: 'take_screenshot', args: {} }], []]);
  assert.deepEqual(out.find((e) => e.type === 'toolCancel').ids, []);
  assert.equal(live.state, 'thinking');
  live.stop();
  live.stop(); // stopping twice is harmless
  assert.equal(out.filter((e) => e.type === 'state' && e.state === 'closed').length, 1);
}

// ---------- livebrain.mjs ----------

{ // A tool name Gemini makes up gets an error answer naming the real tools; the call carries on.
  const { t, out, brain } = brainSetup({ tools: [tool('read_file', async () => 'hi', z.object({ path: z.string() }))] });
  await brain.start();
  const s = t.calls[0];
  callTools(s, [{ id: 'u1', name: 'hack_the_planet', args: {} }]);
  await until(() => responses(s).length === 1);
  const [r] = responses(s);
  assert.equal(r.id, 'u1');
  assert.ok(r.response.error, 'an error answer');
  assert.match(r.response.error, /hack_the_planet/);
  assert.match(r.response.error, /read_file/, 'names a tool that exists');
  assert.equal(out.find((e) => e.type === 'toolEnd').ok, false);
  brain.stop();
}

{ // A tool that throws answers with its message as the error; the next call still runs and answers.
  let n = 0;
  const flaky = tool('act_in_app', async () => { if (n++ === 0) throw new Error('App not found: Notez'); return 'clicked'; },
    z.object({ app: z.string() }));
  const { t, out, brain } = brainSetup({ tools: [flaky] });
  await brain.start();
  const s = t.calls[0];
  callTools(s, [{ id: 'c1', name: 'act_in_app', args: { app: 'Notez' } }]);
  await until(() => responses(s).length === 1);
  callTools(s, [{ id: 'c2', name: 'act_in_app', args: { app: 'Notes' } }]);
  await until(() => responses(s).length === 2);
  assert.deepEqual(responses(s), [
    { id: 'c1', name: 'act_in_app', response: { error: 'App not found: Notez' } },
    { id: 'c2', name: 'act_in_app', response: { output: 'clicked' } },
  ]);
  assert.deepEqual(out.filter((e) => e.type === 'toolEnd').map((e) => e.ok), [false, true]);
  brain.stop();
}

{ // Gemini sends null for an optional field it left out: the call still parses (nulls dropped) and runs.
  let got = null;
  const search = tool('web_search', async (a) => { got = a; return 'results'; }, z.object({ query: z.string(), count: z.number().optional(), opts: z.object({ site: z.string().optional() }).optional() }));
  const { t, brain } = brainSetup({ tools: [search] });
  await brain.start();
  const s = t.calls[0];
  callTools(s, [{ id: 'n1', name: 'web_search', args: { query: 'jarvis', count: null, opts: { site: null } } }]);
  await until(() => responses(s).length === 1);
  assert.deepEqual(responses(s)[0].response, { output: 'results' });
  assert.deepEqual(got, { query: 'jarvis', opts: {} });
  // Args that are wrong even without nulls are refused with the schema's error, and the tool never runs.
  got = null;
  callTools(s, [{ id: 'n2', name: 'web_search', args: { query: 42 } }]);
  await until(() => responses(s).length === 2);
  assert.ok(responses(s)[1].response.error);
  assert.equal(got, null);
  brain.stop();
}

{ // Several calls in one message each run and answer under their own ids; a plain string result is the answer.
  const a = tool('list_files', async () => 'notes.md\nideas.md');
  const b = tool('read_window', async () => ({ content: [{ type: 'text', text: 'Safari: Inbox' }, { type: 'text', text: '3 tabs' }] }));
  const { t, brain } = brainSetup({ tools: [a, b] });
  await brain.start();
  const s = t.calls[0];
  callTools(s, [{ id: 'p1', name: 'list_files', args: {} }, { id: 'p2', name: 'read_window', args: {} }]);
  await until(() => responses(s).length === 2);
  const byId = Object.fromEntries(responses(s).map((r) => [r.id, r.response]));
  assert.deepEqual(byId, { p1: { output: 'notes.md\nideas.md' }, p2: { output: 'Safari: Inbox\n3 tabs' } });
  brain.stop();
}

{ // Hanging up mid-tool aborts it, nothing answers into a dead call, and held agent news is dropped.
  let seen = null;
  const slow = tool('web_fetch', (args, { signal }) => new Promise((_, rej) => { seen = signal; signal.addEventListener('abort', () => rej(new Error('aborted'))); }));
  const { t, brain } = brainSetup({ tools: [slow] });
  await brain.start();
  const s = t.calls[0];
  callTools(s, [{ id: 'f1', name: 'web_fetch', args: {} }]);
  await until(() => seen);
  assert.equal(brain.quiet(), false, 'a running tool is not quiet');
  brain.news('Agent "mail" finished.');
  brain.stop();
  assert.equal(seen.aborted, true);
  await tick();
  assert.deepEqual(responses(s), []);
  assert.deepEqual(notes(s), [], 'held news never goes into a hung-up call');
  // Nor into the next call: news from the old call was dropped with it.
  await brain.start();
  await until(() => t.calls.length === 2 && brain.state === 'listening');
  await tick();
  assert.deepEqual(notes(t.calls[1]), [], 'old news does not leak into the next call');
  brain.stop();
}

{ // tools may be a function: a tool added after the call opened (an MCP server connecting) can be called.
  const list = [];
  const { t, brain } = brainSetup({ tools: () => list });
  await brain.start();
  list.push(tool('draw', async () => 'Drew a flow diagram.'));
  const s = t.calls[0];
  callTools(s, [{ id: 'd1', name: 'draw', args: {} }]);
  await until(() => responses(s).length === 1);
  assert.deepEqual(responses(s)[0].response, { output: 'Drew a flow diagram.' });
  brain.stop();
}

{ // langLine: 'auto' and nothing add no line; a locale is named in English; a bad code falls back to the code.
  assert.equal(langLine('auto'), '');
  assert.equal(langLine(''), '');
  assert.equal(langLine(undefined), '');
  assert.match(langLine('zh-CN'), /Chinese/);
  assert.match(langLine('not a locale!!'), /not a locale!!/);
}

// ---------- livecall.mjs ----------

const callSetup = ({ makeBrain, answer = null, tools = [], holdMs } = {}) => {
  const t = fakeTransport();
  const uis = [], sends = [], asks = [], switched = [], logs = [];
  const call = createLiveCall({
    makeBrain: makeBrain ?? (async (emit) => createLiveBrain({ emit, connect: t.connect, key: 'k', tools, system: () => 'You are Jarvis.' })),
    ui: (m) => uis.push(m),
    send: (m) => sends.push(m),
    ask: async (opts) => { asks.push(opts); return answer; },
    toClassic: () => switched.push('classic'),
    log: (...a) => logs.push(a),
    ...(holdMs ? { holdMs } : {}),
  });
  return { t, call, uis, sends, asks, switched, logs };
};

{ // The brain can't be made at all (the key lookup throws): the card offers Classic and the overlay shows closed.
  const { call, uis, asks, switched } = callSetup({ answer: true, makeBrain: async () => { throw new Error('ENOTFOUND generativelanguage.googleapis.com'); } });
  await call.toggle();
  await until(() => asks.length === 1);
  assert.equal(asks[0].placeholder, liveErrorText('network'));
  assert.deepEqual(asks[0].choices, [SWITCH_TO_CLASSIC, 'Not now']);
  assert.deepEqual(switched, ['classic'], 'yes switches to Classic');
  assert.equal(call.open, false);
  assert.deepEqual(uis.at(-1), { kind: 'live', state: 'closed' });
}

{ // An unknown failure reason gets the general "dropped" words, never undefined.
  assert.equal(liveErrorText('weird'), liveErrorText('dropped'));
  assert.equal(liveErrorText(undefined), liveErrorText('dropped'));
  assert.ok(liveErrorText('dropped').includes('Classic'));
}

{ // A dropped call (no resumption handle) hangs up, logs the error and offers Classic; "Not now" keeps Live.
  const { t, call, asks, switched, logs, sends } = callSetup({ answer: false });
  await call.toggle();
  await until(() => t.calls.length === 1 && call.open);
  await until(() => sends.some((m) => m.on === true));
  t.calls[0].drop({ code: 1006, reason: '' });
  await until(() => asks.length === 1);
  assert.equal(asks[0].placeholder, liveErrorText('dropped'));
  assert.deepEqual(switched, []);
  assert.equal(call.open, false);
  assert.deepEqual(sends.at(-1), { type: 'live_capture', on: false }, 'the mic is stopped');
  assert.ok(logs.some(([k, v]) => k === 'live_error' && v.reason === 'dropped'));
  assert.ok(logs.some(([k, v]) => k === 'live_end' && v.why === 'dropped'));
}

{ // Busy while a tool runs (agent news waits), quiet once it answers; say() is 'later' only with a call open.
  let release;
  const gate = tool('take_screenshot', () => new Promise((r) => { release = () => r('Screenshot taken.'); }));
  const { t, call } = callSetup({ tools: [gate] });
  assert.equal(call.say(), false);
  assert.equal(call.busy(), false);
  assert.equal(call.news('x'), false, 'no call: news is left for Classic');
  await call.toggle();
  await until(() => call.open && t.calls.length === 1);
  await tick();
  assert.equal(call.say(), 'later');
  const s = t.calls[0];
  callTools(s, [{ id: 's1', name: 'take_screenshot', args: {} }]);
  await until(() => release);
  assert.equal(call.busy(), true);
  assert.equal(call.news('Agent "research" finished: 3 links.'), true);
  assert.deepEqual(notes(s), [], 'held while the tool runs');
  release();
  await until(() => responses(s).length === 1);
  s.server({ serverContent: { turnComplete: true } }); // back to listening
  await until(() => notes(s).length === 1);
  assert.deepEqual(notes(s), ['Agent "research" finished: 3 links.']);
  assert.equal(call.busy(), false);
  call.hangUp();
}

{ // Cutting in locally: loud mic frames held for CUT_IN.holdMs while her voice plays stop it; quiet frames don't.
  const { t, call, uis } = callSetup();
  await call.toggle();
  await until(() => call.open && t.calls.length === 1);
  const s = t.calls[0];
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } });
  const frame = (amp, ms = 50) => { const b = Buffer.alloc(16 * ms * 2); for (let i = 0; i < 16 * ms; i++) b.writeInt16LE(amp, i * 2); return b.toString('base64'); };
  const stops = () => uis.filter((m) => m.kind === 'speech' && m.stop).length;
  const before = stops();
  for (let i = 0; i < 10; i++) call.pcm(frame(10)); // near silence
  assert.equal(stops(), before, 'quiet room: she keeps talking');
  const loud = Math.round(CUT_IN.rms * 32768 * 2);
  for (let ms = 0; ms < CUT_IN.holdMs + 50; ms += 50) call.pcm(frame(loud));
  assert.equal(stops(), before + 1, 'he talked over her: stopped once');
  // Her late audio for the reply he cut in on is dropped.
  const chunks = () => uis.filter((m) => m.kind === 'speech' && m.pcm).length;
  const n = chunks();
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BBBB' } }] } } });
  assert.equal(chunks(), n);
  call.hangUp();
}

{ // A drawing held for her voice is dropped when its tool fails, and drawn unvoiced when no voice comes in time.
  const { t, call, uis } = callSetup({ holdMs: 30, tools: [tool('draw', async () => 'ok'), tool('bad_draw', async () => { throw new Error('nope'); })] });
  assert.equal(call.holdDraw({ kind: 'agent', e: { type: 'draw', id: 'x', seg: 0, beats: [] } }), false, 'no call: not held');
  await call.toggle();
  await until(() => call.open && t.calls.length === 1);
  const s = t.calls[0];
  const seg = (id) => ({ kind: 'agent', e: { type: 'draw', id, seg: 0, beats: [{ text: 'step', voiced: true }] } });
  assert.equal(call.holdDraw({ kind: 'speech' }), false, 'only draw segments are held');
  assert.equal(call.holdDraw(seg('bad')), true);
  callTools(s, [{ id: 'bad', name: 'bad_draw', args: {} }]);
  await until(() => responses(s).length === 1);
  await tick(60);
  assert.equal(uis.filter((m) => m.e?.type === 'draw' && m.e.id === 'bad').length, 0, 'a failed drawing never draws');
  assert.equal(call.holdDraw(seg('good')), true);
  callTools(s, [{ id: 'good', name: 'draw', args: {} }]);
  await until(() => responses(s).length === 2);
  await until(() => uis.some((m) => m.e?.type === 'draw' && m.e.id === 'good'));
  const drawn = uis.find((m) => m.e?.type === 'draw' && m.e.id === 'good');
  assert.equal(drawn.e.beats[0].voiced, false, 'no voice came: drawn without waiting for it');
  call.hangUp();
}

// ---------- voicemode.mjs ----------

{ // Only 'live' is Live; anything else (missing, hand-edited, wrong case) is Classic.
  assert.equal(voiceModeOf({ voiceMode: 'live' }), 'live');
  for (const c of [undefined, null, {}, { voiceMode: 'LIVE' }, { voiceMode: 'speech' }]) assert.equal(voiceModeOf(c), DEFAULT_VOICE_MODE);
  const config = { voiceMode: 'live' };
  assert.equal(setVoiceMode(config, 'bogus'), false);
  assert.equal(config.voiceMode, 'live', 'a bad value changes nothing');
  assert.equal(setVoiceMode(config, 'classic'), true);
  assert.equal(voiceModeOf(config), 'classic');
  const voices = [{ id: 'Puck' }, { id: 'Charon' }];
  assert.equal(liveVoiceOf({}, 'Puck'), 'Puck', 'falls back to the look voice');
  assert.equal(setLiveVoice(config, 'Nobody', voices), false);
  assert.equal(liveVoiceOf(config, 'Puck'), 'Puck');
  assert.equal(setLiveVoice(config, 'Charon', voices), true);
  assert.equal(liveVoiceOf(config, 'Puck'), 'Charon');
}

console.log('regress-live: ok');
