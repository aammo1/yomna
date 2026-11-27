# Task 11: Rebuild Settings Panel & Onboarding Wizard for CLI Harnesses, Keyless TTS, and Cross-Platform Gemini Live

## Status

pending

## Wave

3

## Description

Replace the legacy direct-AI-provider / GG Coder / Fish Audio UI in `showcase/panel/` and `showcase/onboarding/` with **Yomna's** clean harness-first experience. Users get an auto-detecting **Harness** page (`Antigravity (agy)` default, `OpenCode`, `Pi`, `Claude Code` as optional runtime harness, and `Custom ACP/CLI`), a **Voice & Live** page featuring keyless local TTS (`Kokoro/Piper`, `Edge TTS` with English + Moroccan Arabic `ar-MA`, `VoiceStudio`) plus **Gemini Live** unlocked on Linux, Windows & macOS (using a free Google AI Studio key), clean `Yomna v1.0.0` release notes, zero Fish Audio affiliate link, zero `EricTechPro` / `Roamies` / `Ken` mock strings, and `dir="auto"` RTL input/output support.

## Dependencies

**Depends on:** `task-05-harness-adapter-framework.md`, `task-07-keyless-local-tts-and-live-bridge.md`
**Blocks:** `task-12-build-wiring-and-omarchy-packaging.md`

**Context from dependencies:**
- `task-05` defined the harness catalog (`agy`, `opencode`, `pi`, `claude`, `custom`) and `detectHarnesses()` probe shape (`{ id, label, installed, path, version, authenticated, installUrl, installCmd, reason }`).
- `task-07` defined keyless TTS providers (`local`, `edge`, `voicestudio`, optional `gemini`), local voice download progress, and cross-platform Gemini Live (`voiceMode: 'classic' | 'live'`).

## Files to Create

- None.

## Files to Modify

- `showcase/panel/index.html` — Update `<title>Yomna</title>`, rename sidebar `"Model"` nav item → `"Harness"`, remove any legacy `Jarvis` copy, add `dir="auto"` on user-content containers.
- `showcase/panel/panel.js` — Major UI update:
  - Replace the `"Model"` pane (direct API keys, GG Coder OAuth, Ollama/LM Studio/OpenRouter/Hybrid/Fallbacks) with the **`Harness`** pane:
    - Shows auto-detected status cards for **Antigravity (`agy`)** (default), **OpenCode (`opencode`)**, **Pi (`pi`)**, **Claude Code (`claude`)**, and **Custom ACP/CLI** (command, args, protocol).
    - Green badge = Ready; Yellow = Installed (needs login, shows terminal command + Copy button); Gray = Not installed (shows 1-line install command + docs link).
    - **"Re-scan Harnesses"** button (`detect_harnesses` IPC) and **Allow Actions** read-only vs edit mode toggle with clear plain-English explanation.
  - Update **`Speaking & Live`** pane:
    - Voice Mode toggle: **Classic Harness Mode (No API Key)** vs **Gemini Live Mode (Free AI Studio Key)** — enabled on **Linux, Windows, and macOS** (no macOS-only gate!).
    - TTS provider picker: **Local Voice (Kokoro/Piper — Offline, Free)**, **Edge TTS (Free, includes Moroccan Arabic `ar-MA`)**, **VoiceStudio (Local App)**, or **Gemini TTS** (only shown if AI Studio key is saved). Remove all Fish Audio UI & links.
  - Update **`Appearance`** pane: Default look label `"Yomna"` (orb) + 5 optional looks.
  - Update **`General`** pane: Rebrand `Jarvis` → `Yomna`, link help/issues to `aammo1/yomna`, restore a concise one-line `AGPL-3.0 Open Source · Created with Antigravity` footer note.
  - Remove preview mock references to `Jarvis` / `EricTech` / `Ken` (`panel.js:1327-1466`).
