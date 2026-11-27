// Speaks replies with Local TTS (Kokoro/Piper, default), Edge TTS, VoiceStudio, or optional Gemini TTS,
// and hands the audio to the overlay ({ kind: 'speech' } messages).
// - Local TTS ('local', default): 100% keyless, local-first Piper / Kokoro ONNX (auto-downloading SHA-256 verified
//   models on first use) with espeak-ng fallback.
// - Edge TTS ('edge'): keyless WebSocket streaming (including ar-MA-MounaNeural / en-US-AvaMultilingualNeural);
//   cleanly fails over to 'local' if offline or missing a converter.
// - VoiceStudio ('voicestudio'): the local VoiceStudio app on this computer (voicestudio.mjs), no key, no paid fallback.
// - Gemini ('gemini'): optional, only when the user adds a free AI Studio key.
// - Each reply has its own id, so audio from one that was stopped can never play over the next.
import { DEFAULT_EDGE_VOICE, EDGE_RATE, EdgeVoice } from './edgetts.mjs';
import { GEMINI_DEFAULT_VOICE, GEMINI_MODEL, GEMINI_MODELS, GEMINI_PITCH, GEMINI_RATE, GeminiVoice, geminiAccount } from './gemini.mjs';
import { DEFAULT_LOCAL_VOICE, LOCAL_RATE, LocalVoice, localTtsStatus } from './localtts.mjs';
import { cueFeel } from './speech.mjs';
import { StudioVoice, studioStatus } from './voicestudio.mjs';

export const DEFAULT_TTS_PROVIDER = 'local';

export const PROVIDERS = {
  local: { id: 'local', name: 'Local TTS', Voice: LocalVoice, keyless: true, rate: LOCAL_RATE, defaultVoice: DEFAULT_LOCAL_VOICE },
  edge: { id: 'edge', name: 'Edge TTS', Voice: EdgeVoice, keyless: true, rate: EDGE_RATE, defaultVoice: DEFAULT_EDGE_VOICE, fallback: 'local' },
  voicestudio: { id: 'voicestudio', name: 'VoiceStudio', Voice: StudioVoice, keyless: true, local: true, rate: 24000, defaultVoice: null },
  gemini: { id: 'gemini', name: 'Gemini', Voice: GeminiVoice, account: geminiAccount, models: GEMINI_MODELS, pick: GEMINI_MODEL, freeModel: null, rate: GEMINI_RATE, play: Math.round(GEMINI_RATE * GEMINI_PITCH), defaultVoice: GEMINI_DEFAULT_VOICE },
};

// Silence trimmed from both ends (a little kept).
export function trimSilence(pcm, rate) {
  const s = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1))), loud = 500, pad = Math.round(rate * 0.04);
  let a = 0, b = s.length - 1;
  while (a < s.length && Math.abs(s[a]) < loud) a++;
  if (a === s.length) return Buffer.from(s.buffer);
  while (b > a && Math.abs(s[b]) < loud) b--;
  return Buffer.from(s.slice(Math.max(0, a - pad), Math.min(s.length, b + 1 + pad)).buffer);
}

export const BEATS = [
  'One sec.', 'On it.', 'Hang on.', 'Hold on.', 'Got it.', 'Okay.', 'Sure.', 'Right.', 'Alright.', 'Gotcha.',
  'Checking.', "Let's see.", 'Sure thing.', 'Coming up.', 'Sec.', 'One moment.', 'Bear with.', 'Hmm, okay.', 'Got you.', 'Right, sec.',
  'Sure, sec.', 'Okay, sec.', 'Roger.', 'Yep.', 'Yep, sec.', 'Two secs.', 'Hold tight.', 'Mm-hmm.', 'Will do.', 'Righto.',
  'Moment.', 'Okay, checking.', 'Sure, checking.', 'Okie-dokie.',
];
const RECENT = 8;
const PREWARM_MS = 20_000;
// VoiceStudio: how much of a reply is spoken, in characters (its text is always all shown). 0: no cap.
export const STUDIO_CAPS = { short: 160, medium: 320, full: 0 };
const KEEP_WARM_MS = 4 * 60_000, KEEP_WARM_IDLE_MS = 30 * 60_000, STUDIO_QUIET_MS = 60_000;
const STUDIO_PING = 'Hm.';

// What the overlay says when a reply's voice fails (onProblem's argument).
export const voiceWhy = (message) => String(message ?? '').replace(/^(Gemini|Edge TTS|Local TTS):\s*/i, '').replace(/[.\s]+$/, '');
export function voiceProblemText(what, name) {
  if (what === 'key') return `My ${name} key isn't working, so replies are text for now.`;
  const why = typeof what === 'string' ? voiceWhy(what) : what?.message ? voiceWhy(what.message) : '';
  return why ? `My voice isn't working right now: ${why}. Replies are text for now.` : "My voice isn't working right now, so replies are text for now.";
}

