// Keyless local-first TTS engine: Piper / Kokoro ONNX with pinned, SHA-256 verified model downloads into
// ~/Yomna/Data/models/tts/, plus offline fallback to system piper / kokoro-onnx / espeak-ng.
// Emits 24 kHz 16-bit signed LE mono PCM chunks matching speaker.mjs's open() / say() / end() / abort() contract.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { dataPaths } from './datadir.mjs';

export const LOCAL_RATE = 24000;
export const DEFAULT_LOCAL_VOICE = 'en_US-amy-medium';
const READY = 'ready.json';

const PIPER_REV = '5ec43b186ef915a195d3ddbcfd9916e76c503c3f';
const KOKORO_REV = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';

export const LOCAL_VOICES = [
  {
    id: 'en_US-amy-medium',
    name: 'Amy (US English)',
    lang: 'en-US',
    engine: 'piper',
    rate: 22050,
    espeakVoice: 'en-us',
    base: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_REV}/en/en_US/amy/medium/`,
    files: [
      { name: 'en_US-amy-medium.onnx', size: 63221984, sha256: 'cf9ccdec59f05adee47173f6fb4d89e8b0c5f30c178748d2572fe4efd1d2724c' },
      { name: 'en_US-amy-medium.onnx.json', size: 6289, sha256: '27490c2197e3e7b566b051fc0b1dae21200e72b44c209731419effdbbe0789e5' },
    ],
  },
  {
    id: 'af_heart',
    name: 'Heart (Kokoro English)',
    lang: 'en-US',
    engine: 'kokoro',
    rate: 24000,
    espeakVoice: 'en-us',
    base: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_REV}/`,
    files: [
      { name: 'onnx/model.onnx', localName: 'model.onnx', size: 325532232, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb' },
      { name: 'voices/af_heart.bin', localName: 'af_heart.bin', size: 522240, sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b' },
    ],
  },
  {
    id: 'ar_JO-kareem-medium',
    name: 'Kareem (Arabic)',
    lang: 'ar-JO',
    engine: 'piper',
    rate: 22050,
    espeakVoice: 'ar',
    base: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_REV}/ar/ar_JO/kareem/medium/`,
    files: [
      { name: 'ar_JO-kareem-medium.onnx', size: 63201294, sha256: '9e95cab07b679da603bba17c4dec7ab3111320571964ee95c0379603c086491e' },
      { name: 'ar_JO-kareem-medium.onnx.json', size: 5024, sha256: 'ea6d9b9d9076dbdb6bf5c98c6a141ef154959d2359709b37855727964e7d6c4d' },
    ],
  },
];

export const findLocalVoice = (id) => LOCAL_VOICES.find((v) => v.id === id) ?? LOCAL_VOICES[0];

/** Base directory for locally cached TTS models (~/Yomna/Data/models/tts by default). */
export function ttsModelDir(voiceId = DEFAULT_LOCAL_VOICE, env = process.env) {
  const custom = env.YOMNA_DATA_DIR;
  let dataDir;
  if (custom) {
    dataDir = path.join(custom, 'Yomna', 'Data');
  } else if (env.LOCALAPPDATA) {
    dataDir = path.join(env.LOCALAPPDATA, 'Yomna', 'Data');
  } else {
    const dp = dataPaths(env).dir;
    dataDir = path.basename(path.dirname(dp)) === 'Yomna' ? dp : path.join(os.homedir(), 'Yomna', 'Data');
  }
  return voiceId ? path.join(dataDir, 'models', 'tts', voiceId) : path.join(dataDir, 'models', 'tts');
}

const fileNameOf = (f) => f.localName ?? f.name;
const fileUrlOf = (voice, f) => f.url ?? `${voice.base ?? ''}${f.name}`;
const resolveVoiceArg = (voice, dir) => {
  if (voice && typeof voice === 'object') return voice;
  if (typeof voice === 'string') return findLocalVoice(voice);
  if (dir) {
    const base = path.basename(dir);
    const byDir = LOCAL_VOICES.find((v) => v.id === base);
    if (byDir) return byDir;
    try {
      const marker = JSON.parse(readFileSync(path.join(dir, READY), 'utf8'));
      const byMarker = LOCAL_VOICES.find((v) => v.id === marker.id);
      if (byMarker) return byMarker;
    } catch {}
  }
  return LOCAL_VOICES[0];
};

/** True once every model file for the voice exists with expected size and ready.json marker. */
export function isTtsReady(dir, voice = null) {
  const v = resolveVoiceArg(voice, dir);
  try {
    if (JSON.parse(readFileSync(path.join(dir, READY), 'utf8')).id !== v.id) return false;
    return v.files.every((f) => statSync(path.join(dir, fileNameOf(f))).size === f.size);
  } catch {
    return false;
  }
}

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Downloads and SHA-256 verifies a local TTS voice model into `dir` with HTTP Range resume.
 * Errors carry a code: 'disk', 'checksum', 'network', or 'aborted'.
 */
export async function downloadTtsModel(dir, { voice = null, onProgress = () => {}, signal, fetchImpl = fetch, retries = 4, retryDelay = 2000 } = {}) {
  const v = resolveVoiceArg(voice, dir);
  await fs.mkdir(dir, { recursive: true });
  const total = v.files.reduce((n, f) => n + f.size, 0);
  const have = async (f) => {
    const name = fileNameOf(f);
    for (const p of [path.join(dir, name), path.join(dir, `${name}.part`)]) {
      try { return Math.min((await fs.stat(p)).size, f.size); } catch {}
    }
    return 0;
  };
  let done = (await Promise.all(v.files.map(have))).reduce((a, b) => a + b, 0);
  try {
    const free = await fs.statfs(dir);
    if (free.bavail * free.bsize < total - done + 50e6) {
      throw fail('disk', `Not enough free disk space for TTS voice ${v.id}.`);
    }
  } catch (e) {
    if (e.code === 'disk') throw e;
  }
  onProgress({ done, total });

  for (const f of v.files) {
    const name = fileNameOf(f);
    const final = path.join(dir, name), part = `${final}.part`;
    await fs.mkdir(path.dirname(final), { recursive: true });
    if (existsSync(final) && statSync(final).size === f.size) {
      if (await sha256(final) === f.sha256) continue;
      await fs.rm(final, { force: true });
      done -= f.size;
      onProgress({ done, total });
    }
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw fail('aborted', 'Download stopped.');
      let start = 0;
      try { start = (await fs.stat(part)).size; } catch {}
      if (start > f.size) { await fs.rm(part, { force: true }); done -= start; start = 0; }
      try {
        if (start < f.size) {
          const res = await fetchImpl(fileUrlOf(v, f), { headers: start ? { Range: `bytes=${start}-` } : {}, signal, redirect: 'follow' });
          if (res.status === 416) { await fs.rm(part, { force: true }); done -= start; onProgress({ done, total }); throw fail('network', 'Range not satisfiable'); }
          if (!res.ok || !res.body) throw fail('network', `HTTP ${res.status}`);
          const resumed = res.status === 206 && start > 0;
          if (!resumed && start) { done -= start; start = 0; }
          const fh = await fs.open(part, resumed ? 'a' : 'w');
          try {
            for await (const chunk of res.body) { await fh.write(chunk); done += chunk.length; onProgress({ done, total }); }
          } finally { await fh.close(); }
        }
        if ((await fs.stat(part)).size !== f.size) throw fail('network', 'Download ended early');
        if (await sha256(part) !== f.sha256) {
          await fs.rm(part, { force: true });
          done -= f.size;
          onProgress({ done, total });
          throw fail('checksum', `${name} didn't match its checksum`);
        }
        await fs.rename(part, final);
        break;
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw fail('aborted', 'Download stopped.');
        if (attempt >= retries) throw e.code === 'checksum' ? e : fail('network', `Couldn't download TTS voice (${e.message}).`);
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
      }
    }
  }
  await fs.writeFile(path.join(dir, READY), JSON.stringify({ id: v.id, at: new Date().toISOString() }));
  onProgress({ done: total, total });
}

