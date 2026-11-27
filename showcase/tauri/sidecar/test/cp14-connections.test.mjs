// CP-14 Connections, end to end with fakes only (no network beyond 127.0.0.1, no real keys, browser, voice helper or
// screen): an MCP server connected through gg's real client and used from the chat's tools, command servers refused
// with actions off, a link opened in the browser, the voice settings sent to the voice helper, and computer control
// wired from the menu's "Allow File Edits & Commands" to the hands helper. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cp14-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP; delete process.env.JARVIS_DATA_DIR;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const SIDECAR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fake hands helper (a .mjs runs on this Node, so it works on Windows too), set before tools.mjs is imported.
const handsLog = path.join(TMP, 'hands.jsonl'), handsFake = path.join(TMP, 'hands.mjs');
fs.writeFileSync(handsFake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(handsLog)}, JSON.stringify(a) + '\\n');
const win = { id: 7, app: 'TextEdit', title: 'notes.txt', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') o = { ok: true, done: JSON.parse(a[1]).steps.map((s) => s.do), window: win };
if (a[0] === 'ui') o = { ok: true, window: win, controls: [], texts: [], note: 'Nothing to list.' };
console.log(JSON.stringify(o));
`);
process.env.JARVIS_HANDS = handsFake;

const { startFakeMcp } = await import('./fakemcpserver.mjs');
const { createMcp, createMcpTools } = await import('../mcp.mjs');
const { checkMcpCall, isYes } = await import('../safety.mjs');
const { DIR, flushWrites } = await import('../store.mjs');

const kept = new Map();
const secrets = { get: async (k) => kept.get(k) ?? null, set: async (k, v) => { kept.set(k, v); }, delete: async (k) => { kept.delete(k); } };
const paths = { gg: path.join(TMP, 'none-gg.json'), 'claude-desktop': path.join(TMP, 'none-claude.json') };
let asked = [], answers = [];
const ask = async (o) => { asked.push(o); return answers.shift() ?? null; };
const toolsOf = (mcp, opts = {}) => Object.fromEntries(createMcpTools({ mcp, ask, isYes, userName: 'Ken', checkCall: checkMcpCall, ...opts }).map((t) => [t.name, t]));

// ---------- CP-14 MCP: connect, list and use a real (fake) server through gg's own client ----------
const server = await startFakeMcp();
const mcp = createMcp({ secrets, paths }); // no manager given: the real @kenkaiiii/ggcoder/mcp client
const T = toolsOf(mcp);
{
  asked = []; answers = ['yes'];
  const out = await T.add_connection.execute({ name: 'notes', url: server.url });
  assert.equal(out, 'Connected notes: 2 tools. Use connection_tools to see them. It shows on the Abilities page\'s Connections tab.', 'CP-14 connect');
  assert.equal(asked.length, 1, 'CP-14 asked once before connecting');
  assert.match(asked[0].placeholder, new RegExp(`^Connect notes\\? Connect to http://127\\.0\\.0\\.1:\\d+/mcp$`));
  await flushWrites();
  assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, 'mcp.json'), 'utf8')).mcpServers.notes.url, server.url, 'CP-14 saved');
  assert.deepEqual(mcp.status().find((s) => s.name === 'notes'), { name: 'notes', remote: true, where: server.url, enabled: true, state: 'connected', toolCount: 2, error: null });

  const listed = await T.connection_tools.execute({ server: 'notes' });
  assert.match(listed, /^- search_notes \[read-only\]: Search the notes\n {2}args: \{"type":"object","properties":\{"q":\{"type":"string"\}\},"required":\["q"\]\}/, 'CP-14 list');
  assert.match(listed, /- delete_note: Delete a note/);
  assert.match(await T.connection_tools.execute({ server: 'notes', query: 'zzz' }), /No notes tools match "zzz"/);

  // A read-only tool runs straight away, and its call reaches the server with the arguments.
  asked = [];
  const used = await T.use_connection.execute({ server: 'notes', tool: 'search_notes', args: '{"q":"milk"}' });
  assert.match(JSON.stringify(used), /found \{\\?"q\\?":\\?"milk\\?"\} via search_notes/, 'CP-14 use');
  assert.equal(asked.length, 0, 'CP-14 read-only: no ask');
  assert.deepEqual(server.calls.filter((c) => c.method === 'tools/call').map((c) => [c.params.name, c.params.arguments]), [['search_notes', { q: 'milk' }]]);

  // Key failure path: a destructive tool always asks; a no means the server never gets the call.
  answers = [null];
  await assert.rejects(T.use_connection.execute({ server: 'notes', tool: 'delete_note', args: '{"id":"1"}' }), /Ken said no, so delete_note wasn't run/);
  assert.ok(!server.calls.some((c) => c.method === 'tools/call' && c.params?.name === 'delete_note'), 'CP-14 refused call never reached the server');
  await assert.rejects(T.use_connection.execute({ server: 'notes', tool: 'nope' }), /no tool called nope/);
  console.log('CP-14 mcp connect/list/use ok');
}

