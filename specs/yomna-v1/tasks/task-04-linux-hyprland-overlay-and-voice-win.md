# Task 04: Fix Omarchy/Hyprland Overlay, Screenshot Leak, PipeWire Mic Filter, and voice-win Live PCM

## Status

complete

## Wave

1

## Description

Upgrade Linux desktop integration (`src-tauri/src/linux.rs`) and the shared Linux/Windows Rust voice helper (`src-tauri/voice-win/`) so Yomna feels native on Omarchy/Hyprland Wayland and unlocks **Gemini Live Mode** on both Linux and Windows. Specifically: fix Hyprland overlay tiling via `unmanaged_for()`, eliminate the 60-second leaked watchdog thread per screenshot, rebrand Linux desktop/autostart/release URLs to Yomna, filter raw ALSA `hw:` spam on PipeWire systems, and implement `live_mode` / `live_capture` 16 kHz mono PCM streaming in `voice-win`.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** `task-07-keyless-local-tts-and-live-bridge.md`, `task-08-hands-linux-helper.md`

**Context from dependencies:** None — Wave 1 foundation task. Note that `src-tauri/src/main.rs` and `src-tauri/src/voice.rs` are owned by `task-02-rust-shell-rebrand-and-csp.md` in this same wave; keep the exact JSONL command contract (`{"cmd":"live_mode","on":bool}`, `{"cmd":"live_capture","on":bool}`, stdout `{"type":"pcm","data":"<base64>"}`) so `task-02` and `task-07` plug right in.

## Files to Create

- None.

## Files to Modify

- `showcase/tauri/src-tauri/src/linux.rs` — Add `"hyprland"`, `"sway"`, and `"i3"` to `unmanaged_for()` (lines 106–112) so XWayland overlays aren't tiled/bordered on Omarchy/Hyprland; rename `JARVIS_TRACE` → `YOMNA_TRACE`, `JARVIS_UNMANAGED` → `YOMNA_UNMANAGED`, portal token `jarvis_` → `yomna_`, autostart file `yomna.desktop` (`Name=Yomna`, `Icon=yomna`), `/usr/bin/yomna`, and `open_releases_page` URL → `https://github.com/aammo1/yomna/releases/latest`; replace `within()`'s uncancellable 60s `thread::sleep` (lines 398–421) with a `Mutex`/`Condvar::wait_timeout` cancelled immediately when the screenshot finishes.
- `showcase/tauri/src-tauri/voice-win/Cargo.toml` — Rename crate `name = "yomna-voice"`, `version = "1.0.0"`, align `x11rb` version if clean, and add `base64` crate (if not already present) for 16 kHz PCM chunk encoding.
- `showcase/tauri/src-tauri/voice-win/src/audio.rs` — On Linux (`#[cfg(target_os = "linux")]`), filter `input_devices()` to exclude raw ALSA `hw:`, `plughw:`, `dsnoop:`, `iec958:`, `surround`, `front:`, `hdmi:` spam when `default` / `pipewire` / `pulse` exists, preventing `DeviceBusy` errors and clean mic dropdowns on Omarchy/PipeWire; expose a streaming callback helper that emits `16 kHz` `i16` mono PCM frames (~20–40ms / 640–1280 bytes per chunk) for Live Mode.
- `showcase/tauri/src-tauri/voice-win/src/main.rs` — Rename ONNX env `"jarvis-voice"` → `"yomna-voice"`, implement `live_mode` and `live_capture` stdin commands (currently dropped at lines 847–848) so while `live_mode && live_capture` are true, `yomna-voice` streams resampled `16 kHz` signed 16-bit little-endian mono PCM chunks as `{"type":"pcm","data":"<base64>"}` to stdout (~40ms frames) without running local Parakeet transcription on them.
- `showcase/tauri/src-tauri/voice-win/src/wake.rs` — Change default wake word name from `"Jarvis"` to `"Yomna"` (updating unit tests in `wake.rs`).
- `showcase/tauri/src-tauri/voice-win/src/ink.rs` — Rename temp path `/tmp/sidekick-marked-*.png` (line 399) → `yomna-marked-*.png`.

