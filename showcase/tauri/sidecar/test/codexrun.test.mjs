// Codex as the engine of a background agent: the real worker (agentrun.mjs) and Codex adapter (codex.mjs), driven by a
// fake Codex CLI (test/fakecodex.mjs) that reaches our tools only through the MCP server it is told to start.
// Progress, done, a refused model, a stop, and the missing / signed-out CLI checks. Run: npm test
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codexrun-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.JARVIS_DATA_DIR = path.join(tmp, 'data');
process.env.FAKE_CODEX_LOG = path.join(tmp, 'codex.log');
delete process.env.JARVIS_FAKE_AGENT;
const fake = fileURLToPath(new URL('./fakecodex.mjs', import.meta.url));
const { agentsRoot, createAgents } = await import('../agents.mjs');
const { checkOpen, checkRead, checkWrite } = await import('../safety.mjs');
const { CODEX_MODELS, codexModels, probeCodex } = await import('../codex.mjs');

let model = 'gpt-5.5';
const events = [];
let onEnd = null;
const mgr = createAgents({
  fork, root: agentsRoot(), userName: 'Ken', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
  config: { model: async () => ({ provider: 'codex', model, route: 'codex', codex: { bin: process.execPath, args: [fake] } }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {} },
  ui: ({ e }) => { events.push(e); if (e.type === 'done' || e.type === 'fail' || e.type === 'gone') onEnd?.(e); },
});
const ended = () => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no result in 20 s: ${JSON.stringify(events.map((e) => e.type))}`)), 20_000);
  onEnd = (e) => { clearTimeout(t); onEnd = null; resolve(e); };
});
const codexLog = () => fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Done: it plans, writes through our write_file (safety.mjs), and finishes through our finish tool.
let done = ended();
const a = await mgr.start({ type: 'maker', title: 'A note', brief: 'Write a short note.' });
let end = await done;
assert.equal(end.type, 'done', end.agent.reason);
assert.ok(events.some((e) => e.type === 'update' && e.agent.step === 'Writing the note'), 'its plan line reached the row');
assert.equal(fs.readFileSync(path.join(a.dir, 'files', 'note.md'), 'utf8'), '# Hi\n');
assert.equal(end.agent.result.outcome, 'Wrote a short note.');
assert.deepEqual(end.agent.result.files.map((f) => f.rel), ['files/note.md']);
const state = JSON.parse(fs.readFileSync(path.join(a.dir, '.agent.json'), 'utf8'));
assert.deepEqual(state.tokens, { in: 1200, out: 80 });
const log = codexLog();
const { argv } = log[0];
// How it was run: headless JSON, our model, in its folder, Codex's own shell off. A maker (the Builder's type) with
// actions allowed can write, but only in its own folder: workspace-write with -C its folder, no /tmp, no $TMPDIR and
// no network.
const CONFINED = ['sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.writable_roots=[]'];
assert.deepEqual(argv.slice(0, 2), ['exec', '--json']);
assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.5');
assert.equal(argv[argv.indexOf('-C') + 1], a.dir);
assert.equal(argv[argv.indexOf('--sandbox') + 1], 'workspace-write', 'a maker gets the write sandbox');
for (const c of CONFINED) assert.ok(argv.includes(c), `confined to its folder: ${c}`);
assert.ok(argv.includes('--skip-git-repo-check'));
// Every Codex built-in that could reach files, commands, the web or other apps is switched off, and only those.
assert.deepEqual(argv.filter((x) => x.startsWith('features.')).sort(), [
  'features.apps=false', 'features.browser_use=false', 'features.computer_use=false', 'features.image_generation=false',
  'features.multi_agent=false', 'features.plugins=false', 'features.shell_tool=false',
  'features.tool_search_always_defer_mcp_tools=false', 'features.unified_exec=false', 'features.view_image=false',
]);
assert.ok(argv.includes('web_search="disabled"'));
assert.deepEqual([...log[1].tools].sort(), ['finish', 'list_files', 'plan', 'read_file', 'run_command', 'search_files', 'web_fetch', 'web_search', 'write_file'], 'only its own tools, plus plan and finish');
assert.match(log[1].input, /Brief from Ken:\nWrite a short note\./);
assert.ok(log[1].input.includes(`Your folder is ${a.dir}.`), 'our agent prompt goes in');
assert.equal(log[2].write.isError, undefined, 'write_file worked');

// A researcher (the Scout's and Reviewer's type) stays read-only. (With actions off no agent starts at all.)
{
  fs.rmSync(process.env.FAKE_CODEX_LOG);
  done = ended();
  await mgr.start({ type: 'researcher', title: 'A look', brief: 'Write a short note.' });
  await done;
  const av = codexLog()[0].argv;
  assert.equal(av[av.indexOf('--sandbox') + 1], 'read-only', 'a researcher: read-only');
  assert.ok(!av.some((x) => x.startsWith('sandbox_workspace_write.')), 'and nothing about writing');
}

// Allow actions turned off mid-run: every later Codex turn is read-only, so apply_patch can't keep writing.
{
  fs.rmSync(process.env.FAKE_CODEX_LOG);
  model = 'gpt-twoturn';
  process.env.FAKE_CODEX_GO = path.join(tmp, 'go');
  done = ended();
  await mgr.start({ type: 'maker', title: 'Two turns', brief: 'Write a short note.' });
  await new Promise((resolve) => { const t = setInterval(() => { if (events.some((e) => e.type === 'update' && e.agent.step === 'First turn')) { clearInterval(t); resolve(); } }, 50); });
  mgr.setAllow(false);
  await new Promise((r) => setTimeout(r, 200)); // the worker has the message before the turn ends
  fs.writeFileSync(process.env.FAKE_CODEX_GO, '');
  end = await done;
  assert.equal(end.type, 'done', end.agent.reason);
  const runs = codexLog().filter((l) => l.argv).map((l) => l.argv);
  assert.equal(runs.length, 2, 'two codex turns');
  assert.equal(runs[0][runs[0].indexOf('--sandbox') + 1], 'workspace-write', 'the first turn could write');
  assert.equal(runs[1][runs[1].indexOf('--sandbox') + 1], 'read-only', 'after actions were turned off: read-only');
  assert.ok(!runs[1].some((x) => x.startsWith('sandbox_workspace_write.')), 'and nothing about writing');
  mgr.setAllow(true);
  delete process.env.FAKE_CODEX_GO;
}

// A model the account can't use: a clear failure that says what to do.
fs.rmSync(process.env.FAKE_CODEX_LOG);
model = 'gpt-nope';
done = ended();
await mgr.start({ type: 'maker', title: 'Another note', brief: 'Write another note.' });
end = await done;
assert.equal(end.type, 'fail');
assert.match(end.agent.reason, /Codex can't use the model gpt-nope on this account/);
assert.match(end.agent.reason, /Subagents page/);

// Stop: a long run ends as stopped, and the Codex process goes with it.
fs.rmSync(process.env.FAKE_CODEX_LOG);
model = 'gpt-slow';
done = ended();
const c = await mgr.start({ type: 'maker', title: 'Slow job', brief: 'Take your time.' });
await new Promise((resolve) => { const t = setInterval(() => { if (events.some((e) => e.type === 'update' && e.agent.step === 'Working for a long time')) { clearInterval(t); resolve(); } }, 50); });
const { pid } = codexLog()[0];
mgr.stop(c.id);
end = await done;
assert.equal(end.type, 'gone');
assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, '.agent.json'), 'utf8')).state, 'stopped');
if (process.platform !== 'win32') {
  // TerminateProcess on Windows gives the worker no chance to take Codex down with it.
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(pid, 0), 'the Codex process ended with the agent');
}

// The engine's availability on the Subagents page: missing, signed out, ready.
assert.deepEqual(await probeCodex({ bin: path.join(tmp, 'no-codex-here') }), { ok: false, reason: 'Codex CLI not found. Install it: npm i -g @openai/codex' });
process.env.FAKE_CODEX_SIGNED_OUT = '1';
assert.deepEqual(await probeCodex({ bin: process.execPath, args: [fake] }), { ok: false, reason: 'Codex is signed out. Run codex login in a terminal.' });
delete process.env.FAKE_CODEX_SIGNED_OUT;
// Ready: the models offered are the ones this account's catalog lists (codex debug models, visibility "list"), in
// its order; hidden ones aren't offered.
const ready = await probeCodex({ bin: process.execPath, args: [fake] });
assert.deepEqual(ready, { ok: true, version: '0.155.1', models: [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }, { id: 'gpt-5.5', name: 'GPT-5.5' }] });
assert.deepEqual(codexModels(ready), ready.models);
// No catalog from this Codex: the built-in list, which leaves out gpt-5.5 (not on every account).
process.env.FAKE_CODEX_NO_MODELS = '1';
const plain = await probeCodex({ bin: process.execPath, args: [fake] });
delete process.env.FAKE_CODEX_NO_MODELS;
assert.deepEqual(plain, { ok: true, version: '0.155.1' });
assert.equal(codexModels(plain), CODEX_MODELS);
assert.ok(!CODEX_MODELS.some((m) => m.id === 'gpt-5.5'), 'gpt-5.5 is not offered by default');

// sidekick.mjs runs at import, so it is read as text: the check runs once at startup too, not only when the panel
// opens, so a crew slot set to Codex still runs after a restart.
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
assert.match(side, /^refreshCodex\(\);/m, 'Codex is checked at startup');

mgr.stopAll();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('codex run tests: passed');
