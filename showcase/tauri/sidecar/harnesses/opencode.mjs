// OpenCode (`opencode`) headless CLI harness driver.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_ERROR_RE,
  HarnessAdapter,
  execProbe,
  extractVersion,
  formatPromptWithSystem,
  hangTimeoutMs,
  loadMcpServers,
  resolveBinary,
  runCliTurn,
  writeTempJson,
} from './base.mjs';

const OPENCODE_KEY_VARS = [
  'OPENCODE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];

export function buildOpenCodeConfig({ mcpConfigPath, mcpServer, allowActions = false } = {}) {
  const servers = loadMcpServers({ mcpConfigPath, mcpServer });
  const mcp = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.url) {
      mcp[name] = { type: 'remote', url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}), enabled: true };
    } else if (cfg.command) {
      mcp[name] = {
        type: 'local',
        command: [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])],
        ...(cfg.env ? { environment: cfg.env } : {}),
        enabled: true,
      };
    }
  }
  const config = {};
  if (Object.keys(mcp).length) config.mcp = mcp;
  if (!allowActions) {
    config.permission = { edit: 'deny', bash: 'deny', webfetch: 'deny' };
  }
  return config;
}

export function buildOpenCodeArgs({
  prompt,
  systemPrompt,
  images = [],
  allowActions = false,
  sessionId,
  model,
} = {}) {
  const args = ['run', '--format', 'json', '--thinking'];
  args.push(...(allowActions ? ['--auto'] : ['--agent', 'plan']));
  if (sessionId) args.push('--session', sessionId);
  if (model) args.push('--model', model);
  for (const img of images) {
    const filePath = typeof img === 'string' ? img : img?.path;
    if (filePath) args.push('--file', filePath);
  }
  const fullPrompt = formatPromptWithSystem(prompt, systemPrompt);
  if (fullPrompt) args.push('--', fullPrompt);
  return args;
}

export function createOpenCodeMapper() {
  let emittedSession = false;
  let emittedDone = false;
  let accumulatedText = '';
  const startedTools = new Set();

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
      const sid = obj.sessionID ?? obj.session_id ?? obj.sessionId;
      if (typeof sid === 'string' && sid && !emittedSession) {
        emittedSession = true;
        out.push({ type: 'session', sessionId: sid });
      }

      if (obj.type === 'text') {
        const text = String(obj.part?.text ?? obj.text ?? '');
        if (text) {
          accumulatedText += text;
          out.push({ type: 'text_delta', text });
        }
        return out;
      }

      if (obj.type === 'text_delta' && obj.text) {
        const text = String(obj.text);
        accumulatedText += text;
        out.push({ type: 'text_delta', text });
        return out;
      }

      if (obj.type === 'reasoning' || obj.type === 'thinking' || obj.type === 'thinking_delta') {
        const text = String(obj.part?.text ?? obj.text ?? '');
        if (text) out.push({ type: 'thinking_delta', text });
        return out;
      }

      if (obj.type === 'tool_use') {
        const p = obj.part ?? obj;
        const id = String(p.callID ?? p.id ?? '');
        const name = String(p.tool ?? p.name ?? 'tool');
        const status = p.state?.status ?? p.status ?? 'running';
        const args = p.state?.input ?? p.input ?? p.args ?? {};
        if (!startedTools.has(id)) {
          startedTools.add(id);
          out.push({ type: 'tool_start', id, name, args });
        }
        if (status === 'completed' || status === 'error') {
          const ok = status !== 'error';
          const output = ok ? p.state?.output : p.state?.error;
          out.push({
            type: 'tool_end',
            id,
            name,
            ok,
            ...(output !== undefined ? { output: String(output) } : {}),
          });
        }
        return out;
      }

      if (obj.type === 'done' || obj.type === 'result') {
        emittedDone = true;
        const text = String(obj.text ?? obj.result ?? '') || accumulatedText;
        out.push({ type: 'done', text });
        return out;
      }

      if (obj.type === 'error') {
        const msg = String(obj.error?.data?.message ?? obj.error?.message ?? obj.message ?? obj.error ?? 'OpenCode error');
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

export class OpenCodeAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super(options, {
      id: 'opencode',
      label: 'OpenCode',
      binary: 'opencode',
      installUrl: 'https://opencode.ai/docs',
      installCmd: 'npm i -g opencode-ai@latest  # or curl -fsSL https://opencode.ai/install | bash',
    });
  }

  async probe({ env = this.env ?? process.env } = {}) {
    const binPath = resolveBinary(this.binary, env);
    if (!binPath) {
      return {
        installed: false,
        authenticated: false,
        reason: `${this.label} is not installed. ${this.installCmd}`,
      };
    }

    const ver = await execProbe(binPath, ['--version'], { env });
    if (ver.error?.code === 'ENOENT') {
      return {
        installed: false,
        authenticated: false,
        reason: `${this.label} is not installed. ${this.installCmd}`,
      };
    }
    const version = extractVersion(ver.stdout || ver.stderr);

    if (OPENCODE_KEY_VARS.some((k) => Boolean(env[k]))) {
      return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
    }

    const auth = await execProbe(binPath, ['auth', 'list'], { env, timeout: 4_000 });
    const hasCreds =
      auth.ok && /\b(stored|oauth|api key|token)\b/i.test(auth.stdout);
    if (hasCreds) {
      return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
    }

    const home = env.HOME || env.USERPROFILE || os.homedir();
    const authJson = path.join(home, '.local', 'share', 'opencode', 'auth.json');
    let hasFileAuth = false;
    try {
      if (fs.existsSync(authJson)) {
        const parsed = JSON.parse(fs.readFileSync(authJson, 'utf8'));
        hasFileAuth = Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0);
      }
    } catch {}

    return {
      installed: true,
      path: binPath,
      ...(version ? { version } : {}),
      authenticated: hasFileAuth,
      ...(hasFileAuth ? {} : { reason: 'OpenCode has no stored credentials. Run `opencode auth login`.' }),
    };
  }

  async *send({
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
  } = {}) {
    const env = { ...process.env, ...this.env };
    const binPath = resolveBinary(this.binary, env);
    if (!binPath) {
      yield {
        type: 'error',
        reason: 'not_installed',
        message: `${this.label} (${this.binary}) is not installed. ${this.installCmd}`,
        suggestSwitch: true,
      };
      return;
    }

    const configObj = buildOpenCodeConfig({ mcpConfigPath, mcpServer, allowActions });
    const tempCfg = Object.keys(configObj).length
      ? writeTempJson('yomna-opencode-', configObj, 'opencode.json')
      : null;
    const unregisterCleanup = tempCfg ? this._registerCleanup(tempCfg.cleanup) : null;
    if (Object.keys(configObj).length) {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(configObj);
      if (tempCfg) env.YOMNA_MCP_CONFIG = tempCfg.path;
    }

    const turn = this._beginTurn(signal);
    const mapper = createOpenCodeMapper();

    try {
      const args = buildOpenCodeArgs({
        prompt,
        systemPrompt,
        images,
        allowActions,
        sessionId,
        model: this.model,
      });

      yield* runCliTurn({
        bin: binPath,
        args,
        cwd,
        env,
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
}
