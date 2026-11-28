// The overlay's click-through (showcase/jarvis/host.js): a button that appears under a cursor that isn't moving takes
// the click without the mouse having to move first. Regression: "Don't install" needed three presses while the
// reply was still being spoken. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const noop = () => {};
const calls = [], timers = [];
const el = () => new Proxy({ style: {}, setAttribute: noop, addEventListener: noop, focus: noop }, { get: (t, k) => (k in t ? t[k] : noop) });
let over = false; // whether the page has something clickable under the cursor
const window = {
  __TAURI__: { core: { invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(true); } } },
  Jarvis: { ptr: () => over },
};
const ctx = {
  window, Jarvis: window.Jarvis, navigator: { platform: 'MacIntel' }, performance, Math, JSON, Promise, Set, Map, Array, Object, String, Number, RegExp, Date,
  document: { createElement: el, addEventListener: noop, body: el(), hidden: false },
  addEventListener: noop, setTimeout: noop, clearTimeout: noop, clearInterval: noop, setInterval: (f, ms) => { timers.push([f, ms]); return timers.length; },
  matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: noop, innerWidth: 1512, innerHeight: 982,
};
vm.runInNewContext(fs.readFileSync(new URL('../../../jarvis/host.js', import.meta.url), 'utf8'), ctx);
const hot = () => calls.filter(([c]) => c === 'set_hot').map(([, a]) => a.hot);
const tick = () => timers.filter(([, ms]) => ms <= 200).forEach(([f]) => f());

window.__jarvisPtr(700, 120, 0);
assert.deepEqual(hot(), [false], 'nothing there: clicks go through');
over = true; // the Allow buttons grow into place under the resting cursor; the shell sends nothing new
tick();
assert.deepEqual(hot(), [false, true], 'the next check makes the window take the click');
tick();
assert.deepEqual(hot(), [false, true], 'no repeat while nothing changes');
over = false; tick();
assert.deepEqual(hot(), [false, true, false], 'and lets clicks through again once it has gone');
console.log('host click-through tests: passed');

// Regression (#108): hiding Jarvis (the summon keys) while it was talking left the voice going.
{
  let hidden = 0, hushed = 0, talking = true;
  const agent = { visible: true, hide: () => { hidden++; agent.visible = false; }, show: () => false, act: noop };
  window.Jarvis.tiles = [{ creature: { agent } }];
  window.Jarvis.voiceOut = { playing: () => talking, stop: () => { hushed++; talking = false; } };
  calls.length = 0;
  window.__jarvisHost({ kind: 'summon' });
  assert.equal(hidden, 1);
  assert.equal(hushed, 1, 'the voice stops');
  assert.ok(calls.some(([c, a]) => c === 'sidecar_send' && a.msg.type === 'menu' && a.msg.id === 'stop'), 'the answer stops too');
  // Not talking: hiding sends no stop.
  agent.visible = true; calls.length = 0;
  window.__jarvisHost({ kind: 'summon' });
  assert.ok(!calls.some(([c, a]) => c === 'sidecar_send' && a.msg.id === 'stop'));
  console.log('host hide-stops-voice tests: passed');
}

// Regression (Linux Wayland): while acting in another app (handsBusy), the overlay must clear its input shape to []
// so the hopping Sidekick creature never intercepts ydotool clicks on the target button.
{
  const lCalls = [], lTimers = [];
  const hand = { begin: noop, at: noop, end: noop };
  const lAgent = { visible: true, hide: noop, show: () => false, act: noop, setAuto: noop, hand };
  const lWin = {
    __TAURI__: { core: { invoke: (cmd, args) => { lCalls.push([cmd, args]); return Promise.resolve(true); } } },
    YOMNA_LINUX: 'wayland',
    Jarvis: {
      ptr: () => false,
      hitTest: () => true,
      hitBox: () => [200, 300, 120, 120],
      hitRects: () => [200, 300, 120, 120],
      tiles: [{ creature: { agent: lAgent } }],
    },
  };
  const lCtx = {
    window: lWin, Jarvis: lWin.Jarvis, navigator: { platform: 'Linux x86_64' }, performance, Math, JSON, Promise, Set, Map, Array, Object, String, Number, RegExp, Date,
    document: { createElement: el, addEventListener: noop, body: el(), hidden: false },
    addEventListener: noop, setTimeout: noop, clearTimeout: noop, clearInterval: noop, setInterval: (f, ms) => { lTimers.push([f, ms]); return lTimers.length; },
    matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: noop, innerWidth: 1536, innerHeight: 864,
  };
  vm.runInNewContext(fs.readFileSync(new URL('../../../jarvis/host.js', import.meta.url), 'utf8'), lCtx);
  const hitCalls = () => lCalls.filter(([c]) => c === 'set_hit_rects').map(([, a]) => Array.from(a.rects));
  const lTick = () => lTimers.filter(([, ms]) => ms <= 200).forEach(([f]) => f());

  lTick();
  assert.deepEqual(hitCalls().at(-1), [200, 300, 120, 120], 'idle overlay advertises its hit rect');

  lWin.__jarvisHost({ kind: 'hands', on: true });
  assert.deepEqual(hitCalls().at(-1), [], 'hands on: input shape clears immediately so clicks pass through');

  lWin.__jarvisHost({ kind: 'hands', step: { bounds: [240, 340, 40, 24] } });
  lTick();
  assert.deepEqual(hitCalls().at(-1), [], 'while stepping, the hopping creature stays 100% click-through');

  lWin.__jarvisHost({ kind: 'hands', on: false });
  assert.deepEqual(hitCalls().at(-1), [200, 300, 120, 120], 'hands off: overlay restores its hit rect');
  console.log('host linux hands click-through tests: passed');
}
