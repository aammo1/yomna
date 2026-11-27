// Optional keyless Edge TTS WebSocket streaming adapter (zero API key required).
// Supports English and Arabic/Moroccan voices (e.g. ar-MA-MounaNeural, en-US-AvaMultilingualNeural),
// decodes MP3 frames via ffmpeg into 24 kHz 16-bit LE mono PCM chunks, and cleanly fails over to 'local'
// when offline or missing a converter.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const EDGE_RATE = 24000;
export const DEFAULT_EDGE_VOICE = 'en-US-AvaMultilingualNeural';
export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '130.0.2849.68';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const EDGE_WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const WIN_EPOCH = 11644473600;

export const EDGE_VOICES = [
  { id: 'ar-MA-MounaNeural', name: 'Mouna (Moroccan Arabic / Darija)', lang: 'ar-MA', gender: 'Female' },
  { id: 'ar-MA-JamalNeural', name: 'Jamal (Moroccan Arabic / Darija)', lang: 'ar-MA', gender: 'Male' },
  { id: 'en-US-AvaMultilingualNeural', name: 'Ava Multilingual (US English)', lang: 'en-US', gender: 'Female' },
  { id: 'en-US-AvaNeural', name: 'Ava (US English)', lang: 'en-US', gender: 'Female' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (UK English)', lang: 'en-GB', gender: 'Female' },
  { id: 'ar-SA-ZariyahNeural', name: 'Zariyah (Arabic)', lang: 'ar-SA', gender: 'Female' },
];

export const findEdgeVoice = (id) => EDGE_VOICES.find((v) => v.id === id) ?? { id: id || DEFAULT_EDGE_VOICE, name: id || DEFAULT_EDGE_VOICE, lang: String(id || DEFAULT_EDGE_VOICE).split('-').slice(0, 2).join('-') || 'en-US' };

/** Compute Microsoft Edge Read-Aloud Sec-MS-GEC token (SHA-256 of 5-min rounded Windows filetime + token). */
export function secMsGec(nowMs = Date.now()) {
  let ticks = Math.floor(nowMs / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;
  const filetime = BigInt(ticks) * 10_000_000n;
  return createHash('sha256').update(`${filetime}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

export function edgeEndpoint(nowMs = Date.now(), connectionId = randomUUID().replace(/-/g, '')) {
  const params = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    'Sec-MS-GEC': secMsGec(nowMs),
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
    ConnectionId: connectionId,
  });
  return `${EDGE_WSS}?${params.toString()}`;
}

export const plain = (text) => String(text ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

export function ssmlFor(text, voice = DEFAULT_EDGE_VOICE, prosodyRate = '+0%') {
  const lang = String(voice).split('-').slice(0, 2).join('-') || 'en-US';
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlEscape(lang)}'><voice name='${xmlEscape(voice)}'><prosody pitch='+0Hz' rate='${xmlEscape(prosodyRate)}' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`;
}

export function detectConverter(env = process.env) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  for (const bin of [env.YOMNA_FFMPEG_BIN, 'ffmpeg']) {
    if (!bin) continue;
    try {
      const out = execFileSync(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 2000 }).trim();
      if (out) return out.split(/\r?\n/)[0];
    } catch {}
  }
  return null;
}

function parseEdgeBinary(data) {
  const buf = data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
  if (buf.length < 2) return null;
  const hdrLen = buf.readUInt16BE(0);
  if (buf.length < 2 + hdrLen) return null;
  const header = buf.subarray(2, 2 + hdrLen).toString('utf8');
  const body = buf.subarray(2 + hdrLen);
  return { header, body };
}

/**
 * One reply's Edge TTS session: say() as many sentences as needed, then end(); abort() stops silently.
 * Emits 24 kHz 16-bit LE mono PCM via onAudio(Uint8Array, EDGE_RATE).
 */
export class EdgeVoice {
  constructor({
    voice = DEFAULT_EDGE_VOICE,
    rate = EDGE_RATE,
    outputFormat = EDGE_OUTPUT_FORMAT,
    WebSocketImpl = globalThis.WebSocket,
    ffmpegBin = undefined,
    rawPcm = false,
    onAudio,
    onEnd,
    onError,
    openTimeout = 6000,
    audioTimeout = 10_000,
  } = {}) {
    Object.assign(this, { voice, rate, outputFormat, WebSocketImpl, rawPcm, onAudio, onEnd, onError, openTimeout, audioTimeout });
    this.ffmpegBin = ffmpegBin === undefined ? detectConverter() : ffmpegBin;
    this.state = 'new'; // new → opening → open → done
    this.ending = false;
    this.busy = false;
    this.heard = false;
    this.queue = [];
    this.ws = null;
    this.decoder = null;
    this.decoderDone = null;
    this.odd = null;
    this.timer = null;
  }

  open() {
    if (this.state !== 'new') return this;
    if (!this.rawPcm && !this.ffmpegBin) {
      this.fail(Object.assign(new Error('Edge TTS requires ffmpeg for audio conversion'), { reason: 'converter' }));
      return this;
    }
    if (typeof this.WebSocketImpl !== 'function') {
      this.fail(Object.assign(new Error('WebSocket is unavailable for Edge TTS'), { reason: 'offline' }));
      return this;
    }
    this.state = 'opening';
    let ws;
    try {
      ws = new this.WebSocketImpl(edgeEndpoint(), {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
        },
      });
    } catch (e) {
      this.fail(Object.assign(e instanceof Error ? e : new Error(String(e)), { reason: 'offline' }));
      return this;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.arm(this.openTimeout, 'Edge TTS took too long to connect', 'offline');

    ws.onopen = () => {
      if (this.state === 'done') return;
      this.state = 'open';
      this.clear();
      const fmt = this.rawPcm ? 'raw-24khz-16bit-mono-pcm' : this.outputFormat;
      ws.send(
        `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: fmt } } } }),
      );
      this.pump();
    };

    ws.onmessage = async (e) => {
      if (this.state === 'done') return;
      if (typeof e.data === 'string') {
        if (/Path:turn\.end\b/i.test(e.data)) {
          await this.finishSentence();
        }
        return;
      }
      const frame = parseEdgeBinary(e.data);
      if (!frame || !/Path:audio\b/i.test(frame.header) || !frame.body.length) return;
      this.arm(this.audioTimeout, 'Edge TTS stopped sending audio', 'network');
      if (this.rawPcm) {
        this.emitPcm(frame.body);
      } else if (this.decoder?.stdin?.writable) {
        this.decoder.stdin.write(frame.body);
      }
    };

    ws.onerror = () => this.fail(Object.assign(new Error(this.heard ? 'Edge TTS connection dropped' : 'Could not reach Edge TTS'), { reason: 'offline' }));
    ws.onclose = () => {
      if (this.state !== 'done') this.fail(Object.assign(new Error('Edge TTS closed the connection'), { reason: 'offline' }));
    };
    return this;
  }

  rebind({ onAudio, onEnd, onError }) {
    if (this.state === 'done') return false;
    Object.assign(this, { onAudio, onEnd, onError });
    return true;
  }

  say(text) {
    if (this.state === 'done' || this.ending) return;
    const t = plain(text);
    if (!t) return;
    if (this.state === 'new') this.open();
    if (this.state === 'done') return;
    this.queue.push(t);
    this.pump();
  }

  end() {
    if (this.state === 'done' || this.ending) return;
    this.ending = true;
    if (this.state === 'new' || (this.state === 'open' && !this.busy && !this.queue.length)) {
      this.finish();
    }
  }

  abort() {
    this.close();
  }

  startDecoder() {
    this.odd = null;
    if (this.rawPcm) {
      this.decoder = null;
      this.decoderDone = Promise.resolve();
      return;
    }
    const p = spawn(
      this.ffmpegBin,
      ['-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(this.rate), 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    p.stdin.on('error', () => {});
    this.decoder = p;
    let stderr = '';
    p.stdout.on('data', (chunk) => this.emitPcm(chunk));
    p.stderr.on('data', (d) => { stderr += d; });
    this.decoderDone = new Promise((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => {
        if (this.decoder === p) this.decoder = null;
        if (this.state === 'done' || code === 0) resolve();
        else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
  }

  pump() {
    if (this.state !== 'open' || this.busy) return;
    const text = this.queue.shift();
    if (text == null) {
      if (this.ending) this.finish();
      return;
    }
    this.busy = true;
    try {
      this.startDecoder();
      const reqId = randomUUID().replace(/-/g, '');
      const ssml = ssmlFor(text, this.voice);
      this.ws.send(
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${ssml}`,
      );
      this.arm(this.audioTimeout, 'Edge TTS stopped sending audio', 'network');
    } catch (err) {
      this.fail(err);
    }
  }

  async finishSentence() {
    this.clear();
    if (this.decoder?.stdin) {
      try { this.decoder.stdin.end(); } catch {}
    }
    try {
      await this.decoderDone;
    } catch (err) {
      if (this.state !== 'done') this.fail(err);
      return;
    }
    if (this.state === 'done') return;
    this.busy = false;
    this.pump();
  }

  emitPcm(bytes) {
    if (this.state === 'done' || !bytes?.length) return;
    let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (this.odd != null) { const c = new Uint8Array(b.length + 1); c[0] = this.odd; c.set(b, 1); b = c; this.odd = null; }
    if (b.length % 2) { this.odd = b[b.length - 1]; b = b.subarray(0, b.length - 1); }
    if (b.length) {
      this.heard = true;
      this.onAudio?.(b, this.rate);
    }
  }

  arm(ms, why, reason = 'network') {
    this.clear();
    this.timer = setTimeout(() => this.fail(Object.assign(new Error(why), { reason })), ms);
  }
  clear() { clearTimeout(this.timer); this.timer = null; }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.clear();
    this.queue.length = 0;
    if (this.decoder) { try { this.decoder.kill(); } catch {} this.decoder = null; }
    try { this.ws?.close(); } catch {}
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
    const out = err instanceof Error ? err : new Error(String(err));
    out.heard = heard;
    this.onError?.(out);
  }
}