const fallbackLocalVoice = (voiceId) => (/^ar-/i.test(String(voiceId ?? '')) ? 'ar_JO-kareem-medium' : DEFAULT_LOCAL_VOICE);

export function createSpeaker({
  emit,
  onProblem = () => {},
  log = () => {},
  provider = DEFAULT_TTS_PROVIDER,
  LocalVoiceImpl = LocalVoice,
  EdgeVoiceImpl = EdgeVoice,
  StudioVoiceImpl = StudioVoice,
  localStatus = studioStatus,
  providers = {},
  beatPhrases = BEATS,
  prewarmMs = PREWARM_MS,
  keepWarmMs = KEEP_WARM_MS,
  keepWarmIdleMs = KEEP_WARM_IDLE_MS,
  studioQuietMs = STUDIO_QUIET_MS,
  now = () => Date.now(),
  setTimer = (f, ms) => setTimeout(f, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  const all = {
    local: { ...PROVIDERS.local, Voice: LocalVoiceImpl, ...providers.local },
    edge: { ...PROVIDERS.edge, Voice: EdgeVoiceImpl, ...providers.edge },
    voicestudio: { ...PROVIDERS.voicestudio, Voice: StudioVoiceImpl, ...providers.voicestudio },
    gemini: { ...PROVIDERS.gemini, ...providers.gemini },
  };
  for (const [k, v] of Object.entries(providers)) {
    if (!all[k]) all[k] = v;
  }

  let P = all[provider] ?? all.local;
  let key = null;
  let voice = P.defaultVoice;
  let pref = P.pick ?? P.models?.[0] ?? null;
  let model = pref;
  let seq = 0;
  let current = null;
  let checking = null;
  let recent = [];
  let prewarmed = null;

  const chain = () => (P.models?.length ? P.models.slice(Math.max(0, P.models.indexOf(pref))) : [null]);
  const pickBeat = () => {
    if (!beatPhrases.length) return '';
    const fresh = beatPhrases.filter((p) => !recent.includes(p));
    const pool = fresh.length ? fresh : beatPhrases;
    const phrase = pool[Math.floor(Math.random() * pool.length)] ?? beatPhrases[0];
    recent = [...recent, phrase].slice(-Math.min(RECENT, Math.max(0, beatPhrases.length - 1)));
    return phrase;
  };

  async function check() {
    if (P.id === 'voicestudio') return checkLocal();
    if (P.keyless) {
      if (P.id === 'local') return localTtsStatus().catch(() => ({ ok: true, credit: null }));
      return { ok: true, credit: null };
    }
    if (!key) return { ok: false, reason: 'key' };
    if (checking) return checking;
    const p = P;
    const mine = checking = p.account(key).then((a) => {
      if (P !== p) return a;
      if (a.ok && p.models?.length) {
        model = a.credit != null && a.credit <= 0.01 && p.freeModel ? p.freeModel : model === p.freeModel ? pref : model;
      }
      log(`${p.id}_account`, { ok: a.ok, reason: a.reason, model });
      return a;
    }).finally(() => { if (checking === mine) checking = null; });
    return mine;
  }

  function stopAll() {
    if (current) { current.abort(); current = null; }
    emit({ kind: 'speech', stop: true });
  }

  // VoiceStudio state
  let localVoice = null, local = null, studioMode = 'short';
  let lastReq = -Infinity, lastReply = -Infinity;
  let warmTimer = null, pinging = null;
  const isStudio = () => P.id === 'voicestudio';

  async function checkLocal() {
    const s = await localStatus().catch((e) => ({ ok: false, reason: 'offline', message: e.message }));
    local = s;
    log('voicestudio_status', { ok: s.ok, reason: s.reason, engine: s.engine });
    return s;
  }

  function ping() {
    if (pinging || current) return false;
    lastReq = now();
    let v = null;
    const done = () => { if (pinging === v) pinging = null; };
    try {
      v = new all.voicestudio.Voice({ voice: localVoice, onAudio() {}, onEnd: done, onError: done });
      pinging = v;
      v.open?.(); v.say(STUDIO_PING); v.end();
    } catch { done(); }
    return true;
  }

  function keepWarm() {
    if (!isStudio()) return;
    lastReply = now();
    if (warmTimer === null) armWarm();
  }
  function armWarm() {
    warmTimer = setTimer(warmTick, keepWarmMs);
    warmTimer?.unref?.();
  }
  function warmTick() {
    warmTimer = null;
    if (!isStudio() || now() - lastReply >= keepWarmIdleMs) return;
    if (!current) ping();
    armWarm();
  }
  function stopWarm() {
    if (warmTimer !== null) clearTimer(warmTimer);
    warmTimer = null;
  }

  function startStudio() {
    stopAll();
    lastReq = now();
    keepWarm();
    const id = `s${++seq}`, said = [], t0 = Date.now();
    let heard = false, done = false, v = null;
    const finish = (whole = false) => {
      if (done) return;
      done = true;
      const chars = whole && heard ? said.join(' ').replace(/\[[^\]]*\]\s*/g, '').length : 0;
      emit({ kind: 'speech', id, end: true, ...(chars ? { chars } : {}) });
      if (current === me) current = null;
    };
    const me = {
      id,
      say(s) { if (done) return; said.push(s); v.say(s); },
      beat() { return false; },
      end() { if (!done) v.end(); },
      abort() { if (done) return; done = true; v?.abort(); if (current === me) current = null; },
    };
    v = new all.voicestudio.Voice({
      voice: localVoice,
      onAudio: (pcm, rate) => {
        if (done) return;
        if (!heard) {
          heard = true;
          log('speech_first_audio', { id, provider: 'voicestudio', ms: Date.now() - t0 });
          if (local && !local.ok) checkLocal();
        }
        emit({ kind: 'speech', id, rate: rate || all.voicestudio.rate, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
      },
      onEnd: () => finish(true),
      onError: (err) => {
        if (done) return;
        log('speech_error', { id, provider: 'voicestudio', heard: !!err.heard, reason: err.reason, message: err.message });
        if (err.reason) local = { ...(local ?? {}), ok: false, reason: err.reason, message: err.message };
        if (!heard) onProblem({ provider: 'voicestudio', reason: err.reason ?? 'error', message: err.message });
        finish();
      },
    });
    log('speech_start', { id, provider: 'voicestudio', voice: localVoice });
    v.open?.();
    current = me;
    return me;
  }

  function prewarm() {
    if (isStudio()) { if (!current && now() - lastReq > studioQuietMs) ping(); return; }
    if (P.id !== 'edge') return;
    const w = prewarmed;
    if (w && w.voice === voice && w.p === P && w.v.state !== 'done') return;
    dropPrewarm();
    try {
      const v = new P.Voice({ voice, onAudio() {}, onEnd() {}, onError() {} }).open();
      const timer = setTimeout(dropPrewarm, prewarmMs);
      timer.unref?.();
      prewarmed = { voice, p: P, v, timer };
    } catch (e) { log('speech_prewarm_error', { message: e.message }); }
  }

  function dropPrewarm() {
    const w = prewarmed;
    if (!w) return;
    prewarmed = null;
    clearTimeout(w.timer);
    w.v.abort?.();
  }

  function takePrewarm() {
    const w = prewarmed;
    if (!w) return null;
    prewarmed = null;
    clearTimeout(w.timer);
    if (w.voice !== voice || w.p !== P || w.v.state === 'done') { w.v.abort?.(); return null; }
    return w.v;
  }

  /** A new reply's voice, ready now. Call say(sentence) as text streams, then end(). */
  function start() {
    if (isStudio()) return startStudio();
    if (!P.keyless && !key) return null;
    stopAll();
    const id = `s${++seq}`, said = [];
    const activeProvider = P;
    const activeVoice = voice;
    let ended = false, tries = 0, v = null, heard = false, done = false, beat = false, fellBack = false, t0 = Date.now();
    let spoken = 0, feel = null;
    const mark = (s) => {
      const f = cueFeel(s);
      if (f !== feel) { feel = f; emit({ kind: 'speech', id, feel: f, at: spoken }); }
      spoken += s.replace(/\[[^\]]*\]\s*/g, '').length + 1;
    };
    const me = {
      id,
      say(s) { if (done) return; mark(s); said.push(s); v.say(s); },
      beat() {
        if (done || beat || said.length || heard || !beatPhrases.length) return false;
        beat = true;
        const phrase = pickBeat();
        if (!phrase) return false;
        log('speech_beat', { id, ms: Date.now() - t0 });
        me.say(phrase);
        return true;
      },
      end() { if (done || ended) return; ended = true; v.end(); },
      abort() { if (done) return; done = true; v?.abort(); if (current === me) current = null; },
    };
    const finish = (whole = false) => {
      if (done) return;
      done = true;
      const chars = whole && heard ? said.join(' ').replace(/\[[^\]]*\]\s*/g, '').length : 0;
      emit({ kind: 'speech', id, end: true, ...(chars ? { chars } : {}) });
      if (current === me) current = null;
    };

    const connectProvider = (prov, vo, m) => {
      tries++;
      const cbs = {
        onAudio: (pcm, rate) => {
          if (done) return;
          if (!heard) {
            heard = true;
            if (prov === activeProvider && m && m !== model) model = m;
            log('speech_first_audio', { id, provider: prov.id, model: m, ms: Date.now() - t0 });
          }
          const outRate = rate || prov.play || prov.rate;
          emit({ kind: 'speech', id, rate: outRate, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
        },
        onEnd: () => finish(true),
        onError: async (err) => {
          if (done) return;
          log('speech_error', { id, provider: prov.id, model: m, heard: !!err.heard, reason: err.reason, message: err.message });
          if (!err.heard && !heard) {
            // Edge TTS cleanly fails over to Local TTS if offline or missing converter.
            if (prov.fallback === 'local' && !fellBack && all.local) {
              fellBack = true;
              const localVo = fallbackLocalVoice(vo);
              log('speech_edge_fallback', { id, to: 'local', voice: localVo, reason: err.reason });
              connectProvider(all.local, localVo, null);
              for (const s of said) v.say(s);
              if (ended) v.end();
              return;
            }
            if (!prov.keyless) {
              const a = await check();
              if (done) return;
              if (!a.ok && a.reason === 'key') { onProblem('key'); return finish(); }
              const c = chain();
              if (tries < c.length) {
                const next = a.ok && prov.freeModel && model === prov.freeModel ? prov.freeModel : c[Math.min(c.indexOf(m) + 1, c.length - 1)];
                connectProvider(prov, vo, next);
                for (const s of said) v.say(s);
                if (ended) v.end();
                return;
              }
              onProblem(err.message);
            } else {
              onProblem({ provider: prov.id, reason: err.reason ?? 'error', message: err.message });
            }
          }
          finish();
        },
      };

      const warm = tries === 1 && prov.id === 'edge' ? takePrewarm() : null;
      if (warm?.rebind?.(cbs)) {
        v = warm;
      } else {
        warm?.abort?.();
        const inst = new prov.Voice({ ...(prov.keyless ? {} : { key }), voice: vo, ...(m ? { model: m } : {}), ...cbs });
        v = inst;
        inst.open();
      }
    };

    log('speech_start', { id, provider: activeProvider.id, voice: activeVoice, model });
    connectProvider(activeProvider, activeVoice, model);
    current = me;
    return me;
  }

  return {
    setKey(k) {
      if (P.keyless) return;
      if ((k || null) !== key) { dropPrewarm(); if (!k) stopAll(); }
      key = k || null;
      if (key) check();
    },
    setModel(m) {
      if (!P.models?.includes(m) || m === P.freeModel || m === pref) return;
      pref = m;
      if (model !== P.freeModel) model = m;
    },
    get pick() { return pref; },
    probe(text = 'Hi.') {
      if (P.keyless) {
        return new Promise((done) => {
          const v = new P.Voice({ voice: isStudio() ? localVoice : voice, onAudio: () => { v.abort(); done({ ok: true }); }, onEnd: () => done({ ok: true }), onError: (e) => done({ ok: false, status: e.status ?? null, reason: e.reason ?? null, message: e.message }) });
          v.open();
          v.say(text); v.end();
        });
      }
      if (!key) return Promise.resolve({ ok: false, status: null, message: 'no key' });
      return new Promise((done) => {
        const v = new P.Voice({ key, voice, model, onAudio: () => { v.abort(); done({ ok: true }); }, onEnd: () => done({ ok: true }), onError: (e) => done({ ok: false, status: e.status ?? null, message: e.message }) });
        v.open();
        v.say(text); v.end();
      });
    },
    setVoice(v) {
      const next = v || P.defaultVoice;
      if (next !== voice) dropPrewarm();
      voice = next;
    },
    setProvider(id) {
      const p = all[id] ?? all.local;
      dropPrewarm();
      if (p === P) return;
      stopWarm();
      if (P.keyless || key) stopAll();
      P = p;
      key = null;
      checking = null;
      voice = p.defaultVoice;
      pref = p.pick ?? p.models?.[0] ?? null;
      model = pref;
      if (p.id === 'voicestudio') checkLocal();
    },
    get provider() { return P.id; },
    localOpts() { return isStudio() ? { early: true, cap: STUDIO_CAPS[studioMode] ?? 0 } : { early: false, cap: 0 }; },
    setStudioSpeak(m) { if (Object.hasOwn(STUDIO_CAPS, m)) studioMode = m; },
    get studioSpeak() { return studioMode; },
    stopWarm,
    setLocalVoice(v) { localVoice = typeof v === 'string' && v ? v : null; },
    get localVoice() { return localVoice; },
    get local() { return local; },
    checkLocal,
    get ready() { return 0; },
    get model() { return model; },
    get on() { return !!P.keyless || !!key; },
    check,
    start,
    prewarm,
    stop: stopAll,
  };
}
