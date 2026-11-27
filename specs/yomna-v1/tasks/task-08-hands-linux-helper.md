# Task 08: Build `hands-linux` Native Helper for Omarchy / Hyprland & X11

## Status

complete

## Wave

2

## Description

Create the missing Linux native automation helper crate (`showcase/tauri/src-tauri/hands-linux/`, binary name `yomna-hands`) implementing the same JSON CLI contract as macOS `hands/main.swift` and Windows `hands-win`. Prioritizes **Omarchy / Hyprland Wayland** first (`hyprctl` IPC for active window & window list, `slurp` + `grim` for interactive area crop, `wtype` / `ydotool` for input automation, AT-SPI2 for focused app UI reading) with X11 (`x11rb` / `xdotool`) fallbacks and `HANDS_OFF` terminal/password-manager protection. Also enables `hasHands` and `canSnap` on Linux in `sidecar/platform.mjs`.

## Dependencies

**Depends on:** `task-02-rust-shell-rebrand-and-csp.md`, `task-04-linux-hyprland-overlay-and-voice-win.md`
**Blocks:** `task-09-sidecar-wireup-and-gg-removal.md`, `task-12-build-wiring-and-omarchy-packaging.md`

**Context from dependencies:** `task-02` rebranded `YOMNA_HANDS` env var and helper naming (`yomna-hands`); `task-04` established Omarchy/Hyprland overlay handling in `linux.rs`. This task creates the standalone `hands-linux` Rust crate and updates `platform.mjs` (`task-12` wires its compilation into `build.sh` and `tauri.linux.conf.json`).

## Files to Create

- `showcase/tauri/src-tauri/hands-linux/Cargo.toml` — Crate `name = "yomna-hands"`, `version = "1.0.0"`, dependencies: `serde`, `serde_json`, `base64`, `x11rb` (X11 fallback), `zbus` (optional AT-SPI2 / portal).
- `showcase/tauri/src-tauri/hands-linux/src/main.rs` — CLI dispatcher supporting the standard `yomna-hands` subcommands with JSON stdout:
  - `front` → `{ "app": "...", "title": "...", "pid": 123, "id": "...", "bounds": { "x", "y", "w", "h" } }`
  - `windows` → `[{ "app", "title", "id", "pid", "workspace", "focused", "bounds" }, ...]` (excluding `yomna` windows)
  - `select` → interactive region drag via `slurp` + `grim` returning `{ "ok": true, "path": "/tmp/yomna-crop-....png", "bounds": { "x", "y", "w", "h" } }`
  - `act --json '<plan>'` → executes steps (`click_at`, `double_click`, `right_click`, `type`, `key`, `scroll`, `wait`) after checking `HANDS_OFF`
  - `ui` → reads accessible controls of the active window via AT-SPI2 (graceful fallback returning `{ "controls": [], "note": "AT-SPI2 unavailable" }` if disabled)
  - `--self-test` → validates `HANDS_OFF` blocklist, Hyprland JSON parser, and `slurp` geometry parser offline (for CI!)
- `showcase/tauri/src-tauri/hands-linux/src/hyprland.rs` — Hyprland IPC client (`hyprctl activewindow -j`, `hyprctl clients -j`, `hyprctl dispatch focuswindow`) with graceful X11 EWMH fallback when `HYPRLAND_INSTANCE_SIGNATURE` is absent.
- `showcase/tauri/src-tauri/hands-linux/src/select.rs` — Interactive area capture: runs `slurp -f "%x,%y %wx%h"` → parses geometry → runs `grim -g "<geom>" <tmp.png>`, cleanly handling `Escape`/cancel (`exit 1` from `slurp` → `{ "cancelled": true }`).
- `showcase/tauri/src-tauri/hands-linux/src/act.rs` — Input execution with strict `HANDS_OFF` blocklist (refuses terminals: `alacritty`, `kitty`, `ghostty`, `foot`, `wezterm`, `gnome-terminal`, `konsole`, `xterm`; password managers: `1password`, `bitwarden`, `keepassxc`, `enpass`; and `yomna` itself!). Executes clicks/scrolls/keys via `ydotool` / `wtype` (Wayland) or `xdotool` (X11), reporting an actionable install hint if neither tool is installed.
- `showcase/tauri/src-tauri/hands-linux/src/atspi.rs` — Lightweight AT-SPI2 reader via `zbus` (`org.a11y.Bus`) to extract focused window text/buttons when accessibility bus is active.

