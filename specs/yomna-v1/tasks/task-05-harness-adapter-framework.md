# Task 05: Build Pluggable CLI Harness Adapter Framework

## Status

complete

## Wave

2

## Description

Build Yomna's new background AI brain layer in `showcase/tauri/sidecar/harnesses/` — completely replacing direct LLM chat APIs with a pluggable adapter framework for local CLI agent harnesses: **Antigravity (`agy`)** (default), **OpenCode (`opencode`)**, **Pi (`pi`)**, **Claude Code (`claude`)** (as an optional user runtime only, zero creator branding), and **Custom ACP / CLI** harnesses. Includes `$PATH` auto-detection, auth/readiness probing, two-level safety mode flags (`allowActions` OFF = read-only/sandbox; ON = edit/auto), `yomna-desktop` MCP server injection, persistent session/conversation resumption, and a 120-second hang watchdog with automatic kill + `switch_harness` recovery.

## Dependencies

**Depends on:** `task-01-debloat-and-docs-rebrand.md`
**Blocks:** `task-09-sidecar-wireup-and-gg-removal.md`, `task-11-panel-and-onboarding-harness-ui.md`

**Context from dependencies:** `task-01` established the Yomna config shape (`"harness": "agy"`, `"allowActions": false`, `"secondBrain"`) and purged legacy bloat. This task creates brand-new files inside `showcase/tauri/sidecar/harnesses/` that `task-09` will wire into `sidekick.mjs` and `task-11` will surface in Settings/Onboarding.

## Files to Create

