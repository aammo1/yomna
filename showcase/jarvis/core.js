(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const rand = (a, b) => a + Math.random() * (b - a);
  const angDamp = (a, b, lambda, dt) => {
    let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return a + d * (1 - Math.exp(-lambda * dt));
  };
  const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');

  const R = (window.Yomna = window.Jarvis = { types: [], TAU, clamp, lerp, damp, rand, angDamp });
  R.register = (def) => R.types.push(def);
  R.unit = (env) => env.unit ?? Math.min(env.w, env.h);
  // Screen edges covered by the menu bar / Dock / taskbar, in CSS px. The desktop host keeps it current.
  R.safe = { top: 0, right: 0, bottom: 0, left: 0 };
  R.coordScale = +window.YOMNA_COORD_SCALE > 0.5 ? +window.YOMNA_COORD_SCALE : 1;
  R.setSafe = (s) => { for (const k of ['top', 'right', 'bottom', 'left']) R.safe[k] = Math.max(0, +s?.[k] || 0); R.origin = { x: +s?.ox || 0, y: +s?.oy || 0 };
    R.coordScale = +s?.coordScale > 0.5 ? +s.coordScale : 1;
    // The notch capsule keeps its own space at the top while it's open (notch.js): cards and drawings land below it.
    R.safeTop0 = R.safe.top; R.safe.top = Math.max(R.safe.top, R.notchReserve || 0);
    // The camera notch on this screen (macOS, main.rs safe_js), for the notch capsule (notch.js), or null.
    const n = s?.notch; R.safe.notch = n && +n.w > 0 ? { x: +n.x || 0, w: +n.w, h: +n.h || 32 } : null; };
  R.origin = { x: 0, y: 0 };

  // Damped 1D spring, used for squash/pop.
  class Spring {
    constructor(k = 170, c = 11) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
    update(dt, target = 0) {
      this.v += (-this.k * (this.x - target) - this.c * this.v) * dt;
      this.x += this.v * dt;
      return this.x;
    }
    kick(v) { this.v += v; }
  }
  R.Spring = Spring;

  // Wander / seek / drag / fling body shared by every jarvis.
  class Mover {
    constructor(env, o = {}) {
      this.o = Object.assign({ speed: 110, accel: 2.6, margin: 0.2, curiosity: 0.4, restMin: 0.8, restMax: 3, bounce: 0.6, friction: 1.6 }, o);
      this.x = env.spawn ? env.spawn.x : env.w * rand(0.35, 0.65);
      this.y = env.spawn ? env.spawn.y : env.h * rand(0.35, 0.65);
      this.vx = 0; this.vy = 0;
      this.tx = this.x; this.ty = this.y;
      this.mode = 'rest'; this.rest = rand(0.3, 1.5);
      this.dragging = false; this.flung = false;
      this.radius = 40;
      this.stretch = 0; this.ang = 0;
      this.grabX = 0; this.grabY = 0;
      this.onBonk = null;
    }
    get speed() { return Math.hypot(this.vx, this.vy); }
    goTo(x, y) { this.tx = x; this.ty = y; this.mode = 'go'; this.flung = false; }
    // drive(dt, env): set x, y, vx, vy for this frame from outside (following the cursor), before the body,
    // face and tail are laid out, so they all agree on where it is.
    drive = null;
    pick(env) {
      // Anchored: idle shuffles around a home spot instead of roaming the screen.
      if (this.anchor) {
        const a = this.anchor, r = a.r ?? 20;
        this.goTo(a.x + rand(-r, r), a.y + rand(-r * 0.45, r * 0.45));
        return;
      }
      const m = env.margin ?? this.o.margin, w = env.w, h = env.h;
      if (env.mouse.inside && Math.random() < this.o.curiosity * (env.curiosity ?? 1)) {
        this.goTo(clamp(env.mouse.x + rand(-70, 70), w * m, w * (1 - m)), clamp(env.mouse.y + rand(-70, 70), h * m, h * (1 - m)));
      } else {
        this.goTo(rand(w * m, w * (1 - m)), rand(h * m, h * (1 - m)));
      }
    }
    update(dt, env) {
      const o = this.o;
      const sp = o.speed * (this.speedMul ?? 1) * (env.reduced ? 0.45 : 1) * (1 - 0.85 * (env.sleepy || 0));
      if (this.drive && !this.dragging) {
        this.drive(dt, env);
      } else if (this.dragging) {
        const nx = env.mouse.x - this.grabX, ny = env.mouse.y - this.grabY;
        this.vx = lerp(this.vx, (nx - this.x) / Math.max(dt, 1e-3), 0.35);
        this.vy = lerp(this.vy, (ny - this.y) / Math.max(dt, 1e-3), 0.35);
        this.x = nx; this.y = ny;
      } else if (this.flung) {
        const f = Math.exp(-o.friction * dt);
        this.vx *= f; this.vy *= f;
        this.x += this.vx * dt; this.y += this.vy * dt;
        if (this.speed < 35) { this.flung = false; this.mode = 'rest'; this.rest = rand(0.5, 1.2); }
      } else {
        if (this.mode === 'rest') {
          this.rest -= dt;
          if (this.rest <= 0 && !(env.sleepy > 0.5)) this.pick(env);
        }
        const dx = this.tx - this.x, dy = this.ty - this.y, d = Math.hypot(dx, dy);
        let dvx = 0, dvy = 0;
        if (this.mode === 'go') {
          const s = sp * Math.min(1, d / (sp * 0.7) + 0.08);
          dvx = (dx / (d || 1)) * s; dvy = (dy / (d || 1)) * s;
          if (d < 5) { this.mode = 'rest'; this.rest = rand(o.restMin, o.restMax); }
        }
        this.vx = damp(this.vx, dvx, o.accel, dt);
        this.vy = damp(this.vy, dvy, o.accel, dt);
        this.x += this.vx * dt; this.y += this.vy * dt;
      }
      if (!this.dragging && !this.drive) this.walls(env);
      const s = this.speed;
      this.stretch = damp(this.stretch, clamp(s / 1100, 0, 0.5), 9, dt);
      if (s > 8) this.ang = angDamp(this.ang, Math.atan2(this.vy, this.vx), 8, dt);
    }
    walls(env) {
      const r = this.radius, s = env.safe ?? {};
      const x0 = (s.left ?? 0) + r, x1 = env.w - (s.right ?? 0) - r, y0 = (s.top ?? 0) + r, y1 = env.h - (s.bottom ?? 0) - r;
      const hit = (axisV) => {
        if (this.flung && Math.abs(axisV) > 260 && this.onBonk) this.onBonk(Math.abs(axisV));
      };
      if (this.x < x0) { hit(this.vx); this.x = x0; this.vx = Math.abs(this.vx) * this.o.bounce; }
      if (this.x > x1) { hit(this.vx); this.x = x1; this.vx = -Math.abs(this.vx) * this.o.bounce; }
      if (this.y < y0) { hit(this.vy); this.y = y0; this.vy = Math.abs(this.vy) * this.o.bounce; }
      if (this.y > y1) { hit(this.vy); this.y = y1; this.vy = -Math.abs(this.vy) * this.o.bounce; }
    }
  }
  R.Mover = Mover;

  // Expression state: blink, happy, surprised, dizzy, sleepy, look direction.
  class Face {
    constructor() {
      this.open = 1; this.happy = 0; this.wide = 0; this.dizzy = 0; this.sleepy = 0;
      this.lookX = 0; this.lookY = 0; this.t = rand(0, 10);
      this.blinkT = -1; this.nextBlink = rand(1, 4);
      this.mood = null; this.moodT = 0;
    }
    set(mood, secs) { this.mood = mood; this.moodT = secs; }
    update(dt, env, x, y, mover) {
      this.t += dt;
      if (this.moodT > 0 && (this.moodT -= dt) <= 0) this.mood = null;
      if (mover && mover.dragging) this.set('surprised', 0.2);
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && this.blinkT < 0) this.blinkT = 0;
      let bl = 0;
      if (this.blinkT >= 0) {
        this.blinkT += dt / 0.16;
        bl = Math.sin(Math.PI * Math.min(1, this.blinkT));
        if (this.blinkT >= 1) { this.blinkT = -1; this.nextBlink = Math.random() < 0.25 ? 0.18 : rand(2, 5.5); }
      }
      this.happy = damp(this.happy, this.mood === 'happy' ? 1 : 0, 12, dt);
      this.wide = damp(this.wide, this.mood === 'surprised' ? 1 : 0, 16, dt);
      this.dizzy = damp(this.dizzy, this.mood === 'dizzy' ? 1 : 0, 8, dt);
      this.sleepy = damp(this.sleepy, env.sleepy > 0.5 && !this.mood ? 1 : 0, 1.6, dt);
      const lid = 1 - this.sleepy * (0.78 + Math.sin(this.t * 0.9) * 0.12);
      this.open = this.wide > 0.5 ? 1 : clamp(Math.min(lid, 1 - bl), 0, 1);
      let lx = Math.sin(this.t * 0.37) * 0.25, ly = Math.cos(this.t * 0.29) * 0.15;
      if (env.mouse.active) {
        const dx = env.mouse.x - x, dy = env.mouse.y - y, d = Math.hypot(dx, dy) || 1;
        const s = Math.min(1, d / 200);
        lx = (dx / d) * s; ly = (dy / d) * s;
      } else if (mover && mover.speed > 12) {
        lx = Math.cos(mover.ang) * 0.7; ly = Math.sin(mover.ang) * 0.7;
      }
      this.lookX = damp(this.lookX, lx, 10, dt);
      this.lookY = damp(this.lookY, ly, 10, dt);
    }
  }
  R.Face = Face;

  const pointer = { x: -1e4, y: -1e4, active: false, last: performance.now(), vx: 0, vy: 0 };
  const setPointer = (x, y) => {
    const now = performance.now(), dt = Math.max(1, now - pointer.last) / 1000;
    pointer.vx = (x - pointer.x) / dt; pointer.vy = (y - pointer.y) / dt;
    pointer.x = x; pointer.y = y; pointer.active = true; pointer.last = now;
  };
  addEventListener('pointermove', (e) => setPointer(e.clientX, e.clientY), { passive: true });
  document.addEventListener('pointerleave', () => { pointer.active = false; });
  addEventListener('blur', () => { pointer.active = false; });

  // Rectangles covering where test(x, y) is true inside box [x, y, w, h], sampled every `cell` px: a run of hits
  // along a row is one rectangle, and the same run on the rows below grows it. Flat [x, y, w, h, …] in whole px,
  // each grown by `pad` all round (what's sampled moves, and the shape made from these is set a moment later).
  // Text in a right-to-left script (Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms, #69).
  const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  R.rtl = (s) => RTL.test(String(s ?? ''));
  // A canvas font for right-to-left text: the Arabic font first, so its own narrow space is used between Arabic words
  // (Martian Mono's space is a whole monospace cell). Other text keeps the font it was given.
  R.rtlFont = (s, font) => (R.rtl(s) ? String(font).replace('"Martian Mono"', '"Jarvis Arabic RTL", "Martian Mono"') : font);
  R.hitRects = (test, box, cell = 12, pad = 8) => {
    const out = [];
    const x0 = Math.floor(box[0]), y0 = Math.floor(box[1]), cols = Math.ceil(box[2] / cell), rows = Math.ceil(box[3] / cell);
    const hit = (i, j) => !!test(x0 + i * cell + cell / 2, y0 + j * cell + cell / 2);
    let open = new Map(); // "first:last" column of a run on the row above → where its rectangle starts in out
    for (let j = 0; j < rows; j++) {
      const next = new Map();
      for (let i = 0; i < cols; i++) {
        if (!hit(i, j)) continue;
        const a = i;
        while (i + 1 < cols && hit(i + 1, j)) i++;
        const key = `${a}:${i}`, k = open.get(key);
        if (k != null) out[k + 3] += cell;
        else out.push(x0 + a * cell - pad, y0 + j * cell - pad, (i - a + 1) * cell + 2 * pad, cell + 2 * pad);
        next.set(key, k ?? out.length - 4);
      }
      open = next;
    }
    return out;
  };

  // Desktop overlay: every companion shares one transparent canvas, cut down to (and moved with) what's drawn. The host app calls
  // Yomna.ptr(x, y) each frame with the real cursor and makes the window click-through unless it returns true.
  R.bootDesktop = (canvas) => {
    const qs = new URLSearchParams(location.search);
    const only = window.YOMNA_ONLY || window.JARVIS_ONLY || qs.get('only')?.split(',');
    const unit = +(window.YOMNA_UNIT || window.JARVIS_UNIT || qs.get('unit') || 340);
    const ctx = canvas.getContext('2d');
    let W = innerWidth, H = innerHeight, dpr = 1, down = null;
    const defs = R.types.filter((d) => !only || only.includes(d.id));
    const cols = Math.max(1, Math.round(Math.sqrt((defs.length * W) / H))), rows = Math.ceil(defs.length / cols);
    const list = defs.map((def, i) => {
      const env = {
        w: W, h: H, dpr, t: 0, unit, margin: 0.05, curiosity: 0.3, transparent: true, safe: R.safe,
        spawn: { x: (((i % cols) + 0.5) / cols) * W, y: ((Math.floor(i / cols) + 0.5) / rows) * H },
        mouse: { x: 0, y: 0, inside: false, active: false }, sleepy: 0, reduced: reducedMQ.matches,
      };
      const c = def.create(env);
      c.mover.onBonk = (s) => { c.face?.set('dizzy', 1.8); c.bonk?.(s); };
      return { def, env, c };
    });
    // The canvas covers only what's drawn this frame (plus slack) and moves with it, so the page uploads
    // and composites a small patch instead of the whole screen at 120 Hz. Drawing stays in screen coordinates.
    Object.assign(canvas.style, { inset: 'auto', left: '0px', top: '0px', transformOrigin: '0 0', willChange: 'transform' });
    let cw = 0, ch = 0, vx = 0, vy = 0, roomy = 0;
    const place = (U, dt) => {
      const x0 = U && clamp(Math.floor(U.x0), 0, W), y0 = U && clamp(Math.floor(U.y0), 0, H);
      const x1 = U && clamp(Math.ceil(U.x1), 0, W), y1 = U && clamp(Math.ceil(U.y1), 0, H);
      if (!U || x1 <= x0 || y1 <= y0) {
        // Nothing to show: hide it and let go of its pixels.
        if (canvas.style.visibility !== 'hidden') { canvas.style.visibility = 'hidden'; canvas.width = canvas.height = 1; cw = ch = 0; }
        return false;
      }
      if (canvas.style.visibility) canvas.style.visibility = '';
      const w = x1 - x0, h = y1 - y0, fits = w <= cw && h <= ch;
      // Grow at once; shrink after a second with lots of room to spare (a bubble closing, say).
      roomy = fits && (cw - w > 320 || ch - h > 320) ? roomy + dt : 0;
      let moved = false;
      if (!fits || roomy > 1) {
        cw = Math.min(W, Math.ceil((w + 96) / 64) * 64); ch = Math.min(H, Math.ceil((h + 96) / 64) * 64);
        canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
        canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
        roomy = 0; moved = true;
      }
      if (moved || x0 < vx || y0 < vy || x1 > vx + cw || y1 > vy + ch) {
        vx = clamp(Math.round((x0 + x1 - cw) / 2), 0, W - cw); vy = clamp(Math.round((y0 + y1 - ch) / 2), 0, H - ch);
        canvas.style.transform = `translate(${vx}px,${vy}px)`;
      }
      return true;
    };
    const resize = () => {
      W = innerWidth; H = innerHeight; dpr = Math.min(2, devicePixelRatio || 1);
      cw = ch = 0;
      for (const o of list) { o.env.w = W; o.env.h = H; o.env.dpr = dpr; o.c.resize?.(o.env); }
    };
    addEventListener('resize', resize);
    resize();
    R.tiles = list.map((o) => ({ def: o.def, creature: o.c, env: o.env }));

    const hitAt = (x, y) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].c.hidden || list[i].c.ghost?.()) continue;
        const m = list[i].c.mover;
        if (Math.hypot(x - m.x, y - m.y) < m.radius * 1.1) return list[i];
      }
      return null;
    };
    // The host's cursor samples (with the time each was read) are replayed a little behind real time, so every
    // frame sees where the cursor was at that frame's instant: even motion however unevenly they arrive.
    const trail = [], LAG = 14;
    let clockOff = Infinity;
    R.ptr = (x, y, t) => {
      if (t != null) {
        const nowMs = performance.now();
        // Host clock → page clock: the smallest delay seen (the fastest delivery), creeping up slowly.
        clockOff = Math.min(clockOff + 0.02, nowMs - t);
        trail.push({ x, y, t: t + clockOff });
        if (trail.length > 48) trail.splice(0, trail.length - 48);
        if (!pointer.active || nowMs - pointer.last > 250) setPointer(x, y);
        pointer.active = true; pointer.last = nowMs;
      } else if (x !== pointer.x || y !== pointer.y) setPointer(x, y);
      return !!down || list.some((o) => o.c.mover.dragging || o.c.hit?.(x, y)) || !!hitAt(x, y) || !!R.panelHit?.(x, y) || !!R.askBarHit?.(x, y) || !!R.homeHit?.(x, y) || !!R.inkHit?.(x, y) || !!R.notchHit?.(x, y);
    };
    // Linux hosts shape the window's click area from these instead of following the cursor (host.js): ptr's answer
    // for a point without moving the pointer, and the patch of screen the canvas covers now (null: nothing drawn).
    R.hitTest = (x, y) => list.some((o) => o.c.hit?.(x, y)) || !!hitAt(x, y) || !!R.panelHit?.(x, y) || !!R.askBarHit?.(x, y) || !!R.homeHit?.(x, y) || !!R.inkHit?.(x, y) || !!R.notchHit?.(x, y, false);
    R.hitBox = () => (cw && ch ? [vx, vy, cw, ch] : null);
    // On the window, not the canvas: the canvas is only as big as what's drawn, and hit areas can reach past it.
    // Clicks on other page elements (the research card) are theirs.
    const ours = (e) => e.target === canvas || e.target === document.body || e.target === document.documentElement;
    addEventListener('wheel', (e) => {
      if (!ours(e)) return;
      const o = list.find((q) => q.c.hit?.(e.clientX, e.clientY));
      if (o) { e.preventDefault(); o.c.wheel?.(e.deltaY); }
    }, { passive: false });
    addEventListener('pointerdown', (e) => {
      if (!ours(e)) return;
      const b = list.find((q) => q.c.hit?.(e.clientX, e.clientY));
      if (b) { b.c.press?.(e.clientX, e.clientY); return; }
      const o = hitAt(e.clientX, e.clientY);
      if (!o) return;
      const m = o.c.mover;
      canvas.setPointerCapture(e.pointerId);
      down = { o, x: e.clientX, y: e.clientY, t: performance.now() };
      m.dragging = true; m.flung = false; m.grabX = e.clientX - m.x; m.grabY = e.clientY - m.y;
      o.c.grab?.(e.clientX, e.clientY);
    });
    const release = (e) => {
      if (!down) return;
      const { o, x, y, t } = down; down = null;
      const c = o.c, m = c.mover;
      m.dragging = false;
      if (Math.hypot(e.clientX - x, e.clientY - y) < 6 && performance.now() - t < 320) {
        c.face?.set('happy', 1.6); c.boop?.(e.clientX, e.clientY); m.mode = 'rest'; m.rest = 1.4;
      } else if (m.speed > 220) m.flung = true;
      else { m.mode = 'rest'; m.rest = 1; }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => { if (down) down.o.c.mover.dragging = false; down = null; });

    let last = performance.now(), skip = false, blank = false, nap = 0, lastSig = '';
    R.wake = () => { if (nap) { clearTimeout(nap); nap = 0; requestAnimationFrame(frame); } };
    const replay = (now, dt) => {
      if (!trail.length) return;
      const at = now - LAG;
      let x, y;
      const z = trail[trail.length - 1], z0 = trail[trail.length - 2];
      if (at >= z.t) {
        // A late sample: carry on along the last stretch for a moment rather than stopping dead.
        const u = z0 && z.t - z0.t > 0.5 && z.t - z0.t < 40 ? Math.min(at - z.t, 16) / (z.t - z0.t) : 0;
        x = z.x + (z.x - (z0?.x ?? z.x)) * u; y = z.y + (z.y - (z0?.y ?? z.y)) * u;
      }
      else if (at <= trail[0].t) ({ x, y } = trail[0]);
      else {
        let i = trail.length - 1;
        while (i > 0 && trail[i - 1].t > at) i--;
        const a = trail[i - 1], b = trail[i], u = (at - a.t) / Math.max(0.001, b.t - a.t);
        x = a.x + (b.x - a.x) * u; y = a.y + (b.y - a.y) * u;
      }
      if (dt > 0) { pointer.vx = (x - pointer.x) / dt; pointer.vy = (y - pointer.y) / dt; }
      pointer.x = x; pointer.y = y;
    };
    const frame = (now) => {
      // Everyone gone: nothing to draw, so the canvas is cleared once and only the bookkeeping (timers,
      // closing bubbles) ticks, ten times a second, off the display clock. A host message wakes it at once.
      const gone = list.length > 0 && list.every((o) => o.c.gone && !o.c.mover.dragging);
      if (gone && blank && now - last < 100) { nap = setTimeout(() => { nap = 0; requestAnimationFrame(frame); }, 100 - (now - last)); return; }
      // On a 120 Hz screen only a moving cursor being followed (or a drag) needs every frame; the rest runs at 60.
      const fast = list.some((o) => o.c.mover.dragging || (o.c.mover.drive && now - pointer.last < 150));
      skip = !gone && !skip && now - last < 12 && !fast;
      if (skip) { requestAnimationFrame(frame); return; }
      const dt = Math.min(gone ? 0.25 : 1 / 30, (now - last) / 1000);
      last = now;
      replay(now, dt);
      const idle = (now - pointer.last) / 1000;
      if (gone && !blank) place(null, dt);
      blank = gone;
      for (const o of list) {
        const { env, c } = o, m = c.mover;
        env.t += dt; env.reduced = reducedMQ.matches; env.sleepy = idle > 12 ? 1 : 0;
        env.mouse.active = pointer.active && idle < 6;
        env.mouse.x = pointer.x; env.mouse.y = pointer.y; env.mouse.vx = pointer.vx; env.mouse.vy = pointer.vy;
        env.mouse.inside = env.mouse.active && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= W && pointer.y <= H;
        if (env.mouse.inside && !m.dragging && !m.drive && idle < 0.05 && Math.hypot(pointer.vx, pointer.vy) > 2600 && Math.hypot(pointer.x - m.x, pointer.y - m.y) < m.radius * 2.2) {
          c.face?.set('surprised', 0.7);
          // Anchored jarvis (the sidekick) only flinch: a shove would dodge the click you were aiming.
          if (!m.anchor) {
            const dx = m.x - pointer.x, dy = m.y - pointer.y, d = Math.hypot(dx, dy) || 1;
            m.vx += (dx / d) * 260; m.vy += (dy / d) * 260;
          }
        }
        c.update(dt, env);
      }
      if (gone) { nap = setTimeout(() => { nap = 0; requestAnimationFrame(frame); }, 100); return; }
      const order = [...list].sort((a, b) => a.c.mover.y - b.c.mover.y);
      let U = null, sig = '';
      for (const o of order) {
        const r = o.c.prepare ? o.c.prepare(o.env) : { x0: 0, y0: 0, x1: W, y1: H, sig: NaN };
        sig += `${r ? r.sig : 'x'},`;
        if (r) U = U ? { x0: Math.min(U.x0, r.x0), y0: Math.min(U.y0, r.y0), x1: Math.max(U.x1, r.x1), y1: Math.max(U.y1, r.y1) } : r;
      }
      const at = `${vx},${vy},${cw},${ch}`, shown = place(U, dt);
      // Same picture in the same place as last frame (resting, nothing moving): leave the canvas alone, so the
      // page has nothing to repaint. NaN never matches, so anything unfingerprinted always redraws.
      const same = shown && !sig.includes('NaN') && sig === lastSig && at === `${vx},${vy},${cw},${ch}`;
      lastSig = shown ? sig : '';
      if (shown && !same) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const o of order) {
          ctx.setTransform(dpr, 0, 0, dpr, -vx * dpr, -vy * dpr);
          ctx.save();
          o.c.draw(ctx, o.env);
          ctx.restore();
        }
      }
      // Nothing on screen (drawn natively, or off it): just the bookkeeping, 30 times a second, off the display clock.
      if (!shown && !list.some((o) => o.c.mover.dragging)) { nap = setTimeout(() => { nap = 0; requestAnimationFrame(frame); }, 33); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
})();
