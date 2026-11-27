# Task 02: Rebrand Rust/Swift Shell to Yomna, Lock Down CSP, and Fix Linux Reliability

## Status

complete

## Wave

1

## Description

Rebrand the Tauri 2 Rust desktop shell, macOS Swift helpers, and Windows `hands-win` metadata from `Jarvis` / `com.erictech.jarvis` to **Yomna** / `com.aammo1.yomna` / `~/Yomna`. At the same time, fix three critical security and Linux stability issues discovered during the deep audit: replace `"csp": null` in `tauri.conf.json` with a strict Content Security Policy, make Linux system-tray creation non-fatal when `libayatana-appindicator3` or a tray daemon is absent, and ensure Linux child processes spawned by the sidecar cannot orphan on crash.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** `task-06-yomna-desktop-mcp-server.md`, `task-08-hands-linux-helper.md`, `task-10-frontend-overlay-rebrand-and-rtl.md`

**Context from dependencies:** None — Wave 1 foundation task. Note that `src-tauri/src/linux.rs` and `src-tauri/voice-win/` are owned by `task-04-linux-hyprland-overlay-and-voice-win.md` in this same wave, so do NOT modify those files here.

## Files to Create

- `showcase/tauri/src-tauri/Yomna.entitlements` — Renamed copy of `Jarvis.entitlements` (remove `Jarvis.entitlements`), scoped cleanly for macOS hardened runtime.

## Files to Modify

- `showcase/tauri/src-tauri/tauri.conf.json` — Set `"productName": "Yomna"`, `"version": "1.0.0"`, `"identifier": "com.aammo1.yomna"`, replace `"csp": null` with strict CSP, and rename `"binaries/jarvis-node"` → `"binaries/yomna-node"`.
- `showcase/tauri/src-tauri/tauri.linux.conf.json` — Rename `binaries/jarvis-voice` & `binaries/jarvis-node` → `binaries/yomna-voice` & `binaries/yomna-node`; add `libayatana-appindicator3-1` to `.deb` recommends/depends.
- `showcase/tauri/src-tauri/tauri.macos.conf.json` — Rename `binaries/jarvis-*` → `binaries/yomna-*` and `"entitlements": "Yomna.entitlements"`.
- `showcase/tauri/src-tauri/tauri.windows.conf.json` — Rename `binaries/jarvis-*` → `binaries/yomna-*`.
- `showcase/tauri/src-tauri/Cargo.toml` — Set `name = "yomna"`, `version = "1.0.0"`, `description = "Yomna: a harness-powered AI desktop companion"`, `repository` & `homepage` = `"https://github.com/aammo1/yomna"`, and remove unused `tauri-plugin-updater` dependency.
- `showcase/tauri/src-tauri/build.rs` — Rename compiled macOS Swift helper binaries from `jarvis-{name}-{target}` to `yomna-{name}-{target}`.
- `showcase/tauri/src-tauri/src/main.rs` — Rename tray ID `"jarvis"` → `"yomna"`, `~/Jarvis` → `~/Yomna`, `JARVIS_*` env vars → `YOMNA_*` (keeping fallback read of `JARVIS_DATA_DIR` only if needed for tests), remove dead updater code (`UPDATES_ENABLED` branch), enable `live_mode`/`live_capture` forwarding on Linux & Windows (not macOS-only at lines 1834/1867), stop grabbing `Control+Alt+KeyA` on Linux until `hands-linux` is wired, and change `tray.build(app)?;` (line 1970) on Linux to log a warning and continue if tray init fails.
- `showcase/tauri/src-tauri/src/sidecar.rs` — Rename `JARVIS_NODE` / `JARVIS_VERSION` / `JARVIS_HANDS` / `JARVIS_EXE` / `JARVIS_SESSION` / `JARVIS_LAUNCH` → `YOMNA_*`, `jarvis-node` → `yomna-node`, `sidekick.log` → `yomna.log`, and add Linux `PR_SET_PDEATHSIG(SIGKILL)` (`pre_exec`) or process-group teardown so orphaned harness/MCP children never leak when Yomna exits.
- `showcase/tauri/src-tauri/src/voice.rs` — Rename `jarvis-voice` → `yomna-voice`, `JARVIS_TEST_AUDIO` → `YOMNA_TEST_AUDIO`, `sidekick-voice.log` → `yomna-voice.log`, and ensure `pcm` / `live_mode` / `live_capture` JSON messages flow identically on Linux, Windows, and macOS.
- `showcase/tauri/src-tauri/hands/main.swift` — Replace `"com.erictech.jarvis"` → `"com.aammo1.yomna"` (lines 37, 1514) and `"Eric Tech"` test strings (lines 1549, 1561) → `"Yomna User"`.
- `showcase/tauri/src-tauri/shared/shot.swift` — Replace `"com.erictech.jarvis"` → `"com.aammo1.yomna"` (line 16).
- `showcase/tauri/src-tauri/hands-win/Cargo.toml` — Set `name = "yomna-hands"`.
- `showcase/tauri/src-tauri/hands-win/src/win.rs` — Replace `["jarvis", "jarvis-voice", "jarvis-hands"]` (line 218) → `["yomna", "yomna-voice", "yomna-hands"]`.

