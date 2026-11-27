// CP-13 Connect providers: Claude sign-in through Claude Code (faked CLI, test/cp13-fakeclaude.mjs), the ChatGPT
// sign-in's saved credentials, and a crew slot set to "codex:<model>" routing a subagent to Codex headless
// (test/fakecodex.mjs). sidekick.mjs runs at import, so its glue (OAUTH, crewRunnable, agentModel's Codex branch) is
// mirrored here and pinned to its source text. No network, OAuth, real CLI or browser. Run: npm test
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cp13-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.JARVIS_DATA_DIR = path.join(tmp, 'data');
process.env.FAKE_CODEX_LOG = path.join(tmp, 'codex.log');
process.env.FAKE_CLAUDE_STATE = path.join(tmp, 'claude-signed-in');
delete process.env.JARVIS_FAKE_AGENT; delete process.env.FAKE_CODEX_SIGNED_OUT; delete process.env.FAKE_CLAUDE_MODE;
const fakeClaude = fileURLToPath(new URL('./cp13-fakeclaude.mjs', import.meta.url));
const fakeCodex = fileURLToPath(new URL('./fakecodex.mjs', import.meta.url));
const { OPENAI_CHATGPT_KEY, dualAuthProvider, signInWithClaudeCode } = await import('@kenkaiiii/gg-core');
const { openAuth, signInCards } = await import('../providers.mjs');
const { codexModels, probeCodex } = await import('../codex.mjs');
const { activeCrew, findSubagent } = await import('../subagents.mjs');
const { parseSpec } = await import('../route.mjs');
const { agentsRoot, createAgents } = await import('../agents.mjs');
const { checkOpen, checkRead, checkWrite } = await import('../safety.mjs');
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');

const store = path.join(tmp, 'gg', 'store.json');
const auth = openAuth(store);
const oauthOn = {};
const cards = () => signInCards(['anthropic', 'openai'], (id) => oauthOn[id]);
const refresh = async () => { // refreshAuthNow's sign-in check, sidekick.mjs
  oauthOn.anthropic = await auth.hasClaudeCodeLogin();
  oauthOn.openai = await auth.hasCredentials(dualAuthProvider('openai')?.oauthKey ?? 'openai');
};
assert.match(side, /p === 'anthropic' \? auth\.hasClaudeCodeLogin\(\) : auth\.hasCredentials\(dualAuthProvider\(p\)\?\.oauthKey \?\? p\)/, 'mirrors sidekick refreshAuthNow');
const claudeOpts = (signal) => ({ signal, binary: process.execPath, binaryArgs: [fakeClaude], home: path.join(tmp, 'cc'), browserWaitMs: 2_000 });
const callbacks = (log) => ({ onOpenUrl: (u) => log.push(['open', u]), onStatus: (m) => log.push(['status', m]), onPromptCode: async () => { log.push(['code']); return ''; } });

// ---- CP-13 Claude sign-in, happy: the CLI's login opens the browser on its localhost callback, then Claude is connected.
{
  await refresh();
  assert.deepEqual(cards().map((c) => [c.id, c.name, c.connected]), [['anthropic', 'Claude', false], ['openai', 'ChatGPT', false]]);
  const log = [];
  const status = await signInWithClaudeCode(auth, callbacks(log), claudeOpts(new AbortController().signal));
  assert.equal(status.loggedIn, true);
  const opened = log.filter(([k]) => k === 'open').map(([, u]) => u);
  assert.equal(opened.length, 1, 'the browser opens once');
  assert.match(opened[0], /redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback/, "it opens on the CLI's own localhost callback");
  assert.ok(!log.some(([k]) => k === 'code'), 'no paste prompt when the browser comes back by itself');
  assert.ok(log.some(([k, m]) => k === 'status' && /Opening Claude sign-in/.test(m)));
  await refresh();
  assert.equal(oauthOn.anthropic, true);
  assert.equal(await auth.hasProviderAuth('anthropic'), true, 'Claude counts as signed in, so its models can be picked');
  assert.equal(cards().find((c) => c.id === 'anthropic').connected, true);
  assert.ok(!fs.readFileSync(store, 'utf8').includes('Token'), 'Claude Code keeps the token: the store holds only the marker');
}

// ---- CP-13 Claude sign-in, failure: the CLI refuses, the error says why, and nothing is saved; a cancel stops it.
{
  await auth.clearClaudeCodeLogin(); fs.rmSync(process.env.FAKE_CLAUDE_STATE, { force: true });
  process.env.FAKE_CLAUDE_MODE = 'deny';
  await assert.rejects(signInWithClaudeCode(auth, callbacks([]), claudeOpts(new AbortController().signal)), /OAuth access was denied/);
  delete process.env.FAKE_CLAUDE_MODE;
  await refresh();
  assert.equal(oauthOn.anthropic, false);
  assert.equal(await auth.hasProviderAuth('anthropic'), false);
  const ac = new AbortController();
  const p = signInWithClaudeCode(auth, callbacks([]), claudeOpts(ac.signal));
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, /cancelled/i);
  assert.equal(await auth.hasClaudeCodeLogin(), false);
}

