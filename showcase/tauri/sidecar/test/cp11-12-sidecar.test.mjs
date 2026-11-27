// CP-11 / CP-12, sidecar side: the real sidekick.mjs spawned with a temp HOME and data dir, driven over its stdin
// line protocol with the setup guide's ob_* messages. No network, no keychain (JARVIS_DATA_DIR puts keys in a test
// file store, sign-in keys go to the temp ~/.gg/auth.json), no real keys. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDEKICK = fileURLToPath(new URL('../sidekick.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-setup-'));
const data = path.join(home, 'data');

function start() {
  const env = { ...process.env, HOME: home, USERPROFILE: home, JARVIS_DATA_DIR: data };
  for (const k of Object.keys(env)) if (/_API_KEY$|^JARVIS_HANDS$|^JARVIS_AGENT$/.test(k)) delete env[k];
  const child = spawn(process.execPath, [SIDEKICK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], waiters = [];
  let buf = '', raw = '', err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    raw += d; buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      out.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    }
  });
  return {
    out,
    get raw() { return raw; },
    get err() { return err; },
    send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`),
    // Resolves with the first message (already seen after `from`, or still to come) that matches.
    next(pred, what, from = out.length, ms = 15000) {
      const seen = out.slice(from).find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}\nstderr:\n${err.slice(-2000)}`)), ms);
        waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
      });
    },
    async stop() { child.stdin.end(); child.kill(); await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r))); },
  };
}
const isState = (m) => m.type === 'onboard' && m.msg?.kind === 'state';
const config = () => JSON.parse(fs.readFileSync(path.join(data, 'Jarvis', 'Data', 'settings.json'), 'utf8'));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
// Polls settings.json until `pred` holds (saves can be debounced; a fixed sleep is flaky on a slow CI runner).
async function saved(pred, what) {
  for (let i = 0; i < 200; i++) { try { if (pred(config())) return config(); } catch {} await settle(50); }
  assert.fail(`${what}: settings.json is ${fs.existsSync(path.join(data, 'Jarvis', 'Data', 'settings.json')) ? JSON.stringify(config()) : 'missing'}`);
}
async function hello(s) { const from = s.out.length; s.send({ type: 'ob_hello' }); return (await s.next(isState, 'ob_hello state', from)).msg; }

