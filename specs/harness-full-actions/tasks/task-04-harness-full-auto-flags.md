# Task 04: Full-auto permission flags for agy and claude

## Status

complete

## Wave

2

## Description

Even with "Allow File Edits & Commands" on, Yomna's harnesses only auto-approve **file edits**. `agy` runs with `--mode accept-edits` and `claude` with `--permission-mode acceptEdits`. Both run headless (`-p`), so shell commands and other tool calls hit a permission prompt nobody can answer, and they get denied. Yomna then just describes what it would do. The user chose **full auto**: when both `allowActions` and `skipAllow` are on, the harness runs everything without prompts. This task maps the new `skipAllow` option to the right CLI flags and updates the flag tests.

## Dependencies

**Depends on:** task-01-agy-mcp-injection.md, task-03-skipallow-plumbing.md
**Blocks:** None

**Context from dependencies:**
- task-01 rewrote `harnesses/agy.mjs` `send()`: MCP servers are now registered with `agy mcp add` (cached per adapter), the turn gets `YOMNA_MCP_SOCKET` in its env, and `--settings` is no longer used for MCP. It also replaced the agy MCP test in `test/harnesses.test.mjs` and removed the `--settings` assertion from the `safety flag mapping…` test. The remaining agy flag assertions in that test (plan/sandbox/accept-edits) are yours to update.
- task-03 made every `harnessManager.send({...})` call (`sidekick.mjs`, `agentrun.mjs`) pass `skipAllow: boolean`. It's true only when `allowActions` is true too. `HarnessManager.send` in `harnesses/index.mjs` spreads `opts` into `harness.send(...)`, so `skipAllow` already reaches each adapter's `send()`. Adapters just need to destructure it.

## Files to Create

None.

## Files to Modify

- `showcase/tauri/sidecar/harnesses/agy.mjs`: `buildAgyArgs` and `send()` accept `skipAllow`.
- `showcase/tauri/sidecar/harnesses/claude.mjs`: `buildClaudeArgs` and `send()` accept `skipAllow`, and always allow `yomna-desktop` MCP tools.
- `showcase/tauri/sidecar/test/harnesses.test.mjs`: update the `safety flag mapping…` test (around line 135) with the new cases.

## Technical Details

### Flag matrix (the decided behaviour)

| allowActions | skipAllow | agy args | claude `--permission-mode` |
|---|---|---|---|
| false | any | `--mode plan --sandbox` (unchanged) | `plan` (unchanged) |
| true | false | `--mode accept-edits` (unchanged) | `acceptEdits` (unchanged) |
| true | true | `--mode auto --dangerously-skip-permissions` | `bypassPermissions` |

Treat `skipAllow` as false whenever `allowActions` is false, even if the caller passes true. Enforce this inside the builders too:
```js
const full = !!allowActions && !!skipAllow;
```

### agy (`harnesses/agy.mjs`)

Current (line ~36):
```js
...(allowActions ? ['--mode', 'accept-edits'] : ['--mode', 'plan', '--sandbox']),
```
New:
```js
...(!allowActions ? ['--mode', 'plan', '--sandbox']
  : full ? ['--mode', 'auto', '--dangerously-skip-permissions']
  : ['--mode', 'accept-edits']),
```
Add `skipAllow = false` to the `buildAgyArgs` params and to the `send()` destructuring, and pass it through. Verified with `agy --help` (1.5.18): `--mode (accept-edits, auto, plan)` and `--dangerously-skip-permissions  Auto-approve all tool permission requests without prompting`.

### claude (`harnesses/claude.mjs`)

Current (line ~29):
```js
'--permission-mode',
allowActions ? 'acceptEdits' : 'plan',
```
New: `!allowActions ? 'plan' : full ? 'bypassPermissions' : 'acceptEdits'`.

Also, when `mcpConfigPath` is set, always push `'--allowedTools', 'mcp__yomna-desktop'`. Yomna's own MCP tools have their own safety layer (`mcp-desktop.mjs` + `safety.mjs`), and screen tools like `take_screenshot` / `read_window` must work even with actions off. The system prompt in `sidekick.mjs` promises this. Add `skipAllow = false` to the `send()` destructuring and pass it to `buildClaudeArgs`.

### Tests (`test/harnesses.test.mjs`, `safety flag mapping…` test)

Replace the agy and claude parts with:
- agy `allowActions:false, skipAllow:true` → `--mode plan`, has `--sandbox`, **no** `--dangerously-skip-permissions`
- agy `allowActions:true` → `--mode accept-edits`, no `--sandbox`, no `--dangerously-skip-permissions`
- agy `allowActions:true, skipAllow:true` → `--mode auto` and has `--dangerously-skip-permissions`
- claude `allowActions:false, skipAllow:true` → `plan`
- claude `allowActions:true` → `acceptEdits`
- claude `allowActions:true, skipAllow:true` → `bypassPermissions`
- claude with `mcpConfigPath` → `--allowedTools` followed by `mcp__yomna-desktop`

Keep the existing `--conversation`, `--add-dir`, `--mcp-config`, `--resume` assertions, and keep the opencode and pi assertions as they are. Rename the test to mention `skipAllow`.

## Acceptance Criteria

- [ ] The flag matrix above holds for agy and claude, with tests covering every row.
- [ ] `skipAllow:true` with `allowActions:false` never produces full-auto flags.
- [ ] claude always allows `mcp__yomna-desktop` when an MCP config is given.
- [ ] `cd showcase/tauri/sidecar && npm test` passes. Harness files import only `node:*` / `./`.

## Notes

- This is a deliberate safety trade-off the user accepted. In full-auto mode, native harness shell and edit tools are **not** filtered by `safety.mjs`. Add a one-line comment above the flag mapping saying it applies only when the user turned on both "Allow File Edits & Commands" and "Skip Allow prompts".
- opencode (`--auto` when allowed) and pi (full tool list when allowed) already execute actions, so leave them alone.
