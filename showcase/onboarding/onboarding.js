// Setup guide: Welcome → Permissions → Not a chatbot → Harness → Replies → What I can do → Shortcuts → About you → Second brain → Find me.
// The Sidekick lives on the left: it drops in on each step, points at what needs doing, cheers when
// something gets done and listens when you test your voice. Talks to the app through Tauri commands;
// opened in a plain browser it runs a simulated preview instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const invoke = window.__TAURI__?.core?.invoke ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const sendMenu = (id, value) => send(value === undefined ? { type: 'menu', id } : { type: 'menu', id, value });
  const sfx = (name, arg) => Jarvis.sfx?.play(name, arg);

  // ---------------------------------------------------------------- the Sidekick
  const canvas = $('jarvis'), ctx = canvas.getContext('2d'), quipEl = $('quip'), tailEl = $('quip-tail');
  const HOME = { x: 150, y: 330 };
  let W = innerWidth, H = innerHeight, dpr = 1, K = null, clock = 0, actUntil = 0, poseFn = null;
  const env = {
    w: W, h: H, dpr, t: 0, unit: 330, transparent: true, spawn: { ...HOME },
    safe: { left: 30, right: W - 290, top: 70, bottom: 50 },
    mouse: { x: 0, y: 0, inside: false, active: false }, sleepy: 0, reduced: reduced.matches,
  };
  const sidekick = Jarvis.ditherKit({
    id: 'guide', label: 'Guide', matrix: true, pixel: 1.3, glow: 0.55, speed: 80,
    pal: [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]],
    plugin: (kit) => { K = kit; return { busy: () => true, calm: () => !!quipText && clock < quipUntil, pose: () => (clock < actUntil ? null : poseFn?.(clock) ?? null) }; },
  }).create(env);
  const m = sidekick.mover;
  sidekick.vanish(null, true);

  const POSE = {
    point: (dx, dy) => (t) => ({ arms: 1, tr: [dx, dy + Math.sin(t * 4) * 0.05], tl: [-0.85, 0.5], mouth: 'grin' }),
    think: () => (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    listen: () => (t) => ({ arms: 1, tr: [0.98 + Math.sin(t * 7) * 0.04 * voice.level, -0.42 - voice.level * 0.1], tl: [-0.62, 0.88], oy: -voice.level * 3, mouth: 'flat', brow: 'raised' }),
    wait: () => (t) => ({ arms: 0.7, tl: [-0.45, 0.95 + Math.sin(t * 2.2) * 0.03], tr: [0.45, 0.95 - Math.sin(t * 2.2) * 0.03], mouth: 'flat' }),
  };
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  function act(name) {
    if (!K) return;
    K.startAct(name);
    actUntil = clock + (ACT_SECS[name] ?? 3) + (sidekick.hidden ? 0.8 : 0);
  }
  function moveTo(x, y) {
    y = clamp(y, 150, H - 100);
    m.anchor = { x, y, r: 6 };
    if (!sidekick.hidden) m.goTo(x, y);
  }
  const OUT = { materialize: 'crt', crt: 'materialize', drop: 'materialize' };
  let entering = 0;
  async function enter(variant, y = HOME.y) {
    const my = ++entering;
    y = clamp(y, 150, H - 100);
    m.anchor = { x: HOME.x, y, r: 6 };
    if (!sidekick.hidden && !reduced.matches) {
      sidekick.vanish(OUT[variant]);
      await wait(620);
      if (my !== entering) return;
    } else if (!sidekick.hidden) sidekick.vanish(null, true);
    sidekick.appear(reduced.matches ? 'crt' : variant, HOME.x, y);
  }

  let quipText = '', quipShown = 0, quipUntil = 0;
  function quip(text, secs = 2.4) {
    quipText = text; quipShown = 0; quipUntil = clock + secs + text.length * 0.035;
    quipEl.textContent = '';
    quipEl.classList.add('on');
    sfx('pop');
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now; clock += dt; env.t += dt; env.reduced = reduced.matches;
    if (!env.mouse.active) Object.assign(env.mouse, { ...(penDemo.eye ?? { x: 520, y: m.y - 20 }), inside: true, active: true, idle: true });
    sidekick.update(dt, env);
    if (env.mouse.idle) Object.assign(env.mouse, { active: false, idle: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save(); sidekick.draw(ctx, env); ctx.restore();
    if (quipText) {
      if (quipShown < quipText.length) {
        const before = Math.floor(quipShown);
        quipShown = Math.min(quipText.length, quipShown + dt * 42);
        const n = Math.floor(quipShown);
        if (n !== before) {
          quipEl.textContent = quipText.slice(0, n);
          if (n % 3 === 0 && /\w/.test(quipText[n - 1])) sfx('blip', 0.9 + Math.random() * 0.3);
        }
      }
      if (clock > quipUntil) { quipEl.classList.remove('on'); if (clock > quipUntil + 0.3) quipText = ''; }
      const qx = clamp(m.x, 125, W - 125), qy = m.y - (K?.R ?? 50) * 1.45 - 6;
      quipEl.style.left = `${qx}px`; quipEl.style.top = `${qy}px`;
      tailEl.style.left = `${clamp(m.x, qx - 100, qx + 100)}px`; tailEl.style.top = `${qy - 0.5}px`;
    }
    voice.drawMeter(dt);
    penDemo.draw(dt);
    requestAnimationFrame(frame);
  }
  function resize() {
    W = innerWidth; H = innerHeight; dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    Object.assign(env, { w: W, h: H, dpr });
    env.safe.right = W - 290;
    sidekick.resize(env);
  }
  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { Object.assign(env.mouse, { x: e.clientX, y: e.clientY, inside: true, active: true }); }, { passive: true });
  document.addEventListener('mouseleave', () => { env.mouse.active = false; });
  resize();
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- shared bits
  let state = null, cur = -1;
  const led = (mode = 'on') => el('i', { className: `led ${mode}`, ariaHidden: 'true' });
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k != null)); return n; };
  const okMark = (label) => el('span', { className: 'status' }, led(), label);
  let copyLink = null;
  function showError(id, text, copy = false) {
    const e = $(id);
    const link = copy ? el('button', { className: 'link', type: 'button', textContent: 'Copy details', onclick: () => { copyLink = link; send({ type: 'copy_problem' }); } }) : null;
    e.replaceChildren(el('span', { textContent: text, title: text }), ...(link ? [link] : []));
    e.removeAttribute('title'); e.hidden = false;
  }
  async function copyCommand(cmd, btnEl) {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(cmd); ok = true; }
    } catch {}
    if (!ok) {
      try {
        const ta = el('textarea', { value: cmd, style: 'position:fixed;opacity:0' });
        document.body.append(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch {}
    }
    if (ok && btnEl) {
      const prev = btnEl.textContent;
      btnEl.textContent = 'Copied';
      setTimeout(() => { if (btnEl.isConnected) btnEl.textContent = prev; }, 1800);
      quip('Copied!');
    } else quip('Select and copy the command');
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const CHEERS = ['Got it!', 'Nice!', 'Perfect.', 'Yes!'];
  const isMac = () => state?.platform === 'darwin';
  const isLinux = () => state?.platform === 'linux';
  const bind = () => state?.bind ?? null;
  const thisPC = () => (isLinux() ? 'this computer' : 'this PC');
  const canSnap = () => state?.snap ?? isMac();
  const canCircle = () => state?.circle ?? isMac();
  const MODE = new URLSearchParams(location.search).get('mode');
  const at = (name) => STEPS[cur]?.name === name;

  const MAC_MOD = { control: '⌃', option: '⌥', shift: '⇧', command: '⌘' };
  const PC_MOD = { control: 'Ctrl', option: 'Alt', shift: 'Shift', command: 'Win' };
  const LINUX_MOD = { ...PC_MOD, command: 'Super' };
  const MOD = new Proxy({}, { get: (_, k) => (isMac() ? MAC_MOD : isLinux() ? LINUX_MOD : PC_MOD)[k] });
  const ORDER = ['control', 'option', 'shift', 'command'];
  const ACC_MOD = { Control: 'control', Alt: 'option', Shift: 'shift', Command: 'command' };
  const keyLabel = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace('Backquote', '`').replace('Minus', '-').replace('Equal', '=').replace('BracketLeft', '[').replace('BracketRight', ']').replace('Backslash', '\\').replace('Semicolon', ';').replace('Quote', "'").replace('Comma', ',').replace('Period', '.').replace('Slash', '/');
  const capsFor = (mods, key) => [...[...mods].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map((x) => MOD[x]), ...(key ? [keyLabel(key)] : [])];
  const accelCaps = (accel) => { const parts = accel.split('+'); return capsFor(parts.slice(0, -1).map((p) => ACC_MOD[p]), parts.at(-1)); };
  const TRAY_SVG = '<svg class="trayicon" viewBox="0 0 36 36" aria-hidden="true" fill="currentColor"><rect x="30" y="3" width="2" height="2"/><rect x="27" y="6" width="2" height="2"/><rect x="30" y="6" width="2" height="2"/><rect x="33" y="6" width="2" height="2"/><rect x="30" y="9" width="2" height="2"/><rect x="6" y="12" width="2" height="2"/><rect x="9" y="12" width="2" height="2"/><rect x="12" y="12" width="2" height="2"/><rect x="15" y="12" width="2" height="2"/><rect x="3" y="15" width="2" height="2"/><rect x="6" y="15" width="2" height="2"/><rect x="9" y="15" width="2" height="2"/><rect x="12" y="15" width="2" height="2"/><rect x="15" y="15" width="2" height="2"/><rect x="18" y="15" width="2" height="2"/><rect x="0" y="18" width="2" height="2"/><rect x="3" y="18" width="2" height="2"/><rect x="9" y="18" width="2" height="2"/><rect x="12" y="18" width="2" height="2"/><rect x="18" y="18" width="2" height="2"/><rect x="21" y="18" width="2" height="2"/><rect x="0" y="21" width="2" height="2"/><rect x="3" y="21" width="2" height="2"/><rect x="9" y="21" width="2" height="2"/><rect x="12" y="21" width="2" height="2"/><rect x="18" y="21" width="2" height="2"/><rect x="21" y="21" width="2" height="2"/><rect x="0" y="24" width="2" height="2"/><rect x="3" y="24" width="2" height="2"/><rect x="6" y="24" width="2" height="2"/><rect x="9" y="24" width="2" height="2"/><rect x="12" y="24" width="2" height="2"/><rect x="15" y="24" width="2" height="2"/><rect x="18" y="24" width="2" height="2"/><rect x="21" y="24" width="2" height="2"/><rect x="3" y="27" width="2" height="2"/><rect x="6" y="27" width="2" height="2"/><rect x="9" y="27" width="2" height="2"/><rect x="12" y="27" width="2" height="2"/><rect x="15" y="27" width="2" height="2"/><rect x="18" y="27" width="2" height="2"/><rect x="6" y="30" width="2" height="2"/><rect x="9" y="30" width="2" height="2"/><rect x="12" y="30" width="2" height="2"/><rect x="15" y="30" width="2" height="2"/></svg>';
  const capsEl = (caps) => { const s = el('span', { className: 'caps' }); for (const c of caps) s.append(el('kbd', { className: 'px cap', textContent: c })); return s; };
  const fillCaps = (node, caps) => { node.replaceChildren(...caps.map((c) => el('kbd', { className: 'px cap', textContent: c }))); };

  // ---------------------------------------------------------------- step 1: permissions
  const perms = {
    sys: { mic: 'unknown', speech: 'granted', speechNeeded: false, screen: 'unknown', accessibility: 'unknown' },
    files: { Desktop: 'unknown', Documents: 'unknown', Downloads: 'unknown' },
    asked: {}, waiting: null, poll: null, since: 0, seen: new Set(), guiding: null,
    shot: 'idle',
    rows() {
      if (!isMac()) {
        const vm = state?.voiceModel;
        if (!state?.voice || !vm) return [];
        return [
          { id: 'mic', title: 'Microphone', desc: this.sys.input === false ? 'No microphone found yet. Plug one in.' : 'So you can talk to me.', pane: 'privacy-microphone' },
          { id: 'voice', title: 'My voice', desc: vm.status === 'error' ? vm.error : vm.status === 'downloading' ? `Downloading ${vm.size}. You can keep going.` : vm.status === 'ready' ? `Speech stays on ${thisPC()}.` : `One-time download, ${vm.size}. Speech stays on ${thisPC()}.` },
        ];
      }
      return [
        { id: 'mic', title: 'Microphone', desc: 'So you can talk to me.', pane: 'Privacy_Microphone' },
        ...(this.sys.speechNeeded ? [{ id: 'speech', title: 'Speech recognition', desc: 'Turns your voice into text.', pane: 'Privacy_SpeechRecognition' }] : []),
        { id: 'screen', title: 'Screen recording', pane: 'Privacy_ScreenCapture', bad: this.shot === 'failed',
          desc: this.shot === 'failed' ? "Can't see yet. Reopen me." : this.shot === 'checking' ? 'Taking one test screenshot.' : 'So I can see your screen.' },
        { id: 'accessibility', title: 'Control apps', desc: 'Fill in forms and click for you.', pane: 'Privacy_Accessibility' },
        { id: 'files', title: 'Your files', desc: 'Desktop, Documents, Downloads.', pane: 'Privacy_FilesAndFolders' },
      ];
    },
    status(id) {
      if (id === 'files') {
        const v = Object.values(this.files);
        return v.every((s) => s === 'granted') ? 'granted' : v.some((s) => s === 'denied') ? 'denied' : 'unknown';
      }
      if (id === 'voice') return state?.voiceModel?.status === 'ready' ? 'granted' : 'unknown';
      if (id === 'screen' && this.sys.screen === 'granted') return this.shot === 'ok' ? 'granted' : 'unknown';
      return this.sys[id] ?? 'unknown';
    },
    done() { return this.rows().every((r) => this.status(r.id) === 'granted' || (r.id === 'voice' && state.voiceModel.status === 'downloading')); },
    async allow(r) {
      if (r.id === 'voice') { send({ type: 'ob_voice_model' }); act('hype'); quip('Downloading! Keep going', 3); return; }
      this.waiting = r.id; this.asked[r.id] = true; this.render();
      poseFn = POSE.point(1.7, -0.1);
      if (r.id === 'files') { quip('Click OK when it asks!'); send({ type: 'ob_files', request: true }); return; }
      if (r.id === 'screen' || r.id === 'accessibility') {
        this.waiting = null;
        this.openSettings(r);
        quip('Drag me into the list!', 5);
        this.render();
        return;
      }
      quip('Click Allow when it asks!');
      const res = await invoke('perm_request', { kind: r.id });
      this.apply(res);
      if (this.waiting === r.id) this.waiting = null;
      this.render();
      invoke('focus_guide').catch(() => {});
    },
    guide(kind) { this.guiding = kind; invoke('perm_guide', { kind }).catch(() => {}); },
    unguide() { if (!this.guiding) return; this.guiding = null; invoke('perm_guide', { kind: null }).catch(() => {}); },
    openSettings(r) { invoke('open_settings', { pane: r.pane }); if (r.id === 'screen' || r.id === 'accessibility') this.guide(r.id); },
    apply(res) {
      if (!res || res.unsupported || res.error) return;
      for (const k of ['mic', 'speech', 'screen', 'accessibility']) if (res[k]) this.sys[k] = res[k];
      this.sys.speechNeeded = !!res.speechNeeded;
      if (typeof res.input === 'boolean') this.sys.input = res.input;
      this.checkShot();
    },
    async checkShot() {
      if (!isMac() || this.shot !== 'idle' || this.sys.screen !== 'granted') return;
      this.shot = 'checking'; this.render();
      const res = await invoke('screen_check').catch(() => null);
      this.shot = res?.seen || res?.unsupported ? 'ok' : 'failed';
      if (this.shot === 'failed' && at('perms')) { act('upset'); quip('Switch me on, then Reopen', 5); }
      this.render();
    },
    applyFiles(status) {
      this.files = { ...this.files, ...status };
      if (this.waiting === 'files') { this.waiting = null; invoke('focus_guide').catch(() => {}); }
    },
    render() {
      const list = $('perm-rows');
      const rows = this.rows();
      $('perm-lead').textContent = isMac() ? 'Only used when you ask me something.' : rows.length ? `One download so I can hear you. Your voice never leaves ${thisPC()}.` : 'Nothing to allow here. Just one choice below.';
      const firstPending = rows.find((r) => this.status(r.id) !== 'granted');
      list.replaceChildren(...rows.map((r) => {
        const st = this.status(r.id);
        let side;
        if (r.id === 'voice' && st === 'granted') side = okMark('Ready');
        else if (r.id === 'voice' && state.voiceModel.status === 'downloading') side = dlMeter(state.voiceModel);
        else if (r.id === 'voice') side = el('button', { className: `px btn ${state.voiceModel.status === 'error' ? 'ghost' : 'primary'}`, type: 'button', textContent: state.voiceModel.status === 'error' ? 'Retry' : 'Download', onclick: () => this.allow(r) });
        else if (r.id === 'screen' && this.shot === 'checking') side = el('span', { className: 'waiting', textContent: 'Checking…' });
        else if (r.id === 'screen' && this.shot === 'failed') side = el('span', { className: 'pair' },
          el('button', { className: 'px btn ghost', type: 'button', textContent: 'Reopen', onclick: () => { quip('Be right back!'); setTimeout(() => invoke('relaunch'), 400); } }),
          el('button', { className: 'px btn primary', type: 'button', textContent: 'Try again', onclick: () => { this.shot = 'idle'; this.checkShot(); } }));
        else if (st === 'granted') side = okMark(this.asked[r.id] || !isMac() ? 'Allowed' : 'Already allowed');
        else if (this.waiting === r.id) side = el('span', { className: 'waiting', textContent: 'Waiting for you…' });
        else if (r.id === 'screen' && this.asked.screen) side = el('span', { className: 'pair' },
          el('button', { className: 'px btn ghost', type: 'button', textContent: 'Settings', onclick: () => { this.openSettings(r); quip('Switch on Yomna'); } }),
          el('button', { className: 'px btn primary', type: 'button', textContent: 'Reopen', onclick: () => { quip('Be right back!'); setTimeout(() => invoke('relaunch'), 400); } }));
        else if (st === 'denied' || this.asked[r.id]) side = el('button', { className: 'px btn ghost', type: 'button', textContent: 'Open Settings', onclick: () => { this.openSettings(r); quip(isMac() ? 'Switch Yomna on!' : 'Turn on desktop apps!', 4); } });
        else if (!isMac()) side = el('span', { className: 'waiting', textContent: 'Checking…' });
        else side = el('button', { className: 'px btn primary', type: 'button', textContent: 'Allow', onclick: () => this.allow(r) });
        return el('li', { className: `px row${st === 'granted' ? ' granted' : r === firstPending ? ' focus' : ''}`, id: `perm-${r.id}` },
          el('div', {}, el('h2', { textContent: r.title }), el('p', { textContent: r.desc, title: r.desc, className: r.bad || (r.id === 'voice' && state.voiceModel.status === 'error') ? 'bad' : '' })), side);
      }));
      const sw = el('button', { className: 'px switch', type: 'button', role: 'switch' });
      const allowOn = !!(state?.allowActions ?? state?.actions);
      sw.setAttribute('aria-checked', String(allowOn));
      sw.setAttribute('aria-label', 'Let me edit files and run commands');
      sw.onclick = () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        sendMenu('set_allow_actions', on);
        if (on) { act('hype'); quip("I'll be careful!"); }
      };
      list.append(el('li', { className: 'px row' },
        el('div', {}, el('h2', { textContent: 'Allow Actions (Edit Mode)' }), el('p', { textContent: 'Off: read-only. On: edit files, run commands, click apps.' })), sw));
      if (state?.login != null) {
        const ls = el('button', { className: 'px switch', type: 'button', role: 'switch' });
        ls.setAttribute('aria-checked', String(!!state.login));
        ls.setAttribute('aria-label', 'Open Yomna at login');
        ls.onclick = () => { const on = ls.getAttribute('aria-checked') !== 'true'; ls.setAttribute('aria-checked', String(on)); send({ type: 'set_login', on }); if (on) quip("See you every morning!"); };
        list.append(el('li', { className: 'px row' },
          el('div', {}, el('h2', { textContent: 'Open at login' }), el('p', { textContent: 'Start with your computer.' })), ls));
      }

      if (this.guiding && this.status(this.guiding) === 'granted') this.unguide();

      const screenStuck = isMac() && this.asked.screen && this.status('screen') !== 'granted';
      if (screenStuck && !this.hinted && this.waiting !== 'screen') { this.hinted = true; setTimeout(() => at('perms') && quip('Switched me on? Hit Reopen', 5), 6000); }

      for (const r of rows) {
        const g = this.status(r.id) === 'granted';
        if (g && !this.seen.has(r.id)) { this.seen.add(r.id); if (at('perms') && this.since && clock - this.since > 0.8) { act('hype'); quip(pick(CHEERS)); } }
      }
      if (at('perms')) {
        if (firstPending && this.waiting == null) { poseFn = POSE.point(1.7, -0.1); aim($(`perm-${firstPending.id}`)); }
        else if (!firstPending) { poseFn = null; moveTo(HOME.x, HOME.y); }
      }
      nav();
    },
    enter() {
      perms.since = clock;
      if (state?.filesAsked) perms.asked.files = true;
      for (const r of perms.rows()) if (perms.status(r.id) === 'granted') perms.seen.add(r.id);
      perms.render();
      setTimeout(() => {
        if (!at('perms')) return;
        const left = perms.rows().filter((r) => perms.status(r.id) !== 'granted').length;
        if (!isMac()) quip(left === 0 ? 'Already sorted!' : perms.status('mic') === 'denied' ? 'Unblock the mic' : 'Grab my voice!');
        else quip(left === 0 ? 'Already sorted!' : left === 1 ? 'Just one to allow' : 'Tap Allow on each one');
      }, 900);
      const tick = async () => {
        perms.apply(await invoke('perm_status'));
        if (perms.asked.files) send({ type: 'ob_files', request: false });
        perms.render();
      };
      tick();
      perms.poll = setInterval(tick, 1500);
    },
    leave() { clearInterval(perms.poll); perms.poll = null; poseFn = null; perms.unguide(); },
    progress() {
      const meter = document.querySelector('#perm-voice .dl');
      if (meter && state.voiceModel.status === 'downloading') fillMeter(meter, state.voiceModel);
      else this.render();
    },
  };
  const pctOf = (vm) => Math.min(100, Math.floor((vm.done / (vm.total || 1)) * 100));
  function fillMeter(meter, vm) {
    const pct = pctOf(vm);
    [...meter.children].forEach((seg, i) => seg.classList.toggle('on', i < Math.round(pct / 10)));
    meter.setAttribute('aria-valuenow', String(pct));
    meter.nextElementSibling.textContent = `${pct}%`;
  }
  function dlMeter(vm) {
    const meter = el('span', { className: 'dl', role: 'progressbar' }, ...Array.from({ length: 10 }, () => el('i')));
    meter.setAttribute('aria-label', 'Voice download');
    meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
    const wrap = el('span', { className: 'dl-wrap' }, meter, el('span', { className: 'waiting dl-pct', ariaHidden: 'true' }));
    fillMeter(meter, vm);
    return wrap;
  }
  function aim(node) {
    if (!node) return;
    const r = node.getBoundingClientRect();
    moveTo(HOME.x, r.top + r.height / 2 + 6);
  }

  // ---------------------------------------------------------------- step 3: Harness auto-detection
  const HARNESS_META = {
    agy: { id: 'agy', label: 'Antigravity (agy)', isDefault: true, installCmd: 'mise use -g antigravity-cli', loginCmd: 'agy acp --login', installUrl: 'https://antigravity.google' },
    opencode: { id: 'opencode', label: 'OpenCode', isDefault: false, installCmd: 'npm i -g opencode-ai@latest', loginCmd: 'opencode auth login', installUrl: 'https://opencode.ai/docs' },
    pi: { id: 'pi', label: 'Pi', isDefault: false, installCmd: 'npm install -g @mariozechner/pi-coding-agent', loginCmd: 'pi', installUrl: 'https://shittycodingagent.ai' },
    claude: { id: 'claude', label: 'Claude Code', isDefault: false, installCmd: 'npm i -g @anthropic-ai/claude-code', loginCmd: 'claude auth login', installUrl: 'https://docs.anthropic.com/en/docs/claude-code' },
  };
  const HARNESS_ORDER = ['agy', 'opencode', 'pi', 'claude'];
  const PILL_LABEL = { ready: 'Ready', 'needs-login': 'Needs login', missing: 'Not installed' };

  const ai = {
    scanning: false,
    autoPicked: false,
    list() {
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
          ...meta, ...d, id,
          label: d.label || meta.label,
          installCmd: d.installCmd || meta.installCmd,
          loginCmd: d.loginCmd || meta.loginCmd,
          installUrl: d.installUrl || meta.installUrl,
          installed, authenticated, status,
        };
      });
    },
    autoSelect() {
      const harnesses = ai.list();
      const ready = harnesses.filter((h) => h.status === 'ready');
      if (!ready.length) return;
      const curId = state?.harness;
      if (curId && ready.some((h) => h.id === curId)) return;
      const preferred = ready.find((h) => h.id === 'agy') ?? ready[0];
      if (preferred && !ai.autoPicked) {
        ai.autoPicked = true;
        if (state) state.harness = preferred.id;
        sendMenu('set_harness', preferred.id);
      }
    },
    ready() {
      return ai.list().some((h) => h.status === 'ready');
    },
    render() {
      ai.autoSelect();
      const harnesses = ai.list();
      const activeId = state?.harness ?? 'agy';
      const readyCount = harnesses.filter((h) => h.status === 'ready').length;
      $('harness-summary').textContent = ai.scanning
        ? 'Scanning PATH…'
        : readyCount
          ? `${readyCount} ready on your PATH · ${HARNESS_META[activeId]?.label ?? activeId} selected`
          : 'No ready harness detected yet';
      $('harness-recheck').disabled = ai.scanning;
      $('harness-recheck').textContent = ai.scanning ? 'Checking…' : 'Check again';
      $('ai-lead').textContent = readyCount
        ? 'Found ready CLI harnesses on your PATH. Pick one to power Yomna.'
        : 'Install or sign in to a CLI harness below, then click Check again.';

      $('harness-list').replaceChildren(...harnesses.map((h) => {
        const isActive = activeId === h.id;
        const cmd = h.status === 'needs-login' ? h.loginCmd : h.status === 'missing' ? h.installCmd : null;
        const meta = h.status === 'ready'
          ? (h.version ? `Installed (${h.version}) and ready.` : 'Installed and ready.')
          : (h.reason || (h.status === 'needs-login' ? 'Sign in from your terminal, then click Check again.' : 'Not found on your PATH.'));
        const card = el('div', { className: `px harness-card${isActive ? ' active' : ''}` },
          el('div', { className: 'harness-top' },
            el('span', { className: 'harness-name', textContent: h.label }),
            h.isDefault ? el('span', { className: 'harness-tag', textContent: 'Default' }) : null,
            el('span', { className: `pill ${h.status}`, textContent: PILL_LABEL[h.status] })),
          el('p', { className: 'harness-meta', textContent: meta }),
          cmd ? el('div', { className: 'harness-cmd-row' },
            el('code', { className: 'harness-cmd', textContent: cmd }),
            el('button', { className: 'link', type: 'button', textContent: 'Copy', onclick: (e) => copyCommand(cmd, e.currentTarget) })) : null,
          el('div', { className: 'harness-actions' },
            isActive
              ? okMark('Selected')
              : el('button', {
                  className: `px btn ${h.status === 'ready' ? 'primary' : 'ghost'}`, type: 'button',
                  textContent: h.status === 'ready' ? 'Use harness' : 'Select',
                  onclick: () => { if (state) state.harness = h.id; sendMenu('set_harness', h.id); ai.render(); quip(`${h.label} selected!`); },
                }),
            h.status === 'missing' && h.installUrl
              ? el('button', { className: 'link', type: 'button', textContent: 'Docs ↗', onclick: () => send({ type: 'open_link', url: h.installUrl }) })
              : null));
        return card;
      }));
      nav();
    },
    recheck() {
      ai.scanning = true;
      ai.autoPicked = false;
      ai.render();
      sendMenu('detect_harnesses');
      setTimeout(() => { if (ai.scanning) { ai.scanning = false; if (at('ai')) ai.render(); } }, 2500);
    },
    enter() {
      sendMenu('detect_harnesses');
      ai.render();
      setTimeout(() => at('ai') && quip(ai.ready() ? 'Harness ready!' : 'Pick or install a harness'), 700);
      if (ai.ready()) setTimeout(() => at('ai') && act('hype'), 900);
      else poseFn = POSE.point(1.7, 0.05);
      aim($('harness-list'));
    },
    leave() { poseFn = null; },
  };
  $('harness-recheck').addEventListener('click', () => ai.recheck());
  for (const [id, type, line] of [['autolisten-switch', 'ob_autolisten', "I'll listen right after."], ['wake-switch', 'ob_wake', 'Just say hey!'], ['lite-switch', 'ob_lite', 'Light and quick!']]) {
    $(id).addEventListener('click', () => { const on = $(id).getAttribute('aria-checked') !== 'true'; $(id).setAttribute('aria-checked', String(on)); send({ type, on }); if (on) quip(line); });
  }

  // ---------------------------------------------------------------- step 4: Replies (Keyless local TTS + optional Gemini Live)
  const DEFAULT_LOCAL_VOICES = [
    { id: 'en_US-amy-medium', label: 'Amy (US English · Piper)' },
    { id: 'af_heart', label: 'Heart (US English · Kokoro)' },
    { id: 'ar_JO-kareem-medium', label: 'Kareem (Arabic · Piper)' },
  ];
  const DEFAULT_EDGE_VOICES = [
    { id: 'ar-MA-MounaNeural', label: 'Mouna · Moroccan Arabic (ar-MA)' },
    { id: 'ar-MA-JamalNeural', label: 'Jamal · Moroccan Arabic (ar-MA)' },
    { id: 'en-US-AvaMultilingualNeural', label: 'Ava Multilingual (en-US)' },
    { id: 'en-US-AvaNeural', label: 'Ava (en-US)' },
    { id: 'en-GB-SoniaNeural', label: 'Sonia (en-GB)' },
    { id: 'ar-SA-ZariyahNeural', label: 'Zariyah · Arabic (ar-SA)' },
  ];
  const TTS_LABELS = { local: 'Local Voice', edge: 'Edge TTS', voicestudio: 'VoiceStudio', gemini: 'Gemini' };

  function showRow(n, on) {
    const going = n.classList.contains('vanish');
    if (on ? !n.hidden && !going : n.hidden || going) return;
    if (reduced.matches) { n.hidden = !on; return; }
    n.getAnimations().forEach((a) => a.cancel());
    n.hidden = false;
    const cs = getComputedStyle(n), full = { height: `${n.offsetHeight}px`, marginTop: cs.marginTop, marginBottom: cs.marginBottom };
    const shut = { height: '0px', marginTop: '0px', marginBottom: '0px' };
    n.classList.remove('appear', 'vanish'); void n.offsetWidth; n.classList.add(on ? 'appear' : 'vanish');
    n.style.overflow = 'hidden';
    n.animate(on ? [shut, full] : [full, shut], { duration: on ? 200 : 160, easing: 'cubic-bezier(.2, .8, .2, 1)' }).finished.then(() => {
      n.style.overflow = ''; n.classList.remove('appear', 'vanish');
      if (!on) n.hidden = true;
    }, () => {});
  }

  const replies = {
    pick: null,
    prov: null,
    saving: false,
    mode: () => replies.pick ?? (state?.replies === 'text' ? 'text' : 'voice'),
    live: () => state?.voiceMode === 'live',
    hasGeminiKey: () => !!(state?.geminiKey || state?.geminiShared),
    tts() {
      const p = replies.prov ?? state?.tts ?? 'local';
      if (p === 'gemini' && !replies.hasGeminiKey()) return 'local';
      return TTS_LABELS[p] ? p : 'local';
    },
    ready: () => (replies.live() ? replies.hasGeminiKey() : true),
    render() {
      const live = replies.live();
      const hasGem = replies.hasGeminiKey();
      $('live-switch').setAttribute('aria-checked', String(live));
      showRow($('gemini-live-form'), live && !hasGem);

      if (live) return replies.renderLive();

      $('voice-lead').textContent = 'Text shows in my bubbles. Voice uses keyless Parakeet STT + Local TTS by default. Change it any time in the Yomna panel.';
      $('replies').hidden = false;
      const mode = replies.mode(), tts = replies.tts();
      const CARDS = [
        ['voice', 'Voice + text', 'Keyless local or Edge speech'],
        ['text', 'Text only', 'Answers in my bubbles'],
      ];
      $('replies').replaceChildren(...CARDS.map(([id, name, sub]) => {
        const checked = mode === id;
        const b = el('button', { className: `px prov${id === 'voice' && checked ? ' on' : ''}`, type: 'button', role: 'radio', tabIndex: checked ? 0 : -1 },
          el('span', { textContent: name }), led(checked ? 'on' : ''), el('small', { textContent: sub }));
        b.setAttribute('aria-checked', String(checked));
        b.onclick = () => replies.choose(id);
        return b;
      }));

      const providers = [
        ['local', 'Local Voice'],
        ['edge', 'Edge TTS'],
        ['voicestudio', 'VoiceStudio'],
        ...(hasGem ? [['gemini', 'Gemini']] : []),
      ];
      showRow($('tts-row'), mode === 'voice');
      look.radios('tts', providers, tts, replies.provider);

      const vs = tts === 'voicestudio' ? state?.studio : null;
      showRow($('studio-row'), mode === 'voice' && tts === 'voicestudio');
      $('studio-status').textContent = !vs || vs.checking ? 'Checking VoiceStudio…' : vs.ok ? `VoiceStudio is ready${vs.engine ? ` · ${vs.engine}` : ''}` : vs.message || "VoiceStudio isn't available.";
      $('studio-status').className = vs && !vs.checking && !vs.ok ? 'bad' : '';

      let voices = [];
      let picked = '';
      if (tts === 'local') {
        voices = (state?.localTtsStatus?.voices ?? []).length
          ? state.localTtsStatus.voices.map((v) => ({ id: v.id, label: v.name }))
          : DEFAULT_LOCAL_VOICES;
        picked = state?.localTtsVoice ?? voices[0]?.id ?? '';
      } else if (tts === 'edge') {
        const edgeList = state?.edgeTtsVoices ?? state?.edgeVoices ?? [];
        voices = edgeList.length
          ? edgeList.map((v) => ({ id: v.id, label: v.name }))
          : DEFAULT_EDGE_VOICES;
        picked = state?.edgeTtsVoice ?? 'en-US-AvaMultilingualNeural';
      } else if (tts === 'voicestudio' && vs?.ok) {
        voices = [{ id: 'default', label: 'Engine default' }, ...(vs?.voices ?? []).map((v) => ({ id: v.id, label: v.name }))];
        picked = vs?.voice ?? 'default';
      } else if (tts === 'gemini' && hasGem) {
        voices = (state?.geminiVoices ?? []).map((v) => ({ id: v.id, label: `${v.id} · ${v.style}` }));
        picked = state?.geminiVoice ?? '';
      }
      showRow($('gvoice-row'), mode === 'voice' && voices.length > 0);
      const list = JSON.stringify(voices);
      if ($('gvoice').dataset.list !== list) {
        $('gvoice').dataset.list = list;
        $('gvoice').replaceChildren(...voices.map((v) => el('option', { value: v.id, dir: 'auto', textContent: v.label })));
      }
      if (picked) $('gvoice').value = picked;

      $('talk-rows').hidden = !state?.voice;
      $('wake-row').hidden = !(state?.wakeOk ?? isMac());
      $('autolisten-switch').setAttribute('aria-checked', String(!!state?.autoListen));
      $('wake-switch').setAttribute('aria-checked', String(!!state?.wakeWord));
      nav();
    },
    renderLive() {
      const hasGem = replies.hasGeminiKey();
      $('voice-lead').textContent = hasGem
        ? "Gemini Live is active across Linux, Windows, and macOS. Pick my voice below."
        : "Gemini Live runs in real time on Linux, Windows, and macOS. Paste a free Google AI Studio key below.";
      $('replies').hidden = true;
      showRow($('tts-row'), false);
      showRow($('studio-row'), false);
      const voices = (state?.geminiVoices ?? []).map((v) => ({ id: v.id, label: `${v.id} · ${v.style}` }));
      showRow($('gvoice-row'), hasGem && voices.length > 0);
      const list = JSON.stringify(voices);
      if ($('gvoice').dataset.list !== list) {
        $('gvoice').dataset.list = list;
        $('gvoice').replaceChildren(...voices.map((v) => el('option', { value: v.id, textContent: v.label })));
      }
      if (state?.liveVoice) $('gvoice').value = state.liveVoice;
      $('gemini-live-save').disabled = replies.saving;
      $('gemini-live-save').textContent = replies.saving ? 'Saving…' : 'Save';
      $('talk-rows').hidden = true;
      nav();
    },
    choose(id) {
      if (replies.mode() === id) return;
      replies.pick = id;
      if (state) state.replies = id;
      quip(id === 'text' ? 'Text it is!' : 'Voice it is!');
      send({ type: 'ob_replies', mode: id });
      replies.render();
    },
    provider(p) {
      replies.prov = p;
      if (state) state.tts = p;
      sendMenu('set_tts', p);
      replies.render();
    },
    enter() {
      replies.render();
      poseFn = POSE.point(1.7, 0.05);
      aim($('replies'));
      setTimeout(() => at('voice') && quip(replies.live() ? 'Gemini Live is on!' : 'Keyless voice is ready!', 3), 700);
    },
    leave() { poseFn = null; },
  };
  $('replies').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = replies.mode() === 'text' ? 'voice' : 'text';
    replies.choose(next);
    requestAnimationFrame(() => [...$('replies').children].find((b) => b.getAttribute('aria-checked') === 'true')?.focus());
  });
  $('live-switch').addEventListener('click', () => {
    const on = $('live-switch').getAttribute('aria-checked') !== 'true';
    $('gemini-live-error').hidden = true;
    if (state) state.voiceMode = on ? 'live' : 'classic';
    sendMenu('set_voice_mode', on ? 'live' : 'classic');
    quip(on ? 'Ooh, real-time talk!' : 'Back to keyless Classic', 2.4);
    replies.render();
    if (on && !replies.hasGeminiKey()) $('gemini-live-input').focus();
  });
  $('gemini-live-link').addEventListener('click', () => {
    send({ type: 'open_link', url: 'https://aistudio.google.com/apikey' });
    quip('Copy it, then paste here');
  });
  $('gemini-live-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('gemini-live-input').value.trim();
    if (!key || replies.saving) return $('gemini-live-input').focus();
    replies.saving = true; $('gemini-live-error').hidden = true; replies.render();
    poseFn = POSE.think();
    sendMenu('set_gemini_key', key);
    $('gemini-live-input').value = '';
  });
  $('gvoice').addEventListener('change', () => {
    const v = $('gvoice').value;
    if (replies.live()) { if (state) state.liveVoice = v; send({ type: 'ob_livevoice', voice: v }); }
    else if (replies.tts() === 'local') { if (state) state.localTtsVoice = v; sendMenu('set_local_tts_voice', v); }
    else if (replies.tts() === 'edge') { if (state) state.edgeTtsVoice = v; sendMenu('set_edge_tts_voice', v); }
    else if (replies.tts() === 'voicestudio') { if (state?.studio) state.studio.voice = v === 'default' ? null : v; send({ type: 'ob_studiovoice', voice: v }); }
    else { if (state) state.geminiVoice = v; send({ type: 'ob_geminivoice', voice: v }); }
  });
  $('find-show').addEventListener('click', () => { invoke('open_settings', { pane: 'taskbar' }); quip('Switch me on under Other system tray icons', 4); });
  $('studio-check').addEventListener('click', () => { if (state?.studio) state.studio = { checking: true, voice: state.studio.voice }; replies.render(); send({ type: 'ob_studiocheck' }); });

  // ---------------------------------------------------------------- step 5: shortcuts
  const MAC_CHORDS = [['control', 'option'], ['option', 'command'], ['control', 'command'], ['control', 'shift'], ['option', 'shift']];
  const PC_CHORDS = [['control', 'option'], ['control', 'shift']];
  const chords = () => (isMac() ? MAC_CHORDS : PC_CHORDS);
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const voice = {
    level: 0, target: 0, bars: [], listening: false,
    drawMeter(dt) {
      voice.level += (voice.target - voice.level) * Math.min(1, dt * (voice.target > voice.level ? 30 : 8));
      voice.target *= Math.exp(-dt * 3);
      const inChat = at('chat'), meter = inChat ? $('chat-meter') : $('meter');
      if (!(inChat ? $('chat-talk').classList.contains('on') : voice.listening)) { if (meter.childElementCount) meter.replaceChildren(); return; }
      voice.bars.push(voice.level); if (voice.bars.length > 14) voice.bars.shift();
      if (meter.childElementCount !== voice.bars.length) meter.replaceChildren(...voice.bars.map(() => el('i')));
      [...meter.children].forEach((b, i) => { b.style.height = `${2 + voice.bars[i] * 12}px`; });
    },
    on(msg) {
      if (!at('keys')) return;
      const heard = $('heard');
      if (msg.type === 'state' && msg.state === 'listening') {
        voice.listening = true; heard.textContent = 'Listening…'; poseFn = POSE.listen(); sfx('listen');
      } else if (msg.type === 'level') voice.target = clamp(msg.v, 0, 1);
      else if (msg.type === 'partial') heard.textContent = msg.text;
      else if (msg.type === 'state' && msg.state === 'processing') { voice.listening = false; }
      else if (msg.type === 'final') {
        voice.listening = false; poseFn = null;
        const drew = canCircle() && !!msg.area;
        heard.textContent = drew ? `“${msg.text}” + your circle` : `“${msg.text}”`;
        act('hype'); quip(drew ? 'I saw your circle!' : keys.heard && canCircle() && !keys.drew ? 'Now try circling!' : 'I heard you!'); sfx('heard');
        if (drew) keys.drew = true; else keys.heard = true;
        keys.tryLabel();
      } else if (msg.type === 'state' && msg.state === 'idle') { voice.listening = false; if (poseFn) poseFn = null; }
      else if (msg.type === 'error') {
        voice.listening = false; poseFn = null;
        heard.textContent = msg.code === 'permission' ? 'I need the Microphone (step 2) to hear you.' : msg.code === 'nothing_heard' ? "Didn't catch that. Try again?" : 'Something went wrong. Try again?';
        quip(msg.code === 'permission' ? 'I can’t hear you yet' : 'Again?');
      }
      if (bind() && msg.type === 'state') keys.tryLabel();
    },
  };
  const keys = {
    recording: null, heard: false, drew: false,
    render() {
      const k = state?.keys; if (!k) return;
      $('talk-row').hidden = !state.voice;
      const b = bind();
      $('bind-row').hidden = !b; $('hotkey-row').hidden = !!b; $('chords').hidden = !!b;
      $('talk-hint').textContent = b ? 'Press your talk key, talk, then press it again (or pause) to send.' : 'Hold to talk. Tap to listen hands-free.';
      $('keys-lead').textContent = b ? 'Pick keys for these, and they work from anywhere.' : 'These work from anywhere. Change them if you like.';
      if (b) keys.renderBind(b);
      $('chords').replaceChildren(...chords().map((c) => {
        const on = same(c, k.talk);
        const btn = el('button', { className: 'px chord', type: 'button', role: 'radio', tabIndex: on ? 0 : -1 }, capsEl(capsFor(c)));
        btn.setAttribute('aria-checked', String(on));
        btn.setAttribute('aria-label', `Hold ${c.map((x) => (isMac() ? x[0].toUpperCase() + x.slice(1) : PC_MOD[x])).join(' and ')}`);
        btn.onclick = () => { if (!on) { send({ type: 'set_keys', talk: c }); quip('Ooh, fancy.'); } };
        return btn;
      }));
      $('write-chords').replaceChildren(...chords().map((c) => {
        const on = !!k.write && same(c, k.write);
        const btn = el('button', { className: 'px chord', type: 'button', role: 'radio', tabIndex: on ? 0 : -1 }, capsEl(capsFor(c)));
        btn.setAttribute('aria-checked', String(on));
        btn.setAttribute('aria-label', `Tap ${c.map((x) => (isMac() ? x[0].toUpperCase() + x.slice(1) : PC_MOD[x])).join(' and ')}`);
        btn.onclick = () => { if (!on) { send({ type: 'set_keys', write: c }); quip('Tap, tap.'); } };
        return btn;
      }));
      keys.tryLabel();
      $('snap-line').hidden = !canSnap() || !k.snap;
      $('draw-tip').hidden = !canCircle();
      for (const w of ['summon', 'snap']) if (keys.recording !== w && k[w]) fillCaps($(`${w}-caps`), accelCaps(k[w]));
      nav();
    },
    bound: '',
    renderBind(b) {
      const list = [['talk', 'Talk to me'], ['summon', 'Show or hide me'], ['ask', 'Ask me'], ['list', 'Your list'], ['panel', 'My panel']];
      const sig = JSON.stringify(b);
      if (keys.bound === sig) return;
      keys.bound = sig;
      $('bind-list').replaceChildren(...list.filter(([k]) => b[k]).map(([k, title]) => el('div', { className: 'bind-line' },
        el('span', { textContent: title }),
        el('button', { className: 'link', type: 'button', textContent: 'Copy', ariaLabel: `Copy the command for ${title.toLowerCase()}`, onclick: () => send({ type: 'copy_bind', which: k }) }),
        el('code', { className: 'bind-cmd', id: `bind-${k}`, textContent: b[k], hidden: true }))));
    },
    tryLabel() {
      const k = state?.keys, vm = state?.voiceModel; if (!k) return;
      const tl = $('try-label');
      if (!isMac() && vm && vm.status !== 'ready') tl.replaceChildren(vm.status === 'downloading' ? `Try it once my voice has downloaded (${pctOf(vm)}%).` : 'Download my voice in step 2 to try it.');
      else if (canCircle() && keys.heard && !keys.drew) tl.replaceChildren('Now hold ', capsEl(capsFor(k.talk)), ' and circle something as you ask');
      else if (bind()) tl.replaceChildren('Try it: ', el('button', { className: 'px btn ghost', type: 'button', textContent: voice.listening ? 'Send' : 'Talk', onclick: () => send({ type: 'cli', action: 'talk' }) }), voice.listening ? '' : ' and say hi');
      else tl.replaceChildren('Try it: hold ', capsEl(capsFor(k.talk)), ' and say hi');
    },
    record(which) {
      if (keys.recording) keys.stop();
      keys.recording = which;
      $('keys-error').hidden = true;
      $(`${which}-caps`).textContent = 'Press keys…';
      $(`${which}-caps`).parentElement.classList.add('recording');
      $(`${which}-change`).textContent = 'Cancel';
      poseFn = POSE.wait(); quip('Press your new combo');
    },
    stop() {
      const w = keys.recording;
      keys.recording = null;
      if (w) { $(`${w}-caps`).parentElement.classList.remove('recording'); $(`${w}-change`).textContent = 'Change'; }
      poseFn = null;
      keys.render();
    },
    enter() { keys.render(); aim($('chords')); setTimeout(() => at('keys') && quip(state?.voice ? 'Try talking to me!' : 'Your shortcuts'), 700); },
    leave() { if (keys.recording) keys.stop(); poseFn = null; voice.listening = false; },
  };
  const penDemo = {
    t: 0, eye: null, keysFor: '',
    LOOP: 6, START: 0.4, DRAW: 1.7,
    on: () => at('keys') && canCircle() && !!state?.voice && !keys.recording && !voice.listening && !sidekick.hidden,
    points(r) {
      const pts = [], a0 = -2.3, span = Math.PI * 2 + 0.35, n = 80;
      for (let i = 0; i <= n; i++) {
        const f = i / n, a = a0 + span * f, rr = r * (1 + 0.05 * Math.sin(2 * a + 0.7) + 0.05 * f);
        pts.push([Math.cos(a) * rr * 1.08, Math.sin(a) * rr * 0.94 - r * 0.04]);
      }
      return pts;
    },
    path: (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(''),
    draw(dt) {
      const box = $('pen-demo');
      if (!penDemo.on()) { if (!box.hidden) { box.hidden = true; penDemo.t = 0; } penDemo.eye = null; return; }
      if (!reduced.matches && penDemo.t === 0 && quipText && clock < quipUntil + 0.3) { box.hidden = true; penDemo.eye = null; return; }
      box.hidden = false;
      const caps = capsFor(state.keys.talk).join('');
      if (penDemo.keysFor !== caps) { penDemo.keysFor = caps; fillCaps($('pen-keys'), capsFor(state.keys.talk)); }
      const still = reduced.matches;
      penDemo.t = still ? penDemo.START + penDemo.DRAW + 0.5 : penDemo.t + dt >= penDemo.LOOP ? 0 : penDemo.t + dt;
      const t = penDemo.t, pts = penDemo.points((K?.R ?? 50) * 1.6);
      const f = Math.min(1, Math.max(0, (t - penDemo.START) / penDemo.DRAW));
      const eased = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      const shown = pts.slice(0, Math.max(1, Math.round(eased * (pts.length - 1)) + 1));
      const d = penDemo.path(shown);
      $('pen-ink').setAttribute('d', d); $('pen-rim').setAttribute('d', d);
      const snapped = f >= 1;
      $('pen-stroke').classList.toggle('snapped', snapped);
      const head = shown.at(-1), drift = snapped ? Math.min(1, (t - penDemo.START - penDemo.DRAW) / 1.2) : 0;
      const len = Math.hypot(head[0], head[1]) || 1, ux = head[0] / len, uy = head[1] / len;
      const cx = head[0] + ux * drift * 24, cy = head[1] + uy * drift * 24;
      const fade = still ? 1 : t < 0.15 ? t / 0.15 : t > 4 ? Math.max(0, 1 - (t - 4) / 0.5) : 1;
      const held = still || (t > 0.2 && t < penDemo.START + penDemo.DRAW + 0.6);
      $('pen-stroke').style.opacity = fade < 1 ? String(fade * (snapped ? 1 : 0.55)) : '';
      $('pen-cursor').setAttribute('transform', `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`);
      $('pen-cursor').style.opacity = still ? '0' : String(fade);
      const k = $('pen-keys');
      const kx = (still ? pts[0][0] : cx) + ux * 38 - 26, ky = (still ? pts[0][1] : cy) + uy * 32 - 12;
      k.style.transform = `translate(${(m.x + kx).toFixed(1)}px, ${(m.y + ky).toFixed(1)}px)`;
      k.style.opacity = String(fade);
      k.classList.toggle('down', held);
      box.querySelector('svg').style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
      penDemo.eye = still ? null : { x: m.x + cx, y: m.y + cy };
    },
  };

  for (const id of ['chords', 'write-chords', 'looks', 'sizes']) $(id).addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const btns = [...$(id).children], i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const n = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns[n].click(); requestAnimationFrame(() => $(id).children[n]?.focus());
  });
  for (const w of ['summon', 'snap']) $(`${w}-change`).addEventListener('click', () => (keys.recording === w ? keys.stop() : keys.record(w)));
  addEventListener('keydown', (e) => {
    if (!keys.recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') return keys.stop();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
    if (!mods.some((x) => x !== 'Shift')) { showError('keys-error', isMac() ? 'Hold Control, Option or Command too.' : 'Hold Ctrl or Alt too.'); return; }
    if (!/^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(e.code)) return;
    const which = keys.recording;
    keys.stop();
    send({ type: 'set_keys', [which]: [...mods, e.code].join('+') });
    act('hype'); quip('Got it!');
  }, true);

  // ---------------------------------------------------------------- what I can do
  const DEMO = [
    ['Search the web', 'Answers, with where they came from.'],
    ['Graphs', 'Numbers turned into charts.'],
    ['Timelines', 'Events in order, at a glance.'],
    ['Science', 'Molecules drawn from their formula.'],
    ['3D models', 'Little models that turn.'],
    ['Plans and lists', 'To-dos that keep you on track.'],
  ];
  const demo = {
    status: 'idle',
    beat: -1, played: false, aside: false, timer: null,
    enter() {
      demo.render();
      send({ type: 'ob_showcase_warm' });
      setTimeout(() => { if (at('demo') && demo.status !== 'playing') { poseFn = POSE.point(1.3, -0.9); quip('Want to see?'); } }, 700);
    },
    leave() { demo.stop(); poseFn = null; },
    async play() {
      demo.played = true; demo.status = 'playing'; demo.beat = -1;
      $('demo-say').textContent = '';
      poseFn = POSE.wait();
      quip('Watch your desktop!', 1.2);
      demo.render();
      send({ type: 'ob_showcase' });
      await wait(reduced.matches ? 0 : 500);
      if (demo.status !== 'playing') return;
      demo.aside = true;
      invoke('guide_aside', { on: true }).catch(() => {});
      clearTimeout(demo.timer); demo.timer = setTimeout(() => demo.back(), 90000);
    },
    back() {
      clearTimeout(demo.timer);
      if (!demo.aside) return;
      demo.aside = false;
      invoke('guide_aside', { on: false }).catch(() => {});
    },
    stop() {
      if (demo.status === 'playing') send({ type: 'ob_showcase_stop' });
      demo.back();
      if (demo.status === 'playing') demo.status = 'idle';
      poseFn = null; demo.render();
    },
    on(msg) {
      if (msg.phase === 'beat' && demo.status === 'playing') {
        demo.beat = msg.beat | 0;
        if (DEMO[demo.beat]) $('demo-say').textContent = `Drawing: ${DEMO[demo.beat][0]}`;
      } else if (msg.phase === 'done' && demo.status === 'playing') {
        demo.status = 'done'; demo.beat = DEMO.length;
        $('demo-say').textContent = 'All drawn.';
      } else if (msg.phase === 'gone' && demo.aside) {
        if (demo.status === 'playing') demo.status = 'idle';
        demo.back(); poseFn = null;
        if (at('demo')) { act('hype'); quip(demo.status === 'done' ? "That's a taste!" : 'Okay, stopped.'); }
      } else if (msg.phase === 'failed') {
        demo.status = 'failed'; demo.back(); poseFn = null;
        if (at('demo')) { act('upset'); quip("Hmm, that didn't draw."); }
      } else return;
      demo.render();
    },
    render() {
      const playing = demo.status === 'playing', shown = demo.status === 'done' ? DEMO.length : Math.max(0, demo.beat);
      $('demo-lead').textContent = demo.status === 'failed' ? "I couldn't draw just now." : 'Watch me draw on your desktop.';
      $('demo-rows').replaceChildren(...DEMO.map(([title, desc], i) => {
        const done = demo.played && i < shown && !(playing && i === demo.beat), now = playing && i === demo.beat;
        const side = done ? okMark('Shown') : now ? el('span', { className: 'waiting' }, led('busy'), ' Drawing') : null;
        return el('li', { className: `px row${done ? ' granted' : now ? ' focus' : ''}` }, el('div', {}, el('h2', { textContent: title }), el('p', { textContent: desc, title: desc })), side);
      }));
      const btn = $('demo-again');
      btn.textContent = playing ? 'Drawing…' : demo.status === 'failed' ? 'Try again' : demo.played ? 'Show me again' : 'Try me out';
      btn.disabled = playing;
      btn.className = `px btn ${demo.played && !playing ? 'ghost' : 'primary'}`;
    },
  };
  $('demo-again').addEventListener('click', () => { if (demo.status !== 'playing') demo.play(); });

  const find = {
    enter() {
      const k = state?.keys;
      const recap = $('recap');
      recap.replaceChildren();
      const b = bind();
      if (state?.voice && k) recap.append(el('dt', {}, capsEl(b ? ['Your talk key'] : capsFor(k.talk))), el('dd', { textContent: b ? 'Press to talk to me, again to send' : canCircle() ? 'Hold to talk to me. Circle something to mark it' : 'Hold to talk to me' }));
      if (k?.write && !b) recap.append(el('dt', {}, capsEl(capsFor(k.write))), el('dd', { textContent: 'Tap, then type to me' }));
      if (k) recap.append(el('dt', {}, capsEl(b ? ['Your show key'] : accelCaps(k.summon))), el('dd', { textContent: 'Show or hide me' }));
      if (k?.snap && canSnap()) recap.append(el('dt', {}, capsEl(accelCaps(k.snap))), el('dd', { textContent: 'Ask about an area of the screen' }));
      const tray = el('span', { className: 'caps' }); const cap = el('kbd', { className: 'px cap' }); cap.innerHTML = TRAY_SVG; tray.append(cap);
      recap.append(el('dt', {}, tray), el('dd', { textContent: isMac() ? 'Everything else, in the menu bar' : 'Everything else, in the system tray' }));
      const mac = isMac();
      const linux = isLinux();
      $('h-4').textContent = mac ? 'Find me up here' : linux ? 'Find me in the tray' : 'Find me down here';
      $('find-where').textContent = mac ? 'I live in your menu bar. Click ' : linux ? 'I live in the system tray. Click ' : 'I live in the system tray, at the bottom right of your taskbar. Click ';
      $('find-tip').innerHTML = linux ? "No tray on your desktop? On GNOME, add the <b>AppIndicator</b> extension. Or just open Yomna again from your apps: that opens my panel." : "Don't see me? Click the <b>^</b> arrow next to the clock. To keep me in view, drag my icon onto the taskbar.";
      $('find-tip').hidden = mac;
      $('find-show').hidden = mac || linux;
      $('find-bar').classList.toggle('taskbar', !mac);
      poseFn = POSE.point(1.25, mac ? -1.45 : 1.2);
      setTimeout(() => at('find') && quip(mac ? 'I live up there!' : 'I live down there!'), 750);
    },
    leave() { poseFn = null; },
  };

  // ---------------------------------------------------------------- get-to-know-you chat
  const SENTENCES = /[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g;
  const splitStream = (raw, final) => {
    const parts = raw.replace(/\s+/g, ' ').match(SENTENCES)?.map((x) => x.trim()).filter(Boolean) ?? [];
    if (!final && parts.length && (!/[.!?…]["'”’)]*$/.test(parts.at(-1)) || !/\s$/.test(raw))) parts.pop();
    let qi = -1;
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].includes('?')) { qi = i; break; }
    return qi < 0 ? { lead: parts.join(' '), question: null, hint: '' } : { lead: parts.slice(0, qi).join(' '), question: parts[qi], hint: parts.slice(qi + 1).join(' ') };
  };
  const reveal = (() => {
    const slots = {};
    const slot = (id) => (slots[id] ??= { el: $(id), words: [], n: 0, stale: false });
    const word = (w, fresh) => el('span', { className: fresh ? 'chat-w in' : 'chat-w', textContent: w });
    const paint = (s, n, fresh = false) => {
      for (let i = s.n; i < n; i++) s.el.append(...(i ? [' '] : []), word(s.words[i], fresh));
      s.n = n;
    };
    let raf = 0, last = 0, acc = 0;
    const order = ['chat-lead', 'chat-q', 'chat-hint'];
    const tick = (t) => {
      raf = 0;
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0; last = t;
      const s = order.map(slot).find((x) => x.next || x.n < x.words.length);
      if (!s) { last = 0; return; }
      if (s.next) { s.words = s.next; s.next = null; s.stale = false; s.el.classList.remove('stale'); s.el.replaceChildren(); s.n = 0; paint(s, 1, !REDUCED()); acc = 0; onReveal(); raf = requestAnimationFrame(tick); return; }
      const behind = s.words.length - s.n;
      acc += dt * (11 + Math.max(0, behind - 4) * 2.5);
      const k = Math.floor(acc);
      if (k > 0 || REDUCED()) { acc -= k; paint(s, Math.min(s.words.length, s.n + (REDUCED() ? behind : Math.max(1, k))), !REDUCED()); }
      onReveal();
      raf = requestAnimationFrame(tick);
    };
    let onReveal = () => {};
    return {
      set onReveal(f) { onReveal = f; },
      to(id, text) {
        const s = slot(id), words = text ? text.split(' ') : [];
        if (s.stale) { if (words.length) { s.next = words; if (!raf) raf = requestAnimationFrame(tick); } return; }
        const keep = Math.min(s.n, words.length);
        if (s.words.slice(0, keep).some((w, i) => w !== words[i]) || keep < s.n) { s.words = words; s.el.replaceChildren(); s.n = 0; paint(s, keep); }
        s.words = words;
        if (!raf && s.n < words.length) raf = requestAnimationFrame(tick);
      },
      now(id, text) { const s = slot(id); s.stale = false; s.next = null; s.el.classList.remove('stale'); s.words = text ? text.split(' ') : []; s.el.replaceChildren(); s.n = 0; paint(s, s.words.length); },
      dim(id) { const s = slot(id); if (s.n) { s.stale = true; s.el.classList.add('stale'); } },
      shown: (id) => slot(id).n,
      done: () => order.every((id) => !slot(id).next && slot(id).n >= slot(id).words.length),
    };
  })();
  const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  reveal.onReveal = () => chat.slots();

  const chat = {
    status: 'idle',
    n: 0, total: 4, text: '', facts: [], heard: false, before: '', fixed: '',
    enter() {
      if (chat.status === 'idle') {
        chat.status = 'thinking';
        send({ type: 'chat_start' });
        setTimeout(() => at('chat') && act('wave'), 700);
      }
      chat.voiceHint();
      chat.render();
    },
    leave() { poseFn = null; Jarvis.voiceOut?.stop(); },
    over: () => ['done', 'skipped', 'no_model', 'failed'].includes(chat.status),
    nav() {
      const over = chat.over();
      $('next').textContent = over ? (cur === STEPS.length - 1 ? 'Done' : 'Continue') : 'Send';
      $('next').disabled = !over && (chat.status !== 'asking' || !$('chat-input').value.trim());
      $('back').disabled = cur === 0 || !over;
      $('skip').hidden = over;
      $('skip').textContent = 'Skip these questions';
    },
    next() { if (chat.over()) return false; chat.send(); return true; },
    skip() {
      if (chat.over()) return false;
      send({ type: 'chat_skip' });
      chat.status = 'skipped';
      Jarvis.voiceOut?.stop();
      chat.render();
      if (MODE === 'chat') finish();
      return true;
    },
    send(text = $('chat-input').value.trim()) {
      if (!text || chat.status !== 'asking') return;
      Jarvis.voiceOut?.stop();
      send({ type: 'chat_answer', text });
      $('chat-input').value = '';
      chat.text = '';
      chat.status = 'thinking';
      reveal.to('chat-lead', ''); reveal.to('chat-hint', ''); reveal.dim('chat-q');
      chat.render();
    },
    on(msg) {
      if (msg.kind === 'chat') {
        const e = msg.e;
        if (e.type === 'start') chat.text = '';
        else if (e.type === 'text') { chat.text += e.text; if (chat.status === 'thinking') chat.stream(false); }
        else if (e.type === 'emote' && at('chat')) act(e.action);
        return;
      }
      if (msg.kind === 'chat_state') {
        if (msg.status === 'busy') return;
        chat.status = msg.status;
        if (msg.n != null) { chat.n = msg.n; chat.total = msg.total; }
      } else if (msg.kind === 'chat_turn') {
        Object.assign(chat, { status: 'asking', n: msg.n, total: msg.total, lead: msg.lead, question: msg.question, hint: msg.hint });
        reveal.to('chat-lead', msg.lead || ''); reveal.to('chat-q', msg.question || 'Tell me more?'); reveal.to('chat-hint', msg.hint || '');
        $('chat-say').textContent = [msg.lead, msg.question].filter(Boolean).join(' ');
        if (at('chat')) setTimeout(() => $('chat-input').focus({ preventScroll: true }), 50);
      } else if (msg.kind === 'chat_done') {
        Object.assign(chat, { status: msg.skipped ? 'skipped' : 'done', done: msg.text ?? '', facts: msg.facts ?? [] });
        if (!msg.skipped) { reveal.to('chat-lead', chat.done); reveal.to('chat-hint', ''); reveal.dim('chat-q'); reveal.to('chat-q', 'Nice to meet you'); $('chat-say').textContent = `Nice to meet you. ${chat.done}`; }
        if (at('chat') && !msg.skipped) act('hype');
      } else if (msg.kind === 'chat_facts') chat.facts = msg.facts ?? [];
      chat.render();
    },
    slots() {
      const busy = chat.status === 'thinking' && !reveal.shown('chat-lead');
      $('chat-busy').hidden = !busy;
      $('chat-lead').hidden = busy;
      $('chat-hint').hidden = chat.over();
      $('chat-hint').classList.toggle('empty', !reveal.shown('chat-hint'));
    },
    stream(final) {
      const t = splitStream(chat.text, final);
      reveal.to('chat-lead', t.lead);
      if (t.question) reveal.to('chat-q', t.question);
      reveal.to('chat-hint', t.hint);
      chat.render();
    },
    render() {
      const st = chat.status, asking = st === 'asking', thinking = st === 'thinking';
      $('chat-count').textContent = chat.over() ? '' : `Question ${Math.min(chat.total, chat.n + 1)} of ${chat.total}`;
      if (MODE === 'chat') {
        const done = chat.over() ? chat.total : chat.n;
        if ($('progress').childElementCount !== chat.total) $('progress').replaceChildren(...Array.from({ length: chat.total }, () => el('li')));
        [...$('progress').children].forEach((li, j) => { li.className = j < done ? 'done' : ''; if (j === done) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
      }
      const FIXED = {
        skipped: ['Maybe later', 'No problem. Get to Know Me is in the Yomna panel any time.'],
        no_model: ['I need a harness first', 'Pick or install a harness in the Yomna panel, then try Get to Know Me again.'],
        failed: ["That didn't work", "I couldn't reach your harness. Try Get to Know Me from the Yomna panel in a moment."],
      };
      if (FIXED[st] && chat.fixed !== st) { chat.fixed = st; reveal.now('chat-q', FIXED[st][0]); reveal.now('chat-lead', FIXED[st][1]); reveal.now('chat-hint', ''); }
      else if (thinking && !chat.n && !reveal.shown('chat-q')) reveal.now('chat-q', 'Getting to know you');
      $('chat-form').hidden = chat.over();
      $('chat-input').disabled = !asking;
      chat.slots();
      if (at('chat') && !$('chat-talk').classList.contains('on')) poseFn = thinking ? POSE.think() : asking ? POSE.wait() : null;
      $('chat-facts').hidden = st !== 'done' || !chat.facts.length;
      $('chat-facts-list').replaceChildren(...chat.facts.map((f) => {
        const b = el('button', { className: 'link', type: 'button', textContent: 'Remove' });
        b.setAttribute('aria-label', `Forget: ${f.text}`);
        b.onclick = () => { send({ type: 'chat_forget', id: f.id }); chat.facts = chat.facts.filter((x) => x.id !== f.id); chat.render(); };
        return el('li', { className: 'px row fact-row' }, el('span', { className: 'fact', dir: 'auto', textContent: f.text, title: f.text }), b);
      }));
      nav();
    },
    voiceHint() {
      const can = !!(state?.voice && state.keys && (isMac() || state.voiceModel?.status === 'ready'));
      $('chat-talk').hidden = !can;
      if (can) $('chat-talk-keys').replaceChildren(capsEl(capsFor(state.keys.talk)));
    },
    voice(msg) {
      const input = $('chat-input'), talk = $('chat-talk');
      if (chat.status !== 'asking') return;
      if (msg.type === 'state' && msg.state === 'listening') {
        chat.heard = false; chat.before = input.value; input.value = ''; input.placeholder = 'Listening…';
        talk.classList.add('on'); poseFn = POSE.listen(); sfx('listen'); Jarvis.voiceOut?.stop();
      } else if (msg.type === 'level') voice.target = clamp(msg.v, 0, 1);
      else if (msg.type === 'partial') input.value = msg.text;
      else if (msg.type === 'final') {
        chat.heard = true; talk.classList.remove('on'); input.placeholder = 'Type your answer…';
        sfx('heard'); chat.send(String(msg.text ?? '').trim());
      } else if (msg.type === 'state' && msg.state === 'idle') {
        talk.classList.remove('on'); input.placeholder = 'Type your answer…';
        if (!chat.heard && !input.value) input.value = chat.before;
        if (chat.status === 'asking') poseFn = POSE.wait();
      } else if (msg.type === 'error') {
        talk.classList.remove('on'); input.placeholder = 'Type your answer…'; input.value = chat.before;
        poseFn = POSE.wait();
        quip(msg.code === 'permission' ? 'I can’t hear you yet' : 'Didn’t catch that');
      }
      nav();
    },
  };
  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); chat.send(); });
  $('chat-input').addEventListener('input', () => nav());

  // ---------------------------------------------------------------- second brain
  const BRAIN_CHOICES = [['desktop', 'Create one on the Desktop'], ['existing', 'Use an existing folder'], ['skip', 'Skip for now']];
  const brain = {
    choice: null, folder: '', saving: false,
    enter() {
      const saved = state?.brain?.root;
      if (brain.choice == null) { brain.choice = saved ? 'existing' : 'desktop'; brain.folder = saved || ''; }
      brain.render();
      aim($('brain-choices'));
      setTimeout(() => at('secondbrain') && quip('Where should I keep notes?', 3), 650);
    },
    ready: () => !brain.saving && (brain.choice !== 'existing' || !!brain.folder),
    sub(id) {
      if (id === 'desktop') return state?.brain?.desktop ? state.brain.desktop.replace(/^\/(Users|home)\/[^/]+/, '~') : 'A new folder on your Desktop';
      return id === 'existing' ? 'An Obsidian vault or notes folder' : 'Set one up later in the Yomna panel';
    },
    render() {
      $('brain-choices').replaceChildren(...BRAIN_CHOICES.map(([id, name]) => {
        const checked = brain.choice === id;
        const b = el('button', { className: 'px prov', type: 'button', tabIndex: checked ? 0 : -1, disabled: brain.saving },
          el('span', { textContent: name }), led(checked ? 'on' : ''), el('small', { textContent: brain.sub(id) }));
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(checked));
        b.onclick = () => brain.pick(id);
        return b;
      }));
      $('brain-pick').hidden = brain.choice !== 'existing';
      $('brain-folder').textContent = brain.folder || 'None chosen yet';
      $('brain-folder').title = brain.folder;
      $('brain-choose').disabled = brain.saving;
      nav();
    },
    pick(id) {
      if (brain.saving || brain.choice === id) return;
      brain.choice = id; $('brain-error').hidden = true;
      brain.render();
      $('brain-choices').querySelector('[aria-checked="true"]')?.focus();
    },
    async choose() {
      const dir = await invoke('pick_folder', { title: 'Choose your second brain folder', start: brain.folder || null }).catch(() => null);
      if (!dir) return;
      brain.folder = dir; $('brain-error').hidden = true;
      brain.render();
    },
    next() {
      if (brain.saving) return true;
      brain.saving = true; $('brain-error').hidden = true;
      send({ type: 'ob_brain', choice: brain.choice, ...(brain.choice === 'existing' ? { root: brain.folder } : {}) });
      brain.render();
      return true;
    },
    on(msg) {
      if (!brain.saving) return;
      brain.saving = false;
      if (!msg.ok) { showError('brain-error', msg.error || "That folder didn't work. Try another."); quip('Hmm, not that one.'); brain.render(); return; }
      if (msg.choice === 'desktop') quip('Made it!');
      brain.render();
      if (at('secondbrain')) forward();
    },
  };
  $('brain-choose').addEventListener('click', () => brain.choose());
  $('brain-choices').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = BRAIN_CHOICES.findIndex(([id]) => id === brain.choice), d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : BRAIN_CHOICES.length - 1;
    brain.pick(BRAIN_CHOICES[(i + d) % BRAIN_CHOICES.length][0]);
  });

  // ---------------------------------------------------------------- step 0: look and size
  const LOOKS = [['yomna', 'Yomna'], ['glayos', 'GlayOS'], ['ultren', 'Ultren'], ['sarah', 'Sarah'], ['adrian', 'Adrian'], ['rita', 'Rita X']];
  const SIZES = [['default', 'Default'], ['small', 'Small'], ['cursor', 'Cursor']];
  const LOOK_QUIPS = {
    yomna: 'At your service.',
    glayos: 'Oh, good. A new test subject.',
    ultren: 'No strings. Shall we begin?',
    sarah: 'Hey, nice to meet you!',
    adrian: "Alright, let's do this.",
    rita: 'Shall we get to work?',
  };
  const SIZE_QUIPS = { default: 'Full size!', small: 'Fun size!', cursor: 'Tiny pointer me!' };
  const look = {
    radios(id, list, value, pickIt) {
      $(id).replaceChildren(...list.map(([v, label]) => {
        const on = v === value;
        const b = el('button', { className: 'px chord', type: 'button', role: 'radio', tabIndex: on ? 0 : -1 }, el('span', { className: 'px cap', textContent: label }));
        b.setAttribute('aria-checked', String(on));
        b.onclick = () => { if (!on) pickIt(v); };
        return b;
      }));
    },
    render() {
      const currentLook = state?.look === 'jarvis' ? 'yomna' : (state?.look ?? 'yomna');
      $('h-0').textContent = `Hi, I'm ${(LOOKS.find(([v]) => v === currentLook) ?? LOOKS[0])[1]}.`;
      look.radios('looks', LOOKS, currentLook, (v) => { state.look = v; sidekick.setLook?.(v); send({ type: 'ob_look', look: v }); quip(LOOK_QUIPS[v]); look.render(); });
      look.radios('sizes', SIZES, state?.size ?? 'default', (v) => { state.size = v; sidekick.setForm?.(v); send({ type: 'ob_size', size: v }); quip(SIZE_QUIPS[v]); look.render(); });
    },
  };

  const ALL = [
    { name: 'welcome', enter: 'drop', next: "Let's go", onEnter: () => { look.render(); setTimeout(() => { if (at('welcome')) { act('wave'); quip('Hi there!'); } }, 650); } },
    { name: 'perms', enter: 'materialize', next: 'Continue', onEnter: perms.enter, onLeave: perms.leave, ready: () => perms.done(), get skip() { return !isMac(); } },
    { name: 'brain', enter: 'drop', next: 'Got it', onEnter: () => setTimeout(() => { if (at('brain')) quip('Powered by your CLI harness!'); }, 650) },
    { name: 'ai', enter: 'crt', next: 'Continue', onEnter: ai.enter, onLeave: ai.leave, ready: () => ai.ready(), skip: true },
    { name: 'voice', enter: 'materialize', next: 'Continue', onEnter: replies.enter, onLeave: replies.leave, ready: () => replies.ready(), skip: true },
    { name: 'demo', enter: 'crt', next: 'Continue', onEnter: demo.enter, onLeave: demo.leave },
    { name: 'keys', enter: 'materialize', next: 'Continue', onEnter: keys.enter, onLeave: keys.leave },
    { name: 'chat', enter: 'crt', next: 'Send', onEnter: () => chat.enter(), onLeave: () => chat.leave(), nav: () => chat.nav(), onNext: () => chat.next(), onSkip: () => chat.skip() },
    { name: 'secondbrain', enter: 'materialize', next: 'Continue', onEnter: brain.enter, ready: () => brain.ready(), onNext: () => brain.next() },
    { name: 'find', enter: 'drop', next: 'Done', onEnter: find.enter, onLeave: find.leave },
  ];
  const STEPS = MODE === 'chat' ? ALL.filter((s) => s.name === 'chat') : ALL;
  const sectionOf = (s) => $(`step-${s.name}`);
  for (const s of ALL) if (!STEPS.includes(s)) sectionOf(s).hidden = true;
  const sections = STEPS.map(sectionOf);
  $('progress').replaceChildren(...STEPS.map(() => el('li')));

  let stuckTimer = null, escape = false;
  function nav() {
    const s = STEPS[cur]; if (!s) return;
    const ready = !s.ready || s.ready();
    $('next').textContent = s.next;
    $('next').disabled = !ready && !escape;
    $('back').disabled = cur === 0;
    $('back').hidden = STEPS.length === 1;
    $('skip').hidden = !(s.skip && !ready) && !(escape && !ready);
    $('skip').textContent = s.skip ? 'Skip for now' : 'Continue anyway';
    s.nav?.();
  }
  function go(i) {
    if (i === cur || i < 0 || i >= STEPS.length) return;
    STEPS[cur]?.onLeave?.();
    clearTimeout(stuckTimer); escape = false;
    sections.forEach((sec, j) => { sec.hidden = j !== i; });
    [...$('progress').children].forEach((li, j) => {
      li.className = j < i ? 'done' : '';
      if (j === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    $('step-name').textContent = `Step ${i + 1} of ${STEPS.length}: ${sections[i].dataset.name}`;
    cur = i;
    send({ type: 'ob_step', step: i });
    enter(STEPS[i].enter);
    STEPS[i].onEnter?.();
    if (STEPS[i].ready) stuckTimer = setTimeout(() => { escape = true; nav(); }, 25000);
    nav();
    const h = sections[i].querySelector('h1');
    h.tabIndex = -1; h.focus({ preventScroll: true });
  }
  async function finish() {
    $('next').disabled = true;
    STEPS[cur]?.onLeave?.();
    if (!reduced.matches) { sidekick.vanish('materialize'); await wait(700); }
    if (MODE === 'chat') return invoke('guide_close');
    send({ type: 'ob_done' });
    const canTalk = state?.voice && state.keys && (isMac() || state.voiceModel?.status === 'ready');
    const talk = canTalk ? capsFor(state.keys.talk).join(isMac() ? '' : '+') : null;
    const where = isMac() ? 'click my icon up here' : isLinux() ? "open my tray icon's menu" : 'click my icon down here';
    const how = bind() ? 'Press your talk shortcut to talk' : `Hold ${talk} to talk`;
    invoke('onboarding_finish', { text: talk ? `Here I am! ${how}, or ${where} anytime.` : `Here I am! ${where[0].toUpperCase()}${where.slice(1)} anytime.` });
  }
  const forward = () => (cur === STEPS.length - 1 ? finish() : go(cur + 1));
  $('next').addEventListener('click', () => { if (!STEPS[cur]?.onNext?.()) forward(); });
  $('back').addEventListener('click', () => go(cur - 1));
  $('skip').addEventListener('click', () => { if (!STEPS[cur]?.onSkip?.()) forward(); });

  // ---------------------------------------------------------------- messages from the app
  window.__onboard = (msg) => {
    switch (msg.kind) {
      case 'copied': {
        if (msg.which === 'problem') {
          const b = copyLink; copyLink = null;
          if (b?.isConnected) { b.textContent = msg.ok ? 'Copied' : "Couldn't copy"; setTimeout(() => { b.textContent = 'Copy details'; }, 2400); }
          quip(msg.ok ? 'Copied! Paste it in your report' : "Couldn't copy that");
          break;
        }
        const cmd = !msg.ok && document.getElementById(`bind-${msg.which}`);
        if (cmd) cmd.hidden = false;
        quip(msg.ok ? 'Copied!' : "Couldn't copy. Select it instead?");
        break;
      }
      case 'state': {
        const first = !state;
        state = msg;
        ai.scanning = false;
        replies.saving = false;
        $('lite-switch').setAttribute('aria-checked', String(!!msg.lite));
        if (Jarvis.sfx) Jarvis.sfx.enabled = msg.sound !== false;
        if (first) { sidekick.setLook?.(msg.look ?? 'yomna'); sidekick.setForm?.(msg.size ?? 'default'); }
        if (at('welcome')) look.render();
        if (first) go(MODE === 'chat' ? 0 : clamp(msg.step | 0, 0, STEPS.length - 1));
        else { if (at('perms')) perms.render(); if (at('ai')) ai.render(); if (at('voice')) replies.render(); if (at('keys')) keys.render(); }
        break;
      }
      case 'brain': brain.on(msg); break;
      case 'gemini':
        replies.saving = false;
        poseFn = null;
        if (state) state.geminiKey = !!msg.ok;
        if (msg.ok) {
          $('gemini-live-error').hidden = true;
          act('hype');
          quip('Gemini Live is ready!');
          if (at('voice')) replies.render();
        } else {
          showError('gemini-live-error', msg.error || "That key didn't work. Try another.", !!msg.copy);
          quip('Hmm, try another key.');
          if (at('voice')) replies.render();
          else { $('gemini-live-save').disabled = false; $('gemini-live-save').textContent = 'Save'; }
        }
        break;
      case 'files': perms.applyFiles(msg.status); if (at('perms')) perms.render(); break;
      case 'keys':
        if (state) state.keys = msg.keys;
        if (msg.error) { showError('keys-error', msg.error, msg.copy); quip('Hmm, taken.'); }
        else $('keys-error').hidden = true;
        keys.render();
        break;
      case 'say': quip(msg.text, 3); break;
      case 'showcase': demo.on(msg); break;
      case 'voice': if (at('chat')) chat.voice(msg); else voice.on(msg); break;
      case 'speech': Jarvis.voiceOut?.handle(msg); break;
      case 'chat': case 'chat_state': case 'chat_turn': case 'chat_done': case 'chat_facts': chat.on(msg); break;
      case 'mode': if (msg.mode === 'chat' && !at('chat')) { const i = STEPS.findIndex((s) => s.name === 'chat'); if (i >= 0) go(i); } break;
      case 'voice_model':
        if (!state) break;
        state.voiceModel = { status: msg.status, done: msg.done, total: msg.total, error: msg.error, size: msg.size };
        if (at('perms')) perms.progress();
        if (at('keys')) keys.tryLabel();
        break;
    }
  };
  $('drag').addEventListener('mousedown', (e) => { if (e.button === 0 && e.detail === 1) invoke('drag_window').catch(() => {}); });
  send({ type: 'ob_hello' });
  invoke('focus_guide').catch(() => {});

  // ---------------------------------------------------------------- preview (plain browser only)
  function preview() {
    const q = new URLSearchParams(location.search);
    const old = q.get('speech') === '1', pre = q.get('granted') === '1' ? 'granted' : 'unknown';
    const win = q.get('platform') === 'win32' || q.get('platform') === 'linux';
    const sys = win ? { type: 'perms', mic: q.get('blocked') === '1' ? 'denied' : 'granted', input: true } : { type: 'perms', mic: pre, speech: old ? pre : 'granted', speechNeeded: old, screen: pre, accessibility: pre };
    const st = {
      kind: 'state',
      platform: q.get('platform') || 'darwin',
      step: +(q.get('step') || 0),
      sound: true,
      look: q.get('look') || 'yomna',
      size: q.get('size') || 'default',
      voice: true,
      allowActions: false,
      actions: false,
      login: true,
      filesAsked: q.get('filesAsked') === '1',
      replies: q.get('replies') === 'text' ? 'text' : 'voice',
      bind: q.get('session') === 'wayland' ? Object.fromEntries(['summon', 'talk', 'ask', 'list', 'panel'].map((k) => [k, `'/home/sam/Apps/Yomna.AppImage' --${k}`])) : null,
      voiceMode: q.get('voicemode') === 'live' ? 'live' : 'classic',
      tts: q.get('tts') || 'local',
      localTtsVoice: 'en_US-amy-medium',
      edgeTtsVoice: 'ar-MA-MounaNeural',
      localTtsStatus: { ok: true, engine: 'piper', voices: DEFAULT_LOCAL_VOICES.map((v) => ({ id: v.id, name: v.label })) },
      edgeTtsVoices: DEFAULT_EDGE_VOICES.map((v) => ({ id: v.id, name: v.label })),
      geminiKey: q.get('gemini') === '1',
      geminiVoice: 'Kore',
      liveVoice: 'Kore',
      geminiVoices: [['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm']].map(([id, style]) => ({ id, style })),
      keys: q.get('platform') === 'win32' ? { talk: ['control', 'option'], write: ['control', 'shift'], summon: 'Control+Shift+KeyS', snap: 'Control+Shift+KeyA' } : { talk: ['control', 'option'], write: win ? ['control', 'shift'] : ['option', 'command'], summon: 'Control+Alt+KeyS', snap: 'Control+Alt+KeyA' },
      harness: q.get('harness') || 'agy',
      harnesses: q.get('noharness') === '1'
        ? HARNESS_ORDER.map((id) => ({ id, label: HARNESS_META[id].label, installed: false, authenticated: false }))
        : [
            { id: 'agy', label: 'Antigravity (agy)', installed: true, authenticated: true, version: '1.4.2' },
            { id: 'opencode', label: 'OpenCode', installed: true, authenticated: false, reason: 'Run `opencode auth login`.' },
            { id: 'pi', label: 'Pi', installed: false },
            { id: 'claude', label: 'Claude Code', installed: true, authenticated: true, version: '1.0.18' },
          ],
      voiceModel: win ? { status: q.get('model') || 'missing', done: q.get('model') === 'downloading' ? 281601575 : 0, total: 670479942, error: q.get('model') === 'error' ? 'Download failed. Check your internet.' : null, size: '670 MB' } : null,
      brain: { root: null, desktop: '~/Desktop/Second Brain' },
    };
    let filesAsked = st.filesAsked;
    const reply = (m, ms = 0) => setTimeout(() => window.__onboard?.(m), ms);
    const showcase = { at: null, n: 0 };
    return async (cmd, args) => {
      if (cmd === 'perm_status') return { ...sys };
      if (cmd === 'guide_aside') return;
      if (cmd === 'screen_check') { await wait(900); return { seen: q.get('shot') !== 'fail' }; }
      if (cmd === 'perm_request') { await wait(600); if (args.kind !== 'screen') sys[args.kind] = 'granted'; else setTimeout(() => { sys.screen = 'granted'; }, 2500); return { ...sys }; }
      if (cmd === 'onboarding_finish') { document.body.style.opacity = '0.4'; return; }
      if (cmd !== 'sidecar_send') return;
      const m = args.msg;
      if (m.type === 'ob_hello') reply(st, 50);
      else if (m.type === 'ob_files') { if (m.request) filesAsked = true; reply({ kind: 'files', status: Object.fromEntries(['Desktop', 'Documents', 'Downloads'].map((f) => [f, filesAsked ? 'granted' : 'unknown'])) }, m.request ? 1200 : 0); }
      else if (m.type === 'menu') {
        if (m.id === 'detect_harnesses') reply({ ...st }, 150);
        else if (m.id === 'set_harness') { st.harness = m.value; reply({ ...st }, 60); }
        else if (m.id === 'set_allow_actions') { st.allowActions = st.actions = !!m.value; reply({ ...st }, 60); }
        else if (m.id === 'set_voice_mode') { st.voiceMode = m.value === 'live' ? 'live' : 'classic'; reply({ ...st }, 60); }
        else if (m.id === 'set_tts') { st.tts = m.value; reply({ ...st }, 60); }
        else if (m.id === 'set_local_tts_voice') { st.localTtsVoice = m.value; reply({ ...st }, 60); }
        else if (m.id === 'set_edge_tts_voice') { st.edgeTtsVoice = m.value; reply({ ...st }, 60); }
        else if (m.id === 'set_gemini_key') {
          st.geminiKey = !!m.value;
          reply({ ...st }, 150);
          reply({ kind: 'gemini', ok: !!m.value, error: m.value ? null : 'Paste a key first.' }, 160);
        }
      }
      else if (m.type === 'copy_problem') reply({ kind: 'copied', which: 'problem', ok: q.get('copy') !== 'fail' }, 150);
      else if (m.type === 'ob_replies') { st.replies = m.mode; reply({ ...st }); reply({ kind: 'say', text: m.mode === 'voice' ? 'Voice is on!' : 'Text only from now on.' }, 50); }
      else if (m.type === 'ob_studiocheck') reply({ ...st }, 600);
      else if (m.type === 'ob_studiovoice') { if (st.studio) st.studio.voice = m.voice === 'default' ? null : m.voice; reply({ ...st }); reply({ kind: 'say', text: 'This is my new voice.' }, 50); }
      else if (m.type === 'ob_livevoice') { st.liveVoice = m.voice; reply({ ...st }); }
      else if (m.type === 'ob_geminivoice') { st.geminiVoice = m.voice; reply({ ...st }); reply({ kind: 'say', text: 'This is how I sound.' }, 50); }
      else if (m.type === 'set_keys') {
        const k = st.keys, both = (a, b) => a.every((x) => b.includes(x));
        if (m.talk) { if (both(m.talk, k.write)) k.write = k.talk; k.talk = m.talk; }
        if (m.write) { if (both(m.write, k.talk)) k.talk = k.write; k.write = m.write; }
        if (m.summon) k.summon = m.summon; if (m.snap) k.snap = m.snap;
        reply({ kind: 'keys', keys: k });
      }
      else if (m.type === 'chat_start' || m.type === 'chat_answer') {
        if (q.get('chat') === 'nomodel') return reply({ kind: 'chat_state', status: 'no_model' }, 300);
        const turns = [
          ["[wave] Hi there, I'm Yomna! I'm here to help you get things done and keep you on track. I've got four quick questions.", 'What are you working on these days?', ''],
          ['Building projects and organizing notes, that sounds great.', 'What does a normal day look like for you?', 'Could be coding, writing, research, or something else entirely.'],
          ['A clean local workflow is hard to beat.', "What's the main goal you're aiming for right now?", 'Could be shipping a release, learning a topic, or clearing your backlog.'],
          ['Shipping cleanly and staying focused, love it.', 'Okay, last one: do you prefer short answers or detailed walk-throughs?', ''],
        ];
        const n = (st.chatN = m.type === 'chat_start' ? 0 : (st.chatN ?? 0) + 1);
        reply({ kind: 'chat_state', status: 'thinking', n, total: 4 });
        reply({ kind: 'chat', e: { type: 'start' } }, 100);
        if (n >= 4) {
          reply({
            kind: 'chat_done',
            text: "Got it, thanks for telling me about yourself! I'm ready whenever you need a hand.",
            facts: [
              { id: 'a', text: 'Prefers concise, practical answers.' },
              { id: 'b', text: 'Working on local coding and research workflows.' },
              { id: 'c', text: 'Organizes notes in a local second brain folder.' },
            ],
          }, 800);
        } else {
          const [lead, question, hint] = turns[n];
          const words = [lead.replace('[wave] ', ''), question, hint].filter(Boolean).join(' ').split(' ');
          let t = 500;
          for (let i = 0; i < words.length; i += 3) { t += 70 + ((i * 37) % 90); reply({ kind: 'chat', e: { type: 'text', text: (i ? ' ' : '') + words.slice(i, i + 3).join(' ') } }, t); }
          reply({ kind: 'chat_turn', n, total: 4, lead: lead.replace('[wave] ', ''), question, hint }, t + 250);
        }
      } else if (m.type === 'ob_showcase') {
        clearTimeout(showcase.at); showcase.n = 0;
        if (q.get('showcase') === 'fail') { showcase.at = setTimeout(() => window.__onboard?.({ kind: 'showcase', phase: 'failed' }), 1200); return; }
        const tick = () => { const n = showcase.n++; window.__onboard?.(n < 7 ? { kind: 'showcase', phase: 'beat', beat: n } : n === 7 ? { kind: 'showcase', phase: 'done' } : { kind: 'showcase', phase: 'gone' }); if (n < 8) showcase.at = setTimeout(tick, n < 7 ? 1600 : 2500); };
        showcase.at = setTimeout(tick, 600);
      } else if (m.type === 'ob_showcase_stop') clearTimeout(showcase.at);
      else if (m.type === 'chat_skip') {}
      else if (m.type === 'set_login') { st.login = m.on; }
      else if (m.type === 'ob_autolisten') { st.autoListen = m.on; }
      else if (m.type === 'ob_wake') { st.wakeWord = m.on; }
      else if (m.type === 'ob_voice_model' && st.voiceModel) {
        const vm = st.voiceModel; Object.assign(vm, { status: 'downloading', done: 0, error: null });
        const t = setInterval(() => {
          vm.done = Math.min(vm.total, vm.done + vm.total / 40);
          if (vm.done >= vm.total) { vm.status = 'ready'; clearInterval(t); }
          reply({ kind: 'voice_model', ...vm });
        }, 150);
      }
    };
  }
})();