## Technical Details

### Implementation Steps

1. **Hyprland/Sway `unmanaged_for()` (`src-tauri/src/linux.rs:106-112`):**
   ```rust
   fn unmanaged_for(desktop: &str) -> bool {
       let d = desktop.to_ascii_lowercase();
       d.contains("cosmic") || d.contains("hyprland") || d.contains("sway") || d.contains("i3")
   }
   ```
   Still respect `YOMNA_UNMANAGED=0|1` env override.
2. **Cancelable `within()` timeout (`src-tauri/src/linux.rs:398-421`):**
   Replace the detached `thread::sleep(timeout)` with `Arc<(Mutex<bool>, Condvar)>`: when the worker completes, set `done = true` and `cvar.notify_one()` so the watchdog thread exits immediately instead of leaking for 60s on every screenshot.
3. **PipeWire-safe ALSA mic enumeration (`voice-win/src/audio.rs`):**
   - On Linux, if the device list contains `"default"`, `"pipewire"`, or `"pulse"`, filter out raw hardware ALSA entries matching prefixes `hw:`, `plughw:`, `sysdefault:`, `dsnoop:`, `dmix:`, `iec958:`, `spdif:`, `hdmi:`, `front:`, `surround`, `null`, `lavrate`, `samplerate`, `speexrate`, `upmix`, `vdownmix`, `oss`.
   - Always keep `"default"` first if present.
4. **16 kHz PCM Live Mode streaming (`voice-win/src/main.rs`):**
   - Add state fields `live_mode: bool` and `live_capture: bool`.
   - When `{"cmd":"live_mode","on":true}` arrives: pause wake-word Parakeet loop (if running) so the mic isn't contended.
   - When `{"cmd":"live_capture","on":true}` arrives while `live_mode` is true: open the selected input device (reusing `audio.rs` resampler to `16_000 Hz` mono `f32`), buffer into `640`-sample (`40ms`) `i16` LE frames (`1,280` bytes), base64-encode, and emit `{"type":"pcm","data":"..."}` on stdout; also emit periodic `{"type":"level","v":<0..1>}` RMS meter values so the overlay orb ripples while you talk.
   - When `{"cmd":"live_capture","on":false}` or `{"cmd":"live_mode","on":false}` arrives: immediately drop the `cpal::Stream` so Bluetooth headsets drop out of HFP mode and the mic indicator turns off.
5. Verify with `cargo test --locked --manifest-path showcase/tauri/src-tauri/voice-win/Cargo.toml` (once Rust is installed).

### Code Snippets

PCM frame emitter protocol (matching macOS `voice/livemic.swift` & `sidecar/live.mjs`):
```json
{"type":"pcm","data":"<base64 of 16kHz 16-bit signed LE mono PCM>"}
{"type":"level","v":0.42}
```

## Acceptance Criteria

- [ ] `linux.rs` enables override-redirect on `Hyprland`, `Sway`, `i3`, and `COSMIC` (with `YOMNA_UNMANAGED` override) and points `open_releases_page` to `https://github.com/aammo1/yomna/releases/latest`.
- [ ] `within()` in `linux.rs` wakes and joins/exits its timeout watcher immediately on completion (zero 60s leaked threads).
- [ ] `voice-win` compiles as `yomna-voice`, filters raw ALSA `hw:` spam on Linux when PipeWire/default exists, defaults wake word to `"Yomna"`, and streams `{"type":"pcm","data":"..."}` at 16 kHz mono when `live_mode` + `live_capture` are enabled.
- [ ] `grep -rnIiE "erictech|roamies|jarvis" showcase/tauri/src-tauri/src/linux.rs showcase/tauri/src-tauri/voice-win/` returns 0 matches (except any deliberate legacy cleanup comment if needed, none required).
