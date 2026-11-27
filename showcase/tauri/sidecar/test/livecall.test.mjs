// A Live call as Jarvis runs it (livecall.mjs): the talk chord's tap opens and hangs up the call, the mic goes in,
// her voice goes to the overlay's player, captions become bubbles, and a failure shows one card offering Classic.
// The brain is the real livebrain.mjs; a fake Live transport plays Gemini's side. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLiveBrain } from '../livebrain.mjs';
import { cancelHighlightOpen, createLiveCall, liveErrorText, lookAtArea, openForHighlight } from '../livecall.mjs';
import { holdAfterLaunch } from '../agents.mjs';

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

const setup = ({ tools = [], key = 'k', answer = null, newTurn, now } = {}) => {
  const t = fakeTransport();
  const uis = [], sends = [], asks = [], switched = [];
  const call = createLiveCall({
    makeBrain: async (emit) => createLiveBrain({ emit, connect: t.connect, key, tools, system: () => 'You are Jarvis.' }),
    ui: (m) => uis.push(m),
    send: (m) => sends.push(m),
    ask: async (opts) => { asks.push(opts); return answer; },
    toClassic: () => switched.push('classic'),
    anim: (name) => ({ tool: 'read', label: name }),
    hangUpHint: 'tap ⌃⌥ to hang up',
    newTurn, now,
  });
  return { t, call, uis, sends, asks, switched, agentEvents: () => uis.filter((m) => m.kind === 'agent').map((m) => m.e) };
};

{ // A tap opens the call and starts the mic; mic frames go in; another tap hangs up and stops the mic.
  const { t, call, uis, sends } = setup();
  assert.equal(call.open, false);
  await call.toggle();
  await until(() => t.calls.length === 1);
  assert.equal(call.open, true);
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture'), [{ type: 'live_capture', on: true }]);
  assert.ok(uis.some((m) => m.kind === 'live' && m.state === 'listening' && /Live/.test(m.hint) && /hang up/.test(m.hint)));
  call.pcm('AQACAA==');
  assert.deepEqual(t.calls[0].sent.at(-1), { realtime: { audio: { data: 'AQACAA==', mimeType: 'audio/pcm;rate=16000' } } });
  await call.toggle();
  assert.equal(call.open, false);
  assert.equal(t.calls[0].closed, true);
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture').at(-1), { type: 'live_capture', on: false });
  assert.ok(uis.some((m) => m.kind === 'speech' && m.stop));
  assert.equal(uis.filter((m) => m.kind === 'live').at(-1).state, 'closed');
  call.pcm('AQACAA=='); // hung up: nothing goes anywhere
  assert.equal(t.calls[0].sent.length, 1);
}

{ // Her voice goes to the player, cutting in stops it at once, and the captions become bubbles.
  const { t, call, uis, agentEvents } = setup();
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  s.server({ serverContent: { inputTranscription: { text: 'What time' } } });
  s.server({ serverContent: { inputTranscription: { text: ' is it?' } } });
  assert.deepEqual(uis.filter((m) => m.kind === 'live' && m.heard).map((m) => m.heard), ['What time', 'What time is it?']);
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] }, outputTranscription: { text: "It's" } } });
  s.server({ serverContent: { outputTranscription: { text: ' noon.' } } });
  const speech = uis.filter((m) => m.kind === 'speech');
  assert.deepEqual(speech[0], { kind: 'speech', id: speech[0].id, rate: 24000, pcm: 'AAAA' });
  assert.ok(uis.findIndex((m) => m.turn) < uis.findIndex((m) => m.kind === 'agent'), 'the listening bubble makes way first');
  s.server({ serverContent: { turnComplete: true } });
  const ev = agentEvents();
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'text', 'done']);
  assert.deepEqual(ev.filter((e) => e.type === 'text').map((e) => e.text), ["It's", ' noon.']);
  assert.equal(ev.at(-1).speech, speech[0].id);
  assert.ok(uis.some((m) => m.kind === 'speech' && m.end && m.id === speech[0].id));
  // Cutting in: playback stops now, and her half-said reply ends.
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BBBB' } }] }, outputTranscription: { text: 'Also' } } });
  const before = uis.length;
  s.server({ serverContent: { interrupted: true } });
  const after = uis.slice(before);
  assert.deepEqual(after[0], { kind: 'speech', stop: true });
  assert.ok(after.some((m) => m.kind === 'agent' && m.e.type === 'done'));
  assert.equal(call.open, true, 'cutting in keeps the call open');
}

