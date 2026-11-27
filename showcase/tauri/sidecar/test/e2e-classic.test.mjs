// Classic chat end to end, driven by text: a scripted "model" (a list of tool calls run in order, as the chat loop
// runs them) against the real tools. A temp folder is the second brain, a fake hands helper stands in for the
// screen and mouse, a fake `open` for the browser, a stubbed fetch for the web, and background agents run in the
// real worker (agentrun.mjs) with the scripted test/fakeagent.mjs model. Nothing touches the real screen, network
// or home folder. Run: npm test (or node test/e2e-classic.test.mjs)
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-classic-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.JARVIS_DATA_DIR = path.join(tmp, 'data');
process.env.JARVIS_FAKE_AGENT = fileURLToPath(new URL('./fakeagent.mjs', import.meta.url));
process.env.FAKE_LOG = path.join(tmp, 'fake-agent.log');
process.env.JARVIS_BG = '1';
const HANDS_OK = ['darwin', 'win32'].includes(process.platform);

// The fake hands helper (a .mjs runs on this Node): logs every call, and answers like the real one for one window.
// texts.json: the window's text lines (a doc to fill in). canvas.json: a page drawn in a canvas (Google Docs): its
// lines are only in the pixels, so accessibility (find-text, act's click_text) finds none of them and only ocr-find
// reads them; with canvas.json.noocr beside it, the pixels can't be read either (v0.2.8 had no ocr-find at all).
const handsLog = path.join(tmp, 'hands.jsonl'), handsFake = path.join(tmp, 'hands.mjs');
const textsFile = path.join(tmp, 'texts.json'), canvasFile = path.join(tmp, 'canvas.json');
fs.writeFileSync(handsFake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(handsLog)}, JSON.stringify(a) + '\\n');
const win = { id: 7, app: 'Chrome', title: 'Cards', bounds: [0, 0, 800, 600] };
const texts = fs.existsSync(${JSON.stringify(textsFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(textsFile)}, 'utf8')) : ['Info cards'];
const canvas = fs.existsSync(${JSON.stringify(canvasFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(canvasFile)}, 'utf8')) : null;
let o = { ok: true, window: win };
if (a[0] === 'act') o = { ok: true, done: JSON.parse(a[1]).steps.map((s) => (s.do === 'type' && fs.existsSync(${JSON.stringify(canvasFile)} + '.unconfirmed') ? fs.readFileSync(${JSON.stringify(canvasFile)} + '.unconfirmed', 'utf8') : s.do)), window: win, controls: [{ id: 1, role: 'button', label: 'Video +' }], texts };
if (a[0] === 'act' && canvas) { const p = JSON.parse(a[1]), k = p.steps.findIndex((s) => s.do === 'click_text'); if (k >= 0) o = { ok: false, error: 'Step ' + (k + 1) + ': no visible text "' + p.steps[k].text + '" in Chrome. Check the exact words with a screenshot or read_window.', done: p.steps.slice(0, k).map((s) => 'pressed ' + s.key) }; }
if (a[0] === 'act' && fs.existsSync(${JSON.stringify(canvasFile)} + '.actfail')) { o = { ok: false, error: fs.readFileSync(${JSON.stringify(canvasFile)} + '.actfail', 'utf8'), done: [] }; fs.rmSync(${JSON.stringify(canvasFile)} + '.actfail'); }
if (a[0] === 'ocr-find') o = { ok: true, matches: fs.existsSync(${JSON.stringify(canvasFile)} + '.noocr') ? [] : (canvas ?? []).map((line, i) => ({ text: line, role: 'text', bounds: [100, 150 + 20 * i, 200, 18] })).filter((m) => m.text.toLowerCase().includes(a[2].toLowerCase())) };
if (a[0] === 'ui') o = { ok: true, window: win, controls: [{ id: 1, role: 'button', label: 'Video +', bounds: [10, 10, 80, 24] }, { id: 2, role: 'link', label: 'Upload', bounds: [10, 50, 80, 24] }], texts };
if (a[0] === 'windows') o = { ok: true, windows: [{ id: 7, app: 'Chrome', title: 'Cards', frontApp: true }, { id: 9, app: 'Notes', title: '' }] };
if (a[0] === 'find-text') o = { ok: true, matches: canvas ? [] : [{ text: a[2], match: 'exact', role: 'button', bounds: [100, 100, 80, 24], window: win }] };
if (a[0] === 'locate') o = { ok: true, window: win };
if (a[0] === 'front') o = { ok: true, app: win.app, title: win.title };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: fs.existsSync(${JSON.stringify(canvasFile)} + '.skew') ? [800, 100] : [800, 600] }; }
console.log(JSON.stringify(o));
`);
process.env.JARVIS_HANDS = handsFake;
const handsCalls = () => (fs.existsSync(handsLog) ? fs.readFileSync(handsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A fake `open` (macOS) / `xdg-open` (Linux) first on PATH: links "open" into a log, never a real browser.
const binDir = path.join(tmp, 'bin'), openLog = path.join(tmp, 'open.log');
fs.mkdirSync(binDir);
for (const name of ['open', 'xdg-open']) {
  fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(openLog)}\n`, { mode: 0o755 });
}
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
const OPEN_OK = process.platform !== 'win32';
const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim().split('\n').filter(Boolean) : []);