/** Strip bracketed voice cues so local speech engines don't read them literally. */
export const plain = (text) => String(text ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

/** Resample 16-bit signed LE mono PCM via linear interpolation (e.g. 22050 Hz Piper -> 24000 Hz). */
export function resamplePcm16(pcmBytes, fromRate, toRate = LOCAL_RATE) {
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  const evenLen = bytes.length & ~1;
  if (!evenLen) return new Uint8Array(0);
  if (!fromRate || fromRate === toRate) return bytes.subarray(0, evenLen);

  const srcSamples = evenLen >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, evenLen);
  const dstSamples = Math.max(1, Math.round((srcSamples * toRate) / fromRate));
  const out = new Uint8Array(dstSamples * 2);
  const outView = new DataView(out.buffer);
  const ratio = fromRate / toRate;

  for (let i = 0; i < dstSamples; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = view.getInt16(Math.min(idx, srcSamples - 1) * 2, true);
    const s1 = view.getInt16(Math.min(idx + 1, srcSamples - 1) * 2, true);
    const val = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
    outView.setInt16(i * 2, val, true);
  }
  return out;
}

/** Extract mono 16-bit signed LE PCM and sample rate from a RIFF/WAVE buffer. */
export function parseWavPcm(wavBuffer) {
  const buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { rate: LOCAL_RATE, pcm: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength & ~1) };
  }
  let rate = LOCAL_RATE, channels = 1, offset = 12, pcm = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buf.length, start + size);
    if (id === 'fmt ' && end - start >= 16) {
      channels = buf.readUInt16LE(start + 2) || 1;
      rate = buf.readUInt32LE(start + 4) || LOCAL_RATE;
    } else if (id === 'data') {
      pcm = buf.subarray(start, end);
      break;
    }
    offset = start + size + (size & 1);
  }
  if (!pcm) return { rate, pcm: new Uint8Array(0) };
  if (channels > 1) {
    const frameBytes = channels * 2;
    const frames = Math.floor(pcm.length / frameBytes);
    const mono = Buffer.allocUnsafe(frames * 2);
    for (let i = 0; i < frames; i++) mono.writeInt16LE(pcm.readInt16LE(i * frameBytes), i * 2);
    pcm = mono;
  }
  return { rate, pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength & ~1) };
}