{ // A tool Gemini calls shows its tag, as in Classic.
  const tools = [{ name: 'list_commitments', description: 'List.', parameters: (await import('zod')).z.object({}), execute: async () => 'none' }];
  const { t, call, agentEvents } = setup({ tools });
  await call.toggle();
  await until(() => t.calls.length === 1);
  t.calls[0].server({ toolCall: { functionCalls: [{ id: 'c1', name: 'list_commitments', args: {} }] } });
  await until(() => agentEvents().some((e) => e.type === 'tool_end'));
  const ev = agentEvents();
  assert.deepEqual(ev.find((e) => e.type === 'tool'), { type: 'tool', id: 'c1', anim: { tool: 'read', label: 'list_commitments' } });
  assert.deepEqual(ev.find((e) => e.type === 'tool_end'), { type: 'tool_end', id: 'c1', isError: false });
}

{ // A Live tool call is logged as Classic logs one: 'tool' with { turn, id, name, args }, typed text as its length.
  const { z } = await import('zod');
  const tools = [{ name: 'write_file', description: 'Write.', parameters: z.object({ path: z.string(), content: z.string() }), execute: async () => 'Wrote it.' }];
  const t = fakeTransport();
  const logs = [];
  let requestNo = 0;
  const call = createLiveCall({
    makeBrain: async (emit) => createLiveBrain({ emit, connect: t.connect, key: 'k', tools, system: () => '' }),
    ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {},
    newTurn: () => ++requestNo, log: (kind, data) => logs.push([kind, data]),
  });
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  s.server({ serverContent: { inputTranscription: { text: 'Save a note.' } } });
  s.server({ toolCall: { functionCalls: [{ id: 'w1', name: 'write_file', args: { path: 'a.md', content: 'secret words' } }] } });
  await until(() => s.sent.some((m) => m.tool));
  assert.deepEqual(logs.find(([k]) => k === 'tool'), ['tool', { turn: 1, id: 'w1', name: 'write_file', args: { path: 'a.md', content: '[12 chars]' } }]);
  assert.ok(!JSON.stringify(logs).includes('secret words'), 'no file contents in the log');
  call.hangUp('tap');
}
{ // Classic and Live log tool calls through the same helper.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(src, /logLine\('tool', toolLog\(\{ turn, id: e\.toolCallId, name: e\.name, args: e\.args \}\)\)/);
  assert.match(fs.readFileSync(new URL('../livecall.mjs', import.meta.url), 'utf8'), /log\('tool', toolLog\(/);
}

{ // Each of their turns in the call is a new request, as in Classic: after send_agent the rest of that turn is held,
  // and a tool in their next turn runs.
  const { z } = await import('zod');
  let requestNo = 0;
  const ran = [];
  const tools = holdAfterLaunch([
    { name: 'send_agent', description: 'Agent.', parameters: z.object({}), execute: async () => { ran.push('send_agent'); return 'launched'; } },
    { name: 'list_commitments', description: 'List.', parameters: z.object({}), execute: async () => { ran.push('list'); return 'none'; } },
  ], () => requestNo);
  const { t, call } = setup({ tools, newTurn: () => { requestNo++; } });
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  const answered = (id) => s.sent.find((m) => m.tool?.functionResponses[0].id === id)?.tool.functionResponses[0].response.output;
  s.server({ serverContent: { inputTranscription: { text: 'Send an agent.' } } });
  assert.equal(requestNo, 1);
  s.server({ toolCall: { functionCalls: [{ id: 'a1', name: 'send_agent', args: {} }] } });
  await until(() => answered('a1'));
  s.server({ toolCall: { functionCalls: [{ id: 'a2', name: 'list_commitments', args: {} }] } });
  await until(() => answered('a2'));
  assert.match(answered('a2'), /^Not done: an agent just launched/);
  s.server({ serverContent: { turnComplete: true } });
  s.server({ serverContent: { inputTranscription: { text: 'What is on my list?' } } });
  assert.equal(requestNo, 2);
  s.server({ toolCall: { functionCalls: [{ id: 'a3', name: 'list_commitments', args: {} }] } });
  await until(() => answered('a3'));
  assert.equal(answered('a3'), 'none');
  assert.deepEqual(ran, ['send_agent', 'list']);
  call.hangUp('tap');
}

{ // A bad key hangs up and shows one card: its words point to the key, and its first button switches to Classic.
  const { t, call, uis, sends, asks, switched } = setup({ answer: 'yes' });
  await call.toggle();
  await until(() => t.calls.length === 1);
  t.calls[0].drop({ code: 1008, reason: 'API key not valid' });
  await until(() => switched.length === 1);
  assert.equal(call.open, false);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].placeholder, liveErrorText('key'));
  assert.match(asks[0].placeholder, /Gemini key/);
  assert.deepEqual(asks[0].choices, ['Switch to Classic', 'Not now']);
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture').at(-1), { type: 'live_capture', on: false });
  assert.equal(uis.filter((m) => m.kind === 'live').at(-1).state, 'closed');
}

