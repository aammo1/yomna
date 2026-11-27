// End to end in a Live call, driven by text (Gemini's side is a fake transport that sends model turns and tool
// calls): the real call (livecall.mjs) around the real Live brain, running the real tools (guarded by the loop guard,
// as sidekick.mjs wires them), the real agents manager and the real news desk; every answer must come back to Gemini
// as a toolResponse with the matching id. Each block is one critical path (CP-<n>, see the regression plan): asking
// and answering, the second-brain folder, tool round trips, web_search/web_fetch, seeing the screen, cursor and app
// control (act_in_app clicks, scrolls, a new tab; read_window; take_screenshot), the loop guard, subagents incl. the
// operator, draw (held until her voice), and the Classic <-> Live switch.
// No network, no real screen: a fake hands helper, a stubbed fetch, a temp home. Run: npm test
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-live-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.JARVIS_DATA_DIR = path.join(tmp, 'data');
process.env.JARVIS_FAKE_AGENT = fileURLToPath(new URL('./fakeagent.mjs', import.meta.url));
process.env.FAKE_LOG = path.join(tmp, 'fake.log');
const HANDS = ['darwin', 'win32'].includes(process.platform);

// A fake hands helper (same shape as test/hands.test.mjs): logs every call; the window's title comes from title.txt
// when it exists, so a test can make the screen "change".
const callLog = path.join(tmp, 'calls.jsonl'), handsFake = path.join(tmp, 'hands.mjs'), titleFile = path.join(tmp, 'title.txt'), textsFile = path.join(tmp, 'texts.json');
// canvas.json: a page drawn in a canvas (Google Docs): its lines are only in the pixels, so accessibility (find-text,
// act's click_text) finds none of them and only ocr-find reads them; with canvas.json.noocr, not even that (v0.2.8).
const canvasFile = path.join(tmp, 'canvas.json');
fs.writeFileSync(handsFake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(a) + '\\n');
const title = fs.existsSync(${JSON.stringify(titleFile)}) ? fs.readFileSync(${JSON.stringify(titleFile)}, 'utf8') : 'Cards';
const texts = fs.existsSync(${JSON.stringify(textsFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(textsFile)}, 'utf8')) : ['Hello cards'];
const win = { id: 7, app: 'Chrome', title, bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') o = { ok: true, done: JSON.parse(a[1]).steps.map((s) => s.do), window: win, controls: [{ role: 'button', label: 'Video +' }], texts: fs.existsSync(${JSON.stringify(textsFile)}) ? texts : [] };
const canvas = fs.existsSync(${JSON.stringify(canvasFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(canvasFile)}, 'utf8')) : null;
if (a[0] === 'act' && canvas) { const p = JSON.parse(a[1]), k = p.steps.findIndex((s) => s.do === 'click_text'); if (k >= 0) o = { ok: false, error: 'Step ' + (k + 1) + ': no visible text "' + p.steps[k].text + '" in Chrome. Check the exact words with a screenshot or read_window.', done: p.steps.slice(0, k).map((s) => 'pressed ' + s.key) };
  else if (fs.existsSync(${JSON.stringify(canvasFile)} + '.gone')) o = { ok: false, error: 'No matching window is open.' }; }
if (a[0] === 'ocr-find') o = { ok: true, matches: fs.existsSync(${JSON.stringify(canvasFile)} + '.noocr') ? [] : (canvas ?? []).map((line, i) => ({ text: line, role: 'text', bounds: [100, 150 + 20 * i, 200, 18] })).filter((m) => m.text.toLowerCase().includes(a[2].toLowerCase())) };
if (a[0] === 'find-text' && canvas) o = { ok: true, matches: [] };
else if (a[0] === 'find-text') o = { ok: true, matches: [{ text: a[2], match: 'exact', role: 'button', bounds: [100, 100, 80, 24], window: win }] };
if (a[0] === 'ui') o = { ok: true, window: win, controls: [{ role: 'button', label: 'Save' }], texts, note: '' };
if (a[0] === 'front') o = { ok: true, app: win.app, title: win.title };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`);
fs.writeFileSync(callLog, '');
process.env.JARVIS_HANDS = handsFake;

// No real network: every fetch is recorded and answered with an empty page.
const fetched = [];
globalThis.fetch = async (url) => { fetched.push(String(url?.url ?? url)); return new Response('<html><body>nothing</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); };

const { createTools } = await import('../tools.mjs');
const { createLiveBrain } = await import('../livebrain.mjs');
const { createLiveCall } = await import('../livecall.mjs');
const { guardTools, LOOP_MESSAGE, STUCK_MESSAGE } = await import('../loopguard.mjs');
const { agentsRoot, createAgents, newsDesk } = await import('../agents.mjs');
const { checkOpen, checkRead, checkWrite } = await import('../safety.mjs');
const { setVoiceMode, voiceModeOf } = await import('../voicemode.mjs');

// The second brain: notes plus a read-only _raw.
const brainDir = path.join(tmp, 'Brain');
fs.mkdirSync(path.join(brainDir, '_raw'), { recursive: true });
fs.mkdirSync(path.join(brainDir, '_context'), { recursive: true });
fs.writeFileSync(path.join(brainDir, '_context', 'goals.md'), '# Goals\nShip Jarvis v0.2.6 by Friday.\n');
fs.writeFileSync(path.join(brainDir, '_raw', 'call.txt'), 'raw evidence');
fs.writeFileSync(path.join(brainDir, '_context', 'index.md'), '# Index\n- [[youtube]]: _context/youtube.md, the channel\n');
fs.writeFileSync(path.join(brainDir, '_context', 'youtube.md'), '# YouTube\nOwner: Eric Tech\nChannel: https://www.youtube.com/@EricTech\n');

const overlay = [], callUi = [], sends = [], outcomes = [], events = [], lists = [];
const noop = async () => {};
let actionsOn = true;
// null: Allow prompts are skipped (Eric's setting); otherwise every Allow prompt gets this answer.
let allowAnswer = null; const allowAsked = [];
let liveCall = null;
// Wired the way sidekick.mjs wires it: while a call is open, draw's lines are said by her and its overlay segments
// are held by the call until her voice for them starts.
const made = createTools({
  allowActions: () => actionsOn, ask: async (q) => { allowAsked.push(q?.placeholder); return allowAnswer ?? true; }, openUrl: noop, onCommitments: noop, showList: async () => { lists.push('shown'); }, fmtWhen: String, commitmentsText: () => '', userName: 'Eric',
  speak: (line) => (liveCall?.open ? liveCall.say(line) : false),
  ui: (m) => {
    if (liveCall?.holdDraw(m)) return;
    overlay.push(m);
    if (m.e?.type === 'draw') setImmediate(() => made.ink.started(m.e.id, m.e.seg)); // the overlay starts a segment at once
  },
  fileDir: () => brainDir, readOnly: () => [path.join(brainDir, '_raw')], skipAllow: () => allowAnswer == null,
});
let onEnd = null;
const mgr = createAgents({
  fork, root: agentsRoot(), userName: 'Eric', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
  config: { model: async () => ({ provider: 'anthropic', model: 'fake', route: 'api' }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {} },
  ui: (m) => {
    if (m.kind === 'hands') return;
    const { e } = m;
    events.push(e);
    if (e.type === 'ask') setTimeout(() => mgr.answer(e.agent.id, true), 20);
    if (e.type === 'done' || e.type === 'fail' || e.type === 'gone') onEnd?.(e);
  },
});
const tools = [...guardTools(made.tools, { log: (k, o) => outcomes.push(o) }), ...mgr.tools];

// Gemini's side of the socket (copied from test/livecall.test.mjs).
const sessions = [];
const connect = async (params) => {
  const sent = [];
  const s = { params, sent, closed: false, sendRealtimeInput: (m) => sent.push({ realtime: m }), sendClientContent: (m) => sent.push({ content: m }),
    sendToolResponse: (m) => sent.push({ tool: m }), close() { s.closed = true; }, server: (msg) => params.callbacks.onmessage(msg) };
  sessions.push(s);
  return s;
};
const config = { voiceMode: 'live' };
const switched = [];
liveCall = createLiveCall({
  makeBrain: async (emit) => createLiveBrain({ emit, connect, key: 'k', tools, system: () => 'You are Jarvis.' }),
  ui: (m) => callUi.push(m), send: (m) => sends.push(m), ask: async () => null, toClassic: () => switched.push('classic'),
  inkStarted: (id, seg) => made.ink.started(id, seg),
});
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};
const s = () => sessions.at(-1);
const openCall = async () => { const before = sessions.length; await liveCall.toggle(); await until(() => sessions.length === before + 1); return s(); };
let n = 0;
// One tool call from "Gemini"; resolves with the response Jarvis sent back for it.
const call = async (name, args, ms, sess = s()) => {
  const id = `c${++n}`;
  sess.server({ toolCall: { functionCalls: [{ id, name, args }] } });
  const find = () => sess.sent.flatMap((m) => m.tool?.functionResponses ?? []).find((r) => r.id === id);
  await until(find, ms);
  const r = find();
  assert.equal(r.name, name);
  return r.response;
};
const handsCalls = () => fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const acts = () => handsCalls().filter((c) => c[0] === 'act').map((c) => JSON.parse(c[1]));
const audio = (data = 'AAAA') => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }] } } });
// A named critical path: a failure says which one broke.
const cp = async (name, fn) => {
  try { await fn(); } catch (e) { console.error(`not ok - ${name}`); throw e; }
  console.log(`ok - ${name}`);
};

await cp('CP-1 Live call opens, answers in text and voice, Esc hangs up', async () => {
  const sess = await openCall();
  assert.equal(liveCall.open, true);
  assert.ok(callUi.some((m) => m.kind === 'live' && m.state === 'listening'), 'the call reaches listening');
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture').at(-1), { type: 'live_capture', on: true }, 'the mic is on');
  const before = callUi.length;
  sess.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] }, outputTranscription: { text: 'Hi Eric,' } } });
  sess.server({ serverContent: { outputTranscription: { text: ' ready.' } } });
  sess.server({ serverContent: { turnComplete: true } });
  const after = callUi.slice(before);
  assert.ok(after.some((m) => m.kind === 'speech' && m.pcm === 'AAAA'), 'her voice reaches the player');
  const ev = after.filter((m) => m.kind === 'agent').map((m) => m.e);
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'text', 'done']);
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hi Eric, ready.');
  assert.equal(liveCall.hangUp('esc'), true);
  assert.equal(liveCall.open, false);
  assert.equal(sess.closed, true, 'Esc closes the socket');
  assert.equal(callUi.filter((m) => m.kind === 'live').at(-1).state, 'closed');
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture').at(-1), { type: 'live_capture', on: false }, 'the mic is off');
});

// The rest runs in one open call, the way Eric uses it.
await openCall();

await cp('CP-3 every core tool is declared to Live and a plain tool round-trips', async () => {
  const names = s().params.config.tools[0].functionDeclarations.map((d) => d.name);
  for (const t of ['read_file', 'list_files', 'search_files', 'write_file', 'act_in_app', 'take_screenshot', 'draw', 'open', 'web_search', 'web_fetch', 'send_agent', 'show_list'])
    assert.ok(names.includes(t), `${t} is declared to Live`);
  if (HANDS) assert.ok(names.includes('read_window'));
  const r = await call('show_list', {});
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.output, 'The list is on screen.');
  assert.equal(lists.length, 1, 'the real show_list ran and showed the list');
  const bad = await call('no_such_tool', {});
  assert.ok(bad.error, 'an unknown tool answers with an error, never silence');
});

await cp('CP-2 second brain: read, list, search and write notes; _raw and secrets stay off limits', async () => {
  assert.match((await call('read_file', { path: '_context/goals.md' })).output, /Ship Jarvis v0\.2\.6 by Friday/);
  assert.match((await call('list_files', { dir: '.' })).output, /_context/);
  assert.match((await call('search_files', { dir: '.', pattern: 'v0\\.2\\.6' })).output, /goals\.md/);
  const w = await call('write_file', { path: '_context/todo.md', content: '- test Live' });
  assert.equal(w.error, undefined, w.error);
  assert.equal(fs.readFileSync(path.join(brainDir, '_context', 'todo.md'), 'utf8'), '- test Live');
  // Shell commands start in the second brain too, so a relative path in run_command points at the same notes.
  const sh = await call('run_command', { command: process.platform === 'win32' ? 'type _context\\goals.md' : 'grep -n Friday _context/goals.md' });
  assert.equal(sh.error, undefined, sh.error);
  assert.match(sh.output, /Ship Jarvis v0\.2\.6 by Friday/, 'run_command with a relative path reads the brain');
  const raw = await call('write_file', { path: '_raw/call.txt', content: 'overwritten' });
  assert.ok(raw.error, 'writing into _raw is refused');
  assert.equal(fs.readFileSync(path.join(brainDir, '_raw', 'call.txt'), 'utf8'), 'raw evidence', '_raw is untouched');
  fs.mkdirSync(path.join(tmp, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.ssh', 'id_rsa'), 'PRIVATE');
  const key = await call('read_file', { path: '~/.ssh/id_rsa' });
  assert.ok(key.error && !/PRIVATE/.test(key.error), 'a private key is never read');
});

await cp('CP-4 web_search answers the call; web_fetch blocks this computer and the local network', async () => {
  const before = fetched.length;
  const r = await call('web_fetch', { url: 'http://127.0.0.1:8080/admin' });
  assert.match(JSON.stringify(r), /blocked/i);
  assert.equal(fetched.length, before, 'nothing was fetched from localhost');
  const meta = await call('web_fetch', { url: 'http://169.254.169.254/latest/meta-data' });
  assert.match(JSON.stringify(meta), /blocked/i);
  const q = await call('web_search', { query: 'Jarvis menu bar assistant' }, 15_000);
  assert.ok(q.output !== undefined || q.error !== undefined, 'web_search answers the Live call');
  assert.ok(fetched.every((u) => !/127\.0\.0\.1|localhost/.test(u)));
});

await cp('CP-6 open: other schemes are blocked before anything runs', async () => {
  // A real https open launches the browser (no injectable seam in tools.mjs open), so only the gate is tested here.
  assert.match((await call('open', { target: 'javascript:alert(1)' })).error, /only open web and mail links/);
  assert.ok((await call('open', { target: 'file:///etc/passwd' })).error, 'a file: link is blocked');
});

await cp('CP-9 draw in Live: the flow is held until her voice, then reaches the overlay', async () => {
  const sess = s();
  // Both reach the same overlay in sidekick.mjs: the tools' ui, and the call's ui (where held segments are released).
  const draws = () => [...overlay, ...callUi].filter((m) => m.e?.type === 'draw');
  const before = draws().length;
  const r = await call('draw', { beats: [{ say: 'Live hands off to Classic.', marks: [{ kind: 'flow', dir: 'right',
    nodes: [{ id: 'a', text: 'Live', shape: 'round' }, { id: 'b', text: 'Operator' }, { id: 'c', text: 'Done', shape: 'round' }],
    links: [{ from: 'a', to: 'b', label: 'hands off' }, { from: 'b', to: 'c' }] }] }] });
  assert.equal(r.error, undefined, r.error);
  assert.match(r.output, /p1/);
  assert.match(r.output, /Live hands off to Classic\./, 'the line to say comes back with the answer');
  assert.equal(draws().length, before, 'nothing draws before her voice');
  sess.server(audio());
  const drawn = draws().slice(before);
  assert.ok(drawn.length >= 1, 'her voice releases the drawing');
  assert.ok(JSON.stringify(drawn).includes('Operator'), 'the flow nodes reach the overlay');
  sess.server({ serverContent: { turnComplete: true } });
  const bad = await call('draw', { beats: [{ say: 'x', marks: [{ kind: 'flow', dir: 'up', nodes: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], links: [{ from: 'a', to: 'b' }] }] }] });
  assert.match(JSON.stringify(bad), /dir for a flow is down or right/, 'a bad drawing is an error back to Gemini');
});

if (HANDS) {
  await cp('CP-5 see the screen: read_window and take_screenshot work, even with Allow File Edits off', async () => {
    for (const on of [true, false]) {
      actionsOn = on;
      fs.writeFileSync(callLog, '');
      const rw = await call('read_window', { target: 'front' });
      assert.equal(rw.error, undefined, rw.error);
      assert.match(rw.output, /Chrome/);
      assert.match(rw.output, /Save/);
      const shot = await call('take_screenshot', { target: 'front' });
      assert.equal(shot.error, undefined, shot.error);
      assert.match(shot.output, /800×600 px/);
      assert.ok(handsCalls().some((c) => c[0] === 'capture'), 'the helper captured the window');
    }
    actionsOn = true;
  });

  await cp('CP-6 act_in_app: click, new tab with a URL and scroll reach the hands helper; refused when actions are off', async () => {
    fs.writeFileSync(callLog, '');
    const click = await call('act_in_app', { target: 'front', steps: [{ do: 'click_text', text: 'Video +' }] });
    assert.equal(click.error, undefined, click.error);
    assert.match(click.output, /Video \+/, 'the window after the step comes back');
    const tab = await call('act_in_app', { target: 'front', steps: [{ do: 'key', key: 'cmd+t' }, { do: 'type', text: 'https://example.com' }, { do: 'key', key: 'enter' }] });
    assert.equal(tab.error, undefined, tab.error);
    const sc = await call('act_in_app', { target: 'front', steps: [{ do: 'scroll', direction: 'down', amount: 3 }] });
    assert.equal(sc.error, undefined, sc.error);
    const a = acts();
    assert.deepEqual(a.map((x) => x.steps.map((st) => st.do)), [['click_text'], ['key', 'type', 'key'], ['scroll']]);
    assert.equal(a[0].steps[0].text, 'Video +');
    assert.equal(a[1].steps[1].text, 'https://example.com');
    assert.equal(a[2].steps[0].direction, 'down');
    // Allow File Edits & Commands off: the same call is refused and never reaches the helper.
    actionsOn = false;
    const off = await call('act_in_app', { target: 'front', steps: [{ do: 'click_text', text: 'Video +' }] });
    actionsOn = true;
    assert.match(off.error ?? '', /Allow File Edits & Commands/);
    assert.equal(acts().length, 3, 'nothing ran while actions were off');
  });

  await cp('CP-7 loop guard: 3 identical no-change scrolls run, the 4th is refused; a look or a change resets it', async () => {
    fs.writeFileSync(callLog, '');
    const scroll = { target: 'front', steps: [{ do: 'scroll', direction: 'down' }] };
    // A different call before resets whatever ran earlier.
    await call('take_screenshot', { target: 'front' });
    for (let i = 0; i < 3; i++) assert.equal((await call('act_in_app', scroll)).error, undefined, `scroll ${i + 1} runs`);
    const fourth = await call('act_in_app', { ...scroll, steps: [{ do: 'scroll', direction: 'down', amount: 5 }] });
    assert.equal(fourth.error, LOOP_MESSAGE, 'the fourth identical scroll is refused, whatever the amount');
    assert.equal(acts().length, 3, 'the refused scroll never reached the hands helper');
    assert.ok(outcomes.some((o) => o.reason === 'loop_guard'), 'the refusal is logged as a tool outcome');
    // take_screenshot (what the refusal asks for) lets the same scroll run again.
    await call('take_screenshot', { target: 'front' });
    assert.equal((await call('act_in_app', scroll)).error, undefined, 'after a look the scroll runs again');
    assert.equal((await call('act_in_app', scroll)).error, undefined);
    // The page changes under the third: the count restarts, so the next one runs too.
    fs.writeFileSync(titleFile, 'Cards (scrolled)');
    assert.equal((await call('act_in_app', scroll)).error, undefined);
    assert.equal((await call('act_in_app', scroll)).error, undefined, 'a changed result resets the count');
    fs.rmSync(titleFile);
  });

  await cp('CP-11 "fill this in from what you know about me": the doc\'s blank lines, the brain\'s facts, then act_in_app types each value', async () => {
    fs.writeFileSync(callLog, '');
    fs.writeFileSync(textsFile, JSON.stringify(['Sponsor form', 'Name:', 'Channel URL:']));
    const rw = await call('read_window', { target: 'front' });
    assert.match(rw.output, /Name:/); assert.match(rw.output, /Channel URL:/);
    // Not in memory: the brain, with the file tools, index first.
    assert.match((await call('read_file', { path: '_context/index.md' })).output, /_context\/youtube\.md/);
    const notes = (await call('read_file', { path: '_context/youtube.md' })).output;
    const name = notes.match(/Owner: (.+)/)[1], url = notes.match(/Channel: (\S+)/)[1];
    // One field per call, a check (the result's window) after each.
    for (const [label, value] of [['Name:', name], ['Channel URL:', url]]) {
      const r = await call('act_in_app', { target: 'front', steps: [{ do: 'click_text', text: label }, { do: 'key', key: 'end' }, { do: 'type', text: ` ${value}` }] });
      assert.equal(r.error, undefined, r.error);
      assert.match(r.output, /Name:/, 'the window after the step comes back to check');
    }
    const typed = acts().map((x) => x.steps.find((st) => st.do === 'type')?.text);
    assert.deepEqual(typed, [' Eric Tech', ' https://www.youtube.com/@EricTech'], 'each value typed into its line');
    assert.deepEqual(acts().map((x) => x.steps[0].text), ['Name:', 'Channel URL:']);
    fs.rmSync(textsFile);
  });

  // Eric's Google Doc (v0.2.8): "1. What is my name?" with a "-" line under it. Docs draws its page in a canvas, so
  // click_text found no such text three times and the loop guard then refused the click_at he tried next.
  await cp('CP-11b fill-in on a canvas doc: click_text falls back to the words read off the screen', async () => {
    fs.writeFileSync(callLog, '');
    fs.writeFileSync(canvasFile, JSON.stringify(['1. What is my name?', '-', '2. What is my YouTube Channel Name?', '-']));
    await call('read_window', { target: 'front' });
    const r = await call('act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: 'What is my name?' }, { do: 'key', key: 'down' }, { do: 'key', key: 'end' }, { do: 'type', text: 'Eric Tech' }] });
    assert.equal(r.error, undefined, r.error);
    assert.ok(handsCalls().some((c) => c[0] === 'ocr-find' && c[2] === 'What is my name?'), 'the window is read for the words');
    const last = acts().at(-1);
    assert.deepEqual(last.steps.map((st) => st.do), ['click_at', 'key', 'key', 'type'], 'the rest of the plan runs from a click on the words');
    assert.deepEqual([last.steps[0].x, last.steps[0].y, last.steps[0].global], [200, 159, true], 'the middle of the words, in screen points');
    assert.equal(last.steps[0].real, true, 'with the real cursor: a click without it presses an element, not that spot on the canvas');
    // Steps before it ran once, in the helper's own words.
    fs.writeFileSync(callLog, '');
    const esc = await call('act_in_app', { target: 'browser', steps: [{ do: 'key', key: 'escape' }, { do: 'click_text', text: 'What is my name?' }, { do: 'type', text: 'x' }] });
    assert.match(esc.output, /^In Chrome: pressed escape, clicked "What is my name\?" \(read off the screen\), type\./);
    assert.deepEqual(acts().map((x) => x.steps.map((st) => st.do)), [['key', 'click_text', 'type'], ['click_at', 'type']]);
    // The window closing under the rerun doesn't run the steps before it again.
    fs.writeFileSync(callLog, ''); fs.writeFileSync(canvasFile + '.gone', '');
    assert.match((await call('act_in_app', { target: 'browser', steps: [{ do: 'key', key: 'escape' }, { do: 'click_text', text: 'What is my name?' }] })).error ?? '', /No matching window/);
    assert.equal(acts().length, 2, 'the plan, then its rest; never the plan again');
    fs.rmSync(canvasFile + '.gone');
    // Words read off the screen that could delete, pay, send or sign out ask first, as the helper does for a click_text.
    fs.writeFileSync(canvasFile, JSON.stringify(['Delete draft', 'Keep editing']));
    fs.writeFileSync(callLog, ''); allowAnswer = "Don't allow";
    assert.match((await call('act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: 'draft' }] })).error ?? '', /Eric said no, so I didn't click "Delete draft"/);
    assert.equal(acts().length, 1, 'nothing clicked');
    allowAnswer = 'Allow';
    assert.equal((await call('act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: 'draft' }] })).error, undefined);
    assert.match(allowAsked.at(-1), /Click "Delete draft"/);
    allowAnswer = null;
    // A question that appears twice is not guessed at.
    fs.writeFileSync(canvasFile, JSON.stringify(['1. What is my name?', '-', '4. What is my name?']));
    assert.match((await call('act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: 'What is my name?' }] })).error ?? '', /appears 2 times/);
    fs.rmSync(canvasFile);
  });

  // Eric's doc, his three questions; the answers come from the brain.
  const DOC = ['1. What is my name?', '-', '2. What is my YouTube Channel Name?', '-', "3. What's today's date?", '-'];
  await cp('CP-11c permissions: with Allow File Edits off the brain is still read, act_in_app is refused with the Allow message; on, it types', async () => {
    fs.writeFileSync(callLog, ''); fs.writeFileSync(textsFile, JSON.stringify(DOC));
    const fill = { target: 'front', steps: [{ do: 'click_text', text: 'What is my name?' }, { do: 'key', key: 'down' }, { do: 'type', text: ' Eric Tech' }] };
    actionsOn = false;
    try {
      const idx = await call('read_file', { path: '_context/index.md' });
      const note = await call('read_file', { path: '_context/youtube.md' });
      const found = await call('search_files', { pattern: 'Owner', dir: '_context' });
      const rw = await call('read_window', { target: 'front' });
      for (const r of [idx, note, found, rw]) assert.equal(r.error, undefined, r.error);
      assert.match(idx.output, /_context\/youtube\.md/);
      assert.match(note.output, /Owner: Eric Tech/, 'the brain is read with actions off');
      assert.match(found.output, /youtube\.md:2:Owner: Eric Tech/, 'and searched');
      assert.match(rw.output, /What is my name\?/);
      const off = await call('act_in_app', fill);
      assert.match(off.error ?? '', /turn on "Allow File Edits & Commands"/, 'typing is what the switch stops, and the model is told which switch');
      assert.equal(acts().length, 0, 'nothing reached the hands helper');
    } finally { actionsOn = true; }
    const on = await call('act_in_app', fill);
    assert.equal(on.error, undefined, on.error);
    assert.deepEqual(acts().map((x) => x.steps.at(-1).text), [' Eric Tech'], 'with it on, it types');
    fs.rmSync(textsFile);
  });

  await cp('CP-11d v0.2.8 replay: click_text no_visible_text x3 then click_at on the canvas doc, guarded as sidekick.mjs wires it', async () => {
    // A second call on its own tools, guarded with goals on as sidekick.mjs does (one turn), so the stuck rule is live.
    const goalTools = () => {
      const t = createTools({ allowActions: () => true, ask: async () => true, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Eric', ui: () => {}, fileDir: () => brainDir, readOnly: () => [path.join(brainDir, '_raw')], skipAllow: () => true });
      return guardTools(t.tools, { goals: true, request: () => 1 });
    };
    const callOn = async (gt) => {
      const lc = createLiveCall({ makeBrain: async (emit) => createLiveBrain({ emit, connect, key: 'k', tools: gt, system: () => 'You are Jarvis.' }), ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {}, inkStarted: () => {} });
      const before = sessions.length;
      await lc.toggle();
      await until(() => sessions.length === before + 1);
      return { lc, sess: sessions.pop() }; // off the list, so s() stays the main call
    };
    const tries = ['What is my name?', '1. What is my name?', 'What is my name'].map((t) => ({ target: 'browser', steps: [{ do: 'click_text', text: t }, { do: 'key', key: 'down' }, { do: 'type', text: ' Eric Tech' }] }));
    const pixels = { target: 'browser', steps: [{ do: 'click_at', x: 200, y: 179 }, { do: 'key', key: 'end' }, { do: 'type', text: ' Eric Tech' }] };
    const run = async (sess, plans) => {
      const out = [];
      for (const [name, args] of plans) out.push(await call(name, args, undefined, sess));
      return out;
    };
    fs.writeFileSync(canvasFile, JSON.stringify(DOC));
    // Now: each click_text is found by reading the screen, so nothing fails, and the click_at runs too.
    fs.writeFileSync(callLog, '');
    const a = await callOn(goalTools());
    const now = await run(a.sess, [...tries.map((p) => ['act_in_app', p]), ['take_screenshot', { target: 'browser' }], ['act_in_app', pixels]]);
    assert.deepEqual(now.map((r) => r.error), [undefined, undefined, undefined, undefined, undefined], JSON.stringify(now));
    for (const r of now.slice(0, 3)) assert.match(r.output, /\(read off the screen\)/);
    assert.deepEqual(acts().filter((x) => x.steps[0].do === 'click_at').map((x) => x.steps.at(-1).text), [' Eric Tech', ' Eric Tech', ' Eric Tech', ' Eric Tech'], 'every plan typed its answer');
    a.lc.hangUp('esc');
    // Even when the screen can't be read either (no OCR, as in v0.2.8): the 3 failures stop click_text, not click_at.
    fs.writeFileSync(canvasFile + '.noocr', ''); fs.writeFileSync(callLog, '');
    const b = await callOn(goalTools());
    const blind = await run(b.sess, [...tries.map((p) => ['act_in_app', p]), ['take_screenshot', { target: 'browser' }], ['act_in_app', pixels], ['act_in_app', tries[0]]]);
    for (const r of blind.slice(0, 3)) assert.match(r.error ?? '', /no visible text/);
    assert.equal(blind[3].error, undefined, blind[3].error);
    assert.equal(blind[4].error, undefined, `the click by pixels runs after 3 failures: ${blind[4].error}`);
    assert.match(blind[4].output, /^In Chrome: click_at, key, type\./);
    assert.equal(blind[5].error, STUCK_MESSAGE, 'another click_text is what gets stopped');
    b.lc.hangUp('esc');
    fs.rmSync(canvasFile + '.noocr'); fs.rmSync(canvasFile);
  });
} else console.log('e2e live: hands paths (CP-5, CP-6 act_in_app, CP-7, CP-11) skipped (macOS and Windows only)');

// ---- Subagents from Live.
const ended = () => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no agent result in 20 s: ${JSON.stringify(events.map((e) => e.type))}`)), 20_000);
  onEnd = (e) => { clearTimeout(t); onEnd = null; resolve(e); };
});
await cp('CP-8 send_agent from Live: a researcher finishes and its answer reaches the call through the news desk', async () => {
  const done = ended();
  const r = await call('send_agent', { type: 'researcher', title: 'This week AI news', brief: 'What came out in AI this week?', returns: 'answer' });
  assert.match(r.output, /Started \S+ "This week AI news" \(researcher, returns answer\)/);
  const end = await done;
  assert.equal(end.type, 'done', end.agent?.reason);
  // The news desk, wired as in sidekick.mjs: an open call takes the news itself.
  let clock = 0;
  const desk = newsDesk({
    gates: () => ({ voice: liveCall.busy() }), news: () => mgr.news(), markTold: (ids) => mgr.markTold(ids),
    enqueue: (text, ids) => { if (liveCall.news(text)) desk.started(ids); }, say: () => assert.fail('signed in: no fallback line'),
    signedIn: () => true, now: () => clock,
  });
  // She's still in the turn that launched it (busy): the news waits for her to finish.
  desk.tick();
  clock += 2000;
  assert.equal(desk.tick(), null, 'no news while she is mid-turn');
  s().server({ serverContent: { turnComplete: true } });
  desk.tick();
  clock += 2000;
  assert.equal(desk.tick(), 'turn');
  const notes = s().sent.filter((m) => m.realtime?.text).map((m) => m.realtime.text);
  assert.ok(notes.some((t) => /This week AI news/.test(t) && /GPT-6 and Claude 6/.test(t)), `the agent's answer went into the call: ${JSON.stringify(notes)}`);
  clock += 2000;
  assert.equal(desk.tick(), null, 'told once');
  const bad = await call('send_agent', { type: 'wizard', title: 'x', brief: 'y' });
  assert.match(bad.error ?? '', /operator/, 'an unknown type is an error that lists the types, operator included');
});