function findBin(names) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    if (!name) continue;
    try {
      const out = execFileSync(cmd, [name], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 2000 }).trim();
      if (out) return out.split(/\r?\n/)[0];
    } catch {}
  }
  return null;
}

export function detectLocalBackends(env = process.env) {
  return {
    piper: findBin([env.YOMNA_PIPER_BIN, 'piper', 'piper-tts']),
    kokoro: findBin([env.YOMNA_KOKORO_BIN, 'kokoro-tts', 'kokoro-onnx']),
    espeak: findBin([env.YOMNA_ESPEAK_BIN, 'espeak-ng', 'espeak']),
  };
}

export async function localTtsStatus() {
  const bins = detectLocalBackends();
  const ok = !!(bins.piper || bins.kokoro || bins.espeak);
  const engine = bins.piper ? 'piper' : bins.kokoro ? 'kokoro' : bins.espeak ? 'espeak-ng' : null;
  return {
    ok,
    reason: ok ? null : 'missing',
    message: ok ? null : 'Install piper, kokoro-onnx, or espeak-ng for local offline speech.',
    engine,
    voices: LOCAL_VOICES.map(({ id, name, lang, engine: e }) => ({ id, name, lang, engine: e })),
  };
}

/**
 * Local keyless TTS session matching speaker.mjs's open() / say() / end() / abort() contract.
 * Emits 24 kHz 16-bit LE mono PCM via onAudio(Uint8Array, 24000).
 */
