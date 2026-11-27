// The panel that opens from the menu bar or tray icon: a sidebar of pages. Home (what's going on) and Memory,
// then a page per group of settings: Harness, Appearance, Speaking, Listening, Shortcuts, General, Second brain, and What's new.
// The sidecar owns every value: it sends the whole state when the panel opens and after each change, and the
// panel sends back menu actions ({type:'menu', id, value?}). Opened in a plain browser it shows a
// labelled preview with sample data instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAURI = window.__TAURI__?.core?.invoke;
  const invoke = TAURI ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const hide = () => invoke('panel_hide').catch(() => {});
  // An action from the menu's list. away: it happens on the desktop, so the panel steps aside first.
  const act = (id, away = false) => { if (away) hide(); send({ type: 'menu', id }); };
  const sendMenu = (id, value, away = false) => {
    if (away) hide();
    send(value === undefined ? { type: 'menu', id } : { type: 'menu', id, value });
  };

  let state = null, tab = 'home', deferred = false;
  const ui = {
    key: null,
    arm: null,
    pg: {},
    per: {},
    base: {},
    rec: null,
    mtab: 'facts',
    tabs: {},
    q: '',
    bindShown: new Set(),
    scanning: false,
    custom: null,
    customKey: '',
  };
  let armTimer = 0;
  const disarm = () => { clearTimeout(armTimer); if (ui.arm) { ui.arm = null; return true; } return false; };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
      else if (k.startsWith('aria-') || k === 'role' || k.startsWith('data-')) n.setAttribute(k, String(v));
      else n[k] = v;
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };
  const btn = (label, onclick, { kind = 'ghost', k, disabled, wide, aria, title } = {}) =>
    el('button', { className: `px btn ${kind}${wide ? ' wide' : ''}`, type: 'button', textContent: label, disabled, title, 'data-k': k, 'aria-label': aria, on: { click: onclick } });
  const link = (label, onclick, { k, danger, aria, disabled } = {}) =>
    el('button', { className: `link${danger ? ' danger' : ''}`, type: 'button', textContent: label, 'data-k': k, 'aria-label': aria, disabled, on: { click: onclick } });

  async function copyText(text, trigger, okMsg = 'Copied to clipboard.') {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch {}
    if (!ok) {
      try {
        const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
        document.body.append(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch {}
    }
    if (ok && trigger) {
      const prev = trigger.textContent;
      trigger.textContent = 'Copied';
      setTimeout(() => { if (trigger.isConnected) trigger.textContent = prev; }, 1800);
    }
    note(ok ? okMsg : "Couldn't copy automatically. Select the command to copy it.", !ok);
  }

  // A row's action, played out: the row steps out, then the action goes. Re-rendering brings the list in line.
  const shown = (n) => !n.hidden && n.getClientRects().length > 0;
  function grow(n, open) {
    if (REDUCED.matches || !shown(n)) return Promise.resolve();
    const h = n.offsetHeight, gap = parseFloat(getComputedStyle(n.parentElement).rowGap) || 0;
    n.classList.remove('appear', 'vanish'); void n.offsetWidth; n.classList.add(open ? 'appear' : 'vanish');
    const shut = { height: '0px', marginTop: `${-gap}px` }, full = { height: `${h}px`, marginTop: '0px' };
    n.style.overflow = 'hidden';
    return n.animate(open ? [shut, full] : [full, shut], { duration: open ? 200 : 160, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: open ? 'none' : 'forwards' })
      .finished.catch(() => {}).then(() => { n.style.overflow = ''; if (open) n.classList.remove('appear'); });
  }
  const shutBlock = (id, then) => { const n = document.querySelector(`.pane [data-anim="${CSS.escape(id)}"]`); return n && shown(n) ? grow(n, false).then(then) : then(); };
  function toggleKey(id) {
    const prev = ui.key;
    if (prev === id) return closeKey();
    const open = () => { ui.key = id; render(`key-${id}`); };
    return prev ? shutBlock(`key-${prev}`, open) : open();
  }
  function closeKey() {
    const id = ui.key;
    if (!id) return;
    shutBlock(`key-${id}`, () => { if (ui.key === id) { ui.key = null; render(`addkey:${id}`); } });
  }

  const gone = new Map();
  const rowOf = (k) => document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`)?.closest('li');
  const keepGone = () => { for (const [k, until] of gone) { if (Date.now() > until) gone.delete(k); else rowOf(k)?.classList.add('gone'); } };
  const leave = (from, id) => {
    const k = from.dataset.k, row = from.closest('li');
    if (k) gone.set(k, Date.now() + 4000);
    row?.classList.add('leaving');
    setTimeout(() => { row?.classList.add('gone'); act(id); }, REDUCED.matches ? 0 : 190);
    setTimeout(() => { if (k && gone.delete(k) && rowOf(k)) render(); }, 4100);
  };
  const armed = (label, yes, k, id, aria) => {
    const on = ui.arm === k;
    const b = el('button', { className: 'link danger arm', type: 'button', 'data-k': k, 'aria-pressed': String(on), 'aria-label': on ? `Confirm: ${aria}` : aria },
      el('span', { className: 'no', textContent: label, 'aria-hidden': 'true' }), el('span', { className: 'yes', textContent: yes, 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); b.setAttribute('aria-pressed', 'false'); return leave(b, id); }
      clearTimeout(armTimer); ui.arm = k; render(k);
      armTimer = setTimeout(() => { if (ui.arm === k) { ui.arm = null; render(); } }, 4000);
    });
    return b;
  };
  const PIX = {
    tick: [[0, 3], [1, 4], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]],
    x: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [6, 0], [5, 1], [4, 2], [2, 4], [1, 5], [0, 6]],
  };
  const pix = (name) => `<svg viewBox="0 0 14 14" width="14" height="14" shape-rendering="crispEdges" fill="currentColor">${PIX[name].map(([x, y]) => `<rect x="${x * 2}" y="${y * 2}" width="2" height="2"/>`).join('')}</svg>`;
  const armIcon = (b, on) => { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? `Confirm: ${b.dataset.aria}` : b.dataset.aria); if (on) b.removeAttribute('data-tip'); else b.dataset.tip = b.dataset.name; };
  const calmIcons = () => { for (const o of document.querySelectorAll('.pane .ibtn[aria-pressed="true"]')) armIcon(o, false); };
  function iconArmed(icon, tip, k, id, aria) {
    const no = el('span', { className: 'no', 'aria-hidden': 'true' });
    no.innerHTML = pix(icon);
    const b = el('button', { className: `link ibtn${icon === 'x' ? ' danger' : ''}`, type: 'button', 'data-k': k, 'data-name': tip, 'data-aria': aria },
      no, el('span', { className: 'yes', textContent: 'Confirm', 'aria-hidden': 'true' }));
    armIcon(b, ui.arm === k);
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); return leave(b, id); }
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(k);
      const me = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`) ?? b;
      ui.arm = k; armIcon(me, true); hideTip();
      armTimer = setTimeout(() => { if (ui.arm !== k) return; ui.arm = null; const n = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`); if (n) armIcon(n, false); }, 4000);
    });
    return b;
  }
  const group = (title, desc, n, ...kids) => el('div', { className: 'group' },
    el('div', { className: 'ghead' }, title ? el('h2', {}, title, n != null ? el('span', { className: 'n', textContent: String(n) }) : null) : null, desc ? el('p', { textContent: desc }) : null),
    ...kids);
  const tabRow = (label, panel, tabs, on, pick) => el('div', { className: 'tabs', role: 'tablist', 'aria-label': label }, tabs.map(([id, text]) => el('button', {
    className: 'tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(on === id), 'aria-controls': panel, tabIndex: on === id ? 0 : -1, 'data-k': `tab-${id}`,
    on: { click: () => { if (on !== id) { pick(id); disarm(); render(`tab-${id}`); } } },
  }, text)));
  const pageTab = (page, tabs, first = tabs[0][0]) => (tabs.some(([id]) => id === ui.tabs[page]) ? ui.tabs[page] : first);
  const tabPanel = (id, on, ...kids) => el('div', { className: 'tabpanel', role: 'tabpanel', id, 'aria-labelledby': `tab-${on}` }, ...kids);
  const toggle = (label, hint, on, onflip, k) => el('div', { className: 'setting' },
    el('span', { id: `lbl-${k}` }, label, hint ? el('small', { textContent: hint, className: hint.length > 52 ? 'wrap' : '' }) : null),
    el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `lbl-${k}`, 'data-k': k, on: { click: onflip } }));
  const picks = (label, list, value, pick, k, tips = null) => el('div', { className: 'picks', role: 'radiogroup', 'aria-label': label },
    list.map(([v, text]) => el('button', {
      className: 'px chord', type: 'button', role: 'radio', 'aria-checked': String(v === value), tabIndex: v === value ? 0 : -1, 'data-k': `${k}:${v}`,
      'data-tip': tips?.[v] ?? null, 'aria-describedby': tips?.[v] ? `tip-${k}-${v}` : null,
      on: { click: () => v !== value && pick(v) },
    }, el('span', { className: 'px cap', textContent: text }), tips?.[v] ? el('span', { className: 'sr-only', id: `tip-${k}-${v}`, textContent: tips[v] }) : null)));

  // ---- tooltip ----
  let tipFor = null, tipTimer = 0;
  const tipBox = () => $('tip');
  function showTip(target, own = null) {
    clearTimeout(tipTimer);
    const t = tipBox(), text = own ?? target.dataset.tip;
    if (!text) return;
    if (tipFor !== target) { t.textContent = text; t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); }
    tipFor = target; t.hidden = false;
    const r = target.getBoundingClientRect(), gut = 12;
    t.style.maxWidth = `${Math.min(300, innerWidth - gut * 2)}px`;
    const w = t.offsetWidth, h = t.offsetHeight, below = r.bottom + 6 + h <= innerHeight - 8;
    const x = Math.round(Math.min(Math.max(r.left, gut), innerWidth - gut - w)), y = Math.round(below ? r.bottom + 6 : r.top - 6 - h);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    const at = t.getBoundingClientRect();
    t.style.left = `${x + (x - Math.round(at.left))}px`; t.style.top = `${y + (y - Math.round(at.top))}px`;
  }
  function hideTip(soon = false) {
    clearTimeout(tipTimer);
    if (soon) { tipTimer = setTimeout(() => hideTip(), 120); return; }
    tipFor = null; const t = tipBox(); if (t) t.hidden = true;
  }
  const clipped = (n) => (n && n.scrollWidth > n.clientWidth ? n.textContent : null);
  document.addEventListener('pointerover', (e) => {
    const d = e.target.closest?.('.setting > span small, .ghead p');
    if (d) { const full = clipped(d); if (full) d.dataset.tip = full; else delete d.dataset.tip; }
  }, true);
  document.addEventListener('pointerover', (e) => { const x = e.target.closest?.('[data-tip]'); if (x) showTip(x); else if (e.target.closest?.('#tip')) clearTimeout(tipTimer); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip], #tip') && !e.relatedTarget?.closest?.('[data-tip], #tip')) hideTip(true); });
  document.addEventListener('focusin', (e) => {
    const x = e.target.closest?.('[data-tip]');
    if (x && x.matches(':focus-visible')) return showTip(x);
    const full = !x && e.target.matches?.(':focus-visible') ? clipped(e.target.closest?.('.setting')?.querySelector(':scope > span small')) : null;
    if (full) showTip(e.target, full); else hideTip();
  });
  document.addEventListener('focusout', () => hideTip(true));

  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const GEMINI_WHY = { 'gemini-3.8-flash-lite-tts': 'Quick. Low quota use.', 'gemini-3.8-flash-tts': 'Studio quality.' };
  const GEMINI_WHY_LONG = {
    'gemini-3.8-flash-lite-tts': 'Fast replies for everyday speech.',
    'gemini-3.8-flash-tts': "Google's highest quality expressive voice.",
  };
  const geminiPrice = (c) => `About $${(c.per10s * 120).toFixed(2)} per 100 replies, using your Google AI Studio key (has a free tier).`;
  const where = () => (state?.os === 'mac' ? 'your Keychain' : state?.os === 'win' ? 'Windows, encrypted for your account' : state?.os === 'linux' ? 'your keyring' : 'this computer');

  // ---------------------------------------------------------------- harnesses metadata
  const HARNESS_META = {
    agy: {
      id: 'agy',
      label: 'Antigravity (agy)',
      isDefault: true,
      installCmd: 'mise use -g antigravity-cli',
      loginCmd: 'agy acp --login',
      installUrl: 'https://antigravity.google',
    },
    opencode: {
      id: 'opencode',
      label: 'OpenCode',
      isDefault: false,
      installCmd: 'npm i -g opencode-ai@latest',
      loginCmd: 'opencode auth login',
      installUrl: 'https://opencode.ai/docs',
    },
    pi: {
      id: 'pi',
      label: 'Pi',
      isDefault: false,
      installCmd: 'npm install -g @mariozechner/pi-coding-agent',
      loginCmd: 'pi',
      installUrl: 'https://shittycodingagent.ai',
    },
    claude: {
      id: 'claude',
      label: 'Claude Code',
      isDefault: false,
      installCmd: 'npm i -g @anthropic-ai/claude-code',
      loginCmd: 'claude auth login',
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    },
  };
  const HARNESS_ORDER = ['agy', 'opencode', 'pi', 'claude'];

  function normalizeHarnesses() {
    const raw = state?.harnesses;
    const byId = new Map();
    if (Array.isArray(raw)) {
      for (const h of raw) if (h?.id) byId.set(h.id, h);
    } else if (raw && typeof raw === 'object') {
      for (const [id, h] of Object.entries(raw)) byId.set(id, { id, ...h });
    }
    return HARNESS_ORDER.map((id) => {
      const meta = HARNESS_META[id];
      const d = byId.get(id) ?? {};
      const installed = !!d.installed;
      const authenticated = !!d.authenticated;
      const status = installed && authenticated ? 'ready' : installed ? 'needs-login' : 'missing';
      return {
        ...meta,
        ...d,
        id,
        label: d.label || meta.label,
        installCmd: d.installCmd || meta.installCmd,
        loginCmd: d.loginCmd || meta.loginCmd,
        installUrl: d.installUrl || meta.installUrl,
        installed,
        authenticated,
        status,
      };
    });
  }

  function activeHarnessLabel() {
    const h = state?.harness ?? 'agy';
    if (h === 'custom') return state?.customHarness?.command ? `Custom (${state.customHarness.command})` : 'Custom ACP/CLI';
    const found = normalizeHarnesses().find((x) => x.id === h);
    if (found) return found.label;
    return state?.model?.name || 'Antigravity (agy)';
  }

  // ---------------------------------------------------------------- header
  function head() {
    const s = state.status ?? { state: 'ready', text: 'Ready' };
    const list = normalizeHarnesses();
    const anyReady = state.harness === 'custom' ? !!state.customHarness?.command : list.some((h) => h.status === 'ready');
    const off = s.state === 'off' && !anyReady;
    $('led').className = `led${s.state === 'ready' || (!off && s.state !== 'busy') ? ' on' : s.state === 'busy' ? ' busy' : ''}`;
    const now = $('now');
    now.replaceChildren(el('b', { textContent: s.text }), off ? ' · Set up on the Harness page' : ` · ${activeHarnessLabel()}`);
    now.title = now.textContent;
    $('ver').textContent = `v${state.version ?? '1.0.0'}`;
    updateButton();
    react();
    mark('harness', off ? 'needs setup' : null);
  }
  const FRESH = 6000;
  let freshTimer = 0;
  function updateButton() {
    const u = state.update ?? {}, b = $('head-update'), v = u.available;
    const fresh = u.result?.ok && Date.now() - (u.result.at ?? 0) < FRESH;
    const [label, aria, kind, off] =
      u.done ? ['Done', `Yomna ${u.done} is installed. Restarting`, 'ghost', true]
      : u.installing ? ['Updating…', `Installing Yomna ${v}`, 'ghost', true]
      : v ? (u.page ? [`Get ${v}`, `Open the download page for Yomna ${v}`, 'primary', false] : [`Update to ${v}`, `Install Yomna ${v} and restart`, 'primary', false])
      : u.checking ? ['Checking…', 'Checking for updates', 'ghost', true]
      : u.result?.off ? ['Updates off', 'Updates are off in this build', 'ghost', true]
      : fresh ? ['Up to date', `Yomna ${state.version} is up to date`, 'ghost', true]
      : u.result ? ['Check again', "Couldn't check for updates. Check again", 'ghost', false]
      : ['Check for updates', 'Check for updates', 'ghost', false];
    b.hidden = false; b.textContent = label; b.disabled = off;
    b.className = `px btn mini ${kind}`;
    b.setAttribute('aria-label', aria);
    b.title = u.result && !u.result.ok && !v && !u.checking ? u.result.error ?? "Couldn't check for updates." : '';
    clearTimeout(freshTimer);
    if (fresh) freshTimer = setTimeout(() => state && updateButton(), FRESH - (Date.now() - u.result.at) + 50);
  }
  $('head-update').addEventListener('click', () => act(state?.update?.available ? 'install_update' : 'update'));
  const quitB = $('head-quit');
  let quitTimer = 0;
  const unarmQuit = () => { clearTimeout(quitTimer); quitB.setAttribute('aria-pressed', 'false'); quitB.setAttribute('aria-label', 'Quit Yomna'); };
  quitB.addEventListener('click', () => {
    if (quitB.getAttribute('aria-pressed') === 'true') { unarmQuit(); act('quit'); return; }
    quitB.setAttribute('aria-pressed', 'true'); quitB.setAttribute('aria-label', 'Confirm: quit Yomna');
    quitTimer = setTimeout(unarmQuit, 4000);
  });
  function mark(page, why) {
    const b = $(`nav-${page}`);
    if (!b) return;
    b.classList.toggle('flag', !!why);
    let sr = b.querySelector('.sr-only');
    if (why && !sr) b.append(sr = el('span', { className: 'sr-only' }));
    if (sr) { if (why) sr.textContent = ` (${why})`; else sr.remove(); }
  }

  // ---------------------------------------------------------------- live Yomna
  const LED = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const live = new Set();
  let pointer = null;
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  const POSES = {
    think: (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    concerned: () => ({ arms: 0.7, tl: [-0.45, 0.95], tr: [0.45, 0.95], mouth: 'frown', brow: 'raised' }),
  };
  const ZOOM = 0.5, UNIT = 340;
  function liveAvatar(canvas, w, h, { look = 'yomna', y = 0.56, form = 'default' } = {}) {
    if (!window.Jarvis?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const z = ZOOM, unit = UNIT;
    w /= z; h /= z;
    const env = {
      w, h, dpr, t: 0, unit, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      pose: null, look, form,
      kit: Jarvis.ditherKit({
        id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: 0.55, speed: 80, pal: LED,
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => (clock < actUntil ? null : POSES[me.pose]?.(clock) ?? null) }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setLook(l) { if (l === me.look) return; me.look = l; me.kit.setLook(l); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      appear(v = 'materialize') { me.kit.appear(REDUCED.matches ? 'crt' : v, w / 2, h * y); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / z, y: (pointer[1] - r.top) / z, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook(look); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    live.add({ me, canvas });
    return me;
  }
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(1 / 30, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (document.hidden || $('frame').classList.contains('shut')) return;
    for (const { me, canvas } of live) if (canvas.isConnected && canvas.offsetParent) me.step(dt);
  }
  requestAnimationFrame(loop);

  const avatar = liveAvatar($('avatar'), 100, 74, { y: 0.55 });
  const QUIPS = {
    yomna: 'At your service.',
    glayos: 'Oh, good. A new test subject.',
    ultren: 'No strings. Shall we begin?',
    sarah: 'Hey, nice to meet you!',
    adrian: "Alright, let's do this.",
    rita: 'Shall we get to work?',
  };
  let quipTimer = 0, seen = { look: null, update: null, opened: 0 };
  function quip(text, secs = 2.6) {
    const q = $('saying'), n = $('by');
    clearTimeout(quipTimer);
    q.textContent = text; q.classList.add('on'); n.classList.add('quiet');
    quipTimer = setTimeout(() => { q.classList.remove('on'); n.classList.remove('quiet'); }, secs * 1000);
  }
  function react() {
    if (!avatar) return;
    avatar.pose = state.busy ? 'think' : state.status?.state === 'off' ? 'concerned' : null;
    if (seen.look && state.look !== seen.look) { avatar.setLook(state.look); avatar.act('wave'); quip(QUIPS[state.look] ?? 'Hi!'); }
    else avatar.setLook(state.look ?? 'yomna');
    avatar.setForm(state.size ?? 'default');
    if (state.update?.available && state.update.available !== seen.update && seen.look) { avatar.act('hype'); quip(`Yomna ${state.update.available} is here!`); }
    seen.look = state.look; seen.update = state.update?.available;
  }

  // ---------------------------------------------------------------- Home
  function home() {
    const u = state.update ?? {};
    const mac = state.os === 'mac';
    const name = state.name || 'Yomna';
    return [
      el('div', { className: 'group' },
        el('h2', { className: 'sr-only', textContent: 'Actions' }),
        el('div', { className: 'actions' },
          btn('Ask', () => act('ask', true), { kind: u.available ? 'ghost' : 'primary', k: 'ask', disabled: state.busy,
            aria: state.askKeys ? `Ask ${name}, or tap ${state.askKeys} anywhere` : `Ask ${name}`, title: state.askKeys ? `Or tap ${state.askKeys} anywhere` : null }),
          btn('Show list', () => act('list', true), { k: 'list' }),
          state.snap ?? mac ? btn('Ask about an area', () => act('snap', true), { k: 'snap' }) : null,
          state.busy ? btn('Stop', () => act('stop'), { k: 'stop' }) : btn('New chat', () => act('new'), { k: 'new', disabled: !state.canNew, aria: 'Start a new conversation' }),
          mac ? null : btn(`Show ${name}`, () => act('show', true), { k: 'show' }))),
      recentList(),
    ].flat();
  }
  function recentList() {
    const { box, nav } = paged('recent', state.recent ?? [], (r) => el('li', { className: `item ${r.kind}` },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', dir: 'auto', textContent: r.kind === 'ask' ? `“${r.text}”` : r.text, title: r.text }),
      el('span', { className: 'meta', textContent: ago(r.at) })), { label: 'Recent' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Recent' })), box),
      foot(state.usage ? el('p', { className: 'usage', textContent: `Today: ${state.usage.requests} request${state.usage.requests === 1 ? '' : 's'} · ${tokens(state.usage.tokens)} tokens` }) : null, nav),
    ];
  }

  // ---------------------------------------------------------------- pages of a long list
  const EMPTY = 'Nothing yet…';
  function paged(key, items, row, { label, empty = EMPTY, id, pin = -1 } = {}) {
    const per = ui.per[key] ?? 8, pages = Math.max(1, Math.ceil(items.length / per));
    if (pin >= 0) ui.pg[key] = Math.floor(pin / per);
    const pg = ui.pg[key] = Math.min(Math.max(0, ui.pg[key] ?? 0), pages - 1);
    const slice = items.slice(pg * per, pg * per + per);
    const box = el('div', { className: 'pagebox', 'data-pager': key, id },
      slice.length ? el('ul', { className: 'list', 'aria-label': label }, slice.map(row)) : el('p', { className: 'empty', textContent: empty }));
    return { box, nav: pages > 1 ? pager(key, pg, pages, label) : null };
  }
  function pager(key, pg, pages, label) {
    const go = (d) => {
      ui.pg[key] = pg + d; disarm();
      const edge = pg + d === 0 || pg + d === pages - 1;
      refresh(`${key}:${edge ? (d < 0 ? 'next' : 'prev') : d < 0 ? 'prev' : 'next'}`);
    };
    return el('div', { className: 'pager', role: 'group', 'aria-label': `${label}: page ${pg + 1} of ${pages}` },
      btn('‹', () => go(-1), { kind: 'ghost mini', k: `${key}:prev`, disabled: pg === 0, aria: 'Previous page' }),
      el('span', { className: 'pnum', textContent: `${pg + 1} / ${pages}`, 'aria-hidden': 'true' }),
      btn('›', () => go(1), { kind: 'ghost mini', k: `${key}:next`, disabled: pg === pages - 1, aria: 'Next page' }));
  }
  const foot = (left, nav, id) => (left || nav ? el('div', { className: 'pfoot', id }, el('div', { className: 'pfoot-l' }, left), nav) : null);
  function fit() {
    let changed = false;
    for (const box of document.querySelectorAll(`#pane-${tab} .pagebox`)) {
      const rows = [...box.querySelectorAll('.list > li')].filter((r) => r.offsetHeight > 0);
      if (!rows.length || !box.clientHeight) continue;
      const open = (r) => r.classList.contains('open');
      const shut = rows.filter((r) => !open(r));
      const unit = Math.min(...(shut.length ? shut : rows).map((r) => r.offsetHeight));
      const over = (list) => list.reduce((n, r) => n + Math.max(0, r.offsetHeight - unit), 0);
      const k = box.dataset.pager, h = box.clientHeight, s = ui.base[k];
      let base = Math.floor((h - over(shut)) / unit);
      if (s?.h === h && s.unit === unit) base = Math.min(base, s.n);
      ui.base[k] = { h, unit, n: base };
      const per = Math.max(3, base - Math.ceil(over(rows.filter(open)) / unit));
      if (per !== ui.per[box.dataset.pager]) { ui.per[box.dataset.pager] = per; changed = true; }
    }
    return changed;
  }

  // ---------------------------------------------------------------- Memory
  function memory() {
    const on = ui.mtab === 'commits' ? 'commits' : 'facts';
    return [
      el('div', { className: 'mhead' },
        tabRow('Memory', 'mem-panel', [['facts', 'What I remember'], ['commits', 'Commitments']], on, (id) => { ui.mtab = id; }),
        link('Get to know me', () => act('intro', true), { k: 'intro', disabled: state.intro })),
      ...(on === 'commits' ? commitList() : factList()),
    ];
  }
  // ---------------------------------------------------------------- Abilities
  const ABILITY_TABS = [['skills', 'Skills'], ['connections', 'Connections'], ['routines', 'Routines']];
  function abilitiesPage() {
    const t = pageTab('abilities', ABILITY_TABS);
    const head = el('div', { className: 'mhead' }, tabRow('Abilities', 'ab-panel', ABILITY_TABS, t, (id) => { ui.tabs.abilities = id; }));
    const { body, foot: end } = t === 'connections' ? connectionsTab() : t === 'routines' ? routinesTab() : skillList();
    return [head, tabPanel('ab-panel', t, ...body), end];
  }
  function skillList() {
    const k = state.skills ?? [];
    const { box, nav } = paged('skills', k, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', title: x.description }, x.name, el('small', { dir: 'auto', textContent: x.description })),
      el('span', { className: 'row-btns' },
        link('View', () => act(`skill:view:${x.slug}`, true), { k: `skill:view:${x.slug}`, aria: `View the skill ${x.name}` }),
        x.readonly ? null : armed('Remove', 'Confirm', `skill:forget:${x.slug}`, `skill:forget:${x.slug}`, `Remove the skill ${x.name}`))),
    { label: 'Skills', empty: `None yet. Say “remember how to do this” after I've done something.` });
    return { body: [el('div', { className: 'group paged' }, box)], foot: foot(k.length ? el('p', { className: 'usage', textContent: `${k.length} skill${k.length === 1 ? '' : 's'}` }) : null, nav) };
  }
  function factList() {
    const f = state.facts ?? [], q = ui.q.trim().toLowerCase();
    const hits = q ? f.filter((x) => x.text.toLowerCase().includes(q)) : f;
    const { box, nav } = paged('facts', hits, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', textContent: x.text, title: x.text }),
      el('span', { className: 'row-btns icons' }, iconArmed('x', 'Forget', `forget:${x.id}`, `forget:${x.id}`, `Forget: ${x.text}`))), { label: 'What I remember', empty: q ? `No match for "${ui.q.trim()}".` : EMPTY, id: 'facts-box' });
    const search = f.length > (ui.per.facts ?? 8) || q ? el('div', { className: 'find' }, el('span', { className: 'px field' },
      el('input', { type: 'search', id: 'find-facts', dir: 'auto', value: ui.q, placeholder: `Search ${f.length} memories`, 'aria-label': 'Search what I remember', autocomplete: 'off', spellcheck: false,
        on: { input: (e) => { ui.q = e.target.value; ui.pg.facts = 0; refreshFacts(); }, keydown: (e) => { if (e.key === 'Escape' && ui.q) { e.preventDefault(); e.stopPropagation(); e.target.value = ui.q = ''; refreshFacts(); } } } }))) : null;
    return [
      el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-facts' }, search, box),
      foot(f.length ? armed('Forget everything', `Forget all ${f.length}`, 'forget-all', 'forgetall:yes', `Forget all ${f.length} things I remember`) : null, nav, 'facts-foot'),
    ];
  }
  function refreshFacts() {
    const [panel, ft] = factList(), box = $('facts-box');
    if (!box) return render();
    box.replaceWith(panel.querySelector('#facts-box'));
    const old = $('facts-foot');
    if (old && ft) old.replaceWith(ft); else if (old) old.remove(); else if (ft) $('mem-panel').after(ft);
    if (fit()) refreshFacts();
  }
  function commitList() {
    const commitments = state.commitments ?? [];
    const { box, nav } = paged('commits', commitments, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', title: x.text }, x.text, x.when ? el('small', { className: x.overdue ? 'late' : '', textContent: x.overdue ? `Overdue · ${x.when}` : x.when }) : null),
      el('span', { className: 'row-btns icons' },
        iconArmed('tick', 'Done', `done:${x.id}`, `done:${x.id}`, `Done: ${x.text}`),
        iconArmed('x', 'Drop', `drop:${x.id}`, `drop:${x.id}`, `Drop: ${x.text}`))), { label: 'Commitments' });
    const n = commitments.length;
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-commits' }, box), foot(n ? el('p', { className: 'usage', textContent: `${n} open` }) : null, nav)];
  }
  const refresh = (focusKey) => (tab === 'memory' && ui.mtab === 'facts' && document.activeElement?.id === 'find-facts' ? refreshFacts() : render(focusKey));

  // ---------------------------------------------------------------- Shared key field
  function keyForm(id, label, onsave) {
    const input = el('input', { type: 'password', id: `key-${id}`, dir: 'auto', autocomplete: 'off', spellcheck: false, placeholder: `${label} key`, 'aria-label': `${label} key`, maxLength: 1000 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v); input.value = ''; closeKey(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } });
    return el('div', { className: 'keyform', hidden: ui.key !== id, 'data-anim': `key-${id}` },
      el('span', { className: 'px field' }, input),
      btn('Save', save, { k: `save:${id}` }));
  }

  // ---------------------------------------------------------------- Harness
  const PILL_LABEL = { ready: 'Ready', 'needs-login': 'Needs login', missing: 'Not installed' };

  function harnessCard(h, activeId) {
    const isActive = activeId === h.id;
    const pill = el('span', { className: `pill ${h.status}`, textContent: PILL_LABEL[h.status] ?? 'Unknown' });
    const cmd = h.status === 'needs-login' ? h.loginCmd : h.status === 'missing' ? h.installCmd : null;
    const meta = h.status === 'ready'
      ? (h.version ? `Installed (${h.version}) and ready.` : 'Installed and authenticated.')
      : (h.reason || (h.status === 'needs-login' ? 'Installed, sign in from your terminal to use.' : 'Not found on your PATH.'));
    const copyBtn = cmd ? link('Copy command', (e) => copyText(cmd, e.currentTarget, `Copied: ${cmd}`), { k: `copy-harness-${h.id}` }) : null;
    return el('div', { className: `px harness-card${isActive ? ' active' : ''}` },
      el('div', { className: 'harness-top' },
        el('span', { className: 'harness-name', textContent: h.label }),
        h.isDefault ? el('span', { className: 'harness-tag', textContent: 'Default' }) : null,
        pill),
      el('p', { className: 'harness-meta', dir: 'auto', textContent: meta }),
      cmd ? el('div', { className: 'harness-cmd-row' },
        el('code', { className: 'harness-cmd', textContent: cmd }),
        copyBtn) : null,
      el('div', { className: 'harness-actions' },
        isActive
          ? el('span', { className: 'status', textContent: 'Selected' })
          : btn(h.status === 'ready' ? 'Use harness' : 'Select', () => sendMenu('set_harness', h.id), { kind: h.status === 'ready' ? 'primary mini' : 'ghost mini', k: `use-harness:${h.id}` }),
        h.status === 'missing' && h.installUrl
          ? link('Docs ↗', () => send({ type: 'open_link', url: h.installUrl }), { k: `docs:${h.id}` })
          : null));
  }

  function customHarnessCard(activeId) {
    const saved = state.customHarness ?? { command: '', args: '', protocol: 'acp' };
    const sig = JSON.stringify(saved);
    if (!ui.custom || ui.customKey !== sig) {
      ui.customKey = sig;
      ui.custom = {
        command: saved.command ?? '',
        args: Array.isArray(saved.args) ? saved.args.join(' ') : (saved.args ?? ''),
        protocol: saved.protocol === 'cli' ? 'cli' : 'acp',
      };
    }
    const c = ui.custom;
    const isActive = activeId === 'custom';
    const saveCustom = () => {
      const command = c.command.trim();
      if (!command) return $('custom-cmd')?.focus();
      const args = c.args.trim() ? c.args.trim().split(/\s+/) : [];
      sendMenu('set_custom_harness', { command, args, protocol: c.protocol });
      sendMenu('set_harness', 'custom');
      note(`Saved custom ${c.protocol.toUpperCase()} harness (${command}).`);
    };
    return el('div', { className: `px harness-card${isActive ? ' active' : ''}` },
      el('div', { className: 'harness-top' },
        el('span', { className: 'harness-name', textContent: 'Custom ACP / CLI' }),
        el('span', { className: `pill ${saved.command ? 'ready' : 'missing'}`, textContent: saved.command ? 'Configured' : 'Optional' })),
      el('p', { className: 'harness-meta', textContent: 'Bring any ACP-compatible stdio agent or one-shot CLI binary.' }),
      el('div', { className: 'custom-acp' },
        el('div', { className: 'custom-acp-grid' },
          el('span', { className: 'px field' }, el('input', {
            id: 'custom-cmd', type: 'text', dir: 'auto', value: c.command, placeholder: 'Command (e.g. agy)', 'aria-label': 'Custom harness command',
            autocomplete: 'off', spellcheck: false,
            on: { input: (e) => { c.command = e.target.value; } },
          })),
          el('span', { className: 'px field' }, el('input', {
            id: 'custom-args', type: 'text', dir: 'auto', value: c.args, placeholder: 'Args (e.g. acp --stdio)', 'aria-label': 'Custom harness arguments',
            autocomplete: 'off', spellcheck: false,
            on: { input: (e) => { c.args = e.target.value; } },
          }))),
        el('div', { className: 'setting' },
          el('span', { id: 'lbl-custom-proto' }, 'Protocol', el('small', { textContent: c.protocol === 'acp' ? 'ACP stdio JSON-RPC' : 'One-shot CLI prompt' })),
          picks('Custom protocol', [['acp', 'ACP'], ['cli', 'CLI']], c.protocol, (v) => { c.protocol = v; render('custom-proto'); }, 'custom-proto')),
        el('div', { className: 'harness-actions' },
          btn(isActive ? 'Save custom' : 'Save & use custom', saveCustom, { kind: isActive ? 'ghost mini' : 'primary mini', k: 'save-custom-harness' }),
          !isActive && saved.command ? link('Use saved', () => sendMenu('set_harness', 'custom'), { k: 'use-custom-harness' }) : null)));
  }

  function harnessPage() {
    const harnesses = normalizeHarnesses();
    const activeId = state.harness ?? 'agy';
    const allow = !!(state.allowActions ?? state.actions);
    return [
      el('div', { className: 'group' },
        el('div', { className: 'harness-head' },
          el('div', { className: 'ghead' },
            el('h2', { textContent: 'CLI Harnesses' }),
            el('p', { textContent: 'Auto-detected from your PATH. Antigravity (agy) is the default runtime.' })),
          btn(ui.scanning ? 'Scanning…' : 'Re-scan Harnesses', () => {
            ui.scanning = true;
            render('detect-harnesses');
            sendMenu('detect_harnesses');
            setTimeout(() => { if (ui.scanning) { ui.scanning = false; if (tab === 'harness') render(); } }, 2500);
          }, { kind: 'ghost mini', k: 'detect-harnesses', disabled: ui.scanning })),
        el('div', { className: 'harness-list' },
          harnesses.map((h) => harnessCard(h, activeId)),
          customHarnessCard(activeId))),
      group('Action Permissions', 'Control whether Yomna stays read-only or can make changes on your computer.', null,
        toggle('Allow Actions (Edit Mode)',
          allow
            ? 'On: Yomna can edit files, run commands, and control apps (risky UI clicks still ask).'
            : 'Off (read-only): Yomna can read, explain, and answer, but never edits files or clicks apps.',
          allow,
          () => sendMenu('set_allow_actions', !allow),
          'allow-actions')),
    ];
  }

  // ---------------------------------------------------------------- Appearance
  const SIZE_TIPS = { default: 'My full size.', small: 'Half my size, so I take less of your screen.', cursor: 'I become a little arrow pointer, like your cursor.' };
  const DEFAULT_LOOKS = [['yomna', 'Yomna'], ['glayos', 'GlayOS'], ['ultren', 'Ultren'], ['sarah', 'Sarah'], ['adrian', 'Adrian'], ['rita', 'Rita X']];
  function appearancePage() {
    const tabs = [['look', 'Look'], ['size', 'Size']], t = pageTab('appearance', tabs);
    const head = el('div', { className: 'mhead' }, tabRow('Appearance', 'look-panel', tabs, t, (id) => { ui.tabs.appearance = id; }));
    return [head, tabPanel('look-panel', t, t === 'look'
      ? group(null, 'Each look has its own name and voice.', null, lookTiles())
      : group(null, 'How big I am on your screen.', null, picks('Size', state.sizes ?? [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']], state.size ?? 'default', (x) => act(`size:${x}`), 'size', SIZE_TIPS)))];
  }
  const tiles = new Map();
  function lookTiles() {
    const g = tiles.get('_group') ?? el('div', { className: 'looks', role: 'radiogroup', 'aria-label': 'Look' });
    tiles.set('_group', g);
    const looks = (state.looks?.length ? state.looks : DEFAULT_LOOKS).map(([id, name]) => id === 'jarvis' ? ['yomna', 'Yomna'] : [id, name]);
    g.replaceChildren(...looks.map(([id, name]) => {
      let t = tiles.get(id);
      if (!t) {
        const cv = el('canvas', { 'aria-hidden': 'true' });
        const b = el('button', { className: 'px looktile', type: 'button', role: 'radio', 'data-k': `look:${id}` }, cv, el('span', { className: 'name', textContent: name }));
        const r = liveAvatar(cv, 104, 76, { look: id, y: 0.55, form: state.size ?? 'default' });
        t = { b, r, waved: 0 };
        const wave = () => { if (r && Date.now() - t.waved > 3500) { t.waved = Date.now(); r.act('wave'); } };
        b.addEventListener('pointerenter', wave);
        b.addEventListener('focus', () => b.matches(':focus-visible') && wave());
        b.addEventListener('click', () => { if (state.look !== id) { r?.act('hype'); act(`look:${id}`); } });
        tiles.set(id, t);
        r?.appear('crt');
      }
      t.r?.setForm(state.size ?? 'default');
      const on = (state.look ?? 'yomna') === id;
      t.b.setAttribute('aria-checked', String(on)); t.b.tabIndex = on ? 0 : -1;
      t.b.dataset.tip = on ? `I'm ${name} now.` : `Switch me to ${name}, with ${name}'s own voice.`;
      return t.b;
    }));
    return g;
  }

  // ---------------------------------------------------------------- Speaking & Live
  const DEFAULT_LOCAL_VOICES = [
    { id: 'en_US-amy-medium', name: 'Amy (US English · Piper)' },
    { id: 'af_heart', name: 'Heart (US English · Kokoro)' },
    { id: 'ar_JO-kareem-medium', name: 'Kareem (Arabic · Piper)' },
  ];
  const DEFAULT_EDGE_VOICES = [
    { id: 'ar-MA-MounaNeural', name: 'Mouna · Moroccan Arabic (ar-MA)' },
    { id: 'ar-MA-JamalNeural', name: 'Jamal · Moroccan Arabic (ar-MA)' },
    { id: 'en-US-AvaMultilingualNeural', name: 'Ava Multilingual (en-US)' },
    { id: 'en-US-AvaNeural', name: 'Ava (en-US)' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia (en-GB)' },
    { id: 'ar-SA-ZariyahNeural', name: 'Zariyah · Arabic (ar-SA)' },
  ];

  function studioRows() {
    const vs = state.studio ?? { checking: true };
    const status = vs.checking ? 'Checking VoiceStudio…' : vs.ok ? `Connected${vs.engine ? ` · ${vs.engine}` : ''}` : vs.message || "VoiceStudio isn't available.";
    const voices = vs.voices ?? [];
    const name = state.name || 'Yomna';
    return [
      el('div', { className: 'setting' },
        el('span', {}, 'VoiceStudio', el('small', { className: vs.ok || vs.checking ? '' : 'bad', textContent: status, role: vs.ok || vs.checking ? null : 'alert' })),
        el('span', { className: 'row-btns' }, link('Check again', () => act('voicestudio_check'), { k: 'voicestudio_check', aria: 'Check VoiceStudio again' }))),
      vs.ok ? el('div', { className: 'reveal', 'data-anim': 'studio-voice' },
        el('p', { className: 'sub', textContent: `Voice for ${name}` }),
        el('span', { className: 'px field select' },
          el('select', { 'aria-label': 'VoiceStudio voice', 'data-k': 'studiovoice', on: { change: (e) => act(`studiovoice:${e.target.value}`) } },
            el('option', { value: 'default', textContent: 'Engine default', selected: !vs.voice || !voices.some((x) => x.id === vs.voice) }),
            voices.map((x) => el('option', { value: x.id, textContent: x.name, selected: x.id === vs.voice })))),
        voices.length ? null : el('p', { className: 'why', textContent: 'Save a voice in VoiceStudio (clone or design one) to pick it here.' }),
      ) : null,
    ];
  }

  function speakingPage() {
    const hasGeminiKey = !!(state.geminiKey || state.geminiShared);
    const voiceMode = state.voiceMode === 'live' ? 'live' : 'classic';
    const ttsProviders = [
      ['local', 'Local Voice'],
      ['edge', 'Edge TTS'],
      ['voicestudio', 'VoiceStudio'],
      ...(hasGeminiKey ? [['gemini', 'Gemini TTS']] : []),
    ];
    const tts = ttsProviders.some(([id]) => id === state.tts) ? state.tts : 'local';
    const localVoices = state.localTtsStatus?.voices?.length ? state.localTtsStatus.voices : DEFAULT_LOCAL_VOICES;
    const localVoice = state.localTtsVoice ?? localVoices[0].id;
    const edgeList = state?.edgeTtsVoices ?? state?.edgeVoices;
    const edgeVoices = edgeList?.length ? edgeList : DEFAULT_EDGE_VOICES;
    const edgeVoice = state.edgeTtsVoice ?? 'en-US-AvaMultilingualNeural';
    const name = state.name || 'Yomna';
    const localStatus = state.localTtsStatus;
    const localDesc = !localStatus
      ? 'Offline Kokoro / Piper voice on this computer. Zero API keys.'
      : localStatus.ok
        ? `Ready${localStatus.engine ? ` · ${localStatus.engine}` : ''} (offline & free)`
        : localStatus.message || 'Install piper or kokoro-onnx, or let Yomna download a voice model.';

    return [
      group('Voice Mode', 'Classic works offline with no API key. Gemini Live streams real-time audio on Linux, Windows, and macOS.', null,
        picks('Voice mode', [['classic', 'Classic (No API Key)'], ['live', 'Gemini Live (Free AI Studio Key)']], voiceMode, (x) => {
          if (x === 'live' && !hasGeminiKey) { ui.key = 'gemini'; note('Add a free Google AI Studio key to start Gemini Live.'); }
          sendMenu('set_voice_mode', x);
        }, 'voicemode', {
          classic: 'Keyless Parakeet STT + CLI harness + Local/Edge TTS. Works everywhere offline.',
          live: 'Real-time two-way voice with Gemini Live on Linux, Windows, and macOS using a free Google AI Studio key.',
        }),
        voiceMode === 'live' && !hasGeminiKey
          ? el('p', { className: 'why late', role: 'status', textContent: 'Add your Google AI Studio key below to enable Gemini Live.' })
          : null,
        voiceMode === 'live' && state.geminiVoices?.length ? el('div', { className: 'reveal', 'data-anim': 'live-voice' },
          el('p', { className: 'sub', textContent: 'Gemini Live voice' }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'Gemini Live voice', 'data-k': 'livevoice', on: { change: (e) => act(`livevoice:${e.target.value}`) } },
              state.geminiVoices.map((g) => el('option', { value: g.id, textContent: `${g.id} · ${g.style}`, selected: g.id === (state.liveVoice ?? state.geminiVoice) }))))) : null),

      group('Spoken Replies', 'Hear Yomna speak as well as read text.', null,
        picks('Replies', [['text', 'Text only'], ['voice', 'Voice and text']], state.replies ?? 'voice', (x) => act(`replies:${x}`), 'replies', {
          text: 'Answers appear as text only.',
          voice: 'Yomna speaks replies out loud using the selected TTS provider.',
        }),
        el('p', { className: 'sub', textContent: 'TTS Provider' }),
        picks('TTS provider', ttsProviders, tts, (x) => sendMenu('set_tts', x), 'tts', {
          local: 'Kokoro / Piper offline neural voices. Free, private, no API key.',
          edge: 'Free Microsoft Edge neural voices including English and Moroccan Arabic (ar-MA).',
          voicestudio: 'Free local VoiceStudio app with your own custom or cloned voices.',
          gemini: 'Google Gemini voices using your saved AI Studio key.',
        }),
        tts === 'local' ? el('div', { className: 'reveal', 'data-anim': 'local-tts' },
          el('p', { className: 'why wrap', textContent: localDesc }),
          el('p', { className: 'sub', textContent: 'Local voice' }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'Local TTS voice', 'data-k': 'localvoice', on: { change: (e) => sendMenu('set_local_tts_voice', e.target.value) } },
              localVoices.map((v) => el('option', { value: v.id, textContent: v.name, selected: v.id === localVoice }))))) : null,
        tts === 'edge' ? el('div', { className: 'reveal', 'data-anim': 'edge-tts' },
          el('p', { className: 'why wrap', textContent: 'Free neural voices, including Moroccan Arabic (ar-MA) and English.' }),
          el('p', { className: 'sub', textContent: 'Edge voice' }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'Edge TTS voice', 'data-k': 'edgevoice', on: { change: (e) => sendMenu('set_edge_tts_voice', e.target.value) } },
              edgeVoices.map((v) => el('option', { value: v.id, dir: 'auto', textContent: v.name, selected: v.id === edgeVoice }))))) : null,
        tts === 'voicestudio' ? el('div', { className: 'reveal', 'data-anim': 'studio' }, studioRows()) : null,
        tts === 'voicestudio' ? el('div', { className: 'reveal', 'data-anim': 'studio-speak' },
          el('p', { className: 'sub', textContent: 'How much it speaks' }),
          picks('How much it speaks', [['short', 'Short'], ['medium', 'Medium'], ['full', 'Everything']], state.voice?.studioSpeak ?? 'short', (x) => act(`studiospeak_${x}`), 'studiospeak'),
          el('p', { className: 'why wrap', textContent: 'VoiceStudio is slow. The full answer always shows as text.' })) : null,
        tts === 'gemini' && hasGeminiKey && state.geminiVoices?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-voice' },
          el('p', { className: 'sub', textContent: `Voice for ${name}` }),
          el('span', { className: 'px field select' },
            el('select', { 'aria-label': 'Gemini voice', 'data-k': 'geminivoice', on: { change: (e) => act(`geminivoice:${e.target.value}`) } },
              state.geminiVoices.map((g) => el('option', { value: g.id, textContent: `${g.id} · ${g.style}`, selected: g.id === state.geminiVoice })))),
        ) : null,
        tts === 'gemini' && hasGeminiKey && state.geminiModels?.length ? el('div', { className: 'reveal', 'data-anim': 'gemini-model' },
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.geminiModels.map((c) => [c.id, c.name]), state.geminiModel, (x) => act(`geminimodel:${x}`), 'geminimodel',
            Object.fromEntries(state.geminiModels.map((c) => [c.id, `${GEMINI_WHY_LONG[c.id] ?? ''} ${geminiPrice(c)}`.trim()]))),
          el('p', { className: 'why', textContent: GEMINI_WHY[state.geminiModel] ?? '' }),
        ) : null),

      group('Google AI Studio Key (Optional)', 'Only needed for Gemini Live or Gemini TTS. Classic Mode and local voices are 100% keyless.', null,
        el('div', { className: 'setting' },
          el('span', {}, 'AI Studio key', el('small', { textContent: hasGeminiKey ? `Saved in ${where()}` : 'Optional · Free tier at aistudio.google.com' })),
          el('span', { className: 'row-btns' },
            link('Get free key ↗', () => send({ type: 'open_link', url: 'https://aistudio.google.com/apikey' }), { k: 'get-gemini-key' }),
            link(ui.key === 'gemini' ? 'Cancel' : hasGeminiKey ? 'Change' : 'Add', () => toggleKey('gemini'), { k: 'addkey:gemini', aria: hasGeminiKey ? 'Change the Google AI Studio key' : 'Add a Google AI Studio key' }),
            hasGeminiKey && ui.key !== 'gemini' ? armed('Remove', 'Confirm', 'geminikey-remove', 'geminikey_remove', 'Remove the Google AI Studio key') : null)),
        keyForm('gemini', 'Google AI Studio', (key) => sendMenu('set_gemini_key', key))),
    ];
  }

  // ---------------------------------------------------------------- Listening
  function micPicker(v) {
    if (!v.mics?.length) return null;
    const gone = v.mic && !v.mics.some((m) => m.id === v.mic);
    return el('div', { className: 'reveal', 'data-anim': 'mic' },
      el('p', { className: 'sub', textContent: 'Microphone' }),
      el('span', { className: 'px field select' },
        el('select', { 'aria-label': 'Microphone', 'data-k': 'mic', on: { change: (e) => act(`mic:${e.target.value}`) } },
          el('option', { value: '', textContent: v.micAuto ? `Automatic (${v.micAuto})` : 'Automatic', selected: !v.mic }),
          v.mics.map((m) => el('option', { value: m.id, textContent: m.name, selected: m.id === v.mic })),
          gone ? el('option', { value: v.mic, textContent: 'Picked mic (unplugged, using automatic)', selected: true }) : null)));
  }
  const SPEAK_LANGS = [['auto', 'Automatic (system languages)'], ['en-US', 'English'], ['ar-MA', 'الدارجة · Moroccan Arabic'], ['ar-SA', 'العربية · Arabic'], ['he-IL', 'עברית · Hebrew'],
    ['es-ES', 'Español · Spanish'], ['fr-FR', 'Français · French'], ['de-DE', 'Deutsch · German'], ['it-IT', 'Italiano · Italian'],
    ['pt-BR', 'Português · Portuguese'], ['ja-JP', '日本語 · Japanese'], ['ko-KR', '한국어 · Korean'], ['zh-CN', '中文 · Chinese'], ['hi-IN', 'हिन्दी · Hindi']];
  const SPEAK_ONLINE = 'This language goes to Apple\'s servers. Add it under Dictation in System Settings to keep it on this Mac.';
  function speakPicker(v) {
    const lang = v.lang ?? 'auto';
    const online = v.langOnline === true || (['ar-SA', 'ar-MA', 'he-IL'].includes(lang) && v.langOnline == null);
    return el('div', { className: 'reveal', 'data-anim': 'speakin' },
      el('p', { className: 'sub', textContent: 'Speak in' }),
      el('p', { className: 'why wrap', textContent: 'The language you talk to me in.' }),
      el('span', { className: 'px field select' },
        el('select', { 'aria-label': 'Language I speak', 'data-k': 'speechlang', on: { change: (e) => act(`speechlang:${e.target.value}`) } },
          SPEAK_LANGS.map(([code, label]) => el('option', { value: code, textContent: label, dir: 'auto', selected: code === lang })))),
      online ? el('p', { className: 'why wrap', role: 'status', textContent: SPEAK_ONLINE }) : null);
  }
  const BIND_ROWS = [['talk', 'Talk to me'], ['summon', 'Show or hide me'], ['ask', 'Ask me'], ['list', 'Your list'], ['panel', 'This panel']];
  function listeningPage() {
    const v = state.voice;
    if (!v) return [group('Listening', 'Voice input isn’t available on this computer.', null)];
    const needs = (hint) => (v.on ? hint : 'Needs Voice control on');
    const tabs = [['talking', 'Talking'], ['handsfree', 'Hands-free']], t = pageTab('listening', tabs);
    const head = el('div', { className: 'mhead' }, tabRow('Listening', 'listen-panel', tabs, t, (id) => { ui.tabs.listening = id; }));
    return [head, tabPanel('listen-panel', t, t === 'talking'
      ? group(null, 'Speak instead of typing.', null,
        toggle('Voice control', v.download
          ? (v.download.status === 'downloading' ? `Downloading the voice model… ${v.download.pct}%` : v.download.status === 'error' ? 'The download failed' : `Needs a ${v.download.size} download`)
          : v.keys ? `Hold ${v.keys} to talk` : 'Press your talk shortcut to talk', v.on, () => act('voice'), 'voice'),
        v.download && v.download.status !== 'downloading' ? el('div', { className: 'links' }, link(v.download.status === 'error' ? 'Retry the download' : `Download (${v.download.size})`, () => act('voicedl'), { k: 'voicedl' })) : null,
        micPicker(v),
        v.mac ? toggle('Mute Mac while talking', 'Other sounds go quiet while you talk', v.mute, () => act('mutetalk'), 'mutetalk') : null,
        v.mac && v.on ? speakPicker(v) : null)
      : group(null, 'When the mic opens without a key.', null,
        toggle('Auto-listen', needs(v.listenEvery ? 'Mic opens after every spoken reply.' : 'Mic opens when I ask you something.'), v.autoListen, () => act('autolisten'), 'autolisten'),
        v.autoListen && v.listenChoices ? el('div', { className: 'reveal', 'data-anim': 'listen-more' },
          toggle('After every reply', needs('Not just questions, so you can keep talking.'), v.listenEvery, () => act('listenevery'), 'listenevery'),
          el('p', { className: 'sub', textContent: 'Mic waits for you' }),
          picks('Mic waits for you', v.listenChoices.map((s) => [String(s), `${s} s`]), String(v.listenSecs), (x) => act(`listensecs:${x}`), 'listensecs')) : null,
        toggle('Listen after reminders', needs('Mic opens after a reminder, so you can say “snooze 10 minutes”.'), v.snoozeListen, () => act('snoozelisten'), 'snoozelisten'),
        v.wake ? toggle('Wake word', needs(`Say “Hey ${v.wakeName || 'Yomna'}” to talk. Mic stays on.`), v.wakeWord, () => act('wakeword'), 'wakeword') : null,
        v.wake ? el('div', { className: 'setting' }, el('span', {}, 'Wake word name', el('small', { textContent: `Hey ${v.wakeName || 'Yomna'}` })),
          link('Change', () => act('wakename'), { k: 'wakename', aria: 'Change the wake word name' })) : null))];
  }

  // ---------------------------------------------------------------- Shortcuts
  const SHORTCUT_LABELS = { summon: 'Show or hide me', snap: 'Ask about an area', list: 'Your list' };
  function shortcutsPage() {
    const b = state.bind, sc = state.shortcuts, w = state.writeKeys;
    if (b) {
      return [group('Shortcuts', 'Add these as custom shortcuts in your keyboard settings, with any keys you like.', null,
        BIND_ROWS.filter(([k]) => b[k]).map(([k, label]) => el('div', { className: 'setting' },
          el('span', {}, label, ui.bindShown.has(k) ? el('small', { className: 'cmd', textContent: b[k] }) : null),
          link('Copy', () => send({ type: 'copy_bind', which: k }), { k: `bind-${k}`, aria: `Copy the command for ${label.toLowerCase()}` }))))];
    }
    if (!sc) return [group('Shortcuts', 'This computer doesn’t allow shortcuts that work from anywhere.', null)];
    return [
      sc.talk ? group('Talk', 'Hold two keys to talk. Tap them to talk hands-free.', null,
        picks('Talk keys', sc.talk.pairs, sc.talk.value, (x) => act(`talk:${x}`), 'talk',
          Object.fromEntries(sc.talk.pairs.map(([id, keys]) => [id, `Hold ${keys} to talk. If they’re your typing keys, the two swap.`])))) : null,
      sc.highlight ? group('Highlight', 'Hold two keys and move the cursor round something to show me.', null,
        el('div', { className: 'setting' }, el('span', {}, sc.highlight.words ?? 'Off',
          el('small', { className: 'wrap', textContent: sc.highlight.note })))) : null,
      w ? group('Type to me', 'Tap two keys together to open a text box by the cursor.', null,
        picks('Type-to-ask keys', [...w.pairs, ['off', 'Off']], w.value, (x) => act(`write:${x}`), 'write',
          Object.fromEntries([...w.pairs.map(([id, keys]) => [id, `Tap ${keys} together, anywhere, to type to me.`]),
            ['off', 'No tap opens the text box, so the keys stay free for other apps. The Ask button on Home still opens it.']]))) : null,
      group('Other keys', 'Press Change, then the new keys. Esc cancels.', null,
        sc.keys.map(({ id, words }) => {
          const rec = ui.rec === id, label = SHORTCUT_LABELS[id] ?? id;
          return el('div', { className: `setting${rec ? ' recording' : ''}` },
            el('span', {}, label, el('small', { textContent: rec ? 'Press the new keys…' : words, 'aria-live': rec ? 'polite' : null })),
            link(rec ? 'Cancel' : 'Change', () => { ui.rec = rec ? null : id; render(`rec-${id}`); }, { k: `rec-${id}`, aria: rec ? `Stop changing the keys for ${label.toLowerCase()}` : `Change the keys for ${label.toLowerCase()}` }));
        })),
    ];
  }

  // ---------------------------------------------------------------- Routines & Connections
  function routinesTab() {
    const f = state.focus;
    return { body: [
      group(null, 'Things I do on my own through the day.', null,
        state.brief ? toggle('Morning briefing', 'The first time you talk to me each day, I start with what’s due.', state.brief.on, () => act('morningbrief'), 'morningbrief') : null,
        state.brief?.on && state.brief.canTodoist ? toggle('Include Todoist', 'I read your Todoist window (opening it if needed). Stay signed in.', state.brief.todoist, () => act('brieftodoist'), 'brieftodoist') : null,
        f ? el('div', { className: 'setting' },
          el('span', {}, f.until ? 'Focus block running' : 'Focus distractions',
            el('small', { className: 'wrap', textContent: f.until ? `Until ${new Date(f.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${f.task ? ` · ${f.task}` : ''}` : `Say “focus for 30 minutes”. I watch for: ${f.list.slice(0, 4).join(', ')}${f.list.length > 4 ? '…' : ''}` })),
          f.until ? link('Stop', () => act('focusstop'), { k: 'focusstop', aria: 'Stop the focus block' }) : link('Edit', () => act('distractions'), { k: 'distractions', aria: 'Edit the distraction list' })) : null),
      jobGroup(),
    ] };
  }
  function jobGroup() {
    const jobs = state.jobs ?? [];
    return group('Scheduled jobs', 'Work an agent does for you at set times. Ask me to schedule one.', jobs.length || null,
      jobs.length ? el('ul', { className: 'list', 'aria-label': 'Scheduled jobs' }, jobs.map((j) => el('li', { className: 'item mem' },
        el('span', { className: 'text', dir: 'auto', title: j.title }, j.title,
          el('small', { textContent: `${j.next}${j.repeat ? ` · ↻ ${j.repeat}` : ''}` }),
          j.last ? el('small', { className: j.bad ? 'late' : '', textContent: j.last, title: j.last }) : null),
        el('span', { className: 'row-btns' },
          link('Run now', () => act(`job:run:${j.id}`), { k: `job:run:${j.id}`, aria: `Run ${j.title} now` }),
          link(j.paused ? 'Resume' : 'Pause', () => act(`job:${j.paused ? 'resume' : 'pause'}:${j.id}`), { k: `job:pause:${j.id}`, aria: `${j.paused ? 'Resume' : 'Pause'} ${j.title}` }),
          armed('Remove', 'Confirm', `job:remove:${j.id}`, `job:remove:${j.id}`, `Remove ${j.title}`))))) : el('p', { className: 'empty', textContent: 'No scheduled jobs yet.' }));
  }
  const CONN_STATE = {
    connected: (x) => `Connected · ${x.toolCount} tool${x.toolCount === 1 ? '' : 's'}`,
    'needs-login': () => 'Needs sign-in',
    'needs-key': (x) => `Needs a key${x.error ? ` (${x.error.replace(/^needs /, '')})` : ''}`,
    error: (x) => `Not working: ${x.error ?? 'no answer'}`,
    off: () => 'Off',
    connecting: () => 'Connecting…',
    idle: () => 'Not connected yet',
  };
  function connectionsTab() {
    const list = state.connections ?? [];
    const { box, nav } = paged('connections', list, (x) => {
      const bad = x.state === 'error' || x.state === 'needs-key' || x.state === 'needs-login';
      return el('li', { className: 'acct' }, el('div', { className: 'setting' },
        el('span', { id: `lbl-mcp-${x.name}` }, el('span', { className: 'acct-name' }, x.name, x.state === 'connected' ? el('span', { className: 'led on', role: 'img', 'aria-label': 'Connected', 'data-tip': 'Connected' }) : null),
          el('small', { className: bad ? 'late' : '', textContent: (CONN_STATE[x.state] ?? CONN_STATE.idle)(x), title: x.where })),
        el('span', { className: 'row-btns' },
          x.state === 'needs-login' ? link('Sign in', () => act(`mcp:login:${x.name}`, true), { k: `mcp:login:${x.name}`, aria: `Sign in to ${x.name}` }) : null,
          armed('Remove', 'Confirm', `mcp:remove:${x.name}`, `mcp:remove:${x.name}`, `Remove the ${x.name} connection and its keys`),
          el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!x.enabled), 'aria-labelledby': `lbl-mcp-${x.name}`, 'data-k': `mcp:sw:${x.name}`,
            on: { click: () => act(`mcp:${x.enabled ? 'off' : 'on'}:${x.name}`) } }))));
    }, { label: 'Connections', empty: 'No apps connected yet.' });
    return {
      body: [group(null, 'Apps like Linear and Notion I can use for you.', null), el('div', { className: 'group paged' }, box)],
      foot: foot(btn('Connect an app', () => act('askconnect', true), { k: 'askconnect' }), nav),
    };
  }

  // ---------------------------------------------------------------- General
  function generalPage() {
    const allow = !!(state.allowActions ?? state.actions);
    return [
      group('General', 'How Yomna behaves and starts.', null,
        toggle('Sound effects', null, state.sound, () => act('sound'), 'sound'),
        state.notch != null ? group('Where I appear', 'Beside your cursor, or from the top of the screen.', null,
          picks('Where I appear', [['off', 'Beside the cursor'], ['drop', 'Capsule'], ...(state.notchReal ? [['spread', 'Notch']] : [])], state.notch, (x) => act(`notch_${x}`), 'notch',
            { off: 'Everything beside your cursor, as usual.', spread: 'Everything in the notch, widening sideways.', drop: state.notchReal ? 'Everything in a capsule that drops from the notch.' : 'Everything in a capsule at the top of the screen.' })) : null,
        state.gameMode != null ? toggle('Game mode', 'In a fullscreen game, I move to a panel at the edge of the screen.', state.gameMode, () => act('gamemode'), 'gamemode') : null,
        toggle('Allow file edits and commands', 'Change files, run commands, and control apps', allow, () => sendMenu('set_allow_actions', !allow), 'actions'),
        allow ? toggle('Skip Allow prompts', 'Go ahead without asking first. Blocked steps stay blocked.', state.skipAllow, () => act('skipallow'), 'skipallow') : null,
        state.learnSkills != null ? toggle('Learn skills', 'After a long task that worked, I keep the how-to for next time.', state.learnSkills, () => act('learnskills'), 'learnskills') : null,
        state.login ? toggle('Open at login', null, state.login.on, () => act('login'), 'login') : null,
        state.sync ? el('div', { className: 'setting' },
          el('span', {}, 'Sync memory', el('small', { title: state.sync.dir, textContent: !state.sync.dir ? 'Share reminders and memory with your other computer' : state.sync.error ? `Not syncing: ${state.sync.error}` : `Via ${state.sync.dir.split(/[\\/]/).filter(Boolean).pop()}${state.sync.at ? ` · ${new Date(state.sync.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` })),
          state.sync.dir ? [state.sync.paused ? link('Sync anyway', () => act('syncallow'), { k: 'syncallow', danger: true, aria: 'Sync anyway, removing those items on every computer' }) : null,
            link('Stop', () => act('syncstop'), { k: 'syncstop', aria: 'Stop syncing memory' })] : link('Set up', () => act('syncsetup'), { k: 'syncsetup', aria: 'Set up memory sync' })) : null),
      group('Help & About', null, null,
        el('div', { className: 'links' },
          link('Setup guide', () => act('setup', true), { k: 'setup' }),
          link('Show logs', () => act('logs'), { k: 'logs' }),
          link('Save diagnostics', () => act('diagnostics'), { k: 'diagnostics', aria: 'Save a diagnostics file to send when something goes wrong' }),
          link('GitHub & Issues ↗', () => send({ type: 'open_link', url: 'https://github.com/aammo1/yomna/issues' }), { k: 'github-issues' }),
          state.problem ? link('Copy last error', copyProblem, { k: 'copy-problem' }) : null),
        el('p', { className: 'footer-note', textContent: 'AGPL-3.0 Open Source · Created with Antigravity' })),
    ];
  }

  // ---------------------------------------------------------------- Second brain
  const SB_LOCS = [
    ['root', 'Root', 'Its rules (AGENTS.md); relative file paths start here'],
    ['raw', 'Raw evidence', 'Unedited proof: I read it, never change it', '_raw'],
    ['context', 'Context (wiki)', 'Summarised memory, words only', '_context'],
    ['research', 'Research', 'Write-ups built from the context', '_research'],
    ['projects', 'Projects', 'Each one self-contained', 'projects'],
    ['agents', 'Agents folder', 'Its skills/ folder is listed beside your skills', '.agents'],
  ];
  const SB_STATUS = { found: 'Found', missing: 'Missing', 'will create': 'Will create' };
  const sepOf = (p) => (/^[a-z]:\\/i.test(p) || (p.includes('\\') && !p.includes('/')) ? '\\' : '/');
  const joinPath = (dir, name) => (dir && name ? `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}` : '');
  function sbInit() {
    const b = state.secondBrain ?? {}, saved = b.saved ?? {}, using = b.using ?? {};
    const form = Object.fromEntries(SB_LOCS.map(([k]) => [k, saved[k] || using[k] || '']));
    ui.sb = { savedKey: JSON.stringify(b.saved ?? null), mode: 'existing', form, over: new Set(SB_LOCS.map(([k]) => k).filter((k) => k !== 'root' && saved[k])), parent: b.home ? joinPath(b.home, 'Desktop') : '', name: b.name || 'Second Brain', status: null, found: {}, seq: 0, fill: false };
    if (form.root) sbCheck();
  }
  function sbCheck(fill = false) {
    const sb = ui.sb;
    sb.seq += 1; if (fill) sb.fill = true;
    send({ type: 'secondbrain', op: 'check', mode: sb.mode, form: sb.form, seq: sb.seq });
  }
  function sbDefaults() {
    const sb = ui.sb, root = joinPath(sb.parent, sb.name.trim());
    sb.form.root = root;
    for (const [k, , , name] of SB_LOCS) if (k !== 'root' && !sb.over.has(k)) sb.form[k] = root ? joinPath(root, name) : '';
  }
  function sbMode(m) {
    const sb = ui.sb;
    if (sb.mode === m) return;
    sb.mode = m; sb.over.clear(); sb.status = null;
    if (m === 'create') sbDefaults(); else { const b = state.secondBrain ?? {}; for (const [k] of SB_LOCS) sb.form[k] = b.saved?.[k] || b.using?.[k] || ''; }
    render(`sbmode:${m}`);
    if (sb.form.root) sbCheck(m === 'existing');
  }
  const pickFor = (title, start) => invoke('pick_folder', { title, start: start || state.secondBrain?.using?.root || null }).catch(() => null);
  async function sbChoose(k) {
    const sb = ui.sb, label = SB_LOCS.find(([x]) => x === k)[1];
    const dir = await pickFor(k === 'root' ? 'Choose your second brain folder' : `Choose the ${label.toLowerCase()} folder`, sb.form[k] || sb.form.root);
    if (!dir) return;
    sb.form[k] = dir;
    if (k === 'root') { for (const [x] of SB_LOCS) if (x !== 'root' && !sb.over.has(x)) sb.form[x] = ''; } else sb.over.add(k);
    render(`sbpick:${k}`); sbCheck(k === 'root');
  }
  async function sbParent() {
    const dir = await pickFor('Choose where to make your second brain', ui.sb.parent);
    if (!dir) return;
    ui.sb.parent = dir; sbDefaults(); render('sbparent'); sbCheck();
  }
  function sbAuto(k) {
    const sb = ui.sb;
    sb.over.delete(k);
    if (sb.mode === 'create') sbDefaults(); else sb.form[k] = sb.found?.[k] || '';
    render(`sbpick:${k}`); sbCheck();
  }
  let sbTimer = 0;
  function onBrain(m) {
    const sb = ui.sb;
    if (!sb) return;
    if (m.op === 'created') { ui.sb = null; return; }
    if (m.op !== 'check' || m.seq !== sb.seq) return;
    sb.status = m.status; sb.found = m.found ?? {};
    if (sb.fill && sb.mode === 'existing') {
      sb.fill = false;
      for (const [k] of SB_LOCS) if (k !== 'root' && !sb.over.has(k)) sb.form[k] = sb.found[k] || '';
      return sbCheck();
    }
    if (tab === 'secondbrain') render();
  }
  function sbRow(k, label, hint) {
    const sb = ui.sb, st = sb.status?.[k], p = sb.form[k];
    const create = sb.mode === 'create', over = sb.over.has(k);
    const line = !p ? (k === 'root' ? (create ? 'Choose a parent folder and a name' : 'Choose a folder') : create ? 'Not made' : 'None found in the root. I look again at each new chat.')
      : st ? (st.status === 'bad' ? st.why : `${SB_STATUS[st.status] ?? ''}${over ? ' · chosen by hand' : ''}`) : 'Checking…';
    const bad = st && p && (st.status === 'bad' || st.status === 'missing');
    return el('div', { className: 'setting' },
      el('span', { id: `lbl-sb-${k}` }, label, el('small', { dir: 'auto', title: p || hint, textContent: p || hint }),
        el('small', { className: `wrap${bad ? ' late' : st?.status === 'found' || st?.status === 'will create' ? ' ok' : ''}`, textContent: line }),
        st?.warn && p ? el('small', { className: 'wrap late', textContent: st.warn }) : null),
      el('span', { className: 'links' },
        over ? link(create ? 'Default' : 'Auto', () => sbAuto(k), { k: `sbauto:${k}`, aria: `${label}: back to ${create ? 'the default name' : 'what is found in the root'}` }) : null,
        create && k === 'root' ? null : link('Choose folder…', () => sbChoose(k), { k: `sbpick:${k}`, aria: `Choose the ${label} folder` })));
  }
  function secondBrainPage() {
    if (!ui.sb || ui.sb.savedKey !== JSON.stringify(state.secondBrain?.saved ?? null)) sbInit();
    const sb = ui.sb, b = state.secondBrain ?? {}, create = sb.mode === 'create';
    const nameField = el('span', { className: 'px field' }, el('input', {
      id: 'sb-name', dir: 'auto', value: sb.name, placeholder: 'Second brain', 'aria-label': 'Name of the new second brain folder', type: 'text', autocomplete: 'off', spellcheck: false, maxLength: 80,
      on: { input: (e) => { sb.name = e.target.value.replace(/[\\/:]/g, ''); sbDefaults(); clearTimeout(sbTimer); sbTimer = setTimeout(() => sbCheck(), 250); } } }));
    const using = b.using?.root;
    const save = () => send({ type: 'secondbrain', op: create ? 'create' : 'save', form: sb.form });
    return [
      group('Second brain', 'A folder of your notes I work from: its rules, files and skills.', null,
        el('div', { className: 'setting' },
          el('span', {}, 'In use', el('small', { dir: 'auto', title: using || '', textContent: using || (b.missing ? `Can't find ${b.saved?.root}` : 'None yet') }),
            b.found?.length ? el('small', { className: 'wrap', textContent: `Found: ${b.found.join(', ')}` }) : null),
          b.saved ? link('Clear', () => act('secondbrainclear'), { k: 'secondbrainclear', aria: 'Stop using the second brain folder' }) : null),
        picks('How to start', [['existing', 'Use an existing folder'], ['create', 'Create a new one']], sb.mode, sbMode, 'sbmode',
          { existing: 'Choose its folder; I find the rest by name.', create: 'Pick where and a name; I make the folders and starter files.' })),
      create ? group('New one', 'Made with AGENTS.md and the index files. Nothing there already is written over.', null,
        el('div', { className: 'setting' },
          el('span', {}, 'Parent folder', el('small', { dir: 'auto', title: sb.parent, textContent: sb.parent || 'Where to make it' })),
          link('Choose folder…', sbParent, { k: 'sbparent', aria: 'Choose the folder to make the second brain in' })),
        el('div', { className: 'keyform' }, nameField)) : null,
      group('Locations', 'Outside the root is fine while it is in your home folder.', null, SB_LOCS.map(([k, label, hint]) => sbRow(k, label, hint))),
      foot(el('span', { className: 'links' },
        btn(create ? 'Create' : 'Save', save, { k: 'sbsave', kind: 'primary', disabled: !sb.form.root || SB_LOCS.some(([k]) => sb.status?.[k]?.status === 'bad') })), null),
    ];
  }

  // ---------------------------------------------------------------- What's new
  let news = null;
  fetch('whatsnew.json').then((r) => r.json()).then((d) => { news = Array.isArray(d?.updates) ? d.updates : []; })
    .catch(() => { news = []; }).finally(() => { if (state && tab === 'whatsnew') render(); });
  const KIND = { new: 'New', improved: 'Improved', fixed: 'Fixed', removed: 'Removed' };
  const later = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  function whatsNewPage() {
    if (!news) return [];
    const from = state.whatsNewFrom, now = state.version ?? '1.0.0';
    const fresh = (u) => u.version == null || (from ? later(u.version, from) && !later(u.version, now) : u.version === now);
    const all = news.flatMap((u) => (u.items ?? []).map((it) => ({ ...it, version: u.version, date: u.date, fresh: fresh(u) })));
    all.sort((a, b) => b.fresh - a.fresh);
    const lit = all.filter((r) => r.fresh).length;
    const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const { box, nav } = paged('whatsnew', all, (r) => el('li', { className: `item wn${r.fresh ? ' fresh' : ''}` },
      el('div', { className: 'wn-top' },
        el('span', { className: 'wn-title', dir: 'auto', textContent: r.title }),
        el('span', { className: `wn-kind k-${r.kind}`, textContent: KIND[r.kind] ?? r.kind })),
      el('span', { className: 'wn-date', textContent: `${day(r.date)} · ${r.version ? `v${r.version}` : 'Not out yet'}` }),
      el('p', { className: 'wn-text', dir: 'auto', textContent: r.text }),
      r.fresh ? el('span', { className: 'sr-only', textContent: 'In this update.' }) : null),
    { label: "What's new", empty: 'Nothing here yet.' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' },
        el('h2', {}, "What's new", el('span', { className: 'n', textContent: `v${now}` })),
        el('p', { textContent: lit ? `The lit ${lit === 1 ? 'one is' : `${lit} are`} what's new in this update.` : 'Everything I changed lately, newest first.' })), box),
      foot(null, nav),
    ];
  }

  // ---------------------------------------------------------------- render
  const PANES = { home, memory, abilities: abilitiesPage, harness: harnessPage, appearance: appearancePage, speaking: speakingPage, listening: listeningPage, shortcuts: shortcutsPage, general: generalPage, secondbrain: secondBrainPage, whatsnew: whatsNewPage };
  function render(focusKey, animate = false) {
    if (!state) return;
    const active = document.activeElement;
    if (!focusKey && !animate && active?.tagName === 'INPUT' && active.closest('.pane')) { deferred = true; return; }
    deferred = false;
    const keep = focusKey ?? active?.dataset?.k ?? (active?.id?.startsWith('key-') ? active.id : null);
    hideTip();
    const scroll = $('pane-' + tab).closest('.body').scrollTop;
    head();
    const pane = $(`pane-${tab}`);
    const same = render.tab === tab; render.tab = tab;
    const before = new Set([...pane.querySelectorAll('[data-anim]')].filter(shown).map((n) => n.dataset.anim));
    const draw = () => {
      pane.replaceChildren(...PANES[tab]().flat().filter(Boolean));
      pane.classList.toggle('paged', !!pane.querySelector('.pagebox')); keepGone();
    };
    draw();
    if (fit()) draw();
    pane.closest('.body').scrollTop = scroll;
    if (same && !animate) for (const n of pane.querySelectorAll('[data-anim]')) if (shown(n) && !before.has(n.dataset.anim)) grow(n, true);
    pane.classList.toggle('enter', animate);
    if (animate) {
      let i = 0;
      for (const n of pane.children) { n.style.setProperty('--i', Math.min(i++, 10)); for (const li of n.querySelectorAll('.list > li')) li.style.setProperty('--i', Math.min(i++, 10)); }
      clearTimeout(render.t); render.t = setTimeout(() => pane.classList.remove('enter'), 600);
    }
    if (keep) (document.querySelector(`.pane [data-k="${CSS.escape(keep)}"]`) ?? document.getElementById(keep))?.focus();
  }
  document.addEventListener('focusout', (e) => { if (deferred && e.target.tagName === 'INPUT') setTimeout(() => deferred && render(), 0); });
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && render(), 120); });

  const copyProblem = () => send({ type: 'copy_problem', from: 'panel' });
  let noteTimer = 0;
  function note(text, bad = false, copy = false) {
    const n = $('note');
    n.replaceChildren(el('span', { dir: 'auto', textContent: text, title: text }), ...(copy ? [link('Copy details', copyProblem, { k: 'note-copy' })] : []));
    n.removeAttribute('title'); n.className = `note${bad ? ' bad' : ''}`; n.hidden = false;
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, copy ? 20000 : bad ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- sidebar and keys
  const TABS = Object.keys(PANES);
  const navi = (t) => $(`nav-${t}`);
  function show(name, focus = false) {
    if (ABILITY_TABS.some(([id]) => id === name)) { ui.tabs.abilities = name; name = 'abilities'; }
    if (!PANES[name]) name = (name === 'settings' || name === 'model') ? 'harness' : 'home';
    const changed = name !== tab;
    if (!changed && !focus) return;
    tab = name;
    disarm(); ui.key = null; ui.rec = null;
    for (const t of TABS) {
      if (t === name) navi(t).setAttribute('aria-current', 'page'); else navi(t).removeAttribute('aria-current');
      $(`pane-${t}`).hidden = t !== name;
    }
    $('pane-' + name).closest('.body').scrollTop = 0;
    render(null, changed);
    const t = navi(name);
    if (changed) { t.classList.remove('ping'); void t.offsetWidth; t.classList.add('ping'); }
    if (focus) t.focus();
  }
  document.querySelector('.side').addEventListener('animationend', (e) => e.target.classList.remove('ping'));
  for (const t of TABS) navi(t).addEventListener('click', () => show(t));
  document.querySelector('.side').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(e.target.dataset?.page);
    if (i < 0) return;
    const n = TABS.length;
    const j = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j], true); }
  });
  const KEY_CODE = /^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;
  document.addEventListener('keydown', (e) => {
    const which = ui.rec;
    if (!which) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') { ui.rec = null; render(`rec-${which}`); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key) || !KEY_CODE.test(e.code)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
    if (!mods.some((x) => x !== 'Shift')) { note(state.os === 'mac' ? 'Hold Control, Option or Command too.' : 'Hold Ctrl or Alt too.', true); return; }
    ui.rec = null;
    act(`shortcut:${which}:${[...mods, e.code].join('+')}`);
    render(`rec-${which}`);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && tipFor) { e.preventDefault(); hideTip(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) { const was = ui.arm; if (ui.key) closeKey(); else if (disarm()) render(was ?? undefined); else hide(); return; }
    const tl = e.target.closest?.('[role="tablist"]');
    if (tl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const all = [...tl.querySelectorAll('[role="tab"]')], i = all.indexOf(e.target);
      all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.click();
      return;
    }
    const g = e.target.closest?.('[role="radiogroup"]');
    if (!g || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(e.target);
    const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.click();
    const k = next?.dataset.k;
    if (k) { next.focus(); setTimeout(() => document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(), 200); }
  });
  setInterval(() => { if (tab === 'home' && !document.hidden) render(); }, 30000);

  const body = $('frame');
  body.addEventListener('animationend', (e) => {
    if (e.target !== body) return;
    if (e.animationName === 'crt-on' && body.classList.contains('opening')) body.classList.remove('opening');
    else if (e.animationName === 'crt-off' && body.classList.contains('shutting')) { body.classList.remove('shutting'); body.classList.add('shut'); }
  });
  window.__panelOpen = (fromBottom = false) => {
    body.classList.remove('shut', 'shutting', 'opening');
    if (avatar) { avatar.kit.vanish(null, true); setTimeout(() => { avatar.appear(); if (Date.now() - seen.opened > 10 * 60e3) setTimeout(() => avatar.act('wave'), 500); seen.opened = Date.now(); }, REDUCED.matches ? 0 : 120); }
    body.classList.toggle('from-bottom', !!fromBottom);
    if (REDUCED.matches) return render(null, false);
    void body.offsetWidth;
    body.classList.add('opening');
    render(null, true);
  };
  window.__panelShut = () => {
    disarm(); ui.key = null; unarmQuit();
    body.classList.remove('opening');
    if (REDUCED.matches) { body.classList.add('shut'); return; }
    body.classList.add('shutting');
  };
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('#head-quit')) unarmQuit();
    if (ui.arm && !e.target.closest?.('.arm[aria-pressed="true"], .ibtn[aria-pressed="true"]')) {
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render();
    }
  }, true);

  window.__panel = (m) => {
    if (m.kind === 'state') {
      const first = !state; state = m.state; ui.scanning = false;
      if (ui.arm && !document.querySelector(`[data-k="${CSS.escape(ui.arm)}"]`)) ui.arm = null;
      render(null, first);
      if (m.state.tab) show(m.state.tab, true);
    }
    else if (m.kind === 'note') note(m.text, m.bad, m.copy);
    else if (m.kind === 'brain') onBrain(m);
    else if (m.kind === 'copied' && m.which === 'problem') note(m.ok ? 'Copied the error details. Paste them into your report.' : "Couldn't copy the error details. Try Save diagnostics.", !m.ok);
    else if (m.kind === 'copied') {
      if (!m.ok && state?.bind?.[m.which]) { ui.bindShown.add(m.which); render(`bind-${m.which}`); }
      note(m.ok ? 'Copied. Paste it into a new custom shortcut.' : "Couldn't copy it. Select the command and copy it instead.", !m.ok);
    }
  };
  send({ type: 'panel_open' });
  window.__panelOpen();

  // ---------------------------------------------------------------- browser preview
  function preview() {
    document.title = 'Yomna panel (preview with sample data)';
    const at = Date.now(), q = new URLSearchParams(location.search);
    const os = q.get('os') || (/Win/.test(navigator.platform) ? 'win' : /Linux/.test(navigator.platform) ? 'linux' : 'mac');
    const s = {
      version: '1.0.0', os,
      status: { state: 'ready', text: 'Ready' }, busy: false, canNew: true,
      harness: 'agy',
      harnesses: [
        { id: 'agy', label: 'Antigravity (agy)', installed: true, authenticated: true, version: '1.4.2' },
        { id: 'opencode', label: 'OpenCode', installed: true, authenticated: false, reason: 'OpenCode has no stored credentials. Run `opencode auth login`.' },
        { id: 'pi', label: 'Pi', installed: false, reason: 'Pi is not installed.' },
        { id: 'claude', label: 'Claude Code', installed: true, authenticated: true, version: '1.0.18' },
      ],
      customHarness: { command: '', args: [], protocol: 'acp' },
      allowActions: false,
      actions: false,
      recent: [
        { at: at - 20e3, kind: 'did', text: 'Saved to memory' },
        { at: at - 25e3, kind: 'did', text: 'Searched the web' },
        { at: at - 30e3, kind: 'ask', text: 'what tasks are due today?' },
        { at: at - 9 * 60e3, kind: 'did', text: 'Looked at your screen' },
        { at: at - 9.4 * 60e3, kind: 'ask', text: 'summarize this error log' },
      ],
      usage: { requests: 14, tokens: 31240 },
      facts: [
        { id: 'f1', text: 'Prefers concise answers in the morning' },
        { id: 'f2', text: 'Building a desktop companion project' },
        { id: 'f3', text: 'Uses Arabic and English notes' },
      ],
      commitments: [
        { id: 'c1', text: 'Review release notes', when: 'Fri, 10:00', overdue: false },
        { id: 'c2', text: 'Back up workspace', when: 'Mon, 09:00', overdue: true },
      ],
      jobs: [
        { id: 'j1a2b3c', title: 'Morning summary', paused: false, next: 'Thu, 08:00', repeat: 'weekdays', last: 'Last: Summarised today’s notes', bad: false },
      ],
      skills: [
        { slug: 'export-frames', name: 'Export frames', description: 'Export selected design frames as 2x PNGs.' },
      ],
      learnSkills: true,
      connections: [
        { name: 'linear', remote: true, where: 'https://mcp.linear.app/mcp', enabled: true, state: 'connected', toolCount: 23, error: null },
      ],
      name: 'Yomna',
      look: 'yomna',
      looks: DEFAULT_LOOKS,
      size: 'default',
      sizes: [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']],
      voiceMode: q.get('voicemode') === 'live' ? 'live' : 'classic',
      replies: 'voice',
      tts: q.get('tts') || 'local',
      localTtsVoice: 'en_US-amy-medium',
      edgeTtsVoice: 'ar-MA-MounaNeural',
      localTtsStatus: { ok: true, engine: 'piper', voices: DEFAULT_LOCAL_VOICES },
      edgeTtsVoices: DEFAULT_EDGE_VOICES,
      geminiKey: q.has('gemini'),
      geminiVoice: 'Kore',
      liveVoice: 'Kore',
      geminiVoices: [['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm']].map(([id, style]) => ({ id, style })),
      geminiShared: false,
      geminiModel: 'gemini-3.8-flash-lite-tts',
      geminiModels: [{ id: 'gemini-3.8-flash-lite-tts', name: 'Flash Lite', per10s: 0.0015 }, { id: 'gemini-3.8-flash-tts', name: 'Flash', per10s: 0.00225 }],
      voice: {
        on: true, keys: '⌃⌥', ready: true, mac: os === 'mac', lang: 'auto', langOnline: null, studioSpeak: 'short',
        mute: true, autoListen: q.has('listen'), listenEvery: false, listenSecs: 8, listenChoices: [3, 5, 8, 10, 15],
        mics: [{ id: 'BuiltIn', name: 'Built-in Microphone' }], mic: '', micAuto: 'Built-in Microphone',
        wake: !q.has('nowake'), wakeWord: false, wakeName: 'Yomna', download: null,
      },
      askKeys: '⌥⌘',
      brief: { on: true, todoist: false, canTodoist: true },
      focus: { until: null, task: '', list: ['YouTube', 'Reddit', 'X', 'Steam', 'Netflix'], custom: false },
      sync: { dir: '', at: null, error: null, paused: false },
      secondBrain: { saved: null, using: null, missing: false, found: [], home: '/Users/you' },
      shortcuts: {
        talk: { value: 'control+option', pairs: [['control+option', 'Control+Option'], ['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] },
        keys: [{ id: 'summon', words: 'Control+Option+S' }, { id: 'snap', words: 'Control+Option+A' }, { id: 'list', words: 'Control+Option+L' }],
      },
      writeKeys: { value: 'option+command', pairs: [['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] },
      sound: true,
      notch: q.has('notch') || q.has('capsule') ? 'drop' : null,
      notchReal: q.has('notch'),
      skipAllow: false,
      login: { on: true },
      update: { available: null, installing: false, checking: false, result: null },
      intro: false,
    };
    if (q.has('empty')) Object.assign(s, { recent: [], facts: [], commitments: [], jobs: [], skills: [], connections: [], usage: null });
    if (q.get('tab')) setTimeout(() => { if (q.get('mtab')) ui.mtab = q.get('mtab'); if (q.get('atab')) ui.tabs.abilities = q.get('atab'); show(q.get('tab')); }, 0);
    setTimeout(() => window.__panel({ kind: 'state', state: s }), 0);

    return async (cmd, args) => {
      if (cmd === 'pick_folder') return '/Users/you/Documents/Notes';
      if (cmd !== 'sidecar_send') return null;
      console.log('[preview] would send', JSON.stringify(args.msg));
      const msg = args.msg ?? {};
      const id = msg.id ?? '';
      if (msg.type === 'copy_problem') setTimeout(() => window.__panel({ kind: 'copied', which: 'problem', ok: q.get('copy') !== 'fail' }), 150);
      if (id === 'detect_harnesses') setTimeout(() => window.__panel({ kind: 'state', state: s }), 200);
      if (id === 'set_harness') { s.harness = msg.value; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'set_custom_harness') { s.customHarness = msg.value; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'set_allow_actions') { s.allowActions = s.actions = !!msg.value; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'set_voice_mode') { s.voiceMode = msg.value === 'live' ? 'live' : 'classic'; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'set_tts') { s.tts = msg.value; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'set_local_tts_voice') { s.localTtsVoice = msg.value; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'set_edge_tts_voice') { s.edgeTtsVoice = msg.value; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'set_gemini_key') { s.geminiKey = !!msg.value; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'geminikey_remove') { s.geminiKey = false; if (s.tts === 'gemini') s.tts = 'local'; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id.startsWith('size:')) { s.size = id.slice(5); setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id.startsWith('replies:')) { s.replies = id.slice(8); setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id.startsWith('livevoice:')) { s.liveVoice = id.slice(10); setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id.startsWith('studiovoice:') && s.studio) { s.studio.voice = id.slice(12) === 'default' ? null : id.slice(12); setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (id === 'secondbrainclear') { s.secondBrain = { saved: null, using: null, missing: false, found: [] }; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (msg.type === 'secondbrain' && msg.op === 'check') {
        const status = Object.fromEntries(Object.entries(msg.form).map(([k, v]) => [k, v ? { path: v, status: msg.mode === 'create' ? 'will create' : 'found' } : { path: '', status: 'unset' }]));
        const r = msg.form.root, found = r && msg.mode !== 'create' ? { raw: `${r}/_raw`, context: `${r}/_context`, research: '', projects: `${r}/projects`, agents: `${r}/.agents` } : {};
        setTimeout(() => window.__panel({ kind: 'brain', op: 'check', seq: msg.seq, status, found }), 80);
      }
      if (msg.type === 'secondbrain' && (msg.op === 'save' || msg.op === 'create')) {
        s.secondBrain = { saved: { ...msg.form }, using: { ...msg.form }, missing: false, found: ['raw', 'context (wiki)', 'projects', 'skills'] };
        setTimeout(() => window.__panel({ kind: 'state', state: s }), 80);
      }
      if (s.voice && ['autolisten', 'listenevery'].includes(id)) { const k = id === 'autolisten' ? 'autoListen' : 'listenEvery'; s.voice[k] = !s.voice[k]; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (s.voice && id.startsWith('speechlang:')) { s.voice.lang = id.slice(11); setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      if (s.voice && id.startsWith('listensecs:')) { s.voice.listenSecs = Number(id.slice(11)); setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      const gone = [[/^skill:forget:(.+)$/, 'skills', (x, v) => x.slug === v], [/^mcp:remove:(.+)$/, 'connections', (x, v) => x.name === v], [/^job:remove:(.+)$/, 'jobs', (x, v) => x.id === v],
        [/^forget:(.+)$/, 'facts', (x, v) => x.id === v], [/^(?:done|drop):(.+)$/, 'commitments', (x, v) => x.id === v]].find(([re]) => re.test(id));
      if (gone) { const v = id.match(gone[0])[1]; s[gone[1]] = s[gone[1]].filter((x) => !gone[2](x, v)); setTimeout(() => window.__panel({ kind: 'state', state: s }), Number(q.get('lag') ?? 120)); }
      if (id.startsWith('look:')) { s.look = id.slice(5); s.name = (s.looks.find(([v]) => v === s.look)?.[1]) ?? s.name; setTimeout(() => window.__panel({ kind: 'state', state: s }), 80); }
      return null;
    };
  }
})();