{ // The mic card names the cause: a refused permission points to the Privacy settings, any other mic trouble stays general.
  assert.match(liveErrorText('mic_permission'), /Privacy settings/);
  assert.match(liveErrorText('mic_permission'), /Classic/);
  assert.doesNotMatch(liveErrorText('mic'), /Privacy/);
}

{ // "Not now" leaves the mode alone; no key at all gives the key card too.
  const { call, asks, switched } = setup({ key: null, answer: null });
  await call.toggle();
  await until(() => asks.length === 1);
  assert.equal(asks[0].placeholder, liveErrorText('key'));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(switched, []);
  assert.equal(call.open, false);
}

{ // Hanging up from outside (a mode switch, sleep, quit): the call closes; with no call it does nothing.
  const { t, call, sends } = setup();
  assert.equal(call.hangUp('sleep'), false);
  assert.deepEqual(sends, []);
  await call.toggle();
  await until(() => t.calls.length === 1);
  assert.equal(call.hangUp('sleep'), true);
  assert.equal(t.calls[0].closed, true);
  assert.equal(call.open, false);
}

{ // Esc hangs up an open call like a tap does, logged as Esc; while it is still being made, Esc drops it unlogged.
  const t = fakeTransport();
  const logs = [];
  let release;
  const call = createLiveCall({
    makeBrain: (emit) => new Promise((r) => { release = () => r(createLiveBrain({ emit, connect: t.connect, key: 'k', tools: [], system: '' })); }),
    ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {}, log: (event, data) => logs.push([event, data]),
  });
  const opening = call.toggle();
  assert.equal(call.hangUp('esc'), true);
  release();
  await opening;
  assert.equal(call.open, false);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(logs.filter(([e]) => e === 'live_end'), [], 'a call that never opened has no end');
  const second = call.toggle();
  release();
  await second;
  await until(() => t.calls.length === 1);
  assert.equal(call.hangUp('esc'), true);
  assert.equal(t.calls[0].closed, true);
  assert.equal(logs.find(([e]) => e === 'live_end')[1].why, 'esc');
}

{ // Hung up while the call was still being set up: it never opens.
  const t = fakeTransport();
  let release;
  const sends = [];
  const call = createLiveCall({
    makeBrain: (emit) => new Promise((r) => { release = () => r(createLiveBrain({ emit, connect: t.connect, key: 'k', tools: [], system: '' })); }),
    ui: () => {}, send: (m) => sends.push(m), ask: async () => null, toClassic: () => {},
  });
  const opening = call.toggle();
  call.hangUp('switch');
  release();
  await opening;
  assert.equal(call.open, false);
  assert.equal(t.calls.length, 0);
}