export class LocalVoice {
  constructor({ voice = DEFAULT_LOCAL_VOICE, rate = LOCAL_RATE, modelDir = null, piperBin = null, kokoroBin = null, espeakBin = null, fetchImpl = fetch, onAudio, onEnd, onError, sentenceTimeout = 60_000 } = {}) {
    this.voiceSpec = findLocalVoice(voice);
    this.voice = this.voiceSpec.id;
    this.rate = rate || LOCAL_RATE;
    this.modelDir = modelDir ?? ttsModelDir(this.voiceSpec.id);
    this.fetchImpl = fetchImpl;
    this.onAudio = onAudio;
    this.onEnd = onEnd;
    this.onError = onError;
    this.sentenceTimeout = sentenceTimeout;
    const detected = detectLocalBackends();
    this.piperBin = piperBin ?? detected.piper;
    this.kokoroBin = kokoroBin ?? detected.kokoro;
    this.espeakBin = espeakBin ?? detected.espeak;

    this.state = 'new'; // new → open → done
    this.ending = false;
    this.busy = false;
    this.heard = false;
    this.queue = [];
    this.stopper = new AbortController();
    this.child = null;
    this.odd = null;
  }

  open() {
    if (this.state === 'new') this.state = 'open';
    return this;
  }

  say(text) {
    if (this.state === 'done' || this.ending) return;
    const t = plain(text);
    if (!t) return;
    if (this.state === 'new') this.open();
    this.queue.push(t);
    this.pump();
  }

  end() {
    if (this.state === 'done' || this.ending) return;
    this.ending = true;
    if (this.state === 'new' || (!this.busy && !this.queue.length)) {
      this.finish();
    }
  }

  abort() {
    this.close();
  }

  async pump() {
    if (this.state !== 'open' || this.busy) return;
    const text = this.queue.shift();
    if (text == null) {
      if (this.ending) this.finish();
      return;
    }
    this.busy = true;
    try {
      await this.speakSentence(text);
    } catch (err) {
      if (this.state !== 'done') this.fail(err);
      return;
    }
    this.busy = false;
    if (this.state === 'open') this.pump();
  }

  async ensureModel() {
    if (isTtsReady(this.modelDir, this.voiceSpec)) return true;
    try {
      await downloadTtsModel(this.modelDir, { voice: this.voiceSpec, fetchImpl: this.fetchImpl, signal: this.stopper.signal, retries: 1, retryDelay: 500 });
      return true;
    } catch {
      return false;
    }
  }

  async speakSentence(text) {
    const errors = [];
    if (this.voiceSpec.engine === 'kokoro' && this.kokoroBin) {
      const hasModel = await this.ensureModel();
      if (hasModel) {
        try { await this.runKokoro(text); return; } catch (e) { errors.push(e); }
      }
    }
    if (this.piperBin) {
      const piperVoice = this.voiceSpec.engine === 'piper' ? this.voiceSpec : findLocalVoice(DEFAULT_LOCAL_VOICE);
      const piperDir = piperVoice.id === this.voiceSpec.id ? this.modelDir : ttsModelDir(piperVoice.id);
      const ready = isTtsReady(piperDir, piperVoice) || (await downloadTtsModel(piperDir, { voice: piperVoice, fetchImpl: this.fetchImpl, signal: this.stopper.signal, retries: 1, retryDelay: 500 }).then(() => true, () => false));
      if (ready) {
        try { await this.runPiper(text, path.join(piperDir, fileNameOf(piperVoice.files[0])), piperVoice.rate); return; } catch (e) { errors.push(e); }
      }
    }
    if (this.espeakBin) {
      try { await this.runEspeak(text); return; } catch (e) { errors.push(e); }
    }
    const last = errors.at(-1);
    throw Object.assign(new Error(last?.message || 'No local TTS engine available (install piper, kokoro-tts, or espeak-ng).'), { reason: 'offline' });
  }

