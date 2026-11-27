# AGENTS.md

Yomna (derived from Roamies): a Tauri 2 desktop companion (`showcase/tauri/src-tauri`), a Node.js sidecar (`showcase/tauri/sidecar`) that runs pluggable local CLI agent harnesses (`agy` default, `opencode`, `pi`, `claude`, or custom ACP/CLI) with an attached local `yomna-desktop` MCP server, shared browser JS (`showcase/jarvis`), macOS Swift helpers built by `src-tauri/build.rs`, Windows helpers (`src-tauri/voice-win` with Parakeet + `src-tauri/hands-win` over Win32/UIA/OCR), and first-class Linux (Omarchy/Hyprland Wayland + X11) support (`src-tauri/src/linux.rs`, `voice-win` on Linux, and `hands-linux` over `hyprctl`, `slurp`/`grim`, `wtype`/`ydotool`, and AT-SPI2).

Voice runs in two modes: **Classic Harness Mode** (keyless local Parakeet STT → CLI harness → Kokoro/Piper local TTS, or optional Edge TTS / VoiceStudio) and **Gemini Live Mode** (`live.mjs` / `livebrain.mjs` streaming 16 kHz PCM audio across macOS, Linux, and Windows with `delegate_to_harness`).

## Commands

```sh
cd showcase/tauri/sidecar && npm ci     # install sidecar deps
npm test                                # sidecar tests (harnesses, MCP, voice, safety, storage)
npm run build                           # bundle the sidecar into dist/
cd .. && ./build.sh dev                 # web files + sidecar + debug `cargo build`
./build.sh                              # release bundle for this OS (signs on macOS if a Developer ID is in the keychain)
```

- Only `hands-win/src/logic.rs` builds off Windows, so `cargo test` there runs its checks anywhere; from macOS, `cargo xwin check --target x86_64-pc-windows-msvc` type-checks the Windows code with the real SDK.
- Linux debug aids: `YOMNA_TRACE=1` (or `JARVIS_TRACE=1`) prints overlay click areas, and in debug builds `YOMNA_TEST_AUDIO=<wav>` stands in for the microphone.
- There is no linter configured yet.

Releases: bump the version in `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, then push a matching `v*` tag (or run `.github/workflows/release.yml` by hand). It builds macOS DMGs, a Windows installer, and Linux packages (AppImage, `.deb`, `.rpm`) plus `SHA256SUMS` into a GitHub release. Updates are manual via GitHub Releases and the SHA-256 verified installers `get.sh` and `get.ps1` (there is no in-app `tauri-plugin-updater` server). Asset names carry no version (`Yomna-macos-arm64.dmg`, `Yomna-windows-x64-setup.exe`, etc.) so `releases/latest/download/<name>` stays stable across `get.sh`, `get.ps1`, and `release.yml`.

## Commits

Subject: `<emoji> [type] scope: subject`, then short bullets in the body, for example `✨ [feat] harness: add opencode adapter`. Types: ✨ feat · 🐛 fix · 🔧 chore · ♻️ refactor · 🧪 test · ⚡ perf · 📝 docs · 👷 ci · 💄 ui · 🔒 security · ⏪ revert · 🚧 wip.

- `.githooks/commit-msg` rejects other subjects (git's own Merge, Revert and fixup! subjects pass). Enable it once per clone: `git config core.hooksPath .githooks`.
- Squash merges use the pull request title, so the title follows the same format; `.github/workflows/pr-title.yml` checks it with the same hook.

## Rules

- Every tool that touches files, commands, URLs or other apps goes through `showcase/tauri/sidecar/safety.mjs` (tested in `test/safety.test.mjs`) and the `yomna-desktop` MCP safety layer; `allowActions` defaults to `false`, and the hands helpers refuse to type or click in apps listed in `HANDS_OFF` (`hands/main.swift`, `hands-win/src/logic.rs`, `hands-linux`). Add a test case with every rule change.
- Keep `tauri.conf.json` Content Security Policy locked down (never `"csp": null`).
- CI lives in `.github/workflows/ci.yml` and must stay green.
- Never commit with `--no-verify`.
- Never commit experiments (prototypes, test pages, design tools). They stay local and are listed in `.git/info/exclude`; check `git status` before every commit.
- Never commit secrets (API keys, Apple ID passwords, certificates, local auth tokens); signing credentials go in GitHub Actions secrets.