## Files to Modify

- `showcase/tauri/sidecar/platform.mjs` — Update `hasHands(platform)` and `canSnap(platform)` to return `true` on `'linux'` when `process.env.YOMNA_HANDS` exists (keeping safe degradation when absent), and update any `JARVIS_SESSION` / `JARVIS_LAUNCH` references to `YOMNA_SESSION` / `YOMNA_LAUNCH`.

## Technical Details

### Implementation Steps

1. **Hyprland `front` & `windows` (`hyprland.rs`)**:
   - Check `std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok()`.
   - Run `hyprctl activewindow -j` → map `class` → `app`, `title` → `title`, `address` → `id`, `pid`, `at: [x, y]`, `size: [w, h]`.
   - Run `hyprctl clients -j` → filter out `mapped == false` and `class` matching `"yomna"` (case-insensitive), sort focused window first.
   - If not on Hyprland and `DISPLAY` is set, fall back to `x11rb` `_NET_ACTIVE_WINDOW` / `_NET_CLIENT_LIST_STACKING` + `_NET_WM_NAME` / `WM_CLASS`.
2. **Interactive Area Crop (`select.rs`)**:
   - Run `slurp -d -f "%x,%y %wx%h"`. If exit code is non-zero with empty stdout (user pressed Esc), print `{"cancelled":true}` and exit `0`.
   - Run `grim -g "<x>,<y> <w>x<h>" "<out_path>"` into `std::env::temp_dir().join(format!("yomna-crop-{}-{}.png", pid, ts))`.
   - Return JSON `{ "ok": true, "path": "...", "bounds": { "x": x, "y": y, "w": w, "h": h } }`.
3. **`HANDS_OFF` Protection (`act.rs`)**:
   ```rust
   pub const HANDS_OFF: &[&str] = &[
       "yomna", "alacritty", "kitty", "ghostty", "foot", "wezterm", "wezterm-gui",
       "gnome-terminal", "konsole", "xterm", "urxvt", "tilix", "terminator",
       "1password", "bitwarden", "keepassxc", "keepass", "enpass", "seahorse", "kwalletmanager",
   ];
   ```
   Before executing any `act` plan, inspect the target/front window's `app` class (lowercased); if it matches `HANDS_OFF`, immediately refuse with `{ "ok": false, "error": "Refused: cannot control terminals, password managers, or Yomna itself." }`.
4. **Wayland Input Execution (`act.rs`)**:
   - `type`: prefer `wtype -- <text>` on Wayland (`ydotool type -- <text>` fallback), `xdotool type --clearmodifiers -- <text>` on X11.
   - `key`: map normalized chords (`ctrl+c`, `return`, `escape`, `tab`, `down`, `end`, etc.) to `wtype -M ctrl -k c -m ctrl` or `xdotool key`.
   - `click_at(x, y)`: on Hyprland use `hyprctl dispatch movecursor <x> <y>` + `ydotool click 0xC0` (left) / `0xC1` (right); on X11 use `xdotool mousemove <x> <y> click 1`.
5. Verify with `cargo test --manifest-path showcase/tauri/src-tauri/hands-linux/Cargo.toml` and `yomna-hands --self-test`.

## Acceptance Criteria

- [ ] `showcase/tauri/src-tauri/hands-linux/` compiles cleanly with `cargo build --release` and passes `cargo test` + `--self-test`.
- [ ] On Hyprland, `yomna-hands front` and `yomna-hands windows` return valid JSON with accurate app class, title, and bounds, excluding Yomna windows.
- [ ] `yomna-hands select` launches `slurp` + `grim`, returning `{ "ok": true, "path": ..., "bounds": ... }` or `{ "cancelled": true }` on Escape.
- [ ] `yomna-hands act` strictly refuses every app in `HANDS_OFF` (terminals, password managers, Yomna).
- [ ] `showcase/tauri/sidecar/platform.mjs` enables `hasHands` and `canSnap` on Linux when `YOMNA_HANDS` is set, and uses `YOMNA_*` env vars.