const { createTools } = await import('../tools.mjs');
const { guardTools, LOOP_MESSAGE, STUCK_MESSAGE } = await import('../loopguard.mjs');

// The second brain: a folder with notes and a read-only _raw/ evidence folder.
const brain = path.join(tmp, 'Brain');
fs.mkdirSync(path.join(brain, '_raw'), { recursive: true });
fs.mkdirSync(path.join(brain, '_context'), { recursive: true });
fs.writeFileSync(path.join(brain, '_context', 'index.md'), '# Index\nJarvis ships v0.2.6 with the loop guard.\n');
fs.writeFileSync(path.join(brain, '_raw', 'call.md'), 'Raw transcript: Eric said the operator hands off from Live.\n');

const ui = [];
const noop = async () => {};
const asked = [];
const shown = [], committed = [];
const made = createTools({
  allowActions: () => true, ask: async (o) => { asked.push(o); return true; }, openUrl: noop, onCommitments: (c) => committed.push(c), showList: () => shown.push(1), fmtWhen: String, commitmentsText: () => '', userName: 'Eric',
  ui: (m) => { ui.push(m); if (m.e?.type === 'draw') setImmediate(() => made.ink.started(m.e.id, m.e.seg)); },
  workdir: tmp, fileDir: () => brain, readOnly: () => [path.join(brain, '_raw')],
});
const logged = [];
const tools = guardTools(made.tools, { log: (...a) => logged.push(a) });
const tool = (n) => tools.find((t) => t.name === n);
let callN = 0;
// The scripted model: run each call in order, like the chat loop, collecting results or the error the model would see.
async function play(calls) {
  const out = [];
  for (const [name, args] of calls) {
    const t = tool(name);
    assert.ok(t, `the chat has a ${name} tool`);
    try { out.push({ name, ok: true, result: await t.execute(args, { toolCallId: `c${++callN}`, signal: new AbortController().signal }) }); }
    catch (e) { out.push({ name, ok: false, result: e.message }); }
  }
  return out;
}
// Each critical path is a named step, tagged with its CP id from the test plan, so a failure says which path broke.
const passed = [];
async function cp(name, fn) { await fn(); passed.push(name); console.log(`  ok  ${name}`); }
const text = (r) => (typeof r === 'string' ? r : Array.isArray(r?.content) ? r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : typeof r?.content === 'string' ? r.content : JSON.stringify(r));

