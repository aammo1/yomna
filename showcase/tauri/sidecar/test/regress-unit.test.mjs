// Regression unit tests for the critical paths through tools.mjs, safety.mjs, loopguard.mjs and agents.mjs (slice A).
// Text-driven, no network, no real screen: a fake hands helper in a temp dir, a temp second-brain folder, a fake fork.
// Run: npm test (or node test/regress-unit.test.mjs)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const HANDS_OS = ['darwin', 'win32'].includes(process.platform);
// Inside HOME (npm test gives each file a temp HOME): write_file only writes under the home folder.
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), 'jarvis-regress-unit-')));
const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs');
// The fake hands helper: records every call, answers act/ui/capture/windows like the real helpers do.
fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const win = { id: 7, app: 'Chrome', title: 'Cards', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') { const p = JSON.parse(a[1]); o = { ok: true, done: p.steps.map((s) => s.do), window: win, controls: [{ id: 1, role: 'button', label: 'Video +' }] }; }
if (a[0] === 'ui') o = { ok: true, window: win, controls: [{ id: 1, role: 'button', label: 'Video +' }], texts: ['Now showing: Cards'] };
if (a[0] === 'windows') o = { ok: true, windows: [{ id: 7, app: 'Chrome', title: 'Cards', frontApp: true }] };
if (a[0] === 'front') o = { ok: true, app: win.app, title: win.title };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`);
process.env.JARVIS_HANDS = fake;
const { createTools, guardFetch, sideSearchFor } = await import('../tools.mjs');
const { guardTools, LOOP_MESSAGE } = await import('../loopguard.mjs');
const { checkFetch, checkRead, checkWrite, checkOpen, checkLink, inReadOnly, READ_ONLY_REASON, BLOCK } = await import('../safety.mjs');
const { createAgents, toolsFor, OPERATOR_TOOLS } = await import('../agents.mjs');

// A temp second brain: notes plus a read-only _raw folder.
const brain = path.join(dir, 'brain');
fs.mkdirSync(path.join(brain, 'notes'), { recursive: true });
fs.mkdirSync(path.join(brain, '_raw'), { recursive: true });
fs.writeFileSync(path.join(brain, 'notes', 'pricing.md'), '# Pricing\nCoaching is 500 per month.\n');
fs.writeFileSync(path.join(brain, '_raw', 'call.txt'), 'raw transcript\n');

let actions = true;
const uiSeen = [], lists = [];
const noop = async () => {};
const { tools: raw } = createTools({
  allowActions: () => actions, ui: (m) => uiSeen.push(m), ask: async () => false, openUrl: noop, onCommitments: noop,
  showList: (...a) => { lists.push(a); }, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
  fileDir: () => brain, readOnly: () => [path.join(brain, '_raw')],
});
const tool = (n, list = raw) => list.find((t) => t.name === n);
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ctx = { toolCallId: 't1' };
const textOf = (r) => (typeof r === 'string' ? r : (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));

// ---------- CP-2 Knowledge base: the second-brain folder through the real file tools ----------
{
  // CP-2 read_file: a note in the second brain, by a path relative to it, comes back whole.
  const r = await tool('read_file').execute({ path: 'notes/pricing.md' }, ctx);
  assert.match(r, /Coaching is 500 per month/, 'CP-2 read_file returns the note text');
  // CP-2 list_files: the folder lists notes and raw.
  const l = await tool('list_files').execute({ dir: '.' }, ctx);
  assert.deepEqual(l.split('\n').sort(), ['_raw/', 'notes/'], 'CP-2 list_files shows the second-brain folders');
  // CP-2 reading raw evidence is fine; only writing it is refused.
  assert.match(await tool('read_file').execute({ path: '_raw/call.txt' }, ctx), /raw transcript/, 'CP-2 _raw is readable');
  // CP-2 search_files: finds the note by its content (rg, else grep; Windows may have neither).
  if (process.platform !== 'win32') {
    const s = await tool('search_files').execute({ pattern: 'Coaching', dir: '.' }, ctx);
    assert.match(s, /pricing\.md.*Coaching is 500/, 'CP-2 search_files finds the note');
    assert.equal(await tool('search_files').execute({ pattern: 'zzznotthere', dir: '.' }, ctx), 'No matches.');
  }
  // CP-2 write_file: a new note with actions on is written; into _raw it is refused as read-only.
  const w = await tool('write_file').execute({ path: 'notes/new.md', content: 'hello' }, ctx);
  assert.match(w, /^Wrote 5 characters to /);
  assert.equal(fs.readFileSync(path.join(brain, 'notes', 'new.md'), 'utf8'), 'hello', 'CP-2 write_file wrote the note');
  await assert.rejects(tool('write_file').execute({ path: '_raw/evil.md', content: 'x' }, ctx), (e) => e.message.includes(READ_ONLY_REASON), 'CP-2 _raw is read-only');
  assert.ok(!fs.existsSync(path.join(brain, '_raw', 'evil.md')));
  assert.ok(inReadOnly(path.join(brain, '_raw', 'sub', 'x.md'), os.homedir(), [path.join(brain, '_raw')]), 'CP-2 inReadOnly covers nested raw paths');
  // CP-2 with actions off, writing is refused with the Allow message; reading still works.
  actions = false;
  await assert.rejects(tool('write_file').execute({ path: 'notes/off.md', content: 'x' }, ctx), /Allow File Edits & Commands/);
  assert.match(await tool('read_file').execute({ path: 'notes/pricing.md' }, ctx), /Coaching/);
  actions = true;
  // CP-2 secrets stay off limits even inside a readable tree.
  await assert.rejects(tool('read_file').execute({ path: path.join(os.homedir(), '.ssh', 'id_rsa') }, ctx), /Blocked for safety/);
}

// ---------- CP-3 Tool call round trip: a plain tool's real execute runs ----------
{
  const r = await tool('show_list').execute({}, ctx);
  assert.equal(lists.length, 1, 'CP-3 show_list reached the UI hook');
  assert.equal(typeof r, 'string', 'CP-3 show_list returns text for the model');
}

// ---------- CP-4 Web: web_fetch's safety guard, web_search's side-search route ----------
{
  // CP-4 local and private addresses never get fetched (IP literals: no DNS needed).
  for (const u of ['http://127.0.0.1:8080/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'file:///etc/passwd']) {
    const g = await guardFetch(u);
    assert.match(String(g), /^Blocked for safety: /, `CP-4 ${u} blocked`);
  }
  // CP-4 a public address passes (fake DNS answer, no network).
  const ok = await checkFetch('https://example.com/a', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.notEqual(ok.level, BLOCK, 'CP-4 a public site is fetchable');
  // CP-4 DNS rebinding: a public name that resolves to a private address is blocked.
  const rb = await checkFetch('https://evil.example/', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(rb.level, BLOCK, 'CP-4 a name resolving to loopback is blocked');
  // CP-4 web_fetch tool itself refuses localhost before any fetch.
  const realFetch = globalThis.fetch; let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('no network in tests'); };
  try {
    const wf = tool('web_fetch');
    assert.ok(wf, 'CP-4 web_fetch exists');
    const r = await wf.execute({ url: 'http://127.0.0.1:9/secret' }, ctx).then(textOf, (e) => String(e.message));
    assert.match(r, /blocked/i, 'CP-4 web_fetch to localhost is blocked (GG Coder\'s own private-address check or guardFetch)');
    assert.equal(fetched, 0, 'CP-4 nothing was fetched');
  } finally { globalThis.fetch = realFetch; }
  assert.ok(tool('web_search'), 'CP-4 web_search exists');
  // CP-4 no sign-in route: keyless engines (null); a route picks a side search.
  assert.equal(sideSearchFor(null), null);
  assert.equal(sideSearchFor({}), null);
  assert.equal(typeof sideSearchFor({ apiKey: 'k' }), 'function');
  assert.equal(typeof sideSearchFor({ cc: { executable: '/x/claude' } }), 'function');
}

// ---------- CP-5 / CP-6 / CP-7: the screen and app control through the fake hands helper ----------
if (!HANDS_OS) console.log('regress-unit: hands paths skipped (macOS and Windows only)');
else {
  // CP-5 read_window returns the window's controls and text, with actions off.
  actions = false;
  fs.writeFileSync(log, '');
  const rw = textOf(await tool('read_window').execute({ target: 'front' }, ctx));
  assert.match(rw, /Video \+/, 'CP-5 read_window lists the controls');
  assert.match(rw, /Now showing: Cards/, 'CP-5 read_window has the text');
  assert.ok(calls().some((c) => c[0] === 'ui'), 'CP-5 read_window asked the helper for the ui');
  // CP-5 take_screenshot returns an image block, with actions off.
  const shot = await tool('take_screenshot').execute({ target: 'front' }, ctx);
  assert.ok(shot.content.some((c) => c.type === 'image' && c.data), 'CP-5 take_screenshot returns an image block');
  assert.ok(calls().some((c) => c[0] === 'capture'), 'CP-5 take_screenshot asked the helper to capture');
  assert.match(await tool('list_windows').execute({}, ctx), /window:7 {2}Chrome — Cards {2}\(frontmost app\)/, 'CP-5 list_windows');

  // CP-6 with actions off, act_in_app is refused with the Allow message and the helper never acts.
  fs.writeFileSync(log, '');
  await assert.rejects(tool('act_in_app').execute({ target: 'Chrome', steps: [{ do: 'click_text', text: 'Video +' }] }, ctx), /turn on "Allow File Edits & Commands"/, 'CP-6 refused when actions are off');
  assert.ok(!calls().some((c) => c[0] === 'act'), 'CP-6 no act reached the helper');
  // CP-6 an act_in_app made only of reading steps still reads (no refusal).
  assert.match(textOf(await tool('act_in_app').execute({ target: 'front', steps: [{ do: 'read_window' }] }, ctx)), /Video \+/);

  // CP-6 with actions on, click_text and scroll reach the helper with the right arguments.
  actions = true;
  fs.writeFileSync(log, '');
  const r = await tool('act_in_app').execute({ target: 'Chrome', steps: [{ do: 'click_text', text: 'Video +' }, { do: 'scroll', direction: 'down', amount: 3 }] }, ctx);
  const act = calls().find((c) => c[0] === 'act');
  assert.ok(act, 'CP-6 act reached the helper');
  const p = JSON.parse(act[1]);
  // Chrome's window 7 was just read this turn, so the plan stays on that exact window.
  assert.ok(p.window === 7 || p.app === 'Chrome', `CP-6 the target app (got ${act[1]})`);
  assert.deepEqual(p.steps.map((s) => s.do), ['click_text', 'scroll']);
  assert.equal(p.steps[0].text, 'Video +');
  assert.equal(p.steps[1].direction, 'down');
  assert.ok(textOf(r).length > 0, 'CP-6 the result comes back');

  // CP-7 the loop guard over the real act_in_app: three identical no-change scrolls run, the fourth is refused.
  const lines = [];
  const guarded = guardTools(raw, { log: (kind, data) => lines.push({ kind, ...data }) });
  const scroll = { target: 'Chrome', steps: [{ do: 'scroll', direction: 'down', amount: 3 }] };
  const acts = () => calls().filter((c) => c[0] === 'act').length;
  fs.writeFileSync(log, '');
  for (let i = 0; i < 3; i++) await tool('act_in_app', guarded).execute(scroll, { toolCallId: `s${i}` });
  assert.equal(acts(), 3, 'CP-7 three scrolls ran');
  await assert.rejects(tool('act_in_app', guarded).execute(scroll, { toolCallId: 's3' }), (e) => e.message.includes(LOOP_MESSAGE), 'CP-7 fourth refused');
  assert.equal(acts(), 3, 'CP-7 the refused scroll never reached the helper');
  assert.equal(lines.at(-1).reason, 'loop_guard');
  // CP-7 a take_screenshot resets the count.
  await tool('take_screenshot', guarded).execute({ target: 'front' }, { toolCallId: 'shot' });
  await tool('act_in_app', guarded).execute(scroll, { toolCallId: 's4' });
  assert.equal(acts(), 4, 'CP-7 after a screenshot the scroll runs again');
}

// ---------- CP-6 open: unsafe targets refused before anything opens ----------
{
  await assert.rejects(tool('open').execute({ target: 'javascript:alert(1)' }, ctx), /Blocked for safety/, 'CP-6 open refuses a script link');
  assert.equal(checkOpen('https://skool.com', os.homedir()).level, 'safe', 'CP-6 a web link is safe to open');
}

// ---------- CP-8 Subagents: send_agent and the operator type, with a fake fork ----------
{
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-regress-agents-')));
  const children = [];
  const fork = () => { const c = new EventEmitter(); Object.assign(c, { sent: [], connected: true, send(m) { c.sent.push(m); }, kill() { c.emit('close', null, 'SIGTERM'); } }); children.push(c); return c; };
  let allow = true;
  const config = {
    model: async () => ({ provider: 'anthropic', model: 'm1', route: 'api' }), creds: async () => ({}), allowActions: () => allow, userWords: () => '',
    image: () => null, open: async () => {}, reveal: async () => {},
  };
  const openRule = (p, h, o) => checkOpen(String(p).replace(home, '/Users/ken'), '/Users/ken', o);
  const events = [];
  const mgr = createAgents({ fork, ui: (m) => events.push(m), config, root: path.join(home, 'Jarvis'), userName: 'Ken', runner: '/x/agentrun.mjs', safety: { checkRead, checkWrite, checkOpen: openRule, checkLink }, home, now: () => 1 });
  const send = mgr.tools.find((t) => t.name === 'send_agent');
  assert.ok(send, 'CP-8 send_agent is a chat tool');

  // CP-8 a crew agent starts through send_agent and gets its brief.
  const r = await send.execute({ type: 'researcher', title: 'Chairs', brief: 'Compare three dentist chairs.' });
  assert.match(r, /^Started a\w+ "Chairs" \(researcher, returns answer\)/, 'CP-8 send_agent started it');
  assert.equal(children.length, 1, 'CP-8 one worker forked');
  assert.match(children[0].sent[0].content, /Compare three dentist chairs/);

  // CP-8 it finishes and its answer is on the agent for the chat's news.
  const id = mgr.list()[0].id;
  children[0].emit('message', { t: 'finish', result: { outcome: 'Found three chairs', files: [], report: 'A, B and C.' } });
  children[0].emit('message', { t: 'end', ok: true }); children[0].emit('close', 0, null);
  // Poll instead of a fixed sleep, so a slow CI runner can't flake this.
  for (const t0 = Date.now(); mgr.get(id)?.state === 'working' && Date.now() - t0 < 5000;) await new Promise((res) => setTimeout(res, 10));
  const done = mgr.get(id);
  assert.notEqual(done.state, 'working', 'CP-8 the agent finished');
  assert.match(JSON.stringify(done), /Found three chairs/, 'CP-8 its outcome is kept for the news');

  // CP-8 operator: one starts; a second is refused while it runs; the screen tools are exactly the operator set.
  const op = await send.execute({ type: 'operator', title: 'Fill form', brief: 'Fill in the signup form in Chrome.' });
  assert.match(op, /\(operator, returns answer\)/, 'CP-8 an operator starts');
  await assert.rejects(send.execute({ type: 'operator', title: 'Other', brief: 'Click things.' }), /An operator is already working on the screen/, 'CP-8 a second operator is refused');
  assert.equal(children.length, 2, 'CP-8 the refused operator forked nothing');
  assert.deepEqual(toolsFor('operator', raw).map((t) => t.name).sort(), [...OPERATOR_TOOLS].filter((n) => raw.some((t) => t.name === n)).sort(), 'CP-8 operator tools');
  assert.ok(!toolsFor('researcher', raw).some((t) => OPERATOR_TOOLS.includes(t.name) && t.name !== 'open'), 'CP-8 a researcher gets no screen tools');

  // CP-8 with actions off, send_agent is refused with the Allow message.
  allow = false;
  await assert.rejects(send.execute({ type: 'maker', title: 'Page', brief: 'Make a page.' }), /Allow File Edits & Commands/, 'CP-8 refused when actions are off');
  allow = true;
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('regress-unit tests: passed');