{ // Agent news goes into an open call; with no call it is left for Classic.
  const { t, call } = setup();
  assert.equal(call.news('(news)'), false);
  await call.toggle();
  await until(() => t.calls.length === 1);
  assert.equal(call.news('(news)'), true);
  assert.deepEqual(t.calls[0].sent.at(-1), { realtime: { text: '(news)' } });
  assert.equal(call.busy(), false);
}

{ // A crop (look) goes into the open call, or opens one and goes in once it is listening, never lost while it connects.
  const img = Buffer.from([7, 8]);
  const frames = (s) => s.sent.filter((m) => m.realtime?.video);
  { // open call: straight in
    const { t, call } = setup();
    await call.toggle();
    await until(() => t.calls.length === 1);
    await call.look(img, 'image/png');
    assert.deepEqual(frames(t.calls[0]), [{ realtime: { video: { data: img.toString('base64'), mimeType: 'image/png' } } }]);
  }
  { // no call: opens one, then sends once
    const { t, call } = setup();
    await call.look(img, 'image/png');
    assert.equal(call.open, true);
    assert.equal(frames(t.calls[0]).length, 1);
  }
  { // still connecting: held, then sent when listening
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = fakeTransport();
    const call = createLiveCall({
      makeBrain: async (emit) => createLiveBrain({ emit, connect: async (p) => { await gate; return t.connect(p); }, key: 'k', tools: [], system: () => 'x' }),
      ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {},
    });
    const opening = call.toggle();
    await until(() => call.open);
    const crop = call.look(img, 'image/png');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.calls.length, 0);
    release();
    await Promise.all([opening, crop]);
    assert.equal(frames(t.calls[0]).length, 1);
  }
  { // hung up while it waited: nothing is sent to a later call
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = fakeTransport();
    const call = createLiveCall({
      makeBrain: async (emit) => createLiveBrain({ emit, connect: async (p) => { await gate; return t.connect(p); }, key: 'k', tools: [], system: () => 'x' }),
      ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {},
    });
    const opening = call.toggle();
    await until(() => call.open);
    call.look(img, 'image/png');
    call.hangUp('tap');
    release();
    await opening;
    await call.toggle();
    await until(() => t.calls.length >= 1);
    assert.equal(t.calls.flatMap(frames).length, 0);
    call.hangUp('tap');
  }
}

{ // A circle drawn with ⌃⌥ in Live (the helper's live_look): the circled shot goes in through look, opening a call if
  // none is open, and the temp file is removed. No file: nothing happens.
  const img = Buffer.from([4, 2]);
  const frames = (s) => s.sent.filter((m) => m.realtime?.video);
  const { t, call } = setup();
  const removed = [], fitted = [];
  const io = { prepare: async (f) => { fitted.push(f); }, read: async (f) => (f === '/tmp/sidekick-marked-1.png' ? img : null), remove: (f) => removed.push(f) };
  assert.equal(await lookAtArea(call, { file: '/tmp/sidekick-marked-1.png', rect: [0, 0, 320, 220] }, io), true);
  assert.equal(call.open, true, 'a circle with no call open opens one');
  assert.deepEqual(frames(t.calls[0]), [{ realtime: { video: { data: img.toString('base64'), mimeType: 'image/png' } } }]);
  assert.deepEqual(fitted, ['/tmp/sidekick-marked-1.png']);
  assert.deepEqual(removed, ['/tmp/sidekick-marked-1.png']);
  assert.equal(await lookAtArea(call, null, io), false);
  assert.equal(await lookAtArea(call, {}, io), false);
  assert.equal(frames(t.calls[0]).length, 1, 'no area, no look');
  call.hangUp('tap');
  // sidekick.mjs routes the helper's live_look there, only in Live.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(src, /m\.type === 'live_look'\) \{ if \(voiceModeOf\(config\) === 'live'\) lookAtArea\(liveCall, m\.area,/);
  // A Classic reply still streaming or speaking is stopped before the circle opens a call, like a plain tap does.
  assert.match(src, /m\.type === 'live_look'\)[^\n]*quiet: \(\) => \{ interruptQuietly\('live'\); speech\.stop\(\); \}/);
}