// 1. The second brain: list it, read a note by a path relative to the brain, search it, write a new note, and _raw/ stays read-only.
await cp('CP-2 knowledge base: list, read, search and write notes; _raw read-only; secrets off limits', async () => {
  const r = await play([
    ['list_files', { dir: '.' }],
    ['read_file', { path: '_context/index.md' }],
    ['search_files', { pattern: 'loop guard', dir: '_context' }],
    ['write_file', { path: '_context/today.md', content: 'Ran the regression tests.' }],
    ['read_file', { path: '_raw/call.md' }],
    ['write_file', { path: '_raw/call.md', content: 'edited' }],
    ['write_file', { path: '_raw/new.md', content: 'new evidence' }],
  ]);
  assert.ok(r[0].ok && /_context\//.test(r[0].result) && /_raw\//.test(r[0].result), `lists the brain: ${r[0].result}`);
  assert.equal(r[1].result, '# Index\nJarvis ships v0.2.6 with the loop guard.\n', 'reads a note relative to the brain');
  assert.ok(r[2].ok && /index\.md:2:Jarvis ships v0\.2\.6 with the loop guard\./.test(r[2].result), `search finds the line: ${r[2].result}`);
  assert.ok(r[3].ok, r[3].result);
  assert.equal(fs.readFileSync(path.join(brain, '_context', 'today.md'), 'utf8'), 'Ran the regression tests.', 'a new note lands in the brain');
  assert.match(r[4].result, /^Raw transcript/, '_raw/ can be read');
  assert.equal(r[5].ok, false, 'overwriting _raw/ evidence is refused');
  assert.match(r[5].result, /Blocked for safety/);
  assert.equal(r[6].ok, false, 'a new file in _raw/ is refused too');
  assert.equal(fs.readFileSync(path.join(brain, '_raw', 'call.md'), 'utf8'), 'Raw transcript: Eric said the operator hands off from Live.\n', '_raw/ unchanged');
  assert.ok(!fs.existsSync(path.join(brain, '_raw', 'new.md')));
  // Secrets stay off limits even inside the brain.
  fs.writeFileSync(path.join(brain, '.env'), 'KEY=nope');
  const [sec] = await play([['read_file', { path: '.env' }]]);
  assert.equal(sec.ok, false, 'a .env in the brain is not read');
  assert.match(sec.result, /Blocked for safety/);
});

// 1b. A plain tool round trip: the real execute runs and its result is what the model gets back.
await cp('CP-3 tool round trip: show_list and remember_commitment run and answer the model', async () => {
  const r = await play([['show_list', {}], ['remember_commitment', { text: 'Record the Jarvis regression video', due: '2030-01-02T09:00' }]]);
  assert.deepEqual(r.map((x) => x.ok), [true, true], JSON.stringify(r));
  assert.equal(r[0].result, 'The list is on screen.');
  assert.equal(shown.length, 1, 'show_list put the list on screen');
  assert.match(r[1].result, /^Saved as \S+, due .+\. I'll remind them when it is due\.$/);
  assert.equal(committed.at(-1)?.text, 'Record the Jarvis regression video', 'the saved commitment reached the app');
});

// Regression (v0.2.10, Classic, 2026-11-27): YouTube Studio's reply box gave the helper no value to read back, the
// typing went unchecked, Reply was clicked on an empty box and Jarvis said "I replied". The helper now says the typing
// is unconfirmed (hands/main.swift TYPED_UNCONFIRMED), and the result the model gets tells it to look before claiming it.
if (HANDS_OK) await cp('CP-5b unconfirmed typing: act_in_app says to check the screen before saying it was sent', async () => {
  const swift = fs.readFileSync(new URL('../../src-tauri/hands/main.swift', import.meta.url), 'utf8');
  const phrase = swift.match(/let TYPED_UNCONFIRMED = "([^"]+)"/)?.[1];
  assert.ok(phrase, 'the helper names its unconfirmed-typing line');
  made.nextTurn?.();
  fs.writeFileSync(canvasFile + '.unconfirmed', phrase);
  try {
    const [r] = await play([['act_in_app', { target: 'front', steps: [{ do: 'type', text: 'Thank you for watching' }, { do: 'click_text', text: 'Reply' }] }]]);
    assert.ok(r.ok, text(r.result));
    assert.match(r.result, /Not confirmed: /, 'the result flags the unconfirmed typing');
    assert.match(r.result, /take_screenshot/, 'and says to look');
    assert.match(r.result, /before (?:telling|saying)[^\n]*(?:done|sent|replied)/, 'before claiming it went through');
  } finally { fs.rmSync(canvasFile + '.unconfirmed', { force: true }); }
  const [plain] = await play([['act_in_app', { target: 'front', steps: [{ do: 'type', text: 'Hi' }] }]]);
  assert.doesNotMatch(plain.result, /Not confirmed/, 'checked typing carries no note');
});

// 2. The screen: list windows, read the window, click and scroll in it, look at it.
if (HANDS_OK) await cp('CP-5/CP-6 screen: list_windows, read_window, act_in_app click/scroll/click_text, take_screenshot reach the helper', async () => {
  made.nextTurn?.();
  fs.writeFileSync(handsLog, '');
  const r = await play([
    ['list_windows', {}],
    ['read_window', { target: 'front' }],
    ['act_in_app', { target: 'front', steps: [{ do: 'click', id: 1 }] }],
    ['act_in_app', { target: 'Chrome', steps: [{ do: 'scroll', direction: 'down', amount: 3 }] }],
    ['act_in_app', { target: 'front', steps: [{ do: 'click_text', text: 'Upload' }] }],
    ['take_screenshot', { target: 'front' }],
  ]);
  for (const x of r) assert.ok(x.ok, `${x.name}: ${text(x.result)}`);
  assert.match(r[0].result, /window:7 {2}Chrome — Cards {2}\(frontmost app\)/);
  assert.match(r[1].result, /Video \+/, 'read_window lists the controls');
  assert.match(r[2].result, /^In Chrome: click\./);
  assert.match(r[3].result, /^In Chrome: scroll\./);
  assert.match(r[4].result, /^In Chrome: click_text\./);
  const acts = handsCalls().filter((c) => c[0] === 'act').map((c) => JSON.parse(c[1]));
  assert.equal(acts.length, 3, 'three plans reached the helper');
  assert.deepEqual(acts[0].steps.map((s) => [s.do, s.id]), [['click', 1]], 'the click went by the read_window id');
  assert.deepEqual(acts[1].steps[0], { do: 'scroll', direction: 'down', amount: 3 });
  assert.deepEqual(acts[2].steps[0], { do: 'click_text', text: 'Upload' });
  assert.ok(handsCalls().some((c) => c[0] === 'capture'), 'the screenshot went through the helper');
  assert.ok(Array.isArray(r[5].result?.content) && r[5].result.content.some((c) => c.type === 'image'), 'take_screenshot gives the model a picture');
});
if (HANDS_OK) await cp('CP-7 loop guard: 4th identical no-change scroll refused; a take_screenshot resets the count', async () => {
  // The loop guard: the same scroll on a window that never changes is refused on the fourth try.
  made.nextTurn?.();
  const scroll = ['act_in_app', { target: 'front', steps: [{ do: 'scroll', direction: 'down' }] }];
  const g = await play([scroll, scroll, scroll, scroll]);
  assert.deepEqual(g.map((x) => x.ok && !String(x.result).startsWith(LOOP_MESSAGE.slice(0, 20))), [true, true, true, false], `fourth identical scroll refused: ${JSON.stringify(g.map((x) => x.result))}`);
  assert.match(text(g[3].result), /nothing changed after 3 tries/);
  assert.equal(text(g[3].result), LOOP_MESSAGE);
  assert.match(LOOP_MESSAGE, /take_screenshot/, 'the refusal tells the model to look and try a different step');
  // Looking resets it: after a take_screenshot the same scroll runs again (and is counted from one).
  const again = await play([['take_screenshot', { target: 'front' }], scroll, scroll, scroll, scroll]);
  assert.deepEqual(again.map((x) => x.ok), [true, true, true, true, false], `count restarts after a look: ${JSON.stringify(again.map((x) => text(x.result).slice(0, 60)))}`);
  // A different step also breaks the run.
  const other = await play([['act_in_app', { target: 'front', steps: [{ do: 'click', id: 1 }] }], scroll]);
  assert.deepEqual(other.map((x) => x.ok), [true, true], 'a different step lets the scroll run again');
});
// 2b. Eric's "fill this in from what you know about me" on a Google Doc: three questions, each with a "-" line under it.
// The answers are in the second brain (index first, then the note it points to) and today's date is in the prompt.
const QUESTIONS = ['1. What is my name?', '2. What is my YouTube Channel Name?', "3. What's today's date?"];
const DOC = QUESTIONS.flatMap((q) => [q, '-']);
const TODAY = new Date().toLocaleDateString('en-CA'); // the date line sidekick.mjs puts in the prompt
// A separate tool set, wired like sidekick.mjs (the loop guard with goals on, one request), for the permission and
// v0.2.8 replays: its own Allow switch, screenshot and loop-guard state.
const freshTools = ({ actions = true, goals = false } = {}) => {
  const t = createTools({ allowActions: () => actions, ask: async () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Eric', workdir: tmp, fileDir: () => brain, readOnly: () => [path.join(brain, '_raw')] });
  const g = guardTools(t.tools, { goals, request: () => 1 });
  return async (calls) => {
    const out = [];
    for (const [name, args] of calls) {
      try { out.push({ name, ok: true, result: await g.find((x) => x.name === name).execute(args, { toolCallId: `f${++callN}`, signal: new AbortController().signal }) }); }
      catch (e) { out.push({ name, ok: false, result: e.message }); }
    }
    return out;
  };
};
const actsNow = () => handsCalls().filter((c) => c[0] === 'act').map((c) => JSON.parse(c[1]));
if (HANDS_OK) {
  fs.writeFileSync(path.join(brain, '_context', 'index.md'), '# Index\nJarvis ships v0.2.6 with the loop guard.\n- [[youtube]]: _context/youtube.md, Eric and his channel\n');
  fs.writeFileSync(path.join(brain, '_context', 'youtube.md'), '# YouTube\nOwner: Eric Tech\nChannel name: Eric Tech | AI Builder\nChannel: https://www.youtube.com/@EricTech\n');
}

if (HANDS_OK) await cp('CP-11 fill-in from the second brain: read_window, the index, the note, then act_in_app types each answer under its question', async () => {
  made.nextTurn?.();
  fs.writeFileSync(handsLog, ''); fs.writeFileSync(textsFile, JSON.stringify(DOC));
  const look = await play([['read_window', { target: 'front' }], ['read_file', { path: '_context/index.md' }]]);
  for (const x of look) assert.ok(x.ok, `${x.name}: ${text(x.result)}`);
  for (const q of QUESTIONS) assert.ok(look[0].result.includes(q), `read_window shows "${q}"`);
  assert.match(look[1].result, /_context\/youtube\.md/, 'the index points at the note');
  const [note] = await play([['read_file', { path: '_context/youtube.md' }]]);
  const name = note.result.match(/Owner: (.+)/)[1], channel = note.result.match(/Channel name: (.+)/)[1];
  const answers = [name, channel, TODAY];
  // One question per call: click its words, the "-" line under it, its end, the answer.
  const r = await play(QUESTIONS.map((q, i) => ['act_in_app', { target: 'front', steps: [{ do: 'click_text', text: q.replace(/^\d+\. /, '') }, { do: 'key', key: 'down' }, { do: 'key', key: 'end' }, { do: 'type', text: ` ${answers[i]}` }] }]));
  for (const x of r) assert.ok(x.ok, text(x.result));
  for (const x of r) assert.match(x.result, /^In Chrome: click_text, key, key, type\./);
  const a = actsNow();
  assert.deepEqual(a.map((x) => x.steps.find((st) => st.do === 'type').text), [' Eric Tech', ' Eric Tech | AI Builder', ` ${TODAY}`], 'each value typed');
  assert.deepEqual(a.map((x) => x.steps[0].text), ['What is my name?', 'What is my YouTube Channel Name?', "What's today's date?"], 'each at its own question');
  assert.ok(a.every((x) => x.steps[1].key === 'down' && x.steps[2].key === 'end'), 'on the "-" line under it');
  fs.rmSync(textsFile);
});

if (HANDS_OK) await cp('CP-11b fill-in on a canvas doc: click_text finds nothing, the words read off the screen give a real-cursor click_at', async () => {
  made.nextTurn?.();
  fs.writeFileSync(handsLog, ''); fs.writeFileSync(canvasFile, JSON.stringify(DOC));
  const [found] = await play([['act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: 'What is my name?' }, { do: 'key', key: 'down' }, { do: 'key', key: 'end' }, { do: 'type', text: ' Eric Tech' }] }]]);
  assert.ok(found.ok, text(found.result));
  assert.match(found.result, /^In Chrome: clicked "What is my name\?" \(read off the screen\), key, key, type\./);
  assert.ok(handsCalls().some((c) => c[0] === 'ocr-find' && c[2] === 'What is my name?'), 'the window is read for the words');
  const a = actsNow();
  assert.deepEqual(a.map((x) => x.steps.map((st) => st.do)), [['click_text', 'key', 'key', 'type'], ['click_at', 'key', 'key', 'type']], 'the plan, then its rest from a click on the words');
  assert.deepEqual([a[1].steps[0].x, a[1].steps[0].y, a[1].steps[0].global, a[1].steps[0].real], [200, 159, true, true], 'the middle of the words, in screen points, with the real cursor');
  assert.deepEqual([a[1].steps[1].key, a[1].steps[2].key, a[1].steps[3].text], ['down', 'end', ' Eric Tech']);
  // "What is my name?" is inside no other line, but "date" would be: the whole question line wins.
  fs.writeFileSync(handsLog, '');
  const [d] = await play([['act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: "What's today's date?" }, { do: 'key', key: 'down' }, { do: 'type', text: ` ${TODAY}` }] }]]);
  assert.ok(d.ok, text(d.result));
  assert.deepEqual([actsNow()[1].steps[0].y, actsNow()[1].steps[2].text], [150 + 20 * 4 + 9, ` ${TODAY}`], 'clicked the third question, typed the date');
  fs.rmSync(canvasFile);
});

if (HANDS_OK) await cp('CP-11c permissions: with Allow File Edits off the brain is still read, act_in_app is refused with the Allow message; on, it types', async () => {
  fs.writeFileSync(handsLog, ''); fs.writeFileSync(textsFile, JSON.stringify(DOC));
  const fill = ['act_in_app', { target: 'front', steps: [{ do: 'click_text', text: 'What is my name?' }, { do: 'key', key: 'down' }, { do: 'type', text: ' Eric Tech' }] }];
  const off = await freshTools({ actions: false })([
    ['read_file', { path: '_context/index.md' }], ['read_file', { path: '_context/youtube.md' }], ['search_files', { pattern: 'Owner', dir: '_context' }], ['list_files', { dir: '_context' }], ['read_window', { target: 'front' }], fill,
  ]);
  assert.deepEqual(off.map((x) => x.ok), [true, true, true, true, true, false], JSON.stringify(off.map((x) => text(x.result).slice(0, 80))));
  assert.match(off[1].result, /Owner: Eric Tech/, 'the brain is read with actions off');
  assert.match(off[2].result, /youtube\.md:2:Owner: Eric Tech/, 'and searched');
  assert.match(off[5].result, /turn on "Allow File Edits & Commands"/, 'typing is what the switch stops, and the model is told which switch');
  assert.equal(actsNow().length, 0, 'nothing reached the hands helper');
  const on = await freshTools({ actions: true })([fill]);
  assert.ok(on[0].ok, text(on[0].result));
  assert.deepEqual(actsNow().map((x) => x.steps.at(-1).text), [' Eric Tech'], 'with it on, it types');
  fs.rmSync(textsFile);
});

if (HANDS_OK) await cp('CP-11d v0.2.8 replay: click_text no_visible_text x3 then click_at on the canvas doc, guarded as sidekick.mjs wires it', async () => {
  // The log's sequence, against the same canvas doc and a goals-on loop guard (one request).
  const tries = ['What is my name?', '1. What is my name?', 'What is my name'].map((t) => ['act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: t }, { do: 'key', key: 'down' }, { do: 'type', text: ' Eric Tech' }] }]);
  const pixels = ['act_in_app', { target: 'browser', steps: [{ do: 'click_at', x: 200, y: 179 }, { do: 'key', key: 'end' }, { do: 'type', text: ' Eric Tech' }] }];
  fs.writeFileSync(canvasFile, JSON.stringify(DOC));
  // Now: each click_text is found by reading the screen, so nothing fails, and the click_at runs too.
  fs.writeFileSync(handsLog, '');
  const now = await freshTools({ goals: true })([...tries, ['take_screenshot', { target: 'browser' }], pixels]);
  assert.deepEqual(now.map((x) => x.ok), [true, true, true, true, true], JSON.stringify(now.map((x) => text(x.result).slice(0, 100))));
  for (const x of now.slice(0, 3)) assert.match(x.result, /\(read off the screen\)/);
  assert.ok(!now.some((x) => [LOOP_MESSAGE, STUCK_MESSAGE].includes(text(x.result))), 'never stuck');
  assert.deepEqual(actsNow().filter((x) => x.steps[0].do === 'click_at').map((x) => x.steps.at(-1).text), [' Eric Tech', ' Eric Tech', ' Eric Tech', ' Eric Tech'], 'every plan typed its answer');
  // Even when the screen can't be read either (no OCR, as in v0.2.8): the 3 failures stop click_text, not click_at.
  fs.writeFileSync(canvasFile + '.noocr', ''); fs.writeFileSync(handsLog, '');
  const blind = await freshTools({ goals: true })([...tries, ['take_screenshot', { target: 'browser' }], pixels, tries[0]]);
  assert.deepEqual(blind.map((x) => x.ok), [false, false, false, true, true, false], JSON.stringify(blind.map((x) => text(x.result).slice(0, 100))));
  for (const x of blind.slice(0, 3)) assert.match(x.result, /no visible text/);
  assert.match(blind[4].result, /^In Chrome: click_at, key, type\./, 'the click by pixels runs after 3 failures');
  assert.equal(blind[5].result, STUCK_MESSAGE, 'another click_text is what gets stopped');
  fs.rmSync(canvasFile + '.noocr'); fs.rmSync(canvasFile);
});
if (HANDS_OK) await cp('CP-11e v0.2.9 replay: a click_at on a used-up screenshot fails before anything runs, marked so the loop guard does not count it', async () => {
  made.nextTurn?.();
  fs.writeFileSync(handsLog, '');
  const at = { target: 'front', steps: [{ do: 'click_at', x: 300, y: 100 }, { do: 'type', text: 'hello' }] };
  const r = await play([['take_screenshot', { target: 'front' }], ['act_in_app', at]]);
  assert.ok(r[1].ok, text(r[1].result));
  const err = await tool('act_in_app').execute(at, { toolCallId: 'pre1' }).then(() => null, (e) => e);
  assert.match(err?.message ?? '', /Take a new screenshot/);
  assert.equal(err.ranNothing, true, 'nothing ran: marked for the loop guard');
  assert.equal(actsNow().length, 1, 'only the first plan reached the hands helper');
  made.nextTurn?.();
  const old = await tool('act_in_app').execute(at, { toolCallId: 'pre2' }).then(() => null, (e) => e);
  assert.match(old?.message ?? '', /Look again first/);
  assert.equal(old.ranNothing, true);
  // Guarded with goals (as sidekick.mjs wires the chat and Live): two such checks, then a fresh screenshot, and the
  // click_at still gets both of its tries.
  const g = await freshTools({ goals: true })([['act_in_app', at], ['act_in_app', at], ['take_screenshot', { target: 'front' }], ['act_in_app', at]]);
  assert.deepEqual(g.map((x) => x.ok), [false, false, true, true], JSON.stringify(g.map((x) => text(x.result).slice(0, 80))));
  // The Classic run (02:43:07-02:43:25): a plan typing into the Doc failed once for real (the helper's type check),
  // the next click_at hit the used-up screenshot, and the click_at after a fresh screenshot was refused as stuck.
  const plan = { target: 'browser', steps: [{ do: 'click_at', x: 455, y: 285 }, { do: 'key', key: 'cmd+right' }, { do: 'type', text: ' Eric Tech' }] };
  const play2 = freshTools({ goals: true });
  await play2([['take_screenshot', { target: 'browser' }]]);
  fs.writeFileSync(canvasFile + '.actfail', 'Step 3: typed, but the text field still shows "\u200b\u200b", so I stopped before the next step.');
  const c = await play2([['act_in_app', plan], ['act_in_app', plan], ['take_screenshot', { target: 'browser' }], ['act_in_app', plan]]);
  assert.deepEqual(c.map((x) => x.ok), [false, false, true, true], JSON.stringify(c.map((x) => text(x.result).slice(0, 80))));
  assert.match(c[1].result, /Take a new screenshot/);
  assert.notEqual(c[3].result, STUCK_MESSAGE);
  // Only what a fresh look fixes is free: a screenshot that never lines up with its window (it repeats with every new
  // one) and an id gone stale on a page that keeps changing count as failures.
  made.nextTurn?.();
  fs.writeFileSync(canvasFile + '.skew', '');
  await play([['take_screenshot', { target: 'front' }]]);
  const skew = await tool('act_in_app').execute(at, { toolCallId: 'pre3' }).then(() => null, (e) => e);
  fs.rmSync(canvasFile + '.skew');
  assert.match(skew?.message ?? '', /doesn't line up/);
  assert.notEqual(skew.ranNothing, true, 'an unmapped screenshot is not free');
  await play([['read_window', { target: 'front' }]]);
  const stale = await tool('act_in_app').execute({ target: 'front', steps: [{ do: 'click', id: 5 }] }, { toolCallId: 'pre4' }).then(() => null, (e) => e);
  assert.match(stale?.message ?? '', /id is out of date/);
  assert.notEqual(stale.ranNothing, true, 'a stale id is not free');
});
if (!HANDS_OK) console.log('e2e-classic: screen steps skipped (macOS and Windows only)');

// 3. Opening a tab: a link opens in the browser, a bare address is a link, and typing an address into the browser bar
// goes straight to it. Unsafe targets never reach the browser.
if (OPEN_OK) await cp('CP-6 open URL/tab: links and bare addresses open, unsafe targets blocked, typed address goes straight', async () => {
  const r = await play([
    ['open', { target: 'https://youtube.com/studio' }],
    ['open', { target: 'example.com/docs' }],
    ['open', { target: 'file:///etc/passwd' }],
    ['open', { target: 'javascript:alert(1)' }],
  ]);
  assert.equal(r[0].result, 'Opened https://youtube.com/studio.');
  assert.equal(r[1].result, 'Opened https://example.com/docs.', 'a bare address opens as a link');
  assert.equal(r[2].ok, false); assert.match(r[2].result, /Blocked for safety/);
  assert.equal(r[3].ok, false); assert.match(r[3].result, /Blocked for safety/);
  if (HANDS_OK) {
    const [t] = await play([['act_in_app', { target: 'browser', steps: [{ do: 'key', key: 'cmd+l' }, { do: 'type', text: 'skool.com' }, { do: 'key', key: 'return' }] }]]);
    assert.ok(t.ok, t.result);
    assert.match(t.result, /went straight to the address/);
  }
  const o = opened();
  assert.ok(o.some((l) => l.endsWith('https://youtube.com/studio')), `opened: ${o}`);
  assert.ok(o.some((l) => l.endsWith('https://example.com/docs')));
  assert.ok(!o.some((l) => /passwd|javascript/.test(l)), 'blocked targets never reached the browser');
  if (HANDS_OK) assert.ok(o.some((l) => /https:\/\/skool\.com/.test(l)), `typed address opened as a link: ${o}`);
}); else console.log('e2e-classic: open skipped on Windows (no fake Start-Process)');

// 4. Drawing: a flow diagram and a mind-map-style list card go to the overlay as draw segments with their marks.
await cp('CP-9 draw: a flow diagram reaches the overlay; a broken one is refused', async () => {
  made.nextTurn?.();
  ui.length = 0;
  const r = await play([['draw', { beats: [{ say: 'Live hands the long task to an operator.', marks: [{ kind: 'flow', title: 'Handoff', nodes: [{ id: 'a', text: 'Live call', shape: 'round' }, { id: 'b', text: 'Long task?', shape: 'diamond' }, { id: 'c', text: 'Operator agent' }], links: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'yes' }] }] }] }]]);
  assert.ok(r[0].ok, text(r[0].result));
  const draws = ui.filter((m) => m.e?.type === 'draw');
  assert.ok(draws.length >= 1, 'the overlay got a drawing');
  const marks = draws.flatMap((d) => d.e.marks ?? d.e.beats?.flatMap((b) => b.marks) ?? []);
  const flow = marks.find((m) => m.kind === 'flow');
  assert.ok(flow, `a flow mark was sent: ${JSON.stringify(draws.map((d) => d.e)).slice(0, 400)}`);
  assert.deepEqual(flow.nodes.map((n) => n.text), ['Live call', 'Long task?', 'Operator agent']);
  // A broken diagram comes back as the model's error, nothing drawn.
  ui.length = 0;
  const [bad] = await play([['draw', { beats: [{ say: 'Oops.', marks: [{ kind: 'flow', nodes: [{ id: 'a', text: 'A' }], links: [{ from: 'a', to: 'zz' }] }] }] }]]);
  assert.equal(bad.ok, false, 'a link to a missing node is refused');
  assert.equal(ui.filter((m) => m.e?.type === 'draw').length, 0);
});

// 5. The web: web_fetch never reaches this computer or the local network; a public page comes back as text; web_search
// with no side search uses the keyless engines (fetch stubbed with one result page).
await cp('CP-4 web: web_fetch blocks local addresses and reads a public page; web_search returns results', async () => {
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (/93\.184\.215\.14/.test(u)) return new Response('<html><head><title>Jarvis</title></head><body><h1>Jarvis notes</h1><p>The operator agent takes long tasks.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('<html><body><div class="result"><h2><a class="result__a" href="https://example.com/jarvis-assistant">Jarvis desktop assistant release notes</a></h2><a class="result__snippet">Jarvis desktop assistant v0.2.6 adds a loop guard.</a></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const r = await play([
      ['web_fetch', { url: 'http://127.0.0.1:8080/admin' }],
      ['web_fetch', { url: 'http://localhost/' }],
      ['web_fetch', { url: 'http://192.168.1.1/' }],
      ['web_fetch', { url: 'https://93.184.215.14/notes', prefer_llms_txt: false }],
      ['web_search', { query: 'jarvis desktop assistant release notes' }],
    ]);
    for (const x of r.slice(0, 3)) assert.match(text(x.result), /Blocked|blocked|not allowed|private|local/i, `local address refused: ${text(x.result)}`);
    assert.ok(!fetched.some((u) => /127\.0\.0\.1|localhost|192\.168/.test(u)), `nothing local was fetched: ${fetched}`);
    assert.match(text(r[3].result), /The operator agent takes long tasks\./, `a public page is read: ${text(r[3].result).slice(0, 300)}`);
    assert.match(text(r[4].result), /Jarvis desktop assistant release notes/, `search results: ${text(r[4].result).slice(0, 300)}`);
    assert.match(text(r[4].result), /https:\/\/example\.com\/jarvis-assistant/);
  } finally { globalThis.fetch = realFetch; }
});

// 6. Subagents: send_agent starts a researcher in the real worker and its report becomes news for the chat; an
// operator gets the screen tools and the loop guard; a bad launch says so instead of going quiet.
await cp('CP-8 subagents: researcher report reaches the chat; operator runs screen tools loop-guarded; one operator at a time', async () => {
  const { agentsRoot, createAgents } = await import('../agents.mjs');
  const { checkOpen, checkRead, checkWrite } = await import('../safety.mjs');
  const events = [];
  let onEnd = null;
  const mgr = createAgents({
    fork, root: agentsRoot(), userName: 'Eric', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
    config: { model: async () => ({ provider: 'anthropic', model: 'fake', route: 'api' }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {} },
    ui: (m) => {
      if (m.kind === 'hands') return;
      events.push(m.e);
      if (m.e.type === 'ask') setTimeout(() => mgr.answer(m.e.agent.id, true), 20);
      if (['done', 'fail', 'gone'].includes(m.e.type)) onEnd?.(m.e);
    },
  });
  const ended = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no result in 20 s: ${JSON.stringify(events.map((e) => e.type))}`)), 20_000);
    onEnd = (e) => { clearTimeout(t); onEnd = null; resolve(e); };
  });
  const send = mgr.tools.find((t) => t.name === 'send_agent');
  try {
    const end1 = ended();
    const started = await send.execute({ type: 'researcher', title: 'Latest LLM releases', brief: 'Find out the latest LLM releases.' });
    assert.match(started, /^Started a\w* "Latest LLM releases" \(researcher, returns answer\) in .+\. .*the launch is your reply\.$/s, started);
    const e1 = await end1;
    assert.equal(e1.type, 'done', e1.agent?.reason);
    const news = mgr.news().find((n) => n.id === e1.agent.id);
    assert.equal(news.report, 'GPT-6 and Claude 6 both came out this week.\nSources: https://example.com/news', 'the report comes back to the chat');
    assert.match(await mgr.tools.find((t) => t.name === 'agent_report').execute({ id: e1.agent.id }), /Report: GPT-6 and Claude 6/);

    process.env.FAKE_LOG = path.join(tmp, 'fake-operator.log');
    const end2 = ended();
    const op = await send.execute({ type: 'operator', title: 'YouTube info cards', brief: 'Add the five cards from the doc to the video.' });
    assert.match(op, /\(operator, returns answer\)/);
    const e2 = await end2;
    assert.equal(e2.type, 'done', e2.agent?.reason);
    const opLog = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([...opLog[0].tools].sort(), ['act_in_app', 'finish', 'list_windows', 'open', 'plan', 'read_window', 'take_screenshot']);
    assert.deepEqual(opLog.filter((l) => l.name === 'act_in_app').map((l) => l.isError), [false, false, false, true, false, false], 'the operator is loop-guarded, then both sends run');

    await assert.rejects(send.execute({ type: 'researcher', title: 'Bad', brief: 'x', continue: 'nope42' }), /The launch failed, so there is no agent/);

    // Two operators would fight over the mouse: the second is refused while the first runs.
    process.env.FAKE_LOG = path.join(tmp, 'fake-operator2.log');
    const end3 = ended();
    await send.execute({ type: 'operator', title: 'First operator', brief: 'Add the cards.' });
    await assert.rejects(send.execute({ type: 'operator', title: 'Second operator', brief: 'Also add the cards.' }), /An operator is already working on the screen/);
    assert.equal((await end3).type, 'done', 'the first operator still finishes');
  } finally { mgr.stopAll(); }
});

// 7. Safety holds with actions switched off: nothing writes or acts, the model is told how to turn them on; looking still works.
await cp('CP-5/CP-6 allowActions off: act_in_app and write refused with the Allow message; take_screenshot and read_window still work', async () => {
  const off = createTools({ allowActions: () => false, ask: async () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Eric', workdir: tmp, fileDir: () => brain });
  const w = off.tools.find((t) => t.name === 'write_file');
  await assert.rejects(w.execute({ path: '_context/off.md', content: 'x' }, { toolCallId: 'o1' }), /switched off/);
  assert.ok(!fs.existsSync(path.join(brain, '_context', 'off.md')));
  if (HANDS_OK) {
    const ot = (n) => off.tools.find((t) => t.name === n);
    fs.writeFileSync(handsLog, '');
    await assert.rejects(ot('act_in_app').execute({ target: 'front', steps: [{ do: 'click', id: 1 }] }, { toolCallId: 'o2' }), /turn on "Allow File Edits & Commands"/);
    assert.ok(!handsCalls().some((c) => c[0] === 'act'), 'nothing reached the hands helper');
    assert.match(await ot('read_window').execute({ target: 'front' }, { toolCallId: 'o3' }), /Video \+/, 'read_window works with actions off');
    const shot = await ot('take_screenshot').execute({ target: 'front' }, { toolCallId: 'o4' });
    assert.ok(Array.isArray(shot?.content) && shot.content.some((c) => c.type === 'image'), 'take_screenshot works with actions off');
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`e2e-classic tests: passed (${passed.length} critical paths)`);
