// Antigravity (`agy`) CLI harness driver — Yomna's default background AI brain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_ERROR_RE,
  HarnessAdapter,
  createStreamJsonMapper,
  execProbe,
  extractVersion,
  formatPromptWithSystem,
  hangTimeoutMs,
  loadMcpServers,
  resolveBinary,
  runCliTurn,
  writeTempJson,
} from './base.mjs';

export function buildAgySettings({ mcpConfigPath, mcpServer } = {}) {
  const mcpServers = loadMcpServers({ mcpConfigPath, mcpServer });
  if (!Object.keys(mcpServers).length) return null;
  return { mcpServers };
}

export function buildAgyArgs({
  prompt = '',
  allowActions = false,
  secondBrainDirs = [],
  settingsPath,
  sessionId,
  model,
} = {}) {
  const args = [
    '--output-format',
    'stream-json',
    ...(allowActions ? ['--mode', 'accept-edits'] : ['--mode', 'plan', '--sandbox']),
  ];
  if (sessionId) args.push('--conversation', sessionId);
  if (model) args.push('--model', model);
  for (const dir of secondBrainDirs) {
    if (dir) args.push('--add-dir', dir);
  }
  if (settingsPath) args.push('--settings', settingsPath);
  args.push('-p', prompt);
  return args;
}

function buildPromptText({ prompt, systemPrompt, images }) {
  let text = formatPromptWithSystem(prompt, systemPrompt);
  if (Array.isArray(images) && images.length) {
    const refs = [];
    for (const img of images) {
      if (typeof img === 'string' && fs.existsSync(img)) refs.push(img);
    }
    if (refs.length) {
      text += `\n\nAttached image file(s):\n${refs.map((p) => `- ${p}`).join('\n')}`;
    }
  }
  return text || ' ';
}

export class AgyAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super(options, {
      id: 'agy',
      label: 'Antigravity (agy)',
      binary: 'agy',
      installUrl: 'https://antigravity.google',
      installCmd: 'mise use -g antigravity-cli  # or install Antigravity CLI',
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

    if (env.ANTIGRAVITY_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
      return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
    }

    const modelsProbe = await execProbe(binPath, ['models'], { env, timeout: 4_000 });
    const combined = `${modelsProbe.stdout}\n${modelsProbe.stderr}`;
    if (modelsProbe.ok) {
      return { installed: true, path: binPath, ...(version ? { version } : {}), authenticated: true };
    }
    if (AUTH_ERROR_RE.test(combined)) {
      return {
        installed: true,
        path: binPath,
        ...(version ? { version } : {}),
        authenticated: false,
        reason: 'Antigravity is not signed in. Run `agy` or `agy acp --login` to sign in.',
      };
    }

    // Fallback when offline/timed out: check local Antigravity state directory.
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const hasState =
      fs.existsSync(path.join(home, '.gemini', 'antigravity-cli', 'installation_id')) ||
      fs.existsSync(path.join(home, '.config', 'antigravity', 'credential-user-scope'));
    return {
      installed: true,
      path: binPath,
      ...(version ? { version } : {}),
      authenticated: hasState,
      ...(hasState ? {} : { reason: 'Antigravity sign-in could not be verified. Run `agy` to sign in.' }),
    };
  }

  async *send({
    prompt,
    images,
    systemPrompt,
    cwd,
    secondBrainDirs = [],
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

    const settings = buildAgySettings({ mcpConfigPath, mcpServer });
    const tempSettings = settings ? writeTempJson('yomna-agy-', settings, 'settings.json') : null;
    const unregisterCleanup = tempSettings ? this._registerCleanup(tempSettings.cleanup) : null;
    const turn = this._beginTurn(signal);
    const mapper = createStreamJsonMapper();

    try {
      const promptText = buildPromptText({ prompt, systemPrompt, images });
      const args = buildAgyArgs({
        prompt: promptText,
        allowActions,
        secondBrainDirs,
        settingsPath: tempSettings?.path,
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
