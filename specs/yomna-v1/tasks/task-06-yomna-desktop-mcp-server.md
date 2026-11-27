# Task 06: Build `yomna-desktop` Local MCP Server and Rebrand Core Sidecar Paths

## Status

pending

## Wave

2

## Description

Create the lightweight local **`yomna-desktop` MCP server** (`mcp-desktop.mjs`) that Yomna auto-attaches to whichever background CLI harness is active (`agy`, `opencode`, `pi`, `claude`, or custom ACP), giving every harness uniform access to Yomna's unique desktop superpowers (screen vision, overlay drawing/cards, app control, and reminders/focus) with built-in `safety.mjs` gating. In parallel, rebrand core sidecar path/secret/safety/wake modules (`datadir.mjs`, `secrets.mjs`, `wakename.mjs`, `safety.mjs`) from `Jarvis`/`com.erictech.jarvis`/`.gg` to **Yomna** / `com.aammo1.yomna` / `~/Yomna`.

## Dependencies

**Depends on:** `task-02-rust-shell-rebrand-and-csp.md`
**Blocks:** `task-09-sidecar-wireup-and-gg-removal.md`

**Context from dependencies:** `task-02` rebranded the Tauri shell bundle identifier to `com.aammo1.yomna`, data folder to `~/Yomna`, and `YOMNA_*` env vars. This task aligns the sidecar's data/secret/safety layer with those exact identifiers and builds the MCP server that `task-09` will start alongside the harness.

## Files to Create

- `showcase/tauri/sidecar/mcp-desktop.mjs` — Dual-mode (in-process Unix socket / Windows named pipe + stdio relay entrypoint) JSON-RPC 2.0 MCP server (`protocolVersion: "2024-11-05"`) exposing Yomna's desktop-only tools to any CLI harness:
  1. `take_screenshot` — captures screen / active window and returns base64 image content + screen bounds.
  2. `area_crop` — triggers interactive area selection (`yomna-hands select`) and returns cropped image.
  3. `draw` — renders circles, arrows, spotlights, flowcharts, math, chemistry, maps, 3D models, and cards on Yomna's overlay canvas.
  4. `list_windows` — lists visible windows (`app`, `title`, `id`) via `yomna-hands`.
  5. `read_window` — reads focused window accessibility tree / OCR via `yomna-hands`.
  6. `act_in_app` — clicks, types, or presses keys via `yomna-hands`, **always** checking `safety.mjs` `isRiskyClick` and popping up Yomna's on-screen **Allow / Don't allow** card before risky UI actions (`Delete`, `Pay`, `Send`, `Uninstall`, `Sign out`, etc.).
  7. `remember_commitment`, `update_commitment`, `list_commitments`, `forget_fact`, `show_list`, `snooze_reminder`, `schedule_job`, `list_jobs`, `start_focus`, `stop_focus` — Yomna's persistent memory, overlay checklist, routines, and focus mode.

## Files to Modify

- `showcase/tauri/sidecar/datadir.mjs` — Change `JARVIS_DIR` → `YOMNA_DIR` (`~/Yomna`), `JARVIS_DATA_DIR` → `YOMNA_DATA_DIR`, remove legacy `Roamies` and `~/.gg/sidekick` migration code.
- `showcase/tauri/sidecar/secrets.mjs` — Replace `'com.erictech.jarvis'` (line 102) → `'com.aammo1.yomna'`, label `'Jarvis: ...'` → `'Yomna: ...'`, and `jarvis-hands` → `yomna-hands` for macOS Keychain calls.
- `showcase/tauri/sidecar/wakename.mjs` — Replace `DEFAULT_WAKE_NAME = 'Jarvis'` → `'Yomna'` and `/^jarvis$/i` → `/^yomna$/i`.
- `showcase/tauri/sidecar/safety.mjs` — Update protected paths `Jarvis/Data/secrets.json` & `Jarvis/(Skills|Data)` → `Yomna/Data/secrets.json` & `Yomna/(Skills|Data)`, remove `C:\Users\ken` comment, keep `_raw` read-only protection, secret-file blocking, and `RISKY_CLICK` multilingual checks intact.

