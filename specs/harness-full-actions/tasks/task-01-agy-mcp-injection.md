# Task 01: agy MCP injection via `agy mcp add` + `YOMNA_MCP_SOCKET`

## Status

complete

## Wave

1

## Description

Yomna's default harness, Antigravity CLI (`agy`), crashes on every turn with `Error: --settings: unknown setting "mcpServers"`. This happens because `showcase/tauri/sidecar/harnesses/agy.mjs` writes `{ mcpServers: {...} }` to a temp file and passes it as `--settings <file>`. `agy`'s `--settings` only accepts `settings.json` keys. `agy` reads MCP servers from the global `~/.gemini/config/mcp_config.json`, managed with `agy mcp add|remove|list`. Because of this crash, Yomna can talk (through Gemini Live) but can't hand work to `agy`. Even when it doesn't crash, the `yomna-desktop` MCP tools never reach the model. This task switches `agy` to `agy mcp add` registration and passes the per-session socket through the environment.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-04-harness-full-auto-flags.md

**Context from dependencies:** None.

## Files to Create

None.

## Files to Modify

- `showcase/tauri/sidecar/harnesses/agy.mjs`: remove MCP-through-`--settings`, register servers with `agy mcp add`, and set `YOMNA_MCP_SOCKET` in the child env.
- `showcase/tauri/sidecar/mcp-desktop.mjs`: when the relay starts with no socket (or the socket is gone), answer as an empty MCP server instead of exiting 1.
- `showcase/tauri/sidecar/test/harnesses.test.mjs`: replace the `AgyAdapter injects mcpConfigPath via --settings…` test (around lines 178–242), and remove the `--settings` assertion from the `safety flag mapping…` test (line 142). **Do not touch the other agy flag assertions in that test (lines 138–146). Task-04 rewrites them.**

## Technical Details

### Background: how the MCP bridge works today

- `mcp-desktop.mjs` `createDesktopMcpBridge()` (around line 562) listens on a private socket, `path.join(tempDir, 'mcp.sock')` (`tempDir = os.tmpdir()/yomna-mcp-<pid>-<rand>-…`), and writes `mcp-config.json`:
  ```json
  { "mcpServers": { "yomna-desktop": { "command": "<process.execPath>", "args": ["<relayScript>", "<socketPath>"] } } }
  ```
- The relay CLI (bottom of `mcp-desktop.mjs`, around lines 748–756) already reads the socket from `args[0]`, falling back to `process.env.YOMNA_MCP_SOCKET`:
  ```js
  const socketPath = args[0] === '--relay' ? args[1] : (args[0] || process.env.YOMNA_MCP_SOCKET || '');
  if (!socketPath) { process.stderr.write('Usage: …'); process.exit(1); }
  runStdioRelay(socketPath);
  ```
- `sidekick.mjs` uses one bridge for the main process. `agentrun.mjs` (line 130) makes **its own bridge per background agent**, so there can be several sockets at once. That's why the socket must be passed per `agy` process through env, not baked into the global config.
- `harnesses/base.mjs` exports `loadMcpServers({ mcpConfigPath, mcpServer })`, which returns `{ name: { command, args, env? } }`, and `execProbe(bin, args, { env, timeout })`, which returns `{ ok, stdout, stderr, error }`.

### `agy mcp add` CLI (verified, agy 1.5.18)

```
Usage: agy mcp add [flags] <name> <commandOrUrl> [args...]
Flags: -e/--env KEY=value (repeatable), -H/--header, -t/--type stdio|http
Notes: Flags must come before <name>. Use -- before the command if it or args begin with '-'.
"Add or update an MCP server configuration"
```
It writes to `~/.gemini/config/mcp_config.json`. The user already has `browseros-neo` there, so leave other entries alone.

### Implementation Steps

