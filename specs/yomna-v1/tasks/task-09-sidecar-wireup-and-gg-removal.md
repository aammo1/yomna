# Task 09: Wire Harness Architecture into Sidecar (`sidekick.mjs`) and Remove `@kenkaiiii/gg-*`

## Status

complete

## Wave

3

## Description

Wire the new pluggable CLI harness framework (`harnesses/index.mjs`), local `yomna-desktop` MCP bridge (`mcp-desktop.mjs`), keyless local TTS (`localtts.mjs` / `edgetts.mjs`), cross-platform Gemini Live bridge (`livebrain.mjs` with `delegate_to_harness`), and Linux `yomna-hands` support into `showcase/tauri/sidecar/sidekick.mjs` and its supporting sidecar modules. Completely remove `@kenkaiiii/gg-agent`, `@kenkaiiii/gg-ai`, `@kenkaiiii/gg-core`, `@kenkaiiii/ggcoder`, and `@anthropic-ai/claude-agent-sdk` from `package.json`, delete all direct-LLM-API modules, and eliminate every `EricTechPro` / `Jarvis` / `GG Coder` / `Roamies` string from the sidecar runtime.

## Dependencies

**Depends on:** `task-05-harness-adapter-framework.md`, `task-06-yomna-desktop-mcp-server.md`, `task-07-keyless-local-tts-and-live-bridge.md`, `task-08-hands-linux-helper.md`
**Blocks:** `task-12-build-wiring-and-omarchy-packaging.md`

**Context from dependencies:**
- `task-05` created `showcase/tauri/sidecar/harnesses/` exporting `HarnessManager`, `detectHarnesses()`, and drivers for `agy` (default), `opencode`, `pi`, `claude`, and `acp` (custom), with 120s hang watchdog and `allowActions` read-only vs edit flags.
- `task-06` created `showcase/tauri/sidecar/mcp-desktop.mjs` (`createDesktopMcpBridge(handlers)`) and rebranded `datadir.mjs` (`YOMNA_DIR`, `DATA_DIR`, `CONFIG_PATH`), `secrets.mjs` (`com.aammo1.yomna`), `wakename.mjs` (`Yomna`), and `safety.mjs`.
- `task-07` created `localtts.mjs` and `edgetts.mjs`, deleted `fish.mjs` and `rebrand.mjs`, removed `@kenkaiiii/gg-*` from `livebrain.mjs`, and added `delegate_to_harness` to `livebrain.mjs`.
- `task-08` created `hands-linux` (`yomna-hands`) and updated `platform.mjs` to enable `hasHands` and `canSnap` on Linux when `YOMNA_HANDS` is set.

## Files to Create

- None (wires Wave 2 modules into existing sidecar entrypoints).

## Files to Modify

- `showcase/tauri/sidecar/package.json` — Rename `"name": "yomna-sidecar"`, set `"repository.url": "https://github.com/aammo1/yomna.git"`, **remove** `@kenkaiiii/gg-agent`, `@kenkaiiii/gg-ai`, `@kenkaiiii/gg-core`, `@kenkaiiii/ggcoder`, `@anthropic-ai/claude-agent-sdk`, and `@anthropic-ai/sandbox-runtime` overrides; keep `@google/genai`, `zod`, `esbuild`, `c8`.
- `showcase/tauri/sidecar/sidekick.mjs` — Major cleanup & rewiring:
  - Replace `Agent` / `ClaudeCodeAgent` / `AuthStorage` / `~/.gg/auth.json` / `FAST` / `OAUTH` / `hybrid` / `fallbacks` / `localServers` with `HarnessManager` (`config.harness`, default `'agy'`; `config.customHarness`, `{ command, args, protocol }`).
  - Start `createDesktopMcpBridge(...)` on boot and pass its `mcpConfigPath` to every harness turn.
  - Handle new panel/onboarding IPC messages: `detect_harnesses`, `set_harness`, `set_custom_harness`, `switch_harness` (on timeout/auth error), `set_tts` (`'local' | 'edge' | 'voicestudio' | 'gemini'`), `download_tts_model`.
  - Enable **Gemini Live Mode** on Linux & Windows (remove macOS-only guard around line 2365!), passing `onDelegate` to `createLiveBrain` so `delegate_to_harness` dispatches straight to `harnessManager.send(...)` and reports completion via `live.news(...)`.
  - Rename `UPDATE_REPO` → `'aammo1/yomna'`, `LOOKS[0]` → `['yomna', 'Yomna']`, `DEFAULT_LOOK = 'yomna'`, `DEFAULTS.tts = 'local'`, `YOMNA_VERSION`, and update diagnostics toast URL to `github.com/aammo1/yomna/issues`.
