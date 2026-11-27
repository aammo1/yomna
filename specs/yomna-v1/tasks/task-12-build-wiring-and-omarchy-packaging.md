# Task 12: Wire `hands-linux` Build, Sync End-to-End IPC, Add Omarchy Guide, and Verify Zero Brand Leaks

## Status

complete

## Wave

4

## Description

Complete final end-to-end integration across Waves 1–3: compile and bundle the new `hands-linux` (`yomna-hands`) binary in `showcase/tauri/build.sh` and `tauri.linux.conf.json`, verify and align all IPC message types between `src-tauri/src/main.rs`, `sidekick.mjs`, `host.js`, `panel.js`, and `onboarding.js`, re-enable Linux `Control+Alt+KeyA` area-snap hotkey now that `hands-linux` exists, add a crisp Omarchy/Hyprland setup guide (`docs/omarchy-hyprland.md`), and run a full repo-wide branding, build, and sanity verification.

## Dependencies

**Depends on:** `task-03-installers-and-ci-rebrand.md`, `task-08-hands-linux-helper.md`, `task-09-sidecar-wireup-and-gg-removal.md`, `task-10-frontend-overlay-rebrand-and-rtl.md`, `task-11-panel-and-onboarding-harness-ui.md`
**Blocks:** None (final Wave 4 integration task)

**Context from dependencies:**
- `task-03` updated `build.sh`, `bundle.sh`, and CI workflows for Yomna.
- `task-08` created `showcase/tauri/src-tauri/hands-linux/` (`yomna-hands`) and enabled `hasHands`/`canSnap` on Linux in `platform.mjs`.
- `task-09`, `task-10`, and `task-11` wired the sidecar harness/MCP/TTS/Live runtime, overlay RTL & rebrand, and panel/onboarding harness UI.

## Files to Create

- `docs/omarchy-hyprland.md` — Concise Omarchy / Hyprland Wayland setup guide covering:
  - Recommended `~/.config/hypr/bindings.conf` keybinds (`yomna --talk`, `yomna --ask`, `yomna --summon`, `yomna --panel`)
  - Optional Hyprland `windowrulev2` snippet for zero-border transparent overlay & floating panel
  - Optional Wayland helper packages (`sudo pacman -S grim slurp wtype`) for `yomna-hands`
  - PipeWire mic verification note

## Files to Modify

- `showcase/tauri/build.sh` — In the `*-linux-*)` case block, compile `src-tauri/hands-linux/Cargo.toml` (`cargo build --release --locked`) and copy `yomna-hands` to `src-tauri/binaries/yomna-hands-$TRIPLE` alongside `yomna-voice-$TRIPLE`.
- `showcase/tauri/src-tauri/tauri.linux.conf.json` — Add `"binaries/yomna-hands"` to `"externalBin"` so Linux bundles (AppImage, `.deb`, `.rpm`) ship both `yomna-voice` and `yomna-hands`.
- `showcase/tauri/src-tauri/src/main.rs` — Verify `YOMNA_HANDS` env var points to `helper_binary("yomna-hands")` on Linux as well as macOS/Windows, ensure `window.YOMNA_LINUX` is injected cleanly (removing temporary `JARVIS_LINUX` alias once confirmed unused), and verify `live_mode` / `live_capture` / `pcm` / `harness_*` IPC pass-through works end-to-end.

## Technical Details

### Implementation Steps

1. Update `showcase/tauri/build.sh` Linux branch:
   ```bash
   *-linux-*)
     mkdir -p src-tauri/binaries
     cargo build --release --locked --manifest-path src-tauri/voice-win/Cargo.toml --target "$TRIPLE"
     cp "src-tauri/voice-win/target/$TRIPLE/release/yomna-voice" "src-tauri/binaries/yomna-voice-$TRIPLE"
     cargo build --release --locked --manifest-path src-tauri/hands-linux/Cargo.toml --target "$TRIPLE"
     cp "src-tauri/hands-linux/target/$TRIPLE/release/yomna-hands" "src-tauri/binaries/yomna-hands-$TRIPLE" ;;
   ```
2. Update `showcase/tauri/src-tauri/tauri.linux.conf.json`:
   ```json
   "externalBin": [
     "binaries/yomna-voice",
     "binaries/yomna-hands",
     "binaries/yomna-node"
   ]
   ```
3. Write `docs/omarchy-hyprland.md` with copy-pasteable Hyprland binds:
   ```conf
   # ~/.config/hypr/bindings.conf (Omarchy / Hyprland)
   bindd = SUPER SHIFT, Y, Yomna Talk, exec, yomna --talk
   bindd = SUPER ALT, Y, Yomna Ask, exec, yomna --ask
   bindd = SUPER CTRL, Y, Yomna Panel, exec, yomna --panel
   ```
4. Run full end-to-end verification checks:
   - Brand leak audit:
     ```bash
     grep -rnIiE "erictech|erictechpro|ericwtech|ericos|skool\.com/eric|fpr=o3gtlu|com\.erictech\.jarvis" . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=specs --exclude-dir=target
     ```
     (Must return **0 matches**.)
   - Dependency audit: confirm zero `@kenkaiiii/*` or `@anthropic-ai/*` in `showcase/tauri/sidecar/package.json`.
   - Build & check (once Rust is installed per `action-required.md`):
     ```bash
     cd showcase/tauri/sidecar && npm run build
     cd .. && ./build.sh dev
     cargo test --manifest-path src-tauri/Cargo.toml
     cargo test --release --manifest-path src-tauri/voice-win/Cargo.toml
     cargo test --release --manifest-path src-tauri/hands-linux/Cargo.toml
     src-tauri/binaries/yomna-hands-"$(rustc -vV | sed -n 's/^host: //p')" --self-test
     ```

## Acceptance Criteria

- [ ] `build.sh` compiles and copies both `yomna-voice` and `yomna-hands` on Linux, and `tauri.linux.conf.json` lists `binaries/yomna-hands` in `externalBin`.
- [ ] `docs/omarchy-hyprland.md` exists with working Hyprland keybind and package setup instructions.
- [ ] Repo-wide brand audit grep (excluding `.git`, `node_modules`, `specs`, `target`) returns **0 matches** for `erictech`, `erictechpro`, `ericwtech`, `ericos`, `skool.com/eric`, `fpr=o3gtlu`, and `com.erictech.jarvis`.
- [ ] `./showcase/tauri/build.sh dev` builds the sidecar, `yomna-voice`, `yomna-hands`, and `yomna` Tauri binary cleanly on Omarchy Linux.
- [ ] `LICENSE` (AGPL-3.0) and `THIRD_PARTY_NOTICES.md` remain intact and accurate.
