// The setup guide's "Your second brain" step, sidecar side: the real sidekick.mjs spawned with a temp HOME and data
// dir, driven with ob_brain. The default choice makes ~/Desktop/<First> OS (folders and starter files), a second
// run only fills in what's missing and never writes over a file, an existing folder is reused, "Use an existing
// folder" saves the one chosen, and Skip saves nothing. No network, no real keys. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountNames, brainName } from '../secondbrain.mjs';

const SIDEKICK = fileURLToPath(new URL('../sidekick.mjs', import.meta.url));

function start(home) {
  const data = path.join(home, 'data');
  const env = { ...process.env, HOME: home, USERPROFILE: home, JARVIS_DATA_DIR: data };
  for (const k of Object.keys(env)) if (/_API_KEY$|^JARVIS_HANDS$|^JARVIS_AGENT$/.test(k)) delete env[k];
  const child = spawn(process.execPath, [SIDEKICK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], waiters = [];
  let buf = '', err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      out.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    }
  });
  const next = (pred, what, from = out.length, ms = 15000) => {
    const seen = out.slice(from).find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}\nstderr:\n${err.slice(-2000)}`)), ms);
      waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
    });
  };
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  return {
    send,
    config: () => JSON.parse(fs.readFileSync(path.join(data, 'Jarvis', 'Data', 'settings.json'), 'utf8')),
    async hello() { const from = out.length; send({ type: 'ob_hello' }); return (await next((m) => m.type === 'onboard' && m.msg?.kind === 'state', 'state', from)).msg; },
    // Sends one ob_brain and resolves with the guide's answer (kind 'brain').
    async brain(m) { const from = out.length; send({ type: 'ob_brain', ...m }); return (await next((x) => x.type === 'onboard' && x.msg?.kind === 'brain', 'brain reply', from)).msg; },
    async stop() { child.stdin.end(); child.kill(); await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r))); },
  };
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
async function saved(s, pred, what) {
  for (let i = 0; i < 200; i++) { try { if (pred(s.config())) return s.config(); } catch {} await settle(50); }
  assert.fail(`${what}: ${JSON.stringify((() => { try { return s.config(); } catch { return null; } })())}`);
}
// The default folder's name comes from this account (brainname.test.mjs has the cases): "EricTech OS" on Eric's Mac.
const NAME = brainName(accountNames({ user: os.userInfo().username }));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-brainsetup-')));
const homes = [];

try {
  // The default: a fresh home (no Desktop folder yet) gets ~/Desktop/<First> OS, made in full, and it's saved.
  {
    const home = tmp(); homes.push(home);
    const dir = path.join(home, 'Desktop', NAME);
    const s = start(home);
    const st = await s.hello();
    assert.equal(st.brain?.desktop, dir, 'the guide is told where the default one goes');
    assert.equal(st.brain.root, null, 'and that none is set yet');
    const r = await s.brain({ choice: 'desktop' });
    assert.equal(r.ok, true, `the default one is made (${r.error ?? ''})`);
    assert.equal(r.root, dir);
    for (const d of ['_raw', '_context', '_research', 'projects', '.agents/skills']) assert.ok(fs.statSync(path.join(dir, d)).isDirectory(), `${d}/ is made`);
    for (const f of ['AGENTS.md', '_context/index.md', '_context/source-map.md', 'projects/index.md']) assert.ok(fs.statSync(path.join(dir, f)).isFile(), `${f} is made`);
    const c = await saved(s, (x) => x.secondBrain?.root === dir, 'secondBrain.root is saved');
    assert.equal(c.secondBrain.context, path.join(dir, '_context'));
    assert.equal((await s.hello()).brain.root, dir, 'the guide now sees it as set');

    // Again (Back, then Continue): only what's missing is made, nothing is written over.
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Mine\n');
    fs.writeFileSync(path.join(dir, '_context', 'index.md'), '# My index\n');
    fs.writeFileSync(path.join(dir, '_raw', 'note.md'), 'keep me');
    fs.rmSync(path.join(dir, 'projects'), { recursive: true });
    const again = await s.brain({ choice: 'desktop' });
    assert.equal(again.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Mine\n', 'AGENTS.md is never written over');
    assert.equal(fs.readFileSync(path.join(dir, '_context', 'index.md'), 'utf8'), '# My index\n', 'nor the index');
    assert.equal(fs.readFileSync(path.join(dir, '_raw', 'note.md'), 'utf8'), 'keep me', 'their own files stay');
    assert.ok(fs.statSync(path.join(dir, 'projects', 'index.md')).isFile(), 'the missing projects/ is filled back in');
    assert.deepEqual(again.made.map((p) => path.relative(dir, p)).sort(), ['projects', path.join('projects', 'index.md')], 'and only that is made');
    const third = await s.brain({ choice: 'desktop' });
    assert.deepEqual(third.made, [], 'a third run makes nothing');
    await s.stop();
  }

  // One already on the Desktop, laid out its own way: it's reused, its folders found by name, and only
  // the missing pieces added (no _context beside its Wiki).
  {
    const home = tmp(); homes.push(home);
    const dir = path.join(home, 'Desktop', NAME);
    fs.mkdirSync(path.join(dir, 'Wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules\n');
    const s = start(home);
    await s.hello();
    const r = await s.brain({ choice: 'desktop' });
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.join(dir, '_context')), 'no second context folder beside its Wiki');
    assert.ok(fs.statSync(path.join(dir, 'Wiki', 'index.md')).isFile(), 'its Wiki gets the index');
    assert.ok(fs.statSync(path.join(dir, '_raw')).isDirectory(), 'and the missing folders are made');
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Rules\n', 'its own files are left alone');
    assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')), 'no AGENTS.md is added over its CLAUDE.md rules');
    const c = await saved(s, (x) => x.secondBrain?.root === dir, 'the reused one is saved');
    assert.equal(c.secondBrain.context, path.join(dir, 'Wiki'));
    await s.stop();
  }

  // Use an existing folder: the chosen one is checked and saved as is (nothing made in it); a bad one is refused.
  // Skip saves nothing.
  {
    const home = tmp(); homes.push(home);
    const notes = path.join(home, 'Documents', 'Notes');
    fs.mkdirSync(notes, { recursive: true });
    const s = start(home);
    await s.hello();
    const skip = await s.brain({ choice: 'skip' });
    assert.equal(skip.ok, true, 'Skip is fine');
    await settle();
    const before = (() => { try { return s.config().secondBrain ?? null; } catch { return null; } })(); // no settings.json yet is fine too
    assert.equal(before, null, 'Skip saves nothing');
    assert.ok(!fs.existsSync(path.join(home, 'Desktop', NAME)), 'and makes nothing');
    const bad = await s.brain({ choice: 'existing', root: os.tmpdir() });
    assert.equal(bad.ok, false, 'a folder outside the home folder is refused');
    assert.match(bad.error, /inside your home folder/);
    const none = await s.brain({ choice: 'existing', root: '' });
    assert.equal(none.ok, false, 'no folder chosen is refused');
    const r = await s.brain({ choice: 'existing', root: notes });
    assert.equal(r.ok, true);
    const c = await saved(s, (x) => x.secondBrain?.root === notes, 'the chosen folder is saved');
    assert.equal(c.secondBrain.raw, '', 'its locations are found in it at each chat');
    assert.deepEqual(fs.readdirSync(notes), [], 'nothing is made in a chosen folder');
    await s.stop();
  }

  // Running the guide again with a second brain already saved (from the menu's Setup entry, or after a re-prompt):
  // Continue on the same folder keeps the locations picked by hand on the Second brain page, even one outside the
  // root that can't be found again by name. Choosing a different folder starts that one fresh.
  {
    const home = tmp(); homes.push(home);
    const notes = path.join(home, 'Notes'), wiki = path.join(home, 'Documents', 'Wiki'), other = path.join(home, 'Other');
    for (const d of [notes, wiki, other]) fs.mkdirSync(d, { recursive: true });
    const settings = path.join(home, 'data', 'Jarvis', 'Data', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const layout = { root: notes, raw: '', context: wiki, research: '', projects: '', agents: '' };
    fs.writeFileSync(settings, JSON.stringify({ onboarded: true, secondBrain: layout }));
    const s = start(home);
    const st = await s.hello();
    assert.equal(st.brain.root, notes, 'the guide is told the saved root');
    const r = await s.brain({ choice: 'existing', root: st.brain.root });
    assert.equal(r.ok, true, `Continue on the saved folder is fine (${r.error ?? ''})`);
    await settle();
    assert.deepEqual(s.config().secondBrain, layout, 'the hand-picked locations are kept');
    const r2 = await s.brain({ choice: 'existing', root: other });
    assert.equal(r2.ok, true);
    const c = await saved(s, (x) => x.secondBrain?.root === other, 'the other folder is saved');
    assert.equal(c.secondBrain.context, '', 'a different folder starts fresh');
    await s.stop();
  }
} finally {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}
console.log('brainsetup-sidecar: default second brain on the Desktop ok');