## Technical Details

### Implementation Steps

1. **MCP JSON-RPC 2.0 Server Architecture (`mcp-desktop.mjs`)**:
   - Implements MCP stdio methods cleanly with zero heavy SDK bloat: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`.
   - Sidecar starts a local IPC listener (`createDesktopMcpBridge(handlers)`):
     - Linux/macOS: Unix domain socket in `os.tmpdir()/yomna-mcp-<pid>-<rand>/mcp.sock` (mode `0600`).
     - Windows: named pipe `\\.\pipe\yomna-mcp-<pid>-<rand>`.
   - Writes a temporary MCP config file `{ "mcpServers": { "yomna-desktop": { "command": process.execPath, "args": [mcpRelayScript, socketPath] } } }` so **every** CLI harness (`agy`, `opencode`, `pi`, `claude`, `acp`) launches the tiny stdio relay which pipes stdin/stdout to the sidecar's live handlers!
   - Tool parameter schemas are defined in Zod (`zod` `4.x` already in `package.json`) and converted via `z.toJSONSchema(schema)` (native in Zod v4 — zero `@kenkaiiii/gg-ai` needed!).
2. **Two-Level Safety Enforcement inside `mcp-desktop.mjs`**:
   - When `allowActions()` is `false`: `act_in_app` returns an immediate clear error (`"Allow Actions is off in Yomna Settings. Turn it on to let Yomna click or type inside apps."`). `take_screenshot`, `draw`, `list_windows`, `read_window`, and memory/reminder tools remain available.
   - When `allowActions()` is `true`: `act_in_app` checks every step against `isRiskyClick(step.text)` from `safety.mjs` and awaits `confirmOnOverlay("Allow Yomna to click <label>?")` before executing.
3. **Update `datadir.mjs` exports**:
   - Export `YOMNA_DIR`, `DATA_DIR`, `CONFIG_PATH`, `SKILLS_DIR`, `AGENTS_DIR`, `dataPaths`.
   - Keep `JARVIS_DIR` out; `task-09` updates imports in `sidekick.mjs`.
4. **Update `secrets.mjs`**:
   - Linux `secret-tool`: `['service', 'com.aammo1.yomna', 'account', name]`.
   - macOS `yomna-hands`: matches `secretService = "com.aammo1.yomna"` updated in `task-02`.
   - Windows DPAPI: stores encrypted blobs under `~/Yomna/Data/secrets.json`.

### Code Snippets

MCP `tools/list` response format:
```js
{
  jsonrpc: '2.0',
  id: req.id,
  result: {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.parameters),
    })),
  },
}
```

## Acceptance Criteria

- [ ] `mcp-desktop.mjs` starts a local socket/pipe bridge, serves valid MCP `initialize`, `tools/list`, and `tools/call` responses over stdio relay, and cleans up its temp socket dir on `close()`.
- [ ] `act_in_app` refuses execution when `allowActions()` is `false`, and triggers `confirmOnOverlay` when `isRiskyClick` matches even when `allowActions()` is `true`.
- [ ] `datadir.mjs` resolves all paths under `~/Yomna` (`YOMNA_DATA_DIR` override) with zero `Roamies` / `~/.gg` migration remnants.
- [ ] `secrets.mjs` uses `com.aammo1.yomna` and `wakename.mjs` defaults to `'Yomna'`.
- [ ] `grep -rnIiE "erictech|roamies|jarvis" showcase/tauri/sidecar/mcp-desktop.mjs showcase/tauri/sidecar/datadir.mjs showcase/tauri/sidecar/secrets.mjs showcase/tauri/sidecar/wakename.mjs showcase/tauri/sidecar/safety.mjs` returns 0 matches.