  emitPcm(bytes, srcRate) {
    if (this.state === 'done' || !bytes?.length) return;
    let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (this.odd != null) { const c = new Uint8Array(b.length + 1); c[0] = this.odd; c.set(b, 1); b = c; this.odd = null; }
    if (b.length % 2) { this.odd = b[b.length - 1]; b = b.subarray(0, b.length - 1); }
    if (!b.length) return;
    const pcm = resamplePcm16(b, srcRate, this.rate);
    if (pcm.length) {
      this.heard = true;
      this.onAudio?.(pcm, this.rate);
    }
  }

  runPiper(text, modelPath, srcRate = 22050) {
    return new Promise((resolve, reject) => {
      this.odd = null;
      const p = spawn(this.piperBin, ['--model', modelPath, '--output-raw'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      p.stdin.on('error', () => {});
      this.child = p;
      let stderr = '', gotAudio = false;
      const timer = setTimeout(() => { p.kill(); reject(new Error('Piper TTS timed out')); }, this.sentenceTimeout);
      p.stdout.on('data', (chunk) => { gotAudio = true; this.emitPcm(chunk, srcRate); });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', (e) => { clearTimeout(timer); this.child = null; reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (this.child === p) this.child = null;
        if (this.state === 'done') return resolve();
        if (code === 0 && gotAudio) return resolve();
        reject(new Error(stderr.trim() || `Piper exited with code ${code}`));
      });
      p.stdin.end(`${text}\n`);
    });
  }

  runKokoro(text) {
    return new Promise((resolve, reject) => {
      this.odd = null;
      const modelPath = path.join(this.modelDir, 'model.onnx');
      const voicePath = path.join(this.modelDir, 'af_heart.bin');
      const args = ['--model', modelPath, '--voices', voicePath, '--voice', this.voiceSpec.id, '--output-raw', '-'];
      const p = spawn(this.kokoroBin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      p.stdin.on('error', () => {});
      this.child = p;
      let stderr = '', gotAudio = false;
      const timer = setTimeout(() => { p.kill(); reject(new Error('Kokoro TTS timed out')); }, this.sentenceTimeout);
      p.stdout.on('data', (chunk) => { gotAudio = true; this.emitPcm(chunk, this.voiceSpec.rate || LOCAL_RATE); });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', (e) => { clearTimeout(timer); this.child = null; reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (this.child === p) this.child = null;
        if (this.state === 'done') return resolve();
        if (code === 0 && gotAudio) return resolve();
        reject(new Error(stderr.trim() || `Kokoro exited with code ${code}`));
      });
      p.stdin.end(`${text}\n`);
    });
  }

  runEspeak(text) {
    return new Promise((resolve, reject) => {
      const voiceFlag = this.voiceSpec.espeakVoice || 'en-us';
      const p = spawn(this.espeakBin, ['-v', voiceFlag, '--stdout', text], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.child = p;
      const chunks = [];
      let stderr = '';
      const timer = setTimeout(() => { p.kill(); reject(new Error('espeak-ng timed out')); }, this.sentenceTimeout);
      p.stdout.on('data', (c) => chunks.push(c));
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', (e) => { clearTimeout(timer); this.child = null; reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (this.child === p) this.child = null;
        if (this.state === 'done') return resolve();
        if (code !== 0) return reject(new Error(stderr.trim() || `espeak-ng exited with code ${code}`));
        const { rate, pcm } = parseWavPcm(Buffer.concat(chunks));
        if (!pcm.length) return reject(new Error('espeak-ng produced no audio'));
        this.odd = null;
        this.emitPcm(pcm, rate);
        resolve();
      });
    });
  }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.queue.length = 0;
    this.stopper.abort();
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
  }

  finish() {
    if (this.state === 'done') return;
    this.close();
    this.onEnd?.();
  }

  fail(err) {
    if (this.state === 'done') return;
    const heard = this.heard;
    this.close();
    err.heard = heard;
    this.onError?.(err);
  }
}
