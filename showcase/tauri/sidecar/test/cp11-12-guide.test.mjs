// CP-11 / CP-12, setup guide side: the real onboarding/index.html + onboarding.js run in a linkedom DOM inside
// node:vm, with a fake Tauri invoke that records every message the guide sends the sidecar, and the sidecar's
// replies played back through window.__onboard. No browser, no app, no network, no real keys. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const ROOT = new URL('../../../onboarding/', import.meta.url);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// One guide, as opened by the app on a Mac with every permission already allowed. pick: the folder the system's
// folder dialog returns; brainAuto: the sidecar answers each ob_brain with ok (false: the test answers itself).
function openGuide({ pick = null, brainAuto = true } = {}) {
  const html = fs.readFileSync(new URL('index.html', ROOT), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const w = parseHTML(html);
  // Jarvis (the Sidekick's drawing kit) and the canvas: anything they're asked for is a harmless no-op.
  const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : noop), apply: () => noop, construct: () => noop });
  const sent = [], calls = [], logs = [];
  const capture = (...a) => logs.push(a.map(String).join(' '));
  const globals = {
    matchMedia: () => ({ matches: true, addEventListener() {} }), innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, Jarvis: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance, Date, Math, JSON, Promise, Map, Set, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
    location: { search: '' }, navigator: { platform: 'MacIntel', userAgent: 'Macintosh' },
    console: { log: capture, info: capture, warn: capture, error: capture, debug: capture },
    __TAURI__: { core: { invoke: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'sidecar_send') sent.push(JSON.parse(JSON.stringify(args.msg))); // out of the vm realm, so deepEqual compares plain objects
      if (cmd === 'perm_status') return { type: 'perms', mic: 'granted', speech: 'granted', screen: 'granted', accessibility: 'granted' };
      if (cmd === 'screen_check') return { seen: true };
      if (cmd === 'pick_folder') return pick;
      if (cmd === 'sidecar_send' && args.msg.type === 'ob_brain' && brainAuto) setTimeout(() => page.__onboard({ kind: 'brain', ok: true, choice: args.msg.choice }), 0);
      return undefined;
    } } },
  };
  // The page's own global (linkedom's window writes through to Node's globalThis, so it is not used as one).
  const page = { ...globals, document: w.document };
  for (const k of ['Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'HTMLElement', 'getComputedStyle']) if (k in w.window) page[k] = w.window[k];
  page.window = page; page.self = page;
  page.addEventListener = () => {}; page.removeEventListener = () => {};
  w.window.HTMLCanvasElement.prototype.getContext = () => noop;
  w.window.HTMLElement.prototype.focus = function () {};
  // linkedom's <select>.value has no setter: pick the matching option, as a browser does.
  Object.defineProperty(w.window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { return (this.querySelector('option[selected]') ?? this.querySelector('option'))?.getAttribute('value') ?? ''; },
    set(v) { for (const o of this.querySelectorAll('option')) o.toggleAttribute('selected', o.getAttribute('value') === String(v)); } });
  w.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10 });
  vm.runInContext(fs.readFileSync(new URL('onboarding.js', ROOT), 'utf8'), vm.createContext(page));
  const $ = (id) => w.document.getElementById(id);
  return {
    sent, calls, logs, $, doc: w.document,
    reply: (msg) => page.__onboard(msg),
    click: (id) => $(id).dispatchEvent(new page.Event('click')),
    submit: (id) => $(id).dispatchEvent(new page.Event('submit', { cancelable: true })),
    visible: () => [...w.document.querySelectorAll('section.step')].filter((s) => !s.hidden).map((s) => s.id),
    steps: () => sent.filter((m) => m.type === 'ob_step').map((m) => m.step),
  };
}
// What the sidecar's obState() sends (the fields the guide reads).
const state = (over = {}) => ({
  kind: 'state', platform: 'darwin', step: 0, sound: true, look: 'jarvis', size: 'default', voice: true, actions: false, login: true,
  filesAsked: true, replies: 'text', voiceMode: 'classic', tts: 'fish', geminiKey: false, geminiVoice: 'Kore', liveVoice: 'Kore',
  geminiVoices: [{ id: 'Kore', style: 'Firm' }], keys: { talk: ['control', 'option'], write: ['option', 'command'], summon: 'Control+Alt+KeyS', snap: 'Control+Alt+KeyA' },
  connected: null, voiceModel: null, brain: { root: null, desktop: '/Users/sam/Desktop/Sam OS' },
  oauth: [{ id: 'anthropic', name: 'Claude', company: 'Anthropic', connected: false }, { id: 'openai', name: 'ChatGPT', company: 'OpenAI', connected: false }],
  apikey: [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['gemini', 'Gemini'], ['deepseek', 'DeepSeek']].map(([id, name]) => ({ id, name, connected: false, link: `https://example.com/${id}` })),
  ...over,
});
const FAKE_KEY = 'sk-cp12-GUIDE-0123456789abcdef';