// ---- CP-13 ChatGPT sign-in, happy: what loginChatGPT returns is saved under the ChatGPT key (oauthLogin), the card
// shows connected and OpenAI is usable.
{
  assert.match(side, /if \(provider !== 'anthropic'\) await auth\.setCredentials\(dualAuthProvider\(provider\)\?\.oauthKey \?\? provider, creds\)/, 'mirrors sidekick oauthLogin');
  assert.equal(dualAuthProvider('openai').oauthKey, OPENAI_CHATGPT_KEY);
  await auth.setCredentials(OPENAI_CHATGPT_KEY, { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600_000 });
  await refresh();
  assert.equal(cards().find((c) => c.id === 'openai').connected, true);
  assert.equal(await auth.hasProviderAuth('openai'), true);
}

// ---- CP-13 ChatGPT, failure: an OpenAI API key alone is not the ChatGPT sign-in (the card stays off), and a ChatGPT
// sign-in never falls back to a pasted code (sidekick refuses onPromptCode for openai).
{
  const fresh = openAuth(path.join(tmp, 'gg2', 'store.json'));
  await fresh.setCredentials('openai', { accessToken: 'fake-key', refreshToken: '', expiresAt: Date.now() + 864e5 });
  assert.equal(await fresh.hasCredentials(OPENAI_CHATGPT_KEY), false, 'an API key does not light the ChatGPT sign-in card');
  assert.equal(signInCards(['openai'], () => false)[0].connected, false);
  assert.equal(await fresh.hasProviderAuth('openai'), true, 'the key still makes OpenAI usable');
  assert.match(side, /if \(provider === 'openai'\) throw new Error\("ChatGPT sign-in didn't come back from the browser\. Try again\."\)/);
}

// ---- CP-13 crew slot "codex:<model>" routes the subagent to Codex headless (fake codex binary), happy and failure.
const codex = { bin: process.execPath, args: [fakeCodex] };
// The Codex models a slot can run on are the ones the probe found on the account (codex debug models), as offered.
assert.match(side, /const crewRunnable = \(p, id\) => \(p === 'codex' \? codexState\.ok && codexModels\(codexState\)\.some\(\(m\) => m\.id === id\) : runnableSpec\(p, id\)\);/, 'mirrors sidekick crewRunnable');
assert.match(side, /codex: \{ \.\.\.codexState, models: codexModels\(codexState\) \}/, 'the Subagents page offers the same models');
const crewRunnable = (st) => (p, id) => (p === 'codex' ? st.ok && codexModels(st).some((m) => m.id === id) : false);
const crewCfg = { builder: 'codex:gpt-5.5', scout: 'codex:gpt-bogus' };
{
  const st = await probeCodex(codex);
  assert.equal(st.ok, true);
  const crew = activeCrew(crewCfg, crewRunnable(st));
  assert.deepEqual(crew.map((s) => [s.id, s.spec.spec, s.slot]), [['builder', 'codex:gpt-5.5', 'sub_builder']], 'a known Codex model joins the crew; an unknown one does not');

  const events = []; let onEnd = null;
  const modelCalls = [];
  const mgr = createAgents({
    fork, root: agentsRoot(), userName: 'Ken', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
    config: {
      // agentModel's Codex branch (sidekick.mjs): a crew pick on Codex runs on the Codex CLI, nothing else looked up.
      model: async (o) => { modelCalls.push(o); const g = parseSpec(o?.spec); if (g?.provider !== 'codex') throw new Error('not a codex pick'); return { provider: 'codex', model: g.model, route: 'codex', codex, budget: 400_000 }; },
      subagent: (name) => { const s = findSubagent(name, crew); return s ? { id: s.id, label: s.label, type: s.type, role: s.role, spec: s.spec.spec, slot: s.slot } : null; },
      creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {},
    },
    ui: ({ e }) => { events.push(e); if (['done', 'fail', 'gone'].includes(e.type)) onEnd?.(e); },
  });
  const ended = new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`no result: ${events.map((e) => e.type)}`)), 20_000); onEnd = (e) => { clearTimeout(t); resolve(e); }; });
  const a = await mgr.start({ subagent: 'builder', title: 'A note', brief: 'Write a short note.' });
  const end = await ended;
  assert.equal(end.type, 'done', end.agent.reason);
  assert.deepEqual(modelCalls, [{ spec: 'codex:gpt-5.5', slot: 'sub_builder' }], 'the crew slot picks the model');
  assert.equal(fs.readFileSync(path.join(a.dir, 'files', 'note.md'), 'utf8'), '# Hi\n');
  const log = fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log[0].argv.slice(0, 2), ['exec', '--json'], 'Codex runs headless');
  assert.equal(log[0].argv[log[0].argv.indexOf('-m') + 1], 'gpt-5.5');
  assert.match(log[1].input, /You are the Builder/, 'the Builder role goes in front of the brief');
  // A specialist whose Codex model isn't known isn't on the crew: asking for it is a clear error, nothing launched.
  await assert.rejects(mgr.start({ subagent: 'scout', title: 'Look', brief: 'Find it.' }), /There's no subagent "scout" on the crew/);
  mgr.stopAll();
}
{
  // Codex signed out: the slot is not runnable, so the crew is empty, and agentModel's Codex branch would refuse.
  process.env.FAKE_CODEX_SIGNED_OUT = '1';
  const st = await probeCodex(codex);
  delete process.env.FAKE_CODEX_SIGNED_OUT;
  assert.deepEqual(st, { ok: false, reason: 'Codex is signed out. Run codex login in a terminal.' });
  assert.deepEqual(activeCrew(crewCfg, crewRunnable(st)), []);
  assert.match(side, /if \(!codexState\.ok\) throw new Error\(`\$\{codexState\.reason\} \(Codex is picked for this subagent/);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('CP-13 provider tests: passed');