- `showcase/tauri/sidecar/harnesses/index.mjs` — `HarnessManager`, `HARNESS_CATALOG`, `detectHarnesses()`, `probeHarness(id)`, active session lifecycle, 120s inactivity watchdog (`hangTimeoutMs`), and normalized streaming event emitter (`text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `done`, `error`, `switch_suggested`).
- `showcase/tauri/sidecar/harnesses/agy.mjs` — Primary **Antigravity (`agy`)** driver using `agy --input-format stream-json --output-format stream-json` (persistent NDJSON stdin/stdout) or `agy -p --output-format stream-json` with `--conversation <id>`, `--mode plan --sandbox` when `allowActions === false` vs `--mode accept-edits` when `allowActions === true`, `--add-dir <secondBrainRoot>`, and `--settings` JSON injecting the `yomna-desktop` MCP server.
- `showcase/tauri/sidecar/harnesses/opencode.mjs` — **OpenCode (`opencode`)** headless driver (`opencode run --format json` / ACP stdio when supported, passing MCP config and read-only vs edit flags).
- `showcase/tauri/sidecar/harnesses/pi.mjs` — **Pi (`pi`)** coding-agent CLI driver (`pi --mode json` / headless prompt mode with MCP bridge and session persistence).
- `showcase/tauri/sidecar/harnesses/claude.mjs` — Optional **Claude Code (`claude`)** CLI runtime driver (`claude -p --output-format stream-json --verbose --mcp-config <tmpJson> --permission-mode <plan|acceptEdits> --resume <sessionId>`). Pure CLI spawn — zero `@anthropic-ai/claude-agent-sdk` dependency and zero contributor/creator text.
- `showcase/tauri/sidecar/harnesses/acp.mjs` — Generic **Custom ACP / CLI** adapter supporting standard Agent Client Protocol (`<bin> acp --stdio` JSON-RPC 2.0 over stdin/stdout, compatible with `agy acp`, `hermes-acp`, etc.) and configurable custom binary + args.

## Files to Modify

- None (all files are new under `showcase/tauri/sidecar/harnesses/`).

## Technical Details

### Implementation Steps

1. Define the normalized adapter interface every driver implements:
   ```js
   export class HarnessAdapter {
     id;          // 'agy' | 'opencode' | 'pi' | 'claude' | 'custom'
     label;       // 'Antigravity (agy)' | 'OpenCode' | 'Pi' | 'Claude Code' | 'Custom ACP'
     binary;      // default executable name on $PATH
     installUrl;  // docs URL shown if missing during onboarding
     installCmd;  // 1-line terminal hint shown if missing
     async probe({ env }): Promise<{ installed: boolean, path?: string, version?: string, authenticated: boolean, reason?: string }>
     async *send({ prompt, images, systemPrompt, cwd, secondBrainDirs, mcpConfigPath, allowActions, sessionId, signal }): AsyncGenerator<HarnessEvent>
     async oneShot({ prompt, systemPrompt, cwd, signal }): Promise<string> // for memory/skill extraction passes
     abort(): void
     dispose(): void
   }
   ```
2. **Normalized `HarnessEvent` union**:
   - `{ type: 'session', sessionId: string }`
   - `{ type: 'text_delta', text: string }`
   - `{ type: 'thinking_delta', text: string }`
   - `{ type: 'tool_start', id: string, name: string, args: object }`
   - `{ type: 'tool_end', id: string, name: string, ok: boolean, output?: string }`
   - `{ type: 'done', text: string }`
   - `{ type: 'error', reason: 'not_installed' | 'auth' | 'timeout' | 'crashed' | 'aborted', message: string, suggestSwitch?: boolean }`
3. **Antigravity (`agy.mjs`) specifics** (verified against `/usr/bin/agy --help`):
   - Binary detection: resolve `agy` on `$PATH` (cross-platform `which` / `where`).
   - Streaming turn: spawn `agy --print --input-format stream-json --output-format stream-json` (or per-turn with `--conversation <id>`), passing:
     - When `allowActions === false`: `--mode plan --sandbox`
     - When `allowActions === true`: `--mode accept-edits`
     - When `secondBrainDirs` provided: `--add-dir <dir>` for each directory
     - Inline `--settings <tempSettingsPath>` registering the `yomna-desktop` stdio MCP server for this session only (`--settings` is never persisted by `agy`!).
   - Parse stdout NDJSON line by line into normalized `HarnessEvent` objects.
4. **Hang Watchdog & Auto-Recovery (`index.mjs`)**:
   - Track `lastEventAt` on every active `send()` call.
   - If no stdout event arrives for `120_000 ms` (`HANG_TIMEOUT_MS`), kill the child process (`SIGTERM`, then `SIGKILL` after `3s`) and yield `{ type: 'error', reason: 'timeout', message: '<Label> stopped responding after 2 minutes.', suggestSwitch: true }`.
   - On non-zero exit matching auth patterns (`/not logged in|unauthorized|sign in|login required|401/i`), yield `{ type: 'error', reason: 'auth', message: '...', suggestSwitch: true }`.
5. **Auto-Detection (`detectHarnesses()` in `index.mjs`)**:
   - Probes `['agy', 'opencode', 'pi', 'claude']` in parallel (5s timeout each).
   - Returns `{ harnesses: [...], recommended: '<first installed+authenticated id, preferring agy>' }`.
6. Ensure **zero external npm dependencies** are needed for `harnesses/*.mjs` (pure Node.js 22+ `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:readline`).

### Environment Variables

- `YOMNA_HARNESS` — Optional override for active harness ID (`agy`, `opencode`, `pi`, `claude`, `custom`).
- `YOMNA_HANG_TIMEOUT_MS` — Optional override for the 120s watchdog timeout (useful for tests).

## Acceptance Criteria

- [ ] `showcase/tauri/sidecar/harnesses/` contains `index.mjs`, `agy.mjs`, `opencode.mjs`, `pi.mjs`, `claude.mjs`, and `acp.mjs`, all using pure Node 22+ built-ins (zero `@kenkaiiii/gg-*` or `@anthropic-ai/claude-agent-sdk` imports).
- [ ] `detectHarnesses()` detects `/usr/bin/agy` on this Omarchy machine and reports `installed: true`, cleanly marking absent binaries (`opencode`, `pi`, `claude`) as `installed: false` with install commands.
- [ ] Each adapter enforces read-only/sandbox flags when `allowActions === false` and edit/auto flags when `allowActions === true`.
- [ ] Every adapter accepts `mcpConfigPath` (or stdio MCP descriptor) to attach `yomna-desktop`.
- [ ] The 120s hang watchdog kills stalled child processes and emits `{ type: 'error', reason: 'timeout', suggestSwitch: true }`.