- `showcase/panel/panel.css` — Remove orphaned `/* ---------- About: who made it ---------- */` block (line 109), add clean styling for harness status pills (`ready`, `needs-login`, `missing`), and raise muted label contrast from `rgba(255,255,255,0.34)` to `>= 0.62` for WCAG AA readability.
- `showcase/panel/whatsnew.json` — Replace entire changelog with clean **Yomna v1.0.0** release highlights (removing `EricTech OS` at line 54, DevFest slides at line 7, and all 36 legacy `Roamies` entries at lines 124–471).
- `showcase/onboarding/index.html` — Update `<title>Welcome to Yomna</title>`, remove `"Using GG Coder? You're already in."` (line 60), remove `"Get a key at fish.audio ↗"` (line 105), rename `"AI"` step to `"Harness"`, add `dir="auto"` to chat/text inputs.
- `showcase/onboarding/onboarding.js` —
  - **DELETE** Ken's Fish Audio affiliate URL (`const FISH_URL = 'https://fish.audio/?fpr=o3gtlu'` at line 546) and Fish Audio setup step!
  - Replace the AI sign-in/API-key step with **Harness Auto-Detection**: displays scanned `$PATH` results (`agy`, `opencode`, `pi`, `claude`), auto-selects the first ready harness (preferring `agy`), or shows 1-click install/login commands + `"Check again"` if none are ready.
  - Update Voice step: defaults to keyless **Parakeet STT + Local TTS** (zero API key required), with an optional **"Enable Gemini Live (Free AI Studio Key)"** toggle.
  - Replace `"Hi Ken, I'm JARVIS!"` and mock Ken facts (lines 1562–1573) with neutral `"Hi there, I'm Yomna!"` preview data.
  - Set default orb look to `'yomna'`.
- `showcase/onboarding/onboarding.css` — Improve muted text contrast (`rgba(255,255,255,0.34)` → `rgba(255,255,255,0.62)`) and add RTL-safe logical properties (`margin-inline-start` / `padding-inline`) where needed.

## Technical Details

### Implementation Steps

1. **Panel IPC Contract (aligned with `task-09` `sidekick.mjs`)**:
   - Outgoing via `invoke('sidecar_send', { msg: JSON.stringify(...) })`:
     - `{ type: 'menu', id: 'detect_harnesses' }`
     - `{ type: 'menu', id: 'set_harness', value: 'agy' | 'opencode' | 'pi' | 'claude' | 'custom' }`
     - `{ type: 'menu', id: 'set_custom_harness', value: { command, args, protocol } }`
     - `{ type: 'menu', id: 'set_tts', value: 'local' | 'edge' | 'voicestudio' | 'gemini' }`
     - `{ type: 'menu', id: 'set_voice_mode', value: 'classic' | 'live' }`
     - `{ type: 'menu', id: 'set_gemini_key', value: '<key>' }`
     - `{ type: 'menu', id: 'set_allow_actions', value: boolean }`
   - Incoming via `window.__panel(state)`:
     - `state.harness`: active harness ID
     - `state.harnesses`: array of detected harness objects from `detectHarnesses()`
     - `state.voiceMode`: `'classic' | 'live'`
     - `state.tts`: `'local' | 'edge' | 'voicestudio' | 'gemini'`
     - `state.localTtsStatus`: `{ status: 'ready' | 'missing' | 'downloading', done, total }`
2. **Clean `showcase/panel/whatsnew.json`**:
   ```json
   [
     {
       "version": "1.0.0",
       "date": "2026-11-27",
       "items": [
         { "kind": "new", "title": "Meet Yomna", "text": "Your open-source AI desktop companion powered by local CLI harnesses — no paid LLM API keys needed." },
         { "kind": "new", "title": "Pluggable CLI Harnesses", "text": "Run Antigravity (agy), OpenCode, Pi, Claude Code, or any custom ACP agent in the background with screen & drawing superpowers." },
         { "kind": "new", "title": "Keyless Voice + Cross-Platform Gemini Live", "text": "Offline Parakeet STT + local TTS out of the box, plus real-time Gemini Live voice calls on Linux, Windows, and macOS." },
         { "kind": "new", "title": "Omarchy / Hyprland & Arabic/Darija RTL", "text": "Native Hyprland overlay stability, Linux hands helper, PipeWire mic filtering, and right-to-left Arabic/Darija bubbles." }
       ]
     }
   ]
   ```
3. Verify JS syntax (`node --check showcase/panel/panel.js showcase/onboarding/onboarding.js`) and JSON validity (`node -e "JSON.parse(require('fs').readFileSync('showcase/panel/whatsnew.json','utf8'))"`).

## Acceptance Criteria

- [ ] `grep -rnIiE "erictech|roamies|gg coder|fish\.audio|fpr=o3gtlu|Hi Ken" showcase/panel/ showcase/onboarding/` returns 0 matches.
- [ ] Settings Panel has a working **Harness** pane showing auto-detected `agy`, `opencode`, `pi`, `claude`, and Custom ACP controls, and **Speaking & Live** unlocks Gemini Live on Linux, Windows, and macOS with zero Fish Audio UI.
- [ ] Onboarding auto-detects harnesses, skips API keys in Classic Mode, and offers optional Gemini Live setup.
- [ ] `whatsnew.json` is valid JSON containing only clean Yomna v1.0.0 entries.
- [ ] `node --check showcase/panel/panel.js showcase/onboarding/onboarding.js` exits `0`.