## Technical Details

### Implementation Steps

1. Update `tauri.conf.json` with a strict CSP that allows local Tauri assets, inline styles/scripts currently used by `desktop.html` / `panel` / `onboarding`, data/blob images & Web Audio, and Tauri IPC without allowing arbitrary remote script execution:
   ```json
   "security": {
     "csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost https://upload.wikimedia.org https://*.wikimedia.org; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost"
   }
   ```
2. In `src-tauri/src/main.rs`:
   - Replace `tray.build(app)?;` with:
     ```rust
     #[cfg(target_os = "linux")]
     if let Err(e) = tray.build(app) {
         eprintln!("[yomna] tray unavailable ({e}); continuing in CLI/hotkey mode");
     }
     #[cfg(not(target_os = "linux"))]
     tray.build(app)?;
     ```
   - Ensure `live_mode` and `live_capture` sidecar-to-voice-helper commands (around lines 1834–1868) are forwarded on **all platforms** (`#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]`), not just `macos`.
   - Remove `#[cfg(target_os = "windows")]` registry `"Roamies"` migration code if cleanly replaced by `"Yomna"` (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `"Yomna"`), and update `data_root()` to use `~/Yomna`.
   - Update window globals injected into overlay webviews: keep `window.YOMNA_LINUX` (and mirror `window.JARVIS_LINUX` temporarily only if needed, or update in sync with `task-10` — set BOTH `window.YOMNA_LINUX` and `window.JARVIS_LINUX` in Wave 1 so overlays never break before Wave 3!).
3. In `src-tauri/src/sidecar.rs`:
   - On `#[cfg(target_os = "linux")]`, configure `CommandExt::pre_exec` with `libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM)` (or track child PGID and send `SIGTERM` on drop) so killing the Tauri shell terminates the sidecar and its background harness tree cleanly.
4. Remove `showcase/tauri/src-tauri/Jarvis.entitlements` after creating `Yomna.entitlements`.
5. Run `cargo check --manifest-path showcase/tauri/src-tauri/Cargo.toml` (once Rust is installed) to verify compilation with zero errors.

### Environment Variables

- `YOMNA_DATA_DIR` — Override `~/Yomna/Data` location for testing/CI.
- `YOMNA_NODE` — Override bundled `yomna-node` binary path.
- `YOMNA_HANDS` — Path to `yomna-hands` native helper binary.
- `YOMNA_VERSION` — App version passed from Rust shell to sidecar.
- `YOMNA_TEST_AUDIO` — Debug WAV path standing in for live mic.

## Acceptance Criteria

- [ ] `tauri.conf.json` has `"productName": "Yomna"`, `"identifier": "com.aammo1.yomna"`, and a non-null strict `"csp"` policy.
- [ ] `grep -rnIiE "erictech|com\.erictech\.jarvis" showcase/tauri/src-tauri/ --exclude="linux.rs"` returns 0 matches.
- [ ] `tauri-plugin-updater` is removed from `Cargo.toml` and `main.rs` has no dead updater code.
- [ ] Linux tray creation in `main.rs` logs a warning instead of returning `Err` and crashing startup when tray/AppIndicator is unavailable.
- [ ] `live_mode` and `live_capture` messages from sidecar are forwarded to the voice helper on Linux, Windows, and macOS alike.
- [ ] `cargo check --manifest-path showcase/tauri/src-tauri/Cargo.toml` succeeds without errors.
