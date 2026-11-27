// The highlight keys (hold ⌃⌘ to circle part of the screen, macOS): the real sidekick.mjs spawned with a temp HOME
// and data dir, driven over its stdin line protocol. The keybinds it sends the shell carry the highlight pair, which
// is never the talk or type-to-ask pair, and the panel's Shortcuts page shows it. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDEKICK = fileURLToPath(new URL('../sidekick.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-highlight-'));
const MAC = process.platform === 'darwin';

function start() {
  const env = { ...process.env, HOME: home, USERPROFILE: home, JARVIS_DATA_DIR: path.join(home, 'data') };
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
  return {
    out,
    send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`),
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
const isKeys = (m) => m.type === 'keybinds';
const isPanel = (m) => m.type === 'panel' && m.msg?.kind === 'state';

// The system prompt (template literals in sidekick.mjs, read as text): circling is described with the highlight keys
// on the Mac, not the talk keys, in the Shortcuts line, the picture line and the Live call's Voice line.
{
  const src = fs.readFileSync(SIDEKICK, 'utf8');
  const how = src.slice(src.indexOf('const circleHow = '), src.indexOf('\n', src.indexOf('const circleHow = ')));
  assert.match(how, /MAC \? \(keys\(\)\.highlight \? `while holding \$\{highlightWords\(\)\}, moving the cursor round something/, 'the Mac names the highlight keys');
  assert.match(how, /while holding the talk keys/, 'Windows still circles with its talk keys');
  assert.match(src, /\$\{CIRCLE_OK \? `; \$\{circleHow\(\)\}` : ''\}/, 'the Shortcuts line uses it');
  assert.match(src, /marked by circling it with the \$\{MAC \? 'highlight' : 'talk'\} keys while talking \(teal pen strokes\)/);
  assert.match(src.slice(src.indexOf('const LIVE_VOICE_LINE = ')), /^[^\n]*\$\{MAC && keys\(\)\.highlight \? `; holding \$\{highlightWords\(\)\} and circling something shows it to you` : ''\}/);
  assert.doesNotMatch(src, /while holding the talk keys, moving the cursor round something circles it[^\n]*" : ''\}/, 'no fixed talk-keys line left');
}

const s = start();
try {
  const first = await s.next(isKeys, 'the keybinds sent at start');
  assert.deepEqual(first.talk, ['control', 'option'], 'talk stays ⌃⌥');
  if (MAC) assert.deepEqual(first.highlight, ['control', 'command'], 'the keybinds carry the highlight pair: ⌃⌘ by default');
  else assert.equal(first.highlight ?? null, null, 'no highlight keys off the Mac yet');

  if (MAC) {
    // Type-to-ask moved onto ⌃⌘: highlight steps aside to ⌥⇧, and the panel says so.
    let from = s.out.length;
    s.send({ type: 'set_keys', write: ['control', 'command'] });
    const moved = await s.next((m) => isKeys(m) && m.write?.includes('command') && m.write?.includes('control'), 'keybinds after the clash', from);
    assert.deepEqual(moved.highlight, ['option', 'shift'], 'a clash with type-to-ask falls back to ⌥⇧');
    from = s.out.length;
    s.send({ type: 'panel_open' });
    const page = await s.next(isPanel, 'the panel state', from);
    const h = page.msg.state.shortcuts.highlight;
    assert.equal(h.value, 'option+shift');
    assert.match(h.note, /Control\+Command/, 'the panel says why it moved');

    // Talk onto ⌥⇧ too: no pair is left, so highlight is off, and the panel says that.
    from = s.out.length;
    s.send({ type: 'set_keys', talk: ['option', 'shift'] });
    const off = await s.next((m) => isKeys(m) && m.talk?.includes('shift'), 'keybinds with highlight off', from);
    assert.equal(off.highlight, null, 'both fallbacks taken: highlight is off');
    from = s.out.length;
    s.send({ type: 'panel_open' });
    const page2 = await s.next(isPanel, 'the panel state', from);
    assert.equal(page2.msg.state.shortcuts.highlight.value, null);
    assert.match(page2.msg.state.shortcuts.highlight.note, /off/i);

    // Type-to-ask back on ⌥⌘ and talk on ⌃⌥: highlight comes back to ⌃⌘ (the fallback was never saved over it).
    from = s.out.length;
    s.send({ type: 'set_keys', talk: ['control', 'option'], write: ['option', 'command'] });
    const back = await s.next((m) => isKeys(m) && m.talk?.includes('control') && m.write?.includes('option'), 'keybinds back to the defaults', from);
    assert.deepEqual(back.highlight, ['control', 'command'], 'highlight is ⌃⌘ again');
  }
  console.log('highlight tests: passed');
} finally { await s.stop(); }
