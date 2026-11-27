# Requirements: Yomna v1

## Summary

**Yomna** (`aammo1/yomna`) is a brand-new, free open-source AI desktop companion derived from the Tauri 2 + Node.js sidecar + Canvas overlay architecture, upgraded for public release on **Linux (Omarchy/Hyprland Wayland)**, **Windows**, and **macOS** for the owner's YouTube and Skool community. Unlike the original fork (`EricTechPro/jarvis`), Yomna does **not** talk directly to paid LLM chat APIs (`@kenkaiiii/gg-*`, OpenAI/Anthropic/OpenRouter API keys, `~/.gg/auth.json`). Instead, Yomna runs local CLI coding/agent harnesses in the background — **Antigravity (`agy`)** by default, plus **OpenCode (`opencode`)**, **Pi (`pi`)**, **Claude Code (`claude`)**, or any **Custom ACP/CLI harness** — while attaching a lightweight local `yomna-desktop` MCP server so any harness can see the screen, draw rich interactive cards on the overlay, control apps, and manage reminders.

Voice works in two seamless modes: **Classic Harness Mode** (100% keyless and local using Parakeet ONNX STT → CLI Harness → Kokoro/Piper local TTS, with optional Edge TTS / VoiceStudio) and **Gemini Live Mode** (using a free Google AI Studio key, fixed to work on **Linux and Windows** in addition to macOS, with a `delegate_to_harness` tool that hands heavy work to the background CLI harness during a live phone-call conversation). All `EricTechPro` branding, DevFest slides (`34 MB`), paid Fish Audio `.pcm` beats (`15 MB`), affiliate links (`fish.audio/?fpr=o3gtlu`), and `Claude Code` creator/contributor attributions are removed while preserving AGPL-3.0 open-source compliance for safe public GitHub distribution.

## Goals

