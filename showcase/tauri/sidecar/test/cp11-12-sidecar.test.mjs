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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yomna-setup-'));
const data = path.join(home, 'data');

function start() {
  const env = { ...process.env, HOME: home, USERPROFILE: home, YOMNA_DATA_DIR: data };
  for (const k of Object.keys(env)) if (/_API_KEY$|^YOMNA_HANDS$|^YOMNA_AGENT$|^JARVIS_HANDS$|^JARVIS_AGENT$/.test(k)) delete env[k];
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
const config = () => JSON.parse(fs.readFileSync(path.join(data, 'Yomna', 'Data', 'settings.json'), 'utf8'));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
// Polls settings.json until `pred` holds (saves can be debounced; a fixed sleep is flaky on a slow CI runner).
async function saved(pred, what) {
  for (let i = 0; i < 200; i++) { try { if (pred(config())) return config(); } catch {} await settle(50); }
  assert.fail(`${what}: settings.json is ${fs.existsSync(path.join(data, 'Yomna', 'Data', 'settings.json')) ? JSON.stringify(config()) : 'missing'}`);
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

  // CP-12 happy path: harness selection is saved in settings.json and survives restart; custom harness args persist.
  {
    const s = start();
    const st = await hello(s);
    assert.ok(Array.isArray(st.harnesses) && st.harnesses.length >= 4, 'CP-12: harnesses catalog reported in obState');
    s.send({ type: 'set_harness', harness: 'opencode' });
    const sw = await s.next((m) => isState(m) && m.msg.harness === 'opencode', 'CP-12: harness switched to opencode');
    assert.equal(sw.msg.harness, 'opencode');
    await saved((c) => c.harness === 'opencode', 'CP-12: harness persisted to settings.json');
    await s.stop();

    const again = start();
    const back = await hello(again);
    assert.equal(back.harness, 'opencode', 'CP-12: harness persists across restart');
    await again.stop();
  }

  // CP-12 failure path: a malformed Gemini voice key is refused before any check or save, and never written or printed.
  {
    const s = start();
    await hello(s);
    const BAD = 'bad key with spaces';
    const from = s.out.length;
    s.send({ type: 'ob_geminikey', key: BAD });
    const said = await s.next((m) => m.type === 'onboard' && m.msg?.kind === 'gemini' && m.msg.ok === false, 'CP-12: bad voice key refused', from);
    assert.match(said.msg.error, /doesn't look like a Gemini key/, 'CP-12: a malformed key gets a fix-it message');
    await settle();
    const secretsFile = path.join(data, 'Yomna', 'Data', 'test-secrets.json');
    assert.ok(!fs.existsSync(secretsFile) || !fs.readFileSync(secretsFile, 'utf8').includes(BAD), 'CP-12: a refused key is not stored');
    assert.ok(!(await hello(s)).geminiKey, 'CP-12: Gemini voice stays without a key');
    await s.stop();
    assert.ok(!s.raw.includes(BAD) && !s.err.includes(BAD), 'CP-12: a refused key is not printed either');
  }

  // Menu sendMenu(id, value) actions, switch_harness, and liveVoice in panelState / livevoice:<id>.
  {
    const s = start();
    await s.next((m) => m.type === 'menu', 'menu actions: sidekick ready');
    s.send({ type: 'panel_open' });
    const initPanel = await s.next((m) => m.type === 'panel' && m.msg?.kind === 'state', 'menu actions: initial panel state');
    assert.ok(typeof initPanel.msg.state.liveVoice === 'string' && initPanel.msg.state.liveVoice.length > 0, 'panelState includes liveVoice');

    s.send({ type: 'menu', id: 'set_harness', value: 'claude' });
    await saved((c) => c.harness === 'claude', 'menu set_harness persists harness');

    s.send({ type: 'menu', id: 'set_custom_harness', value: { command: 'my-acp', args: ['--stdio'], protocol: 'acp' } });
    await saved((c) => c.harness === 'custom' && c.customHarness?.command === 'my-acp', 'menu set_custom_harness persists custom harness');

    s.send({ type: 'menu', id: 'set_allow_actions', value: true });
    await saved((c) => c.allowActions === true, 'menu set_allow_actions persists allowActions');

    s.send({ type: 'menu', id: 'set_tts', value: 'edge' });
    await saved((c) => c.tts === 'edge', 'menu set_tts persists tts');

    s.send({ type: 'menu', id: 'set_edge_tts_voice', value: 'ar-MA-JamalNeural' });
    await saved((c) => c.edgeTtsVoice === 'ar-MA-JamalNeural', 'menu set_edge_tts_voice persists edgeTtsVoice');

    s.send({ type: 'menu', id: 'set_voice_mode', value: 'live' });
    await saved((c) => c.voiceMode === 'live', 'menu set_voice_mode persists voiceMode');

    s.send({ type: 'menu', id: 'livevoice:Puck' });
    await saved((c) => c.liveVoice === 'Puck', 'menu livevoice:Puck persists liveVoice');
    const lvFrom = s.out.length;
    s.send({ type: 'menu', id: 'livevoice:Charon' });
    await saved((c) => c.liveVoice === 'Charon', 'menu livevoice:Charon persists liveVoice');
    const afterVoice = await s.next((m) => m.type === 'panel' && m.msg?.kind === 'state' && m.msg.state.liveVoice === 'Charon', 'panel state reports liveVoice Charon', lvFrom);
    assert.equal(afterVoice.msg.state.liveVoice, 'Charon');

    const badKeyFrom = s.out.length;
    s.send({ type: 'menu', id: 'set_gemini_key', value: 'bad key with spaces' });
    const badNote = await s.next((m) => m.type === 'panel' && m.msg?.kind === 'note' && m.msg.bad === true, 'menu set_gemini_key routes to voiceKeyLogin', badKeyFrom);
    assert.match(badNote.msg.text, /doesn't look like a Gemini key/);

    const swFrom = s.out.length;
    s.send({ type: 'menu', id: 'switch_harness' });
    await s.next((m) => m.type === 'panel_show', 'menu switch_harness without value opens panel', swFrom);
    const tabState = await s.next((m) => m.type === 'panel' && m.msg?.kind === 'state' && m.msg.state.tab === 'harness', 'menu switch_harness opens harness tab', swFrom);
    assert.equal(tabState.msg.state.tab, 'harness');

    s.send({ type: 'menu', id: 'switch_harness', value: 'opencode' });
    await saved((c) => c.harness === 'opencode', 'menu switch_harness with value switches harness');

    await s.stop();
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('cp11-12-sidecar: CP-11 onboarding flow and CP-12 pasted keys ok');
