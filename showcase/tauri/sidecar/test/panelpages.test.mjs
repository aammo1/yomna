// The panel's pages: every sidebar button has its pane and its render function, the About page is gone (nothing
// links to it, and an old request for it opens Home), and the Second brain page is there. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const html = read('../../../panel/index.html'), js = read('../../../panel/panel.js');
const navPages = [...html.matchAll(/data-page="([a-z]+)"/g)].map((x) => x[1]);
const panes = [...html.matchAll(/id="pane-([a-z]+)"/g)].map((x) => x[1]);
const PANES = js.match(/const PANES = \{([^}]+)\}/)[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
assert.deepEqual(navPages, panes, 'a pane per sidebar button, in order');
assert.deepEqual(PANES, navPages, 'a render function per page, in order');
assert.ok(navPages.includes('secondbrain') && /function secondBrainPage\(\)/.test(js), 'the Second brain page');
assert.match(html, />Second brain</);

// About: no button, pane, render code or link left.
assert.ok(!navPages.includes('about') && !/nav-about|pane-about/.test(html));
assert.ok(!/aboutPage|function maker|const KEN\b|show\('about'/.test(js), 'no About render code');
for (const f of ['../sidekick.mjs', '../../src-tauri/src/main.rs', '../../../jarvis/host.js', '../../../onboarding/onboarding.js']) {
  let t = ''; try { t = read(f); } catch { continue; }
  assert.ok(!/openPanel\('about'\)|tab: 'about'|"about"\)|page=about/.test(t), `${f} opens no About page`);
}
// Its help links moved to General, and the manual says so.
assert.match(js, /group\('Help', null, null,[^]*Save diagnostics/);
const { aboutJarvis } = await import('../about.mjs');
const man = aboutJarvis({ name: 'R', looks: ['A', 'B'], mac: true, linux: false, snap: true, pointer: true, voice: true, hotkeys: true, wake: true });
assert.ok(!/and About \(|in About/.test(man), 'the manual has no About page');
assert.match(man, /Second brain \(/);

// A request for a page that's gone (an old 'about') falls back to Home instead of throwing: run show()'s guard.
const guard = js.match(/if \(!PANES\[name\]\) name = [^;]+;/)[0];
const show = vm.runInNewContext(`(name) => { ${guard} return name; }`, { PANES: Object.fromEntries(PANES.map((k) => [k, 1])) });
assert.equal(show('about'), 'home');
assert.equal(show('settings'), 'model');
assert.equal(show('secondbrain'), 'secondbrain');
console.log('panel pages tests: passed');