{ // A circle that opens a call first quiets whatever Classic is doing (quiet runs before the call opens); one drawn
  // in an open call leaves it alone, the same as a tap of the talk chord.
  const { call } = setup();
  const order = [];
  const io = { read: async () => { order.push(`read:${call.open}`); return Buffer.from([1]); }, quiet: () => order.push(`quiet:${call.open}`) };
  await lookAtArea(call, { file: '/tmp/sidekick-marked-2.png' }, io);
  assert.deepEqual(order, ['quiet:false', 'read:false'], 'no call open: quiet first, before the call opens');
  order.length = 0;
  await lookAtArea(call, { file: '/tmp/sidekick-marked-3.png' }, io);
  assert.deepEqual(order, ['read:true'], 'a call already open: nothing to quiet');
  call.hangUp('tap');
}

{ // sidekick.mjs: in Live the crop goes through liveCall.look and skips the Classic listen/ask; Escape returns before it.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function areaSnap()'), src.indexOf('let snapping = false'));
  assert.match(fn, /if \(res\.cancelled\) return;[^]*voiceModeOf\(config\) === 'live'[^]*liveCall\.look\(/);
  assert.match(fn, /voiceModeOf\(config\) === 'live'\) \{[^]*if \(!liveCall\.open\) \{ interruptQuietly\('live'\); speech\.stop\(\); \}[^]*liveCall\.look\(/,
    'a crop that opens a call stops a Classic reply first');
}

{ // A fresh sidecar (respawned mid-call) has no call: hangUp says so and sends nothing, so sidekick.mjs must tell the overlay.
  const { call, uis, sends } = setup();
  assert.equal(call.hangUp('esc'), false);
  assert.deepEqual(uis, []);
  assert.deepEqual(sends, []);
}

{ // sidekick.mjs wires it up: a mode switch, sleep and quit hang up; the helper hears the mode with its settings.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const menuBranch = src.slice(src.indexOf('function switchVoiceMode(mode)'), src.indexOf('function switchVoiceMode(mode)') + 400);
  assert.match(menuBranch, /liveCall\.hangUp\('switch'\)[^]*saveConfig\(\)/, 'hangs up before saving the new mode');
  assert.match(menuBranch, /voiceConfig\(\)/);
  assert.match(src, /m\.type === 'system_sleep'\) liveCall\.hangUp\('sleep'\)/);
  assert.match(src, /\.on\('close', \(\) => \{[^]{0,200}liveCall\.hangUp\('quit'\)/);
  assert.match(src, /type: 'voice_config',[^\n]*live: voiceModeOf\(config\) === 'live'/);
  assert.match(src, /m\.type === 'live_toggle'\) \{ if \(voiceModeOf\(config\) === 'live'\)/, 'a tap only calls in Live mode');
  // "Hey Jarvis" in Live (wake word on): the helper reports live_wake, which opens a call like a tap when none is
  // open (and her last words have played out: wakeOk), and is ignored during one (never a hang-up).
  assert.match(src, /m\.type === 'live_wake'\) \{ if \(voiceModeOf\(config\) === 'live' && liveCall\.wakeOk\(\)\) \{ interruptQuietly\('live'\); speech\.stop\(\); liveCall\.toggle\(\)/, 'the wake word opens a Live call, never hangs one up');
  const swift = fs.readFileSync(new URL('../../src-tauri/voice/main.swift', import.meta.url), 'utf8');
  assert.match(swift, /private func wakeAllowed[^]{0,300}!\(liveMode && liveWanted\)/, 'the helper listens for the wake word in Live while no call has the mic');
  assert.doesNotMatch(swift.slice(swift.indexOf('private func wakeAllowed'), swift.indexOf('private func startWake')), /&& !liveMode &&/, 'not only in Classic');
  assert.match(swift, /if liveMode \{ stopWake\(\); wakeCooldownUntil = now \+ Self\.wakeCooldown; emit\(\["type": "live_wake"\]\); return \}/, 'heard in Live: report live_wake instead of starting a take');
  assert.match(swift, /func setLiveCapture[^]{0,200}if phase == \.wake \{ stopWake\(\) \}/, "the call's mic takes over from wake listening");
  const voiceRs = fs.readFileSync(new URL('../../src-tauri/src/voice.rs', import.meta.url), 'utf8');
  assert.match(voiceRs, /Some\("live_wake"\) => Some\(json!\(\{ "type": "live_wake" \}\)\)/, 'Rust passes live_wake on to the sidecar');
  assert.match(src, /m\.type === 'live_hangup'\) \{ if \(!liveCall\.hangUp\(m\.via === 'esc' \? 'esc' : 'tap'\)\) ui\(\{ kind: 'live', state: 'closed' \}\); \}/,
    "the overlay's Esc hangs up through the same path, and with no call left (a respawned sidecar) it still tells the overlay the call is closed so Esc is let go");
  // Live mode starts the helper even with Classic talking off (macOS: the only helper with a Live mic).
  assert.match(src, /const liveTalk = \(\) => MAC && voiceModeOf\(config\) === 'live';/);
  assert.match(src, /type: 'voice_config', enabled: VOICE_OK && \(liveTalk\(\) \|\| \(config\.voice && voiceReady\(\)\)\),/);
  // One source for the helper's live mode: voice_config. A restarted helper is sent the whole config again.
  assert.match(src, /m\.type === 'voice_ready'\) \{[^\n]*voiceConfig\(\);/);
  assert.doesNotMatch(src, /type: 'live_mode'/);
  const rust = fs.readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(rust, /Some\("live_mode"\)/, 'Rust has no separate live_mode message');
  // The Live prompt: Classic's live state without its Voice line (hold to talk, a pause sends), and making it leaves
  // the facts the last Classic request used alone (touchFacts marks those after the reply).
  assert.match(src, /const liveSystem = \(\) => \{ const l = livePrompt\('', \{ live: true \}\);/);
  const lp = src.slice(src.indexOf('const livePrompt = '), src.indexOf('return { turn, memory };', src.indexOf('const livePrompt = ')));
  assert.match(lp, /const livePrompt = \(context = '', \{ live = false \} = \{\}\) => \{/);
  assert.match(lp, /if \(!live\) lastFactIds = facts\.map/);
  assert.match(lp, /\$\{live \? LIVE_VOICE_LINE\(\) : VOICE_OK \? `- Voice: /, 'Live has its own Voice line');
  assert.match(src, /toClassic: \(\) => switchVoiceMode\('classic'\),/, "the error card's Switch to Classic is the same switch");
  // One path starts a request in both modes: Classic per message, Live per turn of theirs in the call.
  assert.match(src, /const startRequest = \(\) => \(requestNo = nextTurn\(\)\);/);
  assert.match(src, /const turn = startRequest\(\);/, 'Classic starts its request through it');
  assert.match(src.slice(src.indexOf('const liveCall = createLiveCall(')), /^[^]{0,900}newTurn: startRequest,/, 'Live starts each turn through it');
}

{ // "Hey Jarvis" right after a hang-up doesn't open a new call while her last words may still be coming out of the
  // speakers (the wake word hears her say "Jarvis"): wakeOk() stays false until her voice so far has had time to play
  // out, plus a moment. Before any call, and once that's over, a wake opens one.
  let t0 = 1_000_000;
  const { t, call } = setup({ now: () => t0 });
  assert.equal(call.wakeOk(), true, 'no call yet: a wake opens one');
  await call.toggle();
  await until(() => t.calls.length === 1);
  assert.equal(call.wakeOk(), false, 'a call is open');
  // Two seconds of her voice (24 kHz s16le mono: 96,000 bytes) arrive at once, as Gemini sends it ahead of playback.
  const pcm = Buffer.alloc(96_000).toString('base64');
  t.calls[0].server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm } }] }, outputTranscription: { text: 'Very good, Jarvis signing off.' } } });
  t0 += 200;
  await call.toggle(); // the hang-up
  assert.equal(call.open, false);
  t0 += 1500;
  assert.equal(call.wakeOk(), false, 'her goodbye may still be playing');
  t0 += 1500; // past the end of her voice (1.8 s after the hang-up) and the moment after it
  assert.equal(call.wakeOk(), true, 'then a wake opens a call again');
}

{ // Holding the highlight keys (⌃⌘) in Live opens the call straight away, so she listens while the circle is drawn;
  // a Classic reply is quieted first. A call already open is left as it is (holding never hangs up).
  const { call, t } = setup();
  const order = [];
  assert.equal(await openForHighlight(call, { quiet: () => order.push(`quiet:${call.open}`) }), true);
  assert.equal(call.open, true, 'the hold opened a call');
  assert.deepEqual(order, ['quiet:false'], 'quieted before the call opened');
  assert.equal(await openForHighlight(call, { quiet: () => order.push('again') }), false);
  assert.equal(call.open, true, 'a second hold leaves the open call alone');
  assert.deepEqual(order, ['quiet:false'], 'nothing to quiet in an open call');
  // Letting go with a circle: the circled area goes in through the same look, into the call the hold opened.
  const img = Buffer.from([9, 9]);
  assert.equal(await lookAtArea(call, { file: '/tmp/sidekick-marked-9.png' }, { read: async () => img }), true);
  assert.equal(t.calls.length, 1, 'no second call');
  assert.deepEqual(t.calls[0].sent.filter((m) => m.realtime?.video), [{ realtime: { video: { data: img.toString('base64'), mimeType: 'image/png' } } }]);
  call.hangUp('tap');
  // sidekick.mjs: the helper's live_open (a highlight hold) opens the call only in Live, with the same quiet; the
  // talk chord is a plain tap again, and the highlight release still arrives as live_look.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(src, /m\.type === 'live_open'\) \{ if \(voiceModeOf\(config\) === 'live'\) openForHighlight\(liveCall, \{ quiet: \(\) => \{ interruptQuietly\('live'\); speech\.stop\(\); \} \}\)/);
  const rust = fs.readFileSync(new URL('../../src-tauri/src/voice.rs', import.meta.url), 'utf8');
  assert.match(rust, /Some\("live_open"\) => Some\(json!\(\{ "type": "live_open" \}\)\)/, 'the shell passes live_open straight to the sidecar');
}

{ // A highlight hold that turns out to be a shortcut (a slow ⌃⌘Q, a ⌃⌘-click; the helper's live_cancel): the call that
  // hold opened is hung up, so it never stays connected with the mic streaming. A call already open stays.
  const { call } = setup();
  assert.equal(await openForHighlight(call), true);
  assert.equal(cancelHighlightOpen(call), true, 'the call the hold opened is hung up');
  assert.equal(call.open, false);
  assert.equal(cancelHighlightOpen(call), false, 'a second cancel does nothing');
  await call.toggle(); // a call opened by a tap
  assert.equal(await openForHighlight(call), false);
  assert.equal(cancelHighlightOpen(call), false, 'a shortcut never hangs up a call the hold did not open');
  assert.equal(call.open, true);
  call.hangUp('tap');
  // Cancelled while it was still connecting: no call is left behind.
  const p = openForHighlight(call);
  assert.equal(cancelHighlightOpen(call), true);
  await p;
  assert.equal(call.open, false, 'a cancel while connecting leaves no call');
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(src, /m\.type === 'live_cancel'\) cancelHighlightOpen\(liveCall\)/);
  const rust = fs.readFileSync(new URL('../../src-tauri/src/voice.rs', import.meta.url), 'utf8');
  assert.match(rust, /Some\("live_cancel"\) => Some\(json!\(\{ "type": "live_cancel" \}\)\)/, 'the shell passes live_cancel straight to the sidecar');
}

console.log('livecall tests passed');
