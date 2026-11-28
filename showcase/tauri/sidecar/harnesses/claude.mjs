// Optional Claude Code (`claude`) CLI runtime adapter — pure CLI spawn, zero SDK dependencies.
import {
  AUTH_ERROR_RE,
  HarnessAdapter,
  createStreamJsonMapper,
  execProbe,
  extractVersion,
  hangTimeoutMs,
  loadMcpServers,
  resolveBinary,
  runCliTurn,
  writeTempJson,
} from './base.mjs';

export function buildClaudeArgs({
  allowActions = false,
  skipAllow = false,
  secondBrainDirs = [],
  mcpConfigPath,
  sessionId,
  systemPrompt,
  model,
} = {}) {
  // Full-auto applies only when both "Allow File Edits & Commands" and "Skip Allow prompts" are enabled.
  const full = !!allowActions && !!skipAllow;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    !allowActions ? 'plan' : full ? 'bypassPermissions' : 'acceptEdits',
  ];
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath, '--allowedTools', 'mcp__yomna-desktop');
  }
  if (sessionId) args.push('--resume', sessionId);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (model) args.push('--model', model);
  for (const dir of secondBrainDirs) {
    if (dir) args.push('--add-dir', dir);
  }
  return args;
}

export class ClaudeAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super(options, {
      id: 'claude',
      label: 'Claude Code',
      binary: 'claude',
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      installCmd: 'npm i -g @anthropic-ai/claude-code  # or curl -fsSL https://claude.ai/install.sh | bash',
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

    if (env.ANTHROPIC_API_KEY) {
      return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
    }

    const auth = await execProbe(binPath, ['auth', 'status'], { env, timeout: 4_000 });
    const text = `${auth.stdout}\n${auth.stderr}`;
    try {
      const parsed = JSON.parse(auth.stdout);
      if (parsed && typeof parsed.loggedIn === 'boolean') {
        return {
          installed: true,
          path: binPath,
          ...(version ? { version } : {}),
          authenticated: parsed.loggedIn,
          ...(parsed.loggedIn ? {} : { reason: 'Claude Code is not signed in. Run `claude auth login`.' }),
        };
      }
    } catch {
      // Fall through to text/exit-code check for older CLI builds or mocks.
    }

    const signedOut = !auth.ok || AUTH_ERROR_RE.test(text);
    return {
      installed: true,
      path: binPath,
      ...(version ? { version } : {}),
      authenticated: !signedOut,
      ...(signedOut ? { reason: 'Claude Code is not signed in. Run `claude auth login`.' } : {}),
    };
  }

  async *send({
    prompt,
    systemPrompt,
    cwd,
    secondBrainDirs = [],
    mcpConfigPath,
    mcpServer,
    allowActions = false,
    skipAllow = false,
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
      ? writeTempJson('yomna-claude-', { mcpServers: servers }, 'mcp.json')
      : null;
    const unregisterCleanup = tempMcp ? this._registerCleanup(tempMcp.cleanup) : null;
    const turn = this._beginTurn(signal);
    const mapper = createStreamJsonMapper();

    try {
      const args = buildClaudeArgs({
        allowActions,
        skipAllow,
        secondBrainDirs,
        mcpConfigPath: tempMcp?.path ?? mcpConfigPath,
        sessionId,
        systemPrompt,
        model: this.model,
      });

      yield* runCliTurn({
        bin: binPath,
        args,
        cwd,
        env,
        stdinData: String(prompt ?? ''),
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