// ---------- CP-14 MCP: a server that needs a key, pasted in a masked ask and sent as a bearer header ----------
{
  const locked = await startFakeMcp({ token: 'tok-cp14-secret' });
  asked = []; answers = ['yes', 'tok-cp14-secret'];
  const out = await T.add_connection.execute({ name: 'locked', url: locked.url, header_keys: ['Authorization'], bearer: true });
  assert.match(out, /^Connected locked: 2 tools\./, 'CP-14 keyed connect');
  assert.equal(asked[1].mask, true, 'CP-14 key asked masked');
  await flushWrites();
  const file = fs.readFileSync(path.join(DIR, 'mcp.json'), 'utf8');
  assert.ok(!file.includes('tok-cp14-secret'), 'CP-14 no key in the file');
  assert.ok([...kept.values()].includes('Bearer tok-cp14-secret'), 'CP-14 key in the secret store');
  assert.match(JSON.stringify(await T.use_connection.execute({ server: 'locked', tool: 'search_notes', args: '{"q":"x"}' })), /via search_notes/);
  await locked.close();
}

// ---------- CP-14 MCP failure paths: nothing saved, nothing started ----------
{
  // A command server with actions off: refused before any ask or start.
  const off = toolsOf(mcp, { allowActions: () => false });
  asked = [];
  await assert.rejects(off.add_connection.execute({ name: 'local1', command: 'npx', args: ['-y', '@acme/notes-mcp'] }), /commands are switched off[^]*Allow File Edits & Commands/, 'CP-14 command refused with actions off');
  assert.equal(asked.length, 0, 'CP-14 never asked');
  assert.equal(mcp.has('local1'), false);
  // A remote one is still fine with actions off.
  answers = ['yes'];
  assert.match(await off.add_connection.execute({ name: 'notes_remote', url: server.url }), /^Connected notes_remote/, 'CP-14 remote allowed with actions off');

  // A server that isn't answering: a plain error and nothing saved.
  const gone = await startFakeMcp();
  await gone.close();
  answers = ['yes'];
  await assert.rejects(T.add_connection.execute({ name: 'down', url: gone.url }), /Couldn't connect to down: [^]*Nothing was saved/, 'CP-14 server down');
  assert.equal(mcp.has('down'), false);
  // A remote address on the local network is blocked before anything is asked.
  asked = [];
  await assert.rejects(T.add_connection.execute({ name: 'lan', url: 'http://192.168.1.5/mcp' }), /Blocked for safety/);
  assert.equal(asked.length, 0);
  console.log('CP-14 mcp failure paths ok');
}
await server.close();

// ---------- CP-14 browser: open sends the link to the system opener (a fake `open` / `xdg-open` on PATH) ----------
const { createTools } = await import('../tools.mjs');
const noop = async () => {};
const base = { ui: () => {}, ask: async () => null, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Ken' };
if (process.platform !== 'win32') {
  const bin = path.join(TMP, 'bin'), openLog = path.join(TMP, 'open.log');
  fs.mkdirSync(bin);
  for (const n of ['open', 'xdg-open']) { fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "$@" >> '${openLog}'\n`); fs.chmodSync(path.join(bin, n), 0o755); }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const { tools } = createTools({ ...base, allowActions: () => false });
  const open = tools.find((t) => t.name === 'open');
  assert.equal(await open.execute({ target: 'example.com/news' }, { toolCallId: 'o1' }), 'Opened https://example.com/news.', 'CP-14 openUrl');
  assert.equal(fs.readFileSync(openLog, 'utf8').trim(), 'https://example.com/news', 'CP-14 the opener got the link');
  // Key failure path: a link that would run something is refused and never reaches the opener.
  await assert.rejects(open.execute({ target: 'file:///etc/passwd' }, { toolCallId: 'o2' }), /only open web and mail links/);
  await assert.rejects(open.execute({ target: 'javascript:alert(1)' }, { toolCallId: 'o3' }), /only open web and mail links/);
  assert.equal(fs.readFileSync(openLog, 'utf8').trim().split('\n').length, 1, 'CP-14 refused links never opened');
  console.log('CP-14 browser open ok');
} else console.log('CP-14 browser open: skipped on Windows (opens through the shell, not PATH)');

// ---------- CP-14 voice config and computer control: the real sidecar, its stdin protocol, a throwaway HOME ----------
function startSidekick(home) {
  // JARVIS_DATA_DIR keeps keys in a test file (never the real keychain, keyring or DPAPI), and no hands helper or
  // real API key from the runner's environment reaches it.
  const env = { ...process.env, HOME: home, USERPROFILE: home, JARVIS_DATA_DIR: path.join(home, 'data') };
  for (const k of Object.keys(env)) if (/_API_KEY$|^JARVIS_HANDS$|^JARVIS_AGENT$/.test(k)) delete env[k];
  const p = spawn(process.execPath, [path.join(SIDECAR, 'sidekick.mjs')], { cwd: SIDECAR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const seen = [];
  let buf = '';
  const waiters = [];
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { seen.push(JSON.parse(line)); } catch { continue; }
      for (const w of [...waiters]) if (w.test(seen.at(-1))) { waiters.splice(waiters.indexOf(w), 1); w.res(seen.at(-1)); }
    }
  });
  p.stderr.resume();
  return {
    seen, send: (m) => p.stdin.write(`${JSON.stringify(m)}\n`),
    next: (test, ms = 15_000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timed out waiting; saw ${seen.map((s) => s.type).join(',')}`)), ms); waiters.push({ test, res: (v) => { clearTimeout(t); res(v); } }); }),
    stop: () => new Promise((r) => { p.once('exit', r); p.kill(); }),
  };
}
{
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const sk = startSidekick(home);
  const first = await sk.next((m) => m.type === 'voice_config');
  assert.equal(first.live, false, 'CP-14 starts in Classic');
  for (const k of ['enabled', 'mute', 'sound', 'wake', 'wakeName', 'lang', 'live']) assert.ok(k in first, `CP-14 voice_config has ${k}`);

  // Live picked in setup: the helper is told, and a restarted helper (voice_ready) gets the settings again.
  sk.send({ type: 'ob_voicemode', mode: 'live' });
  assert.equal((await sk.next((m) => m.type === 'voice_config' && m.live === true)).live, true, 'CP-14 voice mode reaches the helper');
  if (process.platform === 'darwin') {
    sk.send({ type: 'ob_wake', on: true });
    assert.equal((await sk.next((m) => m.type === 'voice_config' && m.wake === true)).live, true, 'CP-14 wake word reaches the helper');
  }
  sk.send({ type: 'voice_ready' });
  const again = await sk.next((m) => m.type === 'voice_config');
  assert.equal(again.live, true, 'CP-14 a restarted helper gets the live mode back');
  // Key failure path: an unknown mode changes nothing.
  sk.send({ type: 'ob_voicemode', mode: 'bogus' });
  sk.send({ type: 'voice_ready' });
  assert.equal((await sk.next((m) => m.type === 'voice_config')).live, true, 'CP-14 unknown mode ignored');

  // Computer control: "Allow File Edits & Commands" from the menu is saved, and the hands helper runs only with it on.
  sk.send({ type: 'set_actions', on: true });
  const cfgPath = path.join(home, 'data', 'Jarvis', 'Data', 'settings.json');
  for (let i = 0; i < 100 && !(fs.existsSync(cfgPath) && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).allowActions === true); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).allowActions, true, 'CP-14 allowActions saved');
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).voiceMode, 'live', 'CP-14 voiceMode saved');
  await sk.stop();
  console.log('CP-14 voice config ok');
}

