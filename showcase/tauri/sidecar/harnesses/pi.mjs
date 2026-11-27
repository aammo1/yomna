// Pi (`pi`) coding-agent CLI harness driver.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_ERROR_RE,
  HarnessAdapter,
  execProbe,
  extractVersion,
  hangTimeoutMs,
  loadMcpServers,
  resolveBinary,
  runCliTurn,
  writeTempJson,
} from './base.mjs';

const PI_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
];

export function buildPiArgs({
  prompt,
  images = [],
  systemPrompt,
  allowActions = false,
  sessionId,
  model,
  extensionPath,
} = {}) {
  const args = [
    '--mode',
    'json',
    '-p',
    '--tools',
    allowActions ? 'read,bash,edit,write,grep,find,ls' : 'read,grep,find,ls',
  ];
  if (sessionId) args.push('--session', sessionId);
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (extensionPath) args.push('--extension', extensionPath);
  for (const img of images) {
    const filePath = typeof img === 'string' ? img : img?.path;
    if (filePath) args.push(`@${filePath}`);
  }
  if (prompt) args.push(String(prompt));
  return args;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

export function createPiMapper() {
  let emittedSession = false;
  let emittedDone = false;
  let accumulatedText = '';

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

      const sid = obj.sessionId ?? obj.session_id ?? (obj.type === 'session' ? obj.id : undefined);
      if (typeof sid === 'string' && sid && !emittedSession) {
        emittedSession = true;
        out.push({ type: 'session', sessionId: sid });
      }

      if (obj.type === 'message_update' && obj.assistantMessageEvent) {
        const ev = obj.assistantMessageEvent;
        if (ev.type === 'text_delta' && ev.delta) {
          const text = String(ev.delta);
          accumulatedText += text;
          out.push({ type: 'text_delta', text });
        } else if (ev.type === 'thinking_delta' && ev.delta) {
          out.push({ type: 'thinking_delta', text: String(ev.delta) });
        }
        return out;
      }

      if (obj.type === 'text_delta' && (obj.text || obj.delta)) {
        const text = String(obj.text ?? obj.delta);
        accumulatedText += text;
        out.push({ type: 'text_delta', text });
        return out;
      }

      if (obj.type === 'thinking_delta' && (obj.text || obj.delta)) {
        out.push({ type: 'thinking_delta', text: String(obj.text ?? obj.delta) });
        return out;
      }

      if (obj.type === 'tool_execution_start') {
        out.push({
          type: 'tool_start',
          id: String(obj.toolCallId ?? obj.id ?? ''),
          name: String(obj.toolName ?? obj.name ?? 'tool'),
          args: obj.args ?? {},
        });
        return out;
      }

      if (obj.type === 'tool_execution_end') {
        const output =
          typeof obj.result === 'string'
            ? obj.result
            : obj.result !== undefined
              ? extractTextContent(obj.result?.content) || JSON.stringify(obj.result)
              : undefined;
        out.push({
          type: 'tool_end',
          id: String(obj.toolCallId ?? obj.id ?? ''),
          name: String(obj.toolName ?? obj.name ?? 'tool'),
          ok: !obj.isError,
          ...(output !== undefined ? { output } : {}),
        });
        return out;
      }

      if (obj.type === 'agent_end') {
        emittedDone = true;
        let finalText = accumulatedText;
        if (!finalText && Array.isArray(obj.messages)) {
          const lastAssistant = [...obj.messages].reverse().find((m) => m?.role === 'assistant');
          if (lastAssistant) finalText = extractTextContent(lastAssistant.content);
        }
        out.push({ type: 'done', text: finalText });
        return out;
      }

      if (obj.type === 'done') {
        emittedDone = true;
        out.push({ type: 'done', text: String(obj.text ?? '') || accumulatedText });
        return out;
      }

      if (obj.type === 'error') {
        const msg = String(obj.message ?? obj.error ?? 'Pi error');
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

export class PiAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super(options, {
      id: 'pi',
      label: 'Pi',
      binary: 'pi',
      installUrl: 'https://shittycodingagent.ai',
      installCmd: 'npm install -g @mariozechner/pi-coding-agent',
    });
    this.extensionPath = options.extensionPath;
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

    if (PI_KEY_VARS.some((k) => Boolean(env[k]))) {
      return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
    }

    const home = env.HOME || env.USERPROFILE || os.homedir();
    const agentDir = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
    let hasAuth = false;
    for (const file of ['auth.json', 'oauth.json']) {
      try {
        const p = path.join(agentDir, file);
        if (fs.existsSync(p)) {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            hasAuth = true;
            break;
          }
        }
      } catch {}
    }

    return {
      installed: true,
      path: binPath,
      ...(version ? { version } : {}),
      authenticated: hasAuth,
      ...(hasAuth
        ? {}
        : { reason: 'Pi has no configured model credentials. Run `pi` to sign in or set an API key.' }),
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

    const servers = loadMcpServers({ mcpConfigPath, mcpServer });
    const tempMcp = Object.keys(servers).length
      ? writeTempJson('yomna-pi-', { mcpServers: servers }, 'mcp.json')
      : null;
    const unregisterCleanup = tempMcp ? this._registerCleanup(tempMcp.cleanup) : null;
    if (tempMcp) {
      env.YOMNA_MCP_CONFIG = tempMcp.path;
      env.MCP_CONFIG_PATH = tempMcp.path;
    } else if (mcpConfigPath) {
      env.YOMNA_MCP_CONFIG = mcpConfigPath;
      env.MCP_CONFIG_PATH = mcpConfigPath;
    }

    const turn = this._beginTurn(signal);
    const mapper = createPiMapper();

    try {
      const args = buildPiArgs({
        prompt,
        images,
        systemPrompt,
        allowActions,
        sessionId,
        model: this.model,
        extensionPath: this.extensionPath,
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
