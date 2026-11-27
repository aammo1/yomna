// Pluggable CLI Harness Framework for Yomna — catalog, auto-detection, probing,
// active session lifecycle, and 120s inactivity watchdog management.
import { AcpAdapter } from './acp.mjs';
import { AgyAdapter } from './agy.mjs';
import {
  DEFAULT_HANG_TIMEOUT_MS,
  HarnessAdapter,
  PROBE_TIMEOUT_MS,
  hangTimeoutMs,
  resolveBinary,
} from './base.mjs';
import { ClaudeAdapter } from './claude.mjs';
import { OpenCodeAdapter } from './opencode.mjs';
import { PiAdapter } from './pi.mjs';

export {
  AcpAdapter,
  AgyAdapter,
  ClaudeAdapter,
  DEFAULT_HANG_TIMEOUT_MS,
  HarnessAdapter,
  OpenCodeAdapter,
  PROBE_TIMEOUT_MS,
  PiAdapter,
  hangTimeoutMs,
  resolveBinary,
};

export const DETECT_ORDER = ['agy', 'opencode', 'pi', 'claude'];

export const HARNESS_CATALOG = {
  agy: {
    id: 'agy',
    label: 'Antigravity (agy)',
    binary: 'agy',
    isDefault: true,
    installUrl: 'https://antigravity.google',
    installCmd: 'mise use -g antigravity-cli  # or install Antigravity CLI',
    Adapter: AgyAdapter,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    isDefault: false,
    installUrl: 'https://opencode.ai/docs',
    installCmd: 'npm i -g opencode-ai@latest  # or curl -fsSL https://opencode.ai/install | bash',
    Adapter: OpenCodeAdapter,
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    binary: 'pi',
    isDefault: false,
    installUrl: 'https://shittycodingagent.ai',
    installCmd: 'npm install -g @mariozechner/pi-coding-agent',
    Adapter: PiAdapter,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    isDefault: false,
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    installCmd: 'npm i -g @anthropic-ai/claude-code  # or curl -fsSL https://claude.ai/install.sh | bash',
    Adapter: ClaudeAdapter,
  },
  custom: {
    id: 'custom',
    label: 'Custom ACP',
    binary: 'agy',
    isDefault: false,
    installUrl: 'https://agentclientprotocol.com',
    installCmd: 'Configure a custom ACP-compatible binary (e.g. `agy acp --stdio` or `hermes-acp`)',
    Adapter: AcpAdapter,
  },
};

export function createHarness(id = 'agy', options = {}) {
  const entry = HARNESS_CATALOG[id];
  if (!entry) {
    if (options && (options.binary || options.mode)) {
      return new AcpAdapter({ id, ...options });
    }
    throw new Error(`Unknown harness "${id}". Expected one of: ${Object.keys(HARNESS_CATALOG).join(', ')}`);
  }
  return new entry.Adapter(options);
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
      timer.unref?.();
    }),
  ]);
}

export async function probeHarness(id, { env = process.env, timeoutMs = PROBE_TIMEOUT_MS, ...options } = {}) {
  const adapter = createHarness(id, { ...options, env });
  try {
    const res = await withTimeout(
      adapter.probe({ env }),
      timeoutMs,
      () => ({
        installed: false,
        authenticated: false,
        reason: `${adapter.label} probe timed out after ${timeoutMs}ms.`,
      }),
    );
    return {
      id: adapter.id,
      label: adapter.label,
      binary: adapter.binary,
      installUrl: adapter.installUrl,
      installCmd: adapter.installCmd,
      ...res,
    };
  } finally {
    adapter.dispose();
  }
}

export async function detectHarnesses({ env = process.env, ids = DETECT_ORDER, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const harnesses = await Promise.all(ids.map((id) => probeHarness(id, { env, timeoutMs })));
  const ready = harnesses.filter((h) => h.installed && h.authenticated);
  const agyReady = ready.find((h) => h.id === 'agy');
  const recommended = (agyReady ?? ready[0])?.id ?? null;
  return { harnesses, recommended };
}

/** Stateful coordinator for the active CLI harness, sessions, switching, and hang recovery. */
export class HarnessManager {
  #active;
  #sessions = new Map();
  #optionsByHarness;
  #hangTimeoutMs;

  constructor({ harness = 'agy', hangTimeoutMs: hangOverride, options = {} } = {}) {
    this.#hangTimeoutMs = hangOverride;
    this.#optionsByHarness = options;
    this.#active = this.#instantiate(harness);
  }

  #instantiate(id, overrideOpts = {}) {
    const baseOpts = this.#optionsByHarness[id] ?? {};
    return createHarness(id, {
      hangTimeoutMs: this.#hangTimeoutMs,
      ...baseOpts,
      ...overrideOpts,
    });
  }

  get activeId() {
    return this.#active.id;
  }

  get active() {
    return this.#active;
  }

  getSessionId(id = this.#active.id) {
    return this.#sessions.get(id) ?? null;
  }

  setSessionId(sessionId, id = this.#active.id) {
    if (sessionId) this.#sessions.set(id, sessionId);
    else this.#sessions.delete(id);
  }

  clearSession(id = this.#active.id) {
    this.#sessions.delete(id);
  }

  switchHarness(id, options = {}) {
    this.#active?.dispose();
    this.#active = this.#instantiate(id, options);
    return this.#active;
  }

  async probeAll({ env = process.env } = {}) {
    return detectHarnesses({ env });
  }

  async *send(opts = {}) {
    const harness = this.#active;
    const resumeId =
      opts.newSession
        ? undefined
        : opts.sessionId !== undefined
          ? opts.sessionId
          : this.#sessions.get(harness.id);

    for await (const ev of harness.send({
      allowActions: false,
      ...opts,
      sessionId: resumeId,
    })) {
      if (ev.type === 'session' && ev.sessionId) {
        this.#sessions.set(harness.id, ev.sessionId);
      }
      yield ev;
    }
  }

  async oneShot(opts = {}) {
    let text = '';
    let doneText = null;
    for await (const ev of this.send(opts)) {
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'done') doneText = ev.text;
      else if (ev.type === 'error') throw new Error(ev.message);
    }
    return doneText ?? text;
  }

  abort() {
    this.#active?.abort();
  }

  dispose() {
    this.#active?.dispose();
  }
}