if (['darwin', 'win32'].includes(process.platform)) {
  let allow = true;
  const { tools } = createTools({ ...base, allowActions: () => allow });
  const act = tools.find((t) => t.name === 'act_in_app');
  fs.writeFileSync(handsLog, '');
  const r = await act.execute({ target: 'TextEdit', steps: [{ do: 'key', key: 'cmd+a' }, { do: 'type', text: 'hello' }] }, { toolCallId: 'h1' });
  assert.match(r, /key, type/, 'CP-14 computer control result');
  const call = fs.readFileSync(handsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((c) => c[0] === 'act');
  assert.deepEqual(JSON.parse(call[1]).steps.map((s) => s.do), ['key', 'type'], 'CP-14 steps reached the hands helper');
  // Key failure path: with it off, refused with the turn-it-on message and the helper never acts.
  allow = false; fs.writeFileSync(handsLog, '');
  await assert.rejects(act.execute({ target: 'TextEdit', steps: [{ do: 'key', key: 'return' }] }, { toolCallId: 'h2' }), /Allow File Edits & Commands/, 'CP-14 refused with actions off');
  assert.ok(!fs.readFileSync(handsLog, 'utf8').includes('"act"'), 'CP-14 helper never acted');
  console.log('CP-14 computer control ok');
} else console.log('CP-14 computer control: skipped (macOS and Windows only)');
console.log('cp14 connections ok');
process.exit(0);