if (HANDS) {
  await cp('CP-8 operator: runs act_in_app and take_screenshot through the hands helper; a second one is refused', async () => {
    fs.writeFileSync(process.env.FAKE_LOG, '');
    const done = ended();
    const r = await call('send_agent', { type: 'operator', title: 'Fill the cards', brief: 'In Chrome, fill in the Cards editor.' });
    assert.match(r.output, /\(operator, returns answer\)/);
    const two = await call('send_agent', { type: 'operator', title: 'Another', brief: 'Something else on screen.' });
    assert.match(two.error ?? '', /already working on the screen/, 'two operators would fight over the mouse');
    const end = await done;
    assert.equal(end.type, 'done', end.agent?.reason);
    const log = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(log[0].tools.includes('act_in_app') && log[0].tools.includes('take_screenshot'), 'the operator gets the screen tools');
    const scrolls = log.filter((l) => l.name === 'act_in_app');
    assert.deepEqual(scrolls.map((l) => l.isError), [false, false, false, true, false, false], 'the operator is loop-guarded too, then both sends run');
    assert.equal(log.find((l) => l.name === 'take_screenshot')?.isError, false, 'its screenshot came back');
    const rep = await call('agent_report', { id: end.agent.id });
    assert.match(rep.output, /operator/);
  });
}