// CP-11 happy path: the guide says hello, opens on the saved step, and walks forward one step at a time to the end;
// each step is reported (ob_step) in order, and Done sends ob_done then hands over to the app (onboarding_finish).
{
  const g = openGuide();
  await tick();
  assert.deepEqual(g.sent[0], { type: 'ob_hello' }, 'CP-11: the guide asks for the state first');
  g.reply(state({ step: 0 }));
  await tick();
  assert.deepEqual(g.visible(), ['step-welcome'], 'CP-11: a fresh setup opens on Welcome');
  assert.deepEqual(g.steps(), [0]);
  for (let n = 0; n < 30 && !g.sent.some((m) => m.type === 'ob_done'); n++) {
    g.click(g.$('next').disabled ? 'skip' : 'next');
    await tick(5);
  }
  const order = ['step-welcome', 'step-perms', 'step-brain', 'step-ai', 'step-voice', 'step-demo', 'step-keys', 'step-chat', 'step-secondbrain', 'step-find'];
  assert.deepEqual(g.steps(), order.map((_, i) => i), 'CP-11: every step, in order, none skipped or repeated');
  assert.deepEqual(g.visible(), ['step-find'], 'CP-11: ends on Find me');
  assert.ok(g.sent.some((m) => m.type === 'ob_done'), 'CP-11: Done finishes setup');
  assert.deepEqual(g.sent.filter((m) => m.type === 'ob_brain'), [{ type: 'ob_brain', choice: 'desktop' }], 'CP-11: going straight through makes the default second brain');
  await tick();
  assert.ok(g.calls.indexOf('onboarding_finish') > -1, 'CP-11: and hands over to the app');
}

// CP-11 resume + Classic/Live: a saved step reopens there; picking Live saves it (ob_voicemode) and shows only
// the Gemini key box; Classic shows the sign-in cards again.
{
  const g = openGuide();
  await tick();
  g.reply(state({ step: 3 }));
  await tick();
  assert.deepEqual(g.visible(), ['step-ai'], 'CP-11: resumes at the saved step (Connect AI)');
  assert.deepEqual(g.steps(), [3], 'CP-11: without replaying the earlier steps');
  assert.equal(g.$('providers').hidden, false, 'CP-11: Classic shows the sign-in cards');
  const pick = (name) => [...g.$('ai-version').querySelectorAll('button')].find((b) => b.textContent.startsWith(name));
  pick('Live').onclick();
  assert.deepEqual(g.sent.at(-1), { type: 'ob_voicemode', mode: 'live' }, 'CP-11: the Live pick is saved');
  g.reply(state({ step: 3, voiceMode: 'live' }));
  await tick();
  assert.equal(g.$('key-form').hidden, false, 'CP-11: Live shows the key box');
  assert.match(g.$('key-label').textContent, /Gemini/, 'CP-11: for a Gemini key');
  assert.ok(g.$('providers').hidden && g.$('key-providers').hidden && g.$('key-toggle').hidden, 'CP-11: and nothing else');
  assert.equal(g.$('next').disabled, true, 'CP-11: Live is not ready without a Gemini key');
  pick('Classic').onclick();
  assert.deepEqual(g.sent.at(-1), { type: 'ob_voicemode', mode: 'classic' });
  assert.equal(g.$('providers').hidden, false, 'CP-11: back to the sign-in cards');
  assert.equal(g.$('key-form').hidden, true);

  // A step past the end (an older, longer guide) opens the last step, not a blank page.
  const h = openGuide();
  await tick();
  h.reply(state({ step: 42 }));
  await tick();
  assert.deepEqual(h.visible(), ['step-find'], 'CP-11: an out-of-range saved step is clamped');
}