- **100% Yomna brand & standalone repo (`aammo1/yomna`):** Bundle ID `com.aammo1.yomna`, data folder `~/Yomna`, wake word `"Hey Yomna"`, default orb persona **Yomna**, zero `EricTechPro` references, and zero `Claude Code` creator/contributor attributions.
- **Pluggable Background CLI Harness Brain:** Replace direct LLM chat APIs (`@kenkaiiii/gg-*`, `@anthropic-ai/claude-agent-sdk`, `~/.gg/auth.json`) with clean adapters for `agy` (default), `opencode`, `pi`, `claude` (as user-selectable runtime option only), and generic ACP/CLI harnesses.
- **Hybrid MCP Desktop Superpowers:** Let each CLI harness retain its own native file/shell/web/skill/MCP tools while Yomna auto-attaches a local `yomna-desktop` MCP server for `take_screenshot`, area crop, `draw` cards, `list_windows`/`read_window`/`act_in_app`, and reminders/focus/jobs.
- **Dual-Mode Voice (Keyless Local + Cross-Platform Gemini Live):** Default keyless local Parakeet STT + Kokoro/Piper TTS (with optional Edge TTS / VoiceStudio), plus keep & fix **Gemini Live** (`live.mjs`/`livebrain.mjs`) across Linux & Windows via `voice-win` 16 kHz PCM streaming and `delegate_to_harness`.
- **First-Class Omarchy / Hyprland Linux & Windows Parity:** Fix Hyprland XWayland overlay handling, 60s screenshot thread leak, non-fatal tray startup, PipeWire mic enumeration, Linux child-process cleanup, and build `hands-linux` (`hyprctl`, `slurp`/`grim`, `wtype`/`ydotool`, AT-SPI2).
- **Security & Multilingual Polish:** Lock down Tauri CSP (`tauri.conf.json`), add SHA-256 verification to `get.sh`/`get.ps1`, keep `Allow Actions` OFF by default (read-only/sandboxed harness + on-screen Allow/Don't allow gate on risky UI clicks), and fix Arabic/Darija RTL text rendering in canvas speech bubbles and DOM panels.

## Non-Goals

- **No direct LLM chat API providers:** Do not retain OpenAI, Anthropic, DeepSeek, Kimi, GLM, MiniMax, Xiaomi, OpenRouter, or Ollama direct HTTP chat loops inside the sidecar (Ollama/local models can still be used through `opencode`/`agy`/ACP if configured there).
- **No Fish Audio paid TTS or pre-baked `.pcm` filler clips:** Remove `fish.mjs`, Fish Audio keys/links, and `sidecar/beats/*.pcm`.
- **No in-app auto-updater server:** Keep updates manual via GitHub Releases + verified `get.sh`/`get.ps1` installers (remove dead `tauri-plugin-updater` wiring).
- **No Vite/TypeScript full frontend rewrite in v1:** Keep the existing fast vanilla ES2022 webview architecture while pruning dead Roamies code and adding RTL support (Vite/TS migration can happen in v2).
- **Do not push to `aammo1/jarvis_aammo1`:** All work targets a new standalone `aammo1/yomna` repository.

## Acceptance Criteria

- [ ] Zero occurrences of `erictech`, `erictechpro`, `ericwtech`, `ericos`, `skool.com/erictech`, `fish.audio/?fpr=`, or `"Made with Claude Code"` exist anywhere in the repository (`slides/`, `docs/art/hero.*`, and `sidecar/beats/` are deleted).
- [ ] `LICENSE` (AGPL-3.0) and a clean, accurate `THIRD_PARTY_NOTICES.md` remain intact for safe public GitHub distribution.
- [ ] `@kenkaiiii/gg-agent`, `@kenkaiiii/gg-ai`, `@kenkaiiii/gg-core`, `@kenkaiiii/ggcoder`, and `@anthropic-ai/claude-agent-sdk` are completely removed from `showcase/tauri/sidecar/package.json`.
- [ ] Onboarding auto-detects installed CLI harnesses (`agy`, `opencode`, `pi`, `claude`) on `$PATH`, auto-selects the first authenticated one (preferring `agy`), and displays clear 1-click setup instructions when none are installed.
- [ ] Classic Harness Mode completes a full voice/text turn via `agy` (and supports switching to `opencode`, `pi`, `claude`, or custom ACP), invoking `yomna-desktop` MCP tools (`take_screenshot`, `draw`) and speaking back via local keyless TTS without any LLM API key.
- [ ] Gemini Live Mode streams `16 kHz` PCM audio from `yomna-voice` (`voice-win`) on Linux and Windows, supports real-time barge-in, and delegates heavy tasks to the active CLI harness via `delegate_to_harness`.
- [ ] On Omarchy/Hyprland Wayland, overlays do not get tiled or crash without a tray daemon, PipeWire mic list excludes raw `hw:` spam, screenshots do not leak threads, and `hands-linux` handles `front`, `windows`, `select`, and `act`.
- [ ] `tauri.conf.json` enforces a strict Content Security Policy (never `"csp": null`), and `get.sh` / `get.ps1` verify `SHA256SUMS` before installing.
- [ ] Arabic and Moroccan Darija replies render right-to-left cleanly in both canvas speech bubbles (`agent.js`) and DOM cards/panel (`dir="auto"`).

## Assumptions

- **Local Rust toolchain:** Rust (`rustc` + `cargo`) will be installed on the developer's Omarchy laptop before building Rust crates (documented in `action-required.md`).
- **`agy` headless protocol:** `/usr/bin/agy` supports `--input-format stream-json --output-format stream-json`, `--conversation <id>`, `--mode <plan|accept-edits|auto>`, `--sandbox`, and `agy acp` (verified directly on this laptop).
- **Community harness CLIs:** Users choosing `opencode`, `pi`, or `claude` install and authenticate those CLIs themselves; Yomna detects and invokes them over stdio/JSON/ACP.
- **Gemini Live API:** Requires only a free-tier Google AI Studio API key (`@google/genai` `v1alpha` WebSocket) when the user explicitly toggles Gemini Live Mode ON; Classic Mode needs zero API keys.

## Technical Constraints

- **Repo isolation:** Implement in a clean standalone working tree for `aammo1/yomna` (never pushing to `aammo1/jarvis_aammo1`).
- **Node.js & Rust versions:** Sidecar targets Node `>=22` (bundled `v24.22.2` via `fetch-node.sh`); Tauri shell and helpers compile with stable Rust (`--locked` in CI).
- **Safety boundary:** `allowActions` defaults to `false` (harnesses run read-only/sandboxed; `yomna-desktop` blocks writes to `_raw`, secrets, and startup scripts, and prompts `Allow / Don't allow` before risky UI clicks such as Delete/Pay/Send).
- **AGPL-3.0 legal compliance:** Keep `LICENSE` and accurate third-party notices for reused Tauri/Roamies components, Parakeet ONNX (CC-BY-4.0), Kokoro/Piper voices, and bundled fonts (OFL 1.1).
