// The Second brain page's "Create a New One": the real panel/index.html + panel.js run in a linkedom DOM inside
// node:vm, in its browser preview (sample data), with the state's home folder set. Picking Create a New One fills
// the parent folder with ~/Desktop and the name with the sidecar's default ("Sam OS"), so the root it checks (and
// would make) is ~/Desktop/Sam OS. No browser, no app. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const ROOT = new URL('../../../panel/', import.meta.url);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const HOME = '/Users/sam';

const html = fs.readFileSync(new URL('index.html', ROOT), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const w = parseHTML(html);
const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : noop), apply: () => noop, construct: () => noop });
const sent = [];
const capture = (...a) => { const s = a.map(String).join(' '); const m = s.match(/^\[preview\] would send (.*)$/); if (m) sent.push(JSON.parse(m[1])); };
const page = {
  matchMedia: () => ({ matches: true, addEventListener() {} }), innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, Jarvis: noop,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance, Date, Math, JSON, Promise, Map, Set, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
  location: { search: '?tab=secondbrain' }, navigator: { platform: 'MacIntel', userAgent: 'Macintosh' },
  console: { log: capture, info() {}, warn() {}, error() {}, debug() {} },
  fetch: () => Promise.resolve({ json: () => ({ updates: [] }) }), CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
  getComputedStyle: () => ({ rowGap: '0', getPropertyValue: () => '' }),
  document: w.document,
};
for (const k of ['Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'HTMLElement']) if (k in w.window) page[k] = w.window[k];
page.window = page; page.self = page;
page.addEventListener = () => {}; page.removeEventListener = () => {};
w.window.HTMLCanvasElement.prototype.getContext = () => noop;
w.window.HTMLElement.prototype.focus = function () {};
w.window.HTMLElement.prototype.getClientRects = () => [];
w.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10 });
w.window.HTMLElement.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} });
vm.runInContext(fs.readFileSync(new URL('panel.js', ROOT), 'utf8'), vm.createContext(page));
// The preview's sample state goes out on a timer: give it this computer's home folder first, as the sidecar does.
const real = page.__panel;
page.__panel = (m) => real(m.kind === 'state' ? { ...m, state: { ...m.state, secondBrain: { saved: null, using: null, missing: false, found: [], home: HOME, name: 'Sam OS' } } } : m);
await tick(20);

const $ = (q) => w.document.querySelector(q);
assert.ok($('[data-k="sbmode:create"]'), 'the Second brain page is open');
$('[data-k="sbmode:create"]').dispatchEvent(new page.Event('click'));
await tick(20);
assert.equal($('#sb-name').value, 'Sam OS', 'Create a New One: the name is the default one, "Sam OS"');
const parentRow = [...w.document.querySelectorAll('.setting')].find((n) => n.textContent.startsWith('Parent folder'));
assert.ok(parentRow, 'the parent folder row shows');
assert.match(parentRow.textContent, /\/Users\/sam\/Desktop/, 'Create a New One: the parent folder is ~/Desktop');
const check = sent.filter((m) => m.type === 'secondbrain' && m.op === 'check' && m.mode === 'create').at(-1);
assert.ok(check, 'the new root is checked straight away');
assert.equal(check.form.root, `${HOME}/Desktop/Sam OS`, 'so the root is ~/Desktop/Sam OS');
assert.equal(check.form.context, `${HOME}/Desktop/Sam OS/_context`, 'with the usual folders in it');
console.log('brainsetup-panel: Create a New One starts at ~/Desktop/<First> OS ok');
process.exit(0); // the page's own timers (the Home page's clock) would keep it running