// CP-12 happy path: Live's Gemini key box sends the pasted key (trimmed) as ob_apikey, the field is cleared,
// the sidecar's done reply turns it connected and unlocks Continue; the key is never logged by the guide.
{
  const g = openGuide();
  await tick();
  g.reply(state({ step: 3, voiceMode: 'live' }));
  await tick();
  g.$('key-input').value = `  ${FAKE_KEY}  `;
  g.submit('key-form');
  assert.deepEqual(g.sent.at(-1), { type: 'ob_apikey', provider: 'gemini', key: FAKE_KEY }, 'CP-12: the pasted key goes to the sidecar trimmed');
  assert.equal(g.$('key-input').value, '', 'CP-12: and is cleared from the field');
  assert.equal(g.$('key-save').disabled, true, 'CP-12: Save waits while the key is checked');
  g.reply({ kind: 'login', provider: 'gemini', phase: 'done' });
  g.reply(state({ step: 3, voiceMode: 'live', geminiKey: true, apikey: state().apikey.map((p) => ({ ...p, connected: p.id === 'gemini' })) }));
  await tick();
  assert.equal(g.$('login-error').hidden, true, 'CP-12: no error');
  assert.match(g.$('key-label').textContent, /Gemini is connected/, 'CP-12: shows as connected');
  assert.equal(g.$('next').disabled, false, 'CP-12: Continue unlocks');

  // Classic: Use an API key instead, pick a provider, paste.
  const c = openGuide();
  await tick();
  c.reply(state({ step: 3 }));
  await tick();
  c.click('key-toggle');
  assert.equal(c.$('key-providers').hidden, false, 'CP-12: the key cards show');
  [...c.$('key-providers').querySelectorAll('button')].find((b) => b.textContent.startsWith('DeepSeek')).onclick();
  c.$('key-input').value = FAKE_KEY;
  c.submit('key-form');
  assert.deepEqual(c.sent.at(-1), { type: 'ob_apikey', provider: 'deepseek', key: FAKE_KEY }, 'CP-12: Classic sends the picked provider');
  c.reply({ kind: 'login', provider: 'deepseek', phase: 'done' });
  c.reply(state({ step: 3, connected: { provider: 'DeepSeek', model: 'A model' }, apikey: state().apikey.map((p) => ({ ...p, connected: p.id === 'deepseek' })) }));
  await tick();
  assert.equal(c.$('next').disabled, false, 'CP-12: connected, Continue unlocks');
  for (const x of [g, c]) assert.ok(!x.logs.some((l) => l.includes(FAKE_KEY)), 'CP-12: the guide never logs the key');
  for (const x of [g, c]) assert.ok(!x.doc.documentElement.outerHTML.includes(FAKE_KEY), 'CP-12: nor leaves it in the page');
}

// CP-12 failure path: a bad key shows the sidecar's "That key didn't work" error, Save comes back, the step stays
// locked; a blank key sends nothing; a stale reply for another provider is ignored.
{
  const g = openGuide();
  await tick();
  g.reply(state({ step: 3, voiceMode: 'live' }));
  await tick();
  const before = g.sent.length;
  g.$('key-input').value = '   ';
  g.submit('key-form');
  assert.equal(g.sent.length, before, 'CP-12: a blank key sends nothing');
  g.$('key-input').value = 'bad';
  g.submit('key-form');
  g.reply({ kind: 'login', provider: 'openai', phase: 'done' });
  await tick();
  assert.equal(g.$('key-save').disabled, true, 'CP-12: a reply for another provider is ignored');
  g.reply({ kind: 'login', provider: 'gemini', phase: 'error', error: "That key didn't work. Copy it again from aistudio.google.com and retry." });
  await tick();
  assert.equal(g.$('login-error').hidden, false, 'CP-12: the error shows');
  assert.match(g.$('login-error').textContent, /That key didn't work/, 'CP-12: in the sidecar\'s words');
  assert.equal(g.$('key-save').disabled, false, 'CP-12: Save is back for another try');
  assert.equal(g.$('next').disabled, true, 'CP-12: still not connected');
  assert.ok(!g.logs.some((l) => l.includes('bad')), 'CP-12: the bad key is not logged');
}
// Your second brain: just before Find me. Create one on the Desktop is picked by default (where it goes shown),
// and Continue makes it (ob_brain), waiting for the sidecar before moving on.
{
  const g = openGuide({ brainAuto: false });
  await tick();
  g.reply(state({ step: 8 }));
  await tick();
  assert.deepEqual(g.visible(), ['step-secondbrain'], 'the second brain step is step 8');
  assert.match(g.$('h-secondbrain').textContent, /Your second brain/);
  const radios = [...g.$('brain-choices').querySelectorAll('[role="radio"]')];
  assert.deepEqual(radios.map((b) => b.querySelector('span').textContent), ['Create one on the Desktop', 'Use an existing folder', 'Skip for now'], 'three choices');
  assert.deepEqual(radios.map((b) => b.getAttribute('aria-checked')), ['true', 'false', 'false'], 'Create one on the Desktop is picked by default');
  assert.match(radios[0].textContent, /Desktop\/Sam OS/, 'and says where it goes');
  assert.equal(g.$('next').disabled, false, 'the default is ready to go');
  g.click('next');
  assert.deepEqual(g.sent.at(-1), { type: 'ob_brain', choice: 'desktop' }, 'Continue makes it');
  assert.equal(g.$('next').disabled, true, 'and waits while it is made');
  await tick(5);
  assert.deepEqual(g.visible(), ['step-secondbrain'], 'without moving on yet');
  g.reply({ kind: 'brain', ok: true, choice: 'desktop', root: '/Users/sam/Desktop/Sam OS', made: [], kept: [] });
  await tick(5);
  assert.deepEqual(g.visible(), ['step-find'], 'made: on to Find me');
}

