// Generic Custom ACP (Agent Client Protocol JSON-RPC 2.0 over stdio) / Custom CLI adapter.
import { spawn } from 'node:child_process';
import {
  AUTH_ERROR_RE,
  HarnessAdapter,
  STDERR_TAIL_CHARS,
  createAsyncQueue,
  createStreamJsonMapper,
  execProbe,
  extractVersion,
  formatPromptWithSystem,
  hangTimeoutMs,
  isWindowsBatch,
  killChild,
  loadMcpServers,
  ndjsonParser,
  resolveBinary,
  runCliTurn,
  writeTempJson,
} from './base.mjs';

export function buildAcpMcpList({ mcpConfigPath, mcpServer } = {}) {
  const servers = loadMcpServers({ mcpConfigPath, mcpServer });
  return Object.entries(servers)
    .filter(([, cfg]) => Boolean(cfg.command))
    .map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: Object.entries(cfg.env ?? {}).map(([k, v]) => ({ name: k, value: String(v) })),
    }));
}

function choosePermissionOutcome(options = [], allowActions = false) {
  if (!allowActions) return { outcome: 'cancelled' };
  const preferred =
    options.find((o) => o?.kind === 'allow_always' || o?.kind === 'allow_once') ?? options[0];
  if (!preferred?.optionId) return { outcome: 'cancelled' };
  return { outcome: 'selected', optionId: preferred.optionId };
}

