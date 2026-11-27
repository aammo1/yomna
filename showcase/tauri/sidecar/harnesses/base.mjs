// Shared base class, cross-platform binary resolution, MCP config helpers, and
// 120s inactivity watchdog for Yomna's pluggable CLI harness adapters.
// Uses pure Node.js 22+ built-ins only.
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HANG_TIMEOUT_MS = 120_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const KILL_GRACE_MS = 3_000;
export const STDERR_TAIL_CHARS = 4_000;
export const AUTH_ERROR_RE =
  /not logged in|not signed in|unauthori[sz]ed|sign in|login required|authentication required|invalid api key|missing api key|\b401\b/i;

export function hangTimeoutMs(override) {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const envVal = Number(process.env.YOMNA_HANG_TIMEOUT_MS);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  return DEFAULT_HANG_TIMEOUT_MS;
}

function formatDuration(ms) {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const mins = ms / 60_000;
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  if (ms >= 1_000 && ms % 1_000 === 0) {
    const secs = ms / 1_000;
    return `${secs} second${secs === 1 ? '' : 's'}`;
  }
  return `${ms}ms`;
}

export function isWindowsBatch(binPath) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binPath ?? ''));
}

function isExecutableFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Omarchy Linux installs mise shims for tools that are not yet downloaded; invoking one
// triggers `mise install` over the network. Resolve via `mise which` instead of running the shim.
function resolveMiseShim(candidate, binary, env) {
  try {
    const real = fs.realpathSync(candidate);
    const base = path.basename(real).toLowerCase();
    if (base !== 'mise' && base !== 'mise.exe') return candidate;
    const norm = candidate.replaceAll('\\', '/');
    if (!norm.includes('/mise/shims/') && !norm.includes('/mise/command-wrappers/')) return candidate;
    const out = execFileSync('mise', ['which', binary], {
      env,
      timeout: 2_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out && isExecutableFile(out) ? out : null;
  } catch {
    return null;
  }
}

/** Resolve an executable on `$PATH` (cross-platform), skipping uninstalled mise shims. */
export function resolveBinary(binary, env = process.env) {
  if (!binary || typeof binary !== 'string') return null;
  if (binary.includes('/') || binary.includes('\\')) {
    const abs = path.resolve(binary);
    return isExecutableFile(abs) ? abs : null;
  }
  const pathVar = String(env.PATH ?? env.Path ?? '');
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (path.extname(binary)
          ? ['']
          : String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
              .split(';')
              .filter(Boolean))
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${binary}${ext}`);
      if (!isExecutableFile(candidate)) continue;
      const resolved = resolveMiseShim(candidate, binary, env);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Run a short CLI command for version/auth probing without hanging on stdin. */
export function execProbe(bin, args, { env = process.env, timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env, timeout, windowsHide: true, shell: isWindowsBatch(bin), maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

export function extractVersion(text) {
  const s = String(text ?? '').trim();
  if (!s) return undefined;
  return s.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? s.split(/\r?\n/)[0].trim();
}

/** Normalize MCP server definitions from `mcpConfigPath` or an inline `mcpServer` descriptor. */
export function loadMcpServers({ mcpConfigPath, mcpServer } = {}) {
  const servers = {};
  if (mcpConfigPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
      const map = raw?.mcpServers ?? raw?.mcp ?? raw;
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        for (const [name, cfg] of Object.entries(map)) {
          if (cfg && typeof cfg === 'object' && (cfg.command || cfg.url)) {
            servers[name] = cfg;
          }
        }
      }
    } catch {
      // Caller-provided path may be unreadable or empty; ignore cleanly.
    }
  }
  if (mcpServer && typeof mcpServer === 'object' && (mcpServer.command || mcpServer.url)) {
    const name = mcpServer.name || 'yomna-desktop';
    const { name: _omit, ...cfg } = mcpServer;
    servers[name] = cfg;
  }
  return servers;
}

/** Write a restrictive temporary JSON file and return `{ path, cleanup }`. */
export function writeTempJson(prefix, data, filename = 'config.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return {
    path: filePath,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Incremental NDJSON line parser that ignores blank or malformed lines. */
export function ndjsonParser(onObject) {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk);
      for (let idx; (idx = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          onObject(JSON.parse(line));
        } catch {
          // Ignore non-JSON preamble/diagnostic lines on stdout.
        }
      }
    },
    flush() {
      const line = buf.trim();
      buf = '';
      if (!line) return;
      try {
        onObject(JSON.parse(line));
      } catch {}
    },
  };
}

/** Async push/pull queue bridging process callbacks to an AsyncGenerator. */
export function createAsyncQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(item) {
      if (closed) return;
      items.push(item);
      if (wake) {
        const r = wake;
        wake = null;
        r();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (wake) {
        const r = wake;
        wake = null;
        r();
      }
    },
    async *drain() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export function killChild(child, graceMs = KILL_GRACE_MS) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, graceMs);
  timer.unref?.();
}

/**
 * Shared streaming CLI runner with inactivity hang watchdog, AbortSignal support,
 * bounded stderr capture, auth-error detection, and normalized event queueing.
 */
export async function* runCliTurn({
  bin,
  args,
  cwd,
  env = process.env,
  stdinData,
  hangMs = hangTimeoutMs(),
  label,
  signal,
  parseLine,
  onStart,
  onClose,
  trackChild,
}) {
  if (signal?.aborted) {
    yield { type: 'error', reason: 'aborted', message: `${label} was aborted.` };
    return;
  }

  const queue = createAsyncQueue();
  let child;
  try {
    child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWindowsBatch(bin),
    });
  } catch (err) {
    const reason = err?.code === 'ENOENT' ? 'not_installed' : 'crashed';
    yield { type: 'error', reason, message: err?.message ?? `Failed to start ${label}.`, suggestSwitch: true };
    return;
  }

  // Prevent unhandled EPIPE 'error' events if the child exits before consuming stdin.
  child.stdin?.on('error', () => {});

  const untrack = trackChild?.(child);
  let stderrTail = '';
  let lastEventAt = Date.now();
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let watchdogTimer = null;

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const armWatchdog = () => {
    clearWatchdog();
    if (!Number.isFinite(hangMs) || hangMs <= 0) return;
    watchdogTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      killChild(child);
      queue.push({
        type: 'error',
        reason: 'timeout',
        message: `${label} stopped responding after ${formatDuration(hangMs)}.`,
        suggestSwitch: true,
      });
      queue.close();
    }, hangMs);
    watchdogTimer.unref?.();
  };

  const touchActivity = () => {
    lastEventAt = Date.now();
    if (!settled) armWatchdog();
  };

  const onAbort = () => {
    if (settled) return;
    settled = true;
    aborted = true;
    clearWatchdog();
    killChild(child);
    queue.push({ type: 'error', reason: 'aborted', message: `${label} was aborted.` });
    queue.close();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  armWatchdog();

  const parser = ndjsonParser((obj) => {
    touchActivity();
    const events = parseLine(obj);
    if (Array.isArray(events)) {
      for (const ev of events) queue.push(ev);
    } else if (events) {
      queue.push(events);
    }
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    touchActivity();
    parser.push(chunk);
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
  });

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const reason = err?.code === 'ENOENT' ? 'not_installed' : 'crashed';
    queue.push({
      type: 'error',
      reason,
      message: err?.message ?? `${label} failed to run.`,
      suggestSwitch: true,
    });
    queue.close();
  });

  child.on('close', (code) => {
    clearWatchdog();
    signal?.removeEventListener('abort', onAbort);
    untrack?.();
    if (settled || timedOut || aborted) return;
    settled = true;
    parser.flush();
    const tail = stderrTail.trim();
    const extra = onClose?.({ code, stderr: tail, lastEventAt }) ?? [];
    for (const ev of extra) queue.push(ev);
    if (code !== 0 && !extra.some((ev) => ev.type === 'error')) {
      const isAuth = AUTH_ERROR_RE.test(tail);
      queue.push({
        type: 'error',
        reason: isAuth ? 'auth' : 'crashed',
        message: isAuth
          ? `${label} is not authenticated. Please sign in and retry.`
          : `${label} exited with code ${code}${tail ? `: ${tail.slice(-300)}` : '.'}`,
        suggestSwitch: true,
      });
    }
    queue.close();
  });

  try {
    if (onStart) {
      await onStart(child, { queue, touchActivity });
    } else if (stdinData !== undefined) {
      child.stdin?.write(stdinData);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  } catch (err) {
    if (!settled) {
      settled = true;
      clearWatchdog();
      killChild(child);
      queue.push({
        type: 'error',
        reason: 'crashed',
        message: err?.message ?? `${label} failed during startup.`,
        suggestSwitch: true,
      });
      queue.close();
    }
  }

  try {
    yield* queue.drain();
  } finally {
    clearWatchdog();
    signal?.removeEventListener('abort', onAbort);
    untrack?.();
    if (!settled) killChild(child);
  }
}

/** Shared stream-json NDJSON line mapper used by Antigravity (`agy`) and Claude Code (`claude`). */
export function createStreamJsonMapper() {
  let emittedSession = false;
  let sawStreamText = false;
  let sawStreamThinking = false;
  let emittedDone = false;
  let accumulatedText = '';
  const toolNames = new Map();

  const maybeSession = (obj, out) => {
    const sid = obj?.session_id ?? obj?.sessionId ?? obj?.conversation_id;
    if (typeof sid === 'string' && sid && !emittedSession) {
      emittedSession = true;
      out.push({ type: 'session', sessionId: sid });
    }
  };

  return {
    get accumulatedText() {
      return accumulatedText;
    },
    get emittedDone() {
      return emittedDone;
    },
    parseLine(obj) {
      if (!obj || typeof obj !== 'object') return [];
      const out = [];
      maybeSession(obj, out);

      if (obj.type === 'stream_event' && obj.event) {
        const ev = obj.event;
        if (ev.type === 'content_block_delta') {
          const d = ev.delta ?? {};
          if (d.type === 'text_delta' && d.text) {
            sawStreamText = true;
            const text = String(d.text);
            accumulatedText += text;
            out.push({ type: 'text_delta', text });
          } else if (d.type === 'thinking_delta' && (d.thinking || d.text)) {
            sawStreamThinking = true;
            out.push({ type: 'thinking_delta', text: String(d.thinking ?? d.text) });
          }
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          const b = ev.content_block;
          const id = String(b.id ?? '');
          const name = String(b.name ?? 'tool');
          toolNames.set(id, name);
          out.push({ type: 'tool_start', id, name, args: b.input ?? {} });
        }
        return out;
      }

      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && b.text && !sawStreamText) {
            const text = String(b.text);
            accumulatedText += text;
            out.push({ type: 'text_delta', text });
          } else if (b.type === 'thinking' && (b.thinking || b.text) && !sawStreamThinking) {
            out.push({ type: 'thinking_delta', text: String(b.thinking ?? b.text) });
          } else if (b.type === 'tool_use') {
            const id = String(b.id ?? '');
            const name = String(b.name ?? 'tool');
            if (!toolNames.has(id)) {
              toolNames.set(id, name);
              out.push({ type: 'tool_start', id, name, args: b.input ?? {} });
            }
          }
        }
        return out;
      }

      if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message.content) {
          if (b?.type !== 'tool_result') continue;
          const id = String(b.tool_use_id ?? '');
          const name = toolNames.get(id) ?? 'tool';
          const output =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((p) => (p?.type === 'text' ? String(p.text ?? '') : `[${p?.type ?? 'data'}]`)).join('\n')
                : undefined;
          out.push({ type: 'tool_end', id, name, ok: !b.is_error, ...(output !== undefined ? { output } : {}) });
        }
        return out;
      }

      if (obj.type === 'text_delta' && obj.text) {
        const text = String(obj.text);
        accumulatedText += text;
        out.push({ type: 'text_delta', text });
        return out;
      }

      if (obj.type === 'thinking_delta' && (obj.text || obj.thinking)) {
        out.push({ type: 'thinking_delta', text: String(obj.text ?? obj.thinking) });
        return out;
      }

      if (obj.type === 'tool_start') {
        const id = String(obj.id ?? '');
        const name = String(obj.name ?? 'tool');
        toolNames.set(id, name);
        out.push({ type: 'tool_start', id, name, args: obj.args ?? {} });
        return out;
      }

      if (obj.type === 'tool_end') {
        const id = String(obj.id ?? '');
        const name = String(obj.name ?? toolNames.get(id) ?? 'tool');
        out.push({
          type: 'tool_end',
          id,
          name,
          ok: obj.ok !== false,
          ...(obj.output !== undefined ? { output: String(obj.output) } : {}),
        });
        return out;
      }

      if (obj.type === 'result') {
        if (obj.is_error || obj.subtype === 'error') {
          const msg = String(obj.result ?? obj.error ?? 'Harness returned an error.');
          out.push({
            type: 'error',
            reason: AUTH_ERROR_RE.test(msg) ? 'auth' : 'crashed',
            message: msg,
            suggestSwitch: true,
          });
        } else {
          emittedDone = true;
          const finalText = typeof obj.result === 'string' && obj.result ? obj.result : accumulatedText;
          out.push({ type: 'done', text: finalText });
        }
        return out;
      }

      if (obj.type === 'error') {
        const msg = String(obj.message ?? obj.error?.message ?? obj.error ?? 'Unknown harness error.');
        out.push({
          type: 'error',
          reason: AUTH_ERROR_RE.test(msg) ? 'auth' : 'crashed',
          message: msg,
          suggestSwitch: true,
        });
      }

      return out;
    },
  };
}

export function formatPromptWithSystem(prompt, systemPrompt) {
  const userText = String(prompt ?? '');
  if (!systemPrompt) return userText;
  return `<system_instructions>\n${String(systemPrompt).trim()}\n</system_instructions>\n\n${userText}`;
}

/** Base class every CLI harness driver implements. */
export class HarnessAdapter {
  #activeAbort = null;
  #children = new Set();
  #cleanups = new Set();

  constructor(options = {}, defaults = {}) {
    this.id = options.id ?? defaults.id ?? 'base';
    this.label = options.label ?? defaults.label ?? 'Base Harness';
    this.binary = options.binary ?? defaults.binary ?? '';
    this.installUrl = options.installUrl ?? defaults.installUrl ?? '';
    this.installCmd = options.installCmd ?? defaults.installCmd ?? '';
    this.model = options.model;
    this.env = options.env;
    this.hangTimeoutMs = options.hangTimeoutMs;
  }

  _trackChild(child) {
    this.#children.add(child);
    return () => this.#children.delete(child);
  }

  _registerCleanup(fn) {
    this.#cleanups.add(fn);
    return () => {
      this.#cleanups.delete(fn);
      fn();
    };
  }

  _beginTurn(externalSignal) {
    const controller = new AbortController();
    this.#activeAbort = controller;
    const onExternal = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternal, { once: true });
    }
    return {
      signal: controller.signal,
      finish: () => {
        externalSignal?.removeEventListener('abort', onExternal);
        if (this.#activeAbort === controller) this.#activeAbort = null;
      },
    };
  }

  async probe({ env = this.env ?? process.env } = {}) {
    const binPath = resolveBinary(this.binary, env);
    if (!binPath) {
      return {
        installed: false,
        authenticated: false,
        reason: `${this.label} (${this.binary}) is not installed. ${this.installCmd}`.trim(),
      };
    }
    const ver = await execProbe(binPath, ['--version'], { env });
    if (ver.error?.code === 'ENOENT') {
      return {
        installed: false,
        authenticated: false,
        reason: `${this.label} (${this.binary}) is not installed. ${this.installCmd}`.trim(),
      };
    }
    const version = extractVersion(ver.stdout || ver.stderr);
    return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
  }

  // eslint-disable-next-line no-unused-vars
  async *send(_options) {
    throw new Error(`${this.constructor.name}.send() is not implemented`);
  }

  async oneShot({ prompt, systemPrompt, cwd, secondBrainDirs, mcpConfigPath, mcpServer, signal, allowActions = false }) {
    let text = '';
    let doneText = null;
    for await (const ev of this.send({
      prompt,
      systemPrompt,
      cwd,
      secondBrainDirs,
      mcpConfigPath,
      mcpServer,
      allowActions,
      signal,
    })) {
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'done') doneText = ev.text;
      else if (ev.type === 'error') throw new Error(ev.message);
    }
    return doneText ?? text;
  }

  abort() {
    this.#activeAbort?.abort();
    for (const child of this.#children) killChild(child);
  }

  dispose() {
    this.abort();
    for (const fn of [...this.#cleanups]) {
      try {
        fn();
      } catch {}
    }
    this.#cleanups.clear();
  }
}