// Use an existing folder: Continue waits for a folder, Choose Folder opens the system's dialog, a folder the sidecar
// refuses shows its reason and stays; Skip for now sends skip and moves on.
{
  const g = openGuide({ brainAuto: false, pick: '/Users/sam/Notes' });
  await tick();
  g.reply(state({ step: 8 }));
  await tick();
  const radio = (name) => [...g.$('brain-choices').querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith(name));
  radio('Use an existing folder').onclick();
  assert.equal(radio('Use an existing folder').getAttribute('aria-checked'), 'true');
  assert.equal(g.$('brain-pick').hidden, false, 'the folder row shows');
  assert.equal(g.$('next').disabled, true, 'no folder yet: Continue waits');
  g.click('brain-choose');
  await tick();
  assert.ok(g.calls.includes('pick_folder'), 'Choose Folder opens the folder dialog');
  assert.match(g.$('brain-folder').textContent, /\/Users\/sam\/Notes/, 'and shows the folder chosen');
  assert.equal(g.$('next').disabled, false, 'a folder: Continue unlocks');
  g.click('next');
  assert.deepEqual(g.sent.at(-1), { type: 'ob_brain', choice: 'existing', root: '/Users/sam/Notes' }, 'Continue saves the chosen folder');
  g.reply({ kind: 'brain', ok: false, error: 'The second brain folder has to be inside your home folder.' });
  await tick(5);
  assert.deepEqual(g.visible(), ['step-secondbrain'], 'refused: stays on the step');
  assert.equal(g.$('brain-error').hidden, false);
  assert.match(g.$('brain-error').textContent, /inside your home folder/, "in the sidecar's words");
  assert.equal(g.$('next').disabled, false, 'ready to try again');
  radio('Skip for now').onclick();
  assert.equal(g.$('brain-pick').hidden, true, 'Skip hides the folder row');
  assert.equal(g.$('brain-error').hidden, true, 'and the old error');
  g.click('next');
  assert.deepEqual(g.sent.at(-1), { type: 'ob_brain', choice: 'skip' }, 'Skip for now saves nothing');
  g.reply({ kind: 'brain', ok: true, choice: 'skip' });
  await tick(5);
  assert.deepEqual(g.visible(), ['step-find']);

  // Back on it with one already saved (a resumed setup): that folder, picked.
  const h = openGuide();
  await tick();
  h.reply(state({ step: 8, brain: { root: '/Users/sam/Notes', desktop: '/Users/sam/Desktop/Sam OS' } }));
  await tick();
  const checked = [...h.$('brain-choices').querySelectorAll('[role="radio"]')].find((b) => b.getAttribute('aria-checked') === 'true');
  assert.match(checked.textContent, /^Use an existing folder/, 'a saved one opens as Use an existing folder');
  assert.match(h.$('brain-folder').textContent, /\/Users\/sam\/Notes/, 'with its folder');
  assert.equal(h.$('next').disabled, false);
}
console.log('cp11-12-guide: CP-11 onboarding flow and CP-12 pasted keys ok');