export class AcpAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super(options, {
      id: 'custom',
      label: 'Custom ACP',
      binary: 'agy',
      installUrl: 'https://agentclientprotocol.com',
      installCmd: 'Configure a custom ACP-compatible binary (e.g. `agy acp --stdio` or `hermes-acp`)',
    });
    this.mode = options.mode ?? 'acp'; // 'acp' | 'cli'
    this.args = Array.isArray(options.args) ? options.args : this.mode === 'acp' ? ['acp', '--stdio'] : [];
    this.readOnlyArgs = Array.isArray(options.readOnlyArgs) ? options.readOnlyArgs : [];
    this.editArgs = Array.isArray(options.editArgs) ? options.editArgs : [];
    this.mcpFlag = options.mcpFlag; // optional CLI flag name like '--mcp-config'
  }

  async probe({ env = this.env ?? process.env } = {}) {
    const binPath = resolveBinary(this.binary, env);
    if (!binPath) {
      return {
        installed: false,
        authenticated: false,
        reason: `${this.label} (${this.binary}) is not found on PATH. ${this.installCmd}`,
      };
    }
    const ver = await execProbe(binPath, ['--version'], { env });
    if (ver.error?.code === 'ENOENT') {
      return {
        installed: false,
        authenticated: false,
        reason: `${this.label} (${this.binary}) is not found on PATH.`,
      };
    }
    const version = extractVersion(ver.stdout || ver.stderr);
    return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
  }

  async *send(opts = {}) {
    if (this.mode === 'cli') {
      yield* this.#sendCli(opts);
      return;
    }
    yield* this.#sendAcp(opts);
  }

  async *#sendCli({
    prompt,
    systemPrompt,
    cwd,
    mcpConfigPath,
    mcpServer,
    allowActions = false,
    signal,
    hangTimeoutOverride,
  }) {
    const env = { ...process.env, ...this.env };
    const binPath = resolveBinary(this.binary, env);
    if (!binPath) {
      yield {
        type: 'error',
        reason: 'not_installed',
        message: `${this.label} (${this.binary}) is not installed.`,
        suggestSwitch: true,
      };
      return;
    }

    const servers = loadMcpServers({ mcpConfigPath, mcpServer });
    const tempMcp = Object.keys(servers).length
      ? writeTempJson('yomna-custom-', { mcpServers: servers }, 'mcp.json')
      : null;
    const unregisterCleanup = tempMcp ? this._registerCleanup(tempMcp.cleanup) : null;
    const resolvedMcpPath = tempMcp?.path ?? mcpConfigPath;
    if (resolvedMcpPath) env.YOMNA_MCP_CONFIG = resolvedMcpPath;

    const turn = this._beginTurn(signal);
    const mapper = createStreamJsonMapper();
    const fullPrompt = formatPromptWithSystem(prompt, systemPrompt);
    const args = [
      ...this.args.map((a) => (a === '{prompt}' ? fullPrompt : a)),
      ...(allowActions ? this.editArgs : this.readOnlyArgs),
      ...(this.mcpFlag && resolvedMcpPath ? [this.mcpFlag, resolvedMcpPath] : []),
    ];

    try {
      yield* runCliTurn({
        bin: binPath,
        args,
        cwd,
        env,
        stdinData: this.args.includes('{prompt}') ? undefined : fullPrompt,
        hangMs: hangTimeoutMs(hangTimeoutOverride ?? this.hangTimeoutMs),
        label: this.label,
        signal: turn.signal,
        trackChild: (c) => this._trackChild(c),
        parseLine: (obj) => mapper.parseLine(obj),
        onClose: ({ code }) => {
          if (code === 0 && !mapper.emittedDone) {
            return [{ type: 'done', text: mapper.accumulatedText }];
          }
          return [];
        },
      });
    } finally {
      turn.finish();
      unregisterCleanup?.();
    }
  }

  async *#sendAcp({
    prompt,
    images = [],
    systemPrompt,
    cwd,
    mcpConfigPath,
    mcpServer,
    allowActions = false,
    sessionId,
    signal,
    hangTimeoutOverride,
  }) {
    const env = { ...process.env, ...this.env };
    const binPath = resolveBinary(this.binary, env);
    if (!binPath) {
      yield {
        type: 'error',
        reason: 'not_installed',
        message: `${this.label} (${this.binary}) is not installed.`,
        suggestSwitch: true,
      };
      return;
    }

    const turn = this._beginTurn(signal);
    if (turn.signal.aborted) {
      yield { type: 'error', reason: 'aborted', message: `${this.label} was aborted.` };
      turn.finish();
      return;
    }

    const hangMs = hangTimeoutMs(hangTimeoutOverride ?? this.hangTimeoutMs);
    const queue = createAsyncQueue();
    let child;
    try {
      child = spawn(binPath, this.args, {
        cwd: cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: isWindowsBatch(binPath),
      });
    } catch (err) {
      turn.finish();
      yield {
        type: 'error',
        reason: err?.code === 'ENOENT' ? 'not_installed' : 'crashed',
        message: err?.message ?? `Failed to start ${this.label}.`,
        suggestSwitch: true,
      };
      return;
    }

    // Prevent unhandled EPIPE 'error' events if the child exits before consuming stdin.
    child.stdin?.on('error', () => {});

    const untrack = this._trackChild(child);
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    let stderrTail = '';
    let accumulatedText = '';
    let watchdog = null;
    const toolNames = new Map();

    const clearWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };

    const failAll = (ev) => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      for (const { reject } of pending.values()) reject(new Error(ev.message));
      pending.clear();
      killChild(child);
      queue.push(ev);
      queue.close();
    };

    const armWatchdog = () => {
      clearWatchdog();
      if (!Number.isFinite(hangMs) || hangMs <= 0) return;
      watchdog = setTimeout(() => {
        const mins = hangMs >= 60_000 && hangMs % 60_000 === 0 ? `${hangMs / 60_000} minutes` : `${hangMs}ms`;
        failAll({
          type: 'error',
          reason: 'timeout',
          message: `${this.label} stopped responding after ${mins}.`,
          suggestSwitch: true,
        });
      }, hangMs);
      watchdog.unref?.();
    };

    const onAbort = () => failAll({ type: 'error', reason: 'aborted', message: `${this.label} was aborted.` });
    turn.signal.addEventListener('abort', onAbort, { once: true });
    armWatchdog();

    const sendJson = (msg) => {
      if (!child.stdin?.destroyed) child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };

    const request = (method, params) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sendJson({ jsonrpc: '2.0', id, method, params });
      });
    };

    const handleNotification = (msg) => {
      if (msg.method === 'session/request_permission') {
        const outcome = choosePermissionOutcome(msg.params?.options, allowActions);
        if (msg.id !== undefined) sendJson({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
        return;
      }
      if (msg.method !== 'session/update') return;
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && u.content.text) {
        const text = String(u.content.text);
        accumulatedText += text;
        queue.push({ type: 'text_delta', text });
      } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text' && u.content.text) {
        queue.push({ type: 'thinking_delta', text: String(u.content.text) });
      } else if (u.sessionUpdate === 'tool_call') {
        const id = String(u.toolCallId ?? '');
        const name = String(u.title ?? u.kind ?? 'tool');
        toolNames.set(id, name);
        queue.push({ type: 'tool_start', id, name, args: u.rawInput ?? {} });
      } else if (u.sessionUpdate === 'tool_call_update') {
        const id = String(u.toolCallId ?? '');
        const name = toolNames.get(id) ?? String(u.title ?? 'tool');
        if (u.status === 'completed' || u.status === 'failed') {
          const output = Array.isArray(u.content)
            ? u.content.map((c) => c?.content?.text ?? c?.text ?? '').filter(Boolean).join('\n')
            : undefined;
          queue.push({
            type: 'tool_end',
            id,
            name,
            ok: u.status !== 'failed',
            ...(output ? { output } : {}),
          });
        }
      }
    };

    const parser = ndjsonParser((msg) => {
      if (!msg || typeof msg !== 'object') return;
      armWatchdog();
      if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      handleNotification(msg);
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      armWatchdog();
      parser.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (err) => {
      failAll({
        type: 'error',
        reason: err?.code === 'ENOENT' ? 'not_installed' : 'crashed',
        message: err?.message ?? `${this.label} failed.`,
        suggestSwitch: true,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      const tail = stderrTail.trim();
      const isAuth = AUTH_ERROR_RE.test(tail);
      failAll({
        type: 'error',
        reason: isAuth ? 'auth' : 'crashed',
        message: isAuth
          ? `${this.label} is not authenticated.`
          : `${this.label} closed unexpectedly (code ${code})${tail ? `: ${tail.slice(-300)}` : '.'}`,
        suggestSwitch: true,
      });
    });

    const runProtocol = async () => {
      await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'yomna', version: '1.0.0' },
      });
      const mcpServers = buildAcpMcpList({ mcpConfigPath, mcpServer });
      const workDir = cwd || process.cwd();
      let activeSessionId = sessionId;
      if (activeSessionId) {
        try {
          await request('session/load', { sessionId: activeSessionId, cwd: workDir, mcpServers });
        } catch {
          activeSessionId = null;
        }
      }
      if (!activeSessionId) {
        const created = await request('session/new', { cwd: workDir, mcpServers });
        activeSessionId = created?.sessionId;
      }
      if (activeSessionId) queue.push({ type: 'session', sessionId: activeSessionId });

      const promptBlocks = [{ type: 'text', text: formatPromptWithSystem(prompt, systemPrompt) }];
      for (const img of images) {
        if (img && typeof img === 'object' && img.data) {
          promptBlocks.push({ type: 'image', data: img.data, mimeType: img.mediaType || 'image/png' });
        }
      }
      const res = await request('session/prompt', { sessionId: activeSessionId, prompt: promptBlocks });
      if (!settled) {
        settled = true;
        clearWatchdog();
        const finalText =
          typeof res?.text === 'string' && res.text ? res.text : accumulatedText;
        queue.push({ type: 'done', text: finalText });
        queue.close();
        try {
          child.stdin?.end();
        } catch {}
        killChild(child);
      }
    };

    runProtocol().catch((err) => {
      if (settled) return;
      const msg = err?.message ?? 'ACP request failed.';
      const isAuth = AUTH_ERROR_RE.test(`${msg}\n${stderrTail}`);
      failAll({
        type: 'error',
        reason: isAuth ? 'auth' : 'crashed',
        message: msg,
        suggestSwitch: true,
      });
    });

    try {
      yield* queue.drain();
    } finally {
      clearWatchdog();
      turn.signal.removeEventListener('abort', onAbort);
      turn.finish();
      untrack();
      if (!settled) killChild(child);
    }
  }
}