- `showcase/tauri/sidecar/brain.mjs` — Replace `@kenkaiiii/gg-agent` / `@kenkaiiii/gg-ai` / `@kenkaiiii/gg-core` imports with `harnessManager.oneShot(...)` and local regex secret redaction (zero `gg-*` dependency) for memory/skill extraction passes.
- `showcase/tauri/sidecar/about.mjs` — Rewrite `aboutYomna(o)` (exported as `aboutYomna`) describing Yomna's CLI harness architecture (`agy`, `opencode`, `pi`, `claude`, custom ACP), local keyless voice + Gemini Live, Second Brain, and `github.com/aammo1/yomna/issues` (zero `EricTechPro` / `GG Coder` mentions).
- `showcase/tauri/sidecar/diagnostics.mjs` — Update header URL to `github.com/aammo1/yomna/issues`, filename `yomna-diagnostics-….log`, scrub `Yomna` harness config cleanly.
- `showcase/tauri/sidecar/tools.mjs` — Replace `"https://skool.com"` example in `open` tool description (line 1038) with `"https://example.com"`, point `HANDS` binary lookup to `process.env.YOMNA_HANDS`, and expose desktop handler functions consumed by `mcp-desktop.mjs`.
- `showcase/tauri/sidecar/secondbrain.mjs` — Update `secondBrainBlock()` wording from `"Jarvis's own files are in ~/Jarvis"` to `"Yomna's own files are in ~/Yomna"`.
- `showcase/tauri/sidecar/mcp.mjs` — Update `SECRET_MARK = '@yomna-secret'`, `~/Yomna/Data/mcp.json`, remove `@kenkaiiii/ggcoder/mcp` dependency (or replace with lightweight config pass-through into the harness's MCP list).
- `showcase/tauri/sidecar/wintray.mjs` — Match `Yomna\yomna.exe` instead of `Jarvis\jarvis.exe`.
- `showcase/tauri/sidecar/sync.mjs` — Rename `Jarvis Sync` / `Roamies Sync` → `Yomna Sync`.
- **DELETE** direct-API modules replaced by `harnesses/`:
  - `showcase/tauri/sidecar/claudecode.mjs`
  - `showcase/tauri/sidecar/codex.mjs`
  - `showcase/tauri/sidecar/providers.mjs`
  - `showcase/tauri/sidecar/catalogs.mjs`
  - `showcase/tauri/sidecar/local.mjs`
  - `showcase/tauri/sidecar/limits.mjs`
  - `showcase/tauri/sidecar/route.mjs`

## Technical Details

### Implementation Steps

1. Update `showcase/tauri/sidecar/package.json` and run `npm install` (regenerating `package-lock.json`) so `@kenkaiiii/*` and `@anthropic-ai/*` are completely gone from `node_modules` and lockfile.
2. Refactor `sidekick.mjs` config defaults:
   ```js
   const DEFAULTS = {
     harness: 'agy', // 'agy' | 'opencode' | 'pi' | 'claude' | 'custom'
     customHarness: { command: '', args: [], protocol: 'acp' },
     sound: true,
     allowActions: false,
     skipAllow: false,
     voice: true,
     secondBrain: null,
     notch: 'off',
     onboarded: false,
     onboardStep: 0,
     keys: DEFAULT_KEYS,
     muteWhileTalking: true,
     autoListen: false,
     listenEvery: false,
     listenSecs: 8,
     wakeWord: false,
     setupVersion: 0,
     size: 'default',
     look: 'yomna',
     introDone: false,
     voiceMode: 'classic', // 'classic' | 'live'
     liveVoice: null,
     liveModel: DEFAULT_LIVE_MODEL,
     replies: 'voice',
     speechLang: 'auto',
     tts: 'local', // 'local' | 'edge' | 'voicestudio' | 'gemini'
     localTtsVoice: 'en_US-amy-medium',
     edgeTtsVoice: 'en-US-AvaMultilingualNeural',
     studioSpeak: 'short',
     studioVoices: {},
     geminiVoices: {},
     geminiModel: GEMINI_MODEL,
   };
   ```
3. Wire `sidekick.mjs` main turn flow:
   - On user voice/text prompt in **Classic Mode**: call `harnessManager.send({ prompt, images, systemPrompt, cwd, secondBrainDirs, mcpConfigPath, allowActions: config.allowActions, sessionId, signal })`.
   - Stream `text_delta` → overlay bubble + `speaker.say(...)`; `tool_start`/`tool_end` → overlay tool animations; `error` with `suggestSwitch: true` → bubble toast with `"Switch Harness"` action button.
   - On **Gemini Live Mode**: send `{ type: 'voice', cmd: 'live_mode', on: true }` and `{ type: 'voice', cmd: 'live_capture', on: true }` on ALL platforms (Linux, Windows, macOS), pipe `pcm` events into `liveBrain.pushAudio(pcm)`, and handle `delegate_to_harness` by invoking `harnessManager.send(...)` in the background while showing progress on the overlay card.
4. Update `brain.mjs` to remove `@kenkaiiii/*` imports and use a clean local secret scrubber (`REDACTION_MARKER = '[REDACTED]'`, redacting env secrets + key/token patterns + card numbers) and `harnessManager.oneShot`.
5. Run `node --check showcase/tauri/sidecar/*.mjs showcase/tauri/sidecar/harnesses/*.mjs` and `./showcase/tauri/sidecar/bundle.sh` to verify clean bundling.

## Acceptance Criteria

- [ ] `package.json` contains zero `@kenkaiiii/*` or `@anthropic-ai/*` packages; `claudecode.mjs`, `codex.mjs`, `providers.mjs`, `catalogs.mjs`, `local.mjs`, `limits.mjs`, and `route.mjs` are deleted.
- [ ] `sidekick.mjs` boots, starts `mcp-desktop.mjs`, auto-detects harnesses via `detectHarnesses()`, runs turns through `HarnessManager`, speaks via local keyless TTS, and enables Gemini Live on Linux, Windows, and macOS.
- [ ] `grep -rnIiE "erictech|roamies|gg-agent|gg-core|ggcoder|skool\.com/eric" showcase/tauri/sidecar/ --exclude-dir=node_modules --exclude-dir=test --exclude-dir=dist` returns 0 matches.
- [ ] `./showcase/tauri/sidecar/bundle.sh` exits `0` and produces clean `dist/sidekick.mjs` and `dist/mcp-desktop.mjs`.