1. **`agy.mjs`**
   - Delete `buildAgySettings` usage for MCP. Either keep the export and return `null` for MCP-only input, or remove it and update the test import. Removing it is cleaner. Update the `import { buildAgyArgs, buildAgySettings }` line in the test to match.
   - Keep the `settingsPath` param in `buildAgyArgs` (it may be used for real settings later), but `send()` must no longer pass it for MCP.
   - Add an exported pure helper:
     ```js
     // Splits each server into a global registration (command + args without a socket) and per-turn env.
     export function planAgyMcp(servers) {
       const register = [], env = {};
       for (const [name, s] of Object.entries(servers ?? {})) {
         if (!s?.command) continue;
         let args = Array.isArray(s.args) ? [...s.args] : [];
         if (name === 'yomna-desktop' && args.length >= 2) env.YOMNA_MCP_SOCKET = args.pop();
         register.push({ name, command: s.command, args });
       }
       return { register, env };
     }
     export const agyMcpAddArgs = ({ name, command, args }) => ['mcp', 'add', name, '--', command, ...args];
     ```
     (Put `--` after `<name>` only if `agy` accepts it there. Check `agy mcp add --help`. If not, drop `--`, because the relay path doesn't start with `-`.)
   - In `AgyAdapter`, add a private `#registered = new Map()` (name → JSON of `{command,args}`). In `send()`, before `_beginTurn`:
     ```js
     const { register, env: mcpEnv } = planAgyMcp(loadMcpServers({ mcpConfigPath, mcpServer }));
     for (const r of register) {
       const key = JSON.stringify(r);
       if (this.#registered.get(r.name) === key) continue;
       const res = await execProbe(binPath, agyMcpAddArgs(r), { env, timeout: 10_000 });
       if (res.ok) this.#registered.set(r.name, key);
       // on failure: continue the turn anyway (agy still runs, just without Yomna tools); do not throw
     }
     ```
     Then spawn with `env: { ...env, ...mcpEnv }` in `runCliTurn`.
   - Remove the `writeTempJson` and `_registerCleanup` usage for settings in `send()`.
2. **`mcp-desktop.mjs` relay, empty-server fallback.** When `socketPath` is empty, or the socket connect fails with `ENOENT` / `ECONNREFUSED` (Yomna isn't running, or the user is in their own `agy` session), don't exit 1. Serve a minimal MCP over stdio:
   - `initialize` → `{ jsonrpc:'2.0', id, result: { protocolVersion: <client's requested or '2024-11-05'>, capabilities: { tools: {} }, serverInfo: SERVER_INFO } }`
   - `tools/list` → `{ result: { tools: [] } }`
   - notifications (no `id`) → no response
   - anything else → `{ error: { code: -32601, message: 'Yomna is not running.' } }`
   - Exit 0 when stdin ends.
   Export it as `runEmptyRelay({ stdin, stdout, onExit })` so it can be tested. For the connect-failure case, keep any lines already buffered in `pending` and replay them into the empty server.
3. **Tests (`test/harnesses.test.mjs`)**
   - Replace the old `--settings` injection test with `AgyAdapter registers MCP via "agy mcp add" and passes YOMNA_MCP_SOCKET`. Use a fake `agy` script (the existing `writeExecutableScript` helper) that appends each invocation's `args` and `process.env.YOMNA_MCP_SOCKET` to a capture file. For `args[0]==='mcp'` it exits 0. Otherwise it prints the same NDJSON stream as the old test (`init` / `step_update` / `result`). Assert:
     - one `mcp add yomna-desktop … node mcp-desktop.mjs` call, with **no** socket path in its args
     - the turn call has no `--settings`, and its env `YOMNA_MCP_SOCKET` equals the socket from the config (`args: ['mcp-desktop.mjs', '/tmp/x.sock']`)
     - a second `send()` with the same config does **not** call `mcp add` again
     - the event list is unchanged (`session`, two `text_delta`, `done`), and the prompt still contains `<system_instructions>`
   - Add a unit test for `planAgyMcp`.
   - In the `safety flag mapping…` test, delete only the line asserting `--settings` (line 142) and remove `settingsPath: '/tmp/s.json'` from that call.
   - Add a test for `runEmptyRelay`: feed `initialize` and `tools/list` lines through a `PassThrough` stdin, then assert `serverInfo.name === 'yomna-desktop'` and `tools` is `[]`. Put it in `test/harnesses.test.mjs`, or in `test/mcp-desktop.test.mjs` if that file already tests the relay (it isn't touched by any other task).

### Fallback if `agy` does NOT pass parent env to MCP children

A human verifies this (see `action-required.md`). If the env doesn't reach the relay, register with the socket baked in instead:
`agy mcp add -e YOMNA_MCP_SOCKET=<sock> yomna-desktop <node> <relay>`. Do that in `send()` whenever the socket differs from the last registration (`#registered` key includes the socket). Note in a code comment that concurrent background agents on `agy` then share the last-registered socket.

## Acceptance Criteria

- [ ] `agy.mjs` never passes `--settings` with `mcpServers`.
- [ ] The first `send()` runs `agy mcp add yomna-desktop <node> <relay>` once, and later sends with the same server skip it.
- [ ] The `agy` turn process gets `YOMNA_MCP_SOCKET=<bridge socket>` in its env.
- [ ] A failed `mcp add` doesn't break the turn.
- [ ] The relay started with no socket, or a dead one, answers `initialize` and `tools/list` (empty) and exits 0 when stdin ends.
- [ ] `cd showcase/tauri/sidecar && npm test` passes. Harness modules still import only `node:*` / `./`.

## Notes

- This is a global side effect: Yomna now writes into `~/.gemini/config/mcp_config.json`. Leave other entries alone and never call `agy mcp remove` on names Yomna didn't create.
- The `memory_failed … unknown setting "mcpServers"` log line comes from the same bug and should disappear too.
