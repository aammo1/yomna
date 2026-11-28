# Requirements: Harness Full Actions

## Summary

Yomna sends tasks to a local CLI "harness" (`agy` by default, or `opencode`, `pi`, `claude`, or custom ACP) through `showcase/tauri/sidecar/harnesses/*.mjs`, and attaches its own `yomna-desktop` MCP server (screen, windows, act_in_app, draw, commitments…). The user's settings (`~/Yomna/Data/settings.json`) already have `allowActions: true`, `skipAllow: true`, `harness: "agy"`. Even so, Yomna only talks.

Diagnosis (from `~/Yomna/Data/logs/2026-11-28.log` and the code):

- `agy` exits with code 1 on every turn: `Error: --settings: unknown setting "mcpServers"`. `harnesses/agy.mjs` writes `{ mcpServers }` to a temp file and passes `--settings <file>`, but `agy`'s `--settings` only takes `settings.json` keys (`model`, `permissions`, `allowNonWorkspaceAccess`, `trustedWorkspaces`, …). `agy` reads MCP servers from the global `~/.gemini/config/mcp_config.json`, which is managed with `agy mcp add|remove|list`.
- With actions on, `agy.mjs` passes `--mode accept-edits` and `claude.mjs` passes `--permission-mode acceptEdits`. Both approve only file edits. In headless print mode, nothing can answer a shell or tool permission prompt, so those calls are denied. The `skipAllow` setting never reaches any harness adapter.
- On Linux, the `open` tool (`tools.mjs`) uses `launch()`, which waits for the launcher (`xdg-open` / `gio`) to exit. When the launcher stays attached to the app it started (for example, a browser that wasn't already running), the call hits the 30 s timeout and reports an error even though the app opened.

## Goals

- `agy` turns run without crashing, and the `yomna-desktop` MCP tools are available to `agy`.
- When `allowActions` and `skipAllow` are both on, `agy` and `claude` run in full-auto mode and actually execute shell commands, edits and tool calls.
- When only `allowActions` is on, behaviour stays as it is today (edits only).
- When `allowActions` is off, harnesses stay read-only (plan/sandbox), as they do today.
- On Linux, the `open` tool reports success when the app, file or URL opens, even if the launcher process keeps running.

## Non-Goals

- No new `run_command`, `write_file` or `open` tools on the `yomna-desktop` MCP server. Routing native harness tools through `safety.mjs` is out of scope.
- No changes to `opencode.mjs` or `pi.mjs` flag mapping (`opencode --auto` and the `pi` full toolset already work).
- No changes to Gemini Live (`live.mjs`, `livebrain.mjs`) beyond passing the extra option on delegation.
- No UI or panel changes. The existing toggles stay as they are.
- No changes to `brain.mjs` memory `oneShot` (it deliberately stays `allowActions: false`).

## Acceptance Criteria

- [ ] With `harness: agy`, a classic turn no longer logs `unknown setting "mcpServers"`, and `agy` can list or call `yomna-desktop` tools.
- [ ] With `allowActions: true, skipAllow: true`, `agy` gets `--mode auto --dangerously-skip-permissions`, and `claude` gets `--permission-mode bypassPermissions`.
- [ ] With `allowActions: true, skipAllow: false`, the flags stay `accept-edits` / `acceptEdits`.
- [ ] With `allowActions: false`, the flags stay `plan` (+ `--sandbox` for agy), whatever `skipAllow` says.
- [ ] Background agents (`agentrun.mjs`) get the same mapping, including live toggles.
- [ ] Opening a URL on Linux while the browser isn't running returns `Opened …` within a few seconds, not a 30 s timeout.
- [ ] `cd showcase/tauri/sidecar && npm test` passes, and CI (`.github/workflows/ci.yml`) stays green.

## Assumptions

- `agy` 1.5.18+ (`agy mcp add [flags] <name> <command> [args...]` updates an existing entry with the same name; flags must come before `<name>`).
- `agy` passes its own environment to stdio MCP child processes, so `YOMNA_MCP_SOCKET` set on the `agy` process reaches the relay. This must be verified (see task-01 and action-required). If it doesn't hold, use the documented fallback (`agy mcp add -e YOMNA_MCP_SOCKET=<sock>`).
- `agy --dangerously-skip-permissions` auto-approves all tool permission requests, and `--mode auto` is a valid mode (`agy --help` lists `accept-edits, auto, plan`).
- Claude Code accepts `--permission-mode bypassPermissions` and `--allowedTools`.

## Technical Constraints

- Sidecar harness modules must use only Node built-ins (`node:*`) or relative imports. This is enforced by `test/harnesses.test.mjs`.
- The user chose **full auto**: `--dangerously-skip-permissions` / `bypassPermissions` only when **both** `allowActions` and `skipAllow` are true. In that mode, harness-native tools bypass `safety.mjs`, which the user accepted. `yomna-desktop` MCP tools still go through their own safety layer.
- AGENTS.md: every safety rule change needs a test case, and never commit with `--no-verify`. Commit subject format: `<emoji> [type] scope: subject`.
- The relay script resolves through `resolveRelayScript()` in `mcp-desktop.mjs`. In bundled builds it's `dist/mcp-desktop.mjs` next to `dist/sidekick.mjs`.