const FAKE_KEY = 'sk-cp12-FAKE-0123456789abcdef';
try {
  // CP-11 happy path: first run opens setup at step 0 in Classic, a step is saved and a restart resumes there,
  // the Classic/Live pick is saved as voiceMode, and finishing marks it onboarded so the next start skips setup.
  {
    const s = start();
    await s.next((m) => m.type === 'onboarding', 'CP-11: a fresh install opens setup');
    const st = await hello(s);
    assert.equal(st.step, 0, 'CP-11: setup starts at step 0');
    assert.equal(st.voiceMode, 'classic', 'CP-11: Classic until Live is picked');
    s.send({ type: 'ob_step', step: 3 });
    s.send({ type: 'ob_voicemode', mode: 'live' });
    const live = await s.next((m) => isState(m) && m.msg.voiceMode === 'live', 'CP-11: Live pick echoed in state');
    assert.equal(live.msg.voiceMode, 'live');
    await saved((c) => c.onboardStep === 3 && c.voiceMode === 'live', 'CP-11: the step and the Live pick are saved as onboardStep and voiceMode');
    await s.stop();

    const again = start();
    await again.next((m) => m.type === 'onboarding', 'CP-11: setup reopens while unfinished');
    const back = await hello(again);
    assert.equal(back.step, 3, 'CP-11: a restart resumes at onboardStep');
    assert.equal(back.voiceMode, 'live', 'CP-11: the Live pick survives a restart');
    again.send({ type: 'ob_voicemode', mode: 'classic' });
    await again.next((m) => isState(m) && m.msg.voiceMode === 'classic', 'CP-11: back to Classic');
    again.send({ type: 'ob_done' });
    const c = await saved((x) => x.onboarded === true, 'CP-11: finishing sets onboarded');
    assert.equal(c.onboarded, true, 'CP-11: finishing sets onboarded');
    assert.equal(c.onboardStep, 0, 'CP-11: and resets the step');
    assert.ok(c.setupVersion >= 1, 'CP-11: and records the setup version');
    assert.equal(c.voiceMode, 'classic');
    await again.stop();

    const done = start();
    await done.next((m) => m.type === 'menu', 'CP-11: a finished install still starts');
    await settle(800);
    assert.ok(!done.out.some((m) => m.type === 'onboarding'), 'CP-11: a finished install does not reopen setup');
    await done.stop();
  }

  // CP-11 failure path: out-of-range or junk steps and modes are clamped or ignored, never saved as is.
  {
    const s = start();
    await hello(s);
    s.send({ type: 'ob_step', step: 99 });
    await saved((c) => c.onboardStep === 9, 'CP-11: a step past the end is clamped to the last one (Find me, step 9 of 0-9)');
    s.send({ type: 'ob_step', step: -4 });
    await saved((c) => c.onboardStep === 0, 'CP-11: a negative step is clamped to 0');
    s.send({ type: 'ob_step', step: 5 });
    await saved((c) => c.onboardStep === 5, 'CP-11: a normal step is saved');
    // From 5, so a junk step that was ignored (left at 5) or saved as is would fail here.
    s.send({ type: 'ob_step', step: 'drop table' });
    await saved((c) => c.onboardStep === 0, 'CP-11: a junk step reads as 0');
    s.send({ type: 'ob_voicemode', mode: 'telepathy' }); await settle();
    assert.equal((await hello(s)).voiceMode, 'classic', 'CP-11: an unknown voice mode is ignored');
    assert.notEqual(config().voiceMode, 'telepathy');
    await s.stop();
  }

  // CP-12 happy path: a pasted AI key is saved to the key store (auth.json), the provider shows as connected,
  // and the key itself never appears in what the sidecar prints, its logs or its config.
  {
    const s = start();
    const st = await hello(s);
    const card = st.apikey.find((p) => p.id === 'anthropic');
    assert.ok(card && !card.connected, 'CP-12: Anthropic has a key card, not connected yet');
    const from = s.out.length;
    s.send({ type: 'ob_apikey', provider: 'anthropic', key: `  ${FAKE_KEY}  ` });
    const done = await s.next((m) => m.type === 'onboard' && m.msg?.kind === 'login', 'CP-12: key login result', from);
    assert.equal(done.msg.phase, 'done', `CP-12: a good key is accepted (${done.msg.error ?? ''})`);
    assert.equal(done.msg.provider, 'anthropic');
    const after = await s.next((m) => isState(m) && m.msg.apikey.find((p) => p.id === 'anthropic')?.connected, 'CP-12: connected in state', from);
    assert.ok(after.msg.apikey.find((p) => p.id === 'anthropic').connected, 'CP-12: the provider shows as connected');
    await settle();
    const authFile = path.join(home, '.gg', 'auth.json');
    const stored = fs.readFileSync(authFile, 'utf8');
    assert.ok(stored.includes(FAKE_KEY), 'CP-12: the key is in the key store');
    assert.ok(!stored.includes(`  ${FAKE_KEY}`), 'CP-12: trimmed before saving');
    if (process.platform !== 'win32') assert.equal(fs.statSync(authFile).mode & 0o077, 0, 'CP-12: the key store is owner-only');
    s.send({ type: 'ob_closed' }); await settle();
    await s.stop();

    const again = start();
    const back = await hello(again);
    assert.ok(back.apikey.find((p) => p.id === 'anthropic').connected, 'CP-12: still connected after a restart');
    await again.stop();

    const leaks = [['stdout', s.raw], ['stderr', s.err], ['restart stdout', again.raw], ['restart stderr', again.err]];
    const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
    for (const f of walk(data)) leaks.push([path.relative(home, f), fs.readFileSync(f, 'latin1')]);
    for (const [where, text] of leaks) assert.ok(!text.includes(FAKE_KEY), `CP-12: no key in ${where}`);
  }

  // CP-12 failure path: an empty key saves nothing, and a voice key that can't be one is refused before any
  // check or save, with a fix-it message and nothing written to the key store or printed.
  {
    const s = start();
    await hello(s);
    const before = fs.readFileSync(path.join(home, '.gg', 'auth.json'), 'utf8');
    s.send({ type: 'ob_apikey', provider: 'openai', key: '   ' }); await settle(500);
    assert.equal(fs.readFileSync(path.join(home, '.gg', 'auth.json'), 'utf8'), before, 'CP-12: a blank key saves nothing');
    const BAD = 'bad key with spaces';
    const from = s.out.length;
    s.send({ type: 'ob_geminikey', key: BAD });
    const said = await s.next((m) => m.type === 'onboard' && m.msg?.kind === 'fish' && m.msg.ok === false, 'CP-12: bad voice key refused', from);
    assert.match(said.msg.error, /doesn't look like a Gemini key/, 'CP-12: a malformed key gets a fix-it message');
    await settle();
    const secretsFile = path.join(data, 'Jarvis', 'Data', 'test-secrets.json');
    assert.ok(!fs.existsSync(secretsFile) || !fs.readFileSync(secretsFile, 'utf8').includes(BAD), 'CP-12: a refused key is not stored');
    assert.ok(!(await hello(s)).geminiKey, 'CP-12: Gemini voice stays without a key');
    await s.stop();
    assert.ok(!s.raw.includes(BAD) && !s.err.includes(BAD), 'CP-12: a refused key is not printed either');
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('cp11-12-sidecar: CP-11 onboarding flow and CP-12 pasted keys ok');