await cp('CP-10 Live gets the look and the mic; switching to Classic hangs up and back to Live opens a new call', async () => {
  const sess = s();
  await liveCall.look('aW1n', 'image/png');
  assert.deepEqual(sess.sent.filter((m) => m.realtime?.video).at(-1), { realtime: { video: { data: 'aW1n', mimeType: 'image/png' } } }, 'the crop reaches the open call');
  liveCall.pcm('AQACAA==');
  assert.deepEqual(sess.sent.at(-1), { realtime: { audio: { data: 'AQACAA==', mimeType: 'audio/pcm;rate=16000' } } }, 'mic PCM goes into the call');
  // Settings flips the mode (sidekick.mjs: a changed voiceMode hangs up the call).
  const was = voiceModeOf(config);
  assert.equal(was, 'live');
  assert.equal(setVoiceMode(config, 'classic'), true);
  if (voiceModeOf(config) !== was) liveCall.hangUp('switch');
  assert.equal(liveCall.open, false);
  assert.equal(sess.closed, true);
  const count = sess.sent.length;
  liveCall.pcm('AQACAA==');
  assert.equal(sess.sent.length, count, 'Classic: no audio goes to Gemini');
  assert.equal(setVoiceMode(config, 'bogus'), false);
  assert.equal(voiceModeOf(config), 'classic');
  assert.equal(setVoiceMode(config, 'live'), true);
  const next = await openCall();
  assert.notEqual(next, sess, 'back in Live, a tap opens a fresh call');
  assert.match((await call('read_file', { path: '_context/goals.md' })).output, /Friday/, 'with the same tools');
  await liveCall.toggle(); // a tap hangs up
  assert.equal(liveCall.open, false);
  assert.equal(next.closed, true);
});

mgr.stopAll();
console.log('e2e live tests passed');
process.exit(0);
