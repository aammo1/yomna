# Omarchy / Hyprland (Wayland) Setup

Yomna runs natively on Omarchy / Hyprland using XWayland for its transparent click-through overlay (`YOMNA_LINUX=wayland`) and `yomna-hands` for Hyprland window inspection, `slurp`/`grim` area selection, and `wtype`/`ydotool` input automation.

## 1. Wayland helper packages

`yomna-hands` uses `hyprctl` (built into Hyprland) plus standard Wayland utilities for area snapshots and input control. Install them on Arch / Omarchy:

```bash
sudo pacman -S grim slurp wtype
```

Optional extras:
- `ydotool` — fallback for pointer clicks/drags when `wtype` is unavailable (requires the `ydotoold` user service).
- `libsecret` — provides `secret-tool` for storing optional Gemini Live keys in your keyring.

## 2. Hyprland keybindings (`~/.config/hypr/bindings.conf`)

Wayland prevents apps from grabbing global shortcuts or reading modifier holds over other windows. Bind Yomna's CLI triggers in `~/.config/hypr/bindings.conf` (or `~/.config/hypr/hyprland.conf`) and reload Hyprland (`hyprctl reload`):

```ini
# Yomna shortcuts (adjust modifiers/keys to match your Omarchy bindings)
bindd = SUPER, Y, Talk to Yomna, exec, yomna --talk
bindd = SUPER SHIFT, Y, Ask Yomna, exec, yomna --ask
bindd = SUPER ALT, Y, Show or hide Yomna, exec, yomna --summon
bindd = SUPER CTRL, Y, Open Yomna panel, exec, yomna --panel
bindd = SUPER ALT, L, Yomna reminders list, exec, yomna --list
```

If you prefer plain Hyprland `bind` syntax instead of Omarchy's `bindd`:

```ini
bind = SUPER, Y, exec, yomna --talk
bind = SUPER SHIFT, Y, exec, yomna --ask
bind = SUPER ALT, Y, exec, yomna --summon
bind = SUPER CTRL, Y, exec, yomna --panel
```

Note: In Wayland mode, `yomna --talk` toggles recording (press once to speak, press again or pause to send).

## 3. Optional Hyprland window rules

Yomna automatically sets its desktop overlay to override-redirect on Hyprland so it floats above tiled windows without compositor interference (`YOMNA_UNMANAGED=0` disables this if needed). If your Hyprland theme adds borders, shadows, or blur to the floating Yomna panel or setup window, add optional rules to `~/.config/hypr/hyprland.conf`:

```ini
# Hyprland < 0.53 (windowrulev2)
windowrulev2 = float, class:^(com\.aammo1\.yomna|yomna)$
windowrulev2 = noborder, title:^(Yomna)$
windowrulev2 = noshadow, title:^(Yomna)$
windowrulev2 = noblur, title:^(Yomna)$
windowrulev2 = pin, title:^(Yomna)$

# Hyprland >= 0.53 (windowrule block syntax)
# windowrule {
#   name = yomna-overlay
#   match:title = ^(Yomna)$
#   float = on
#   border_size = 0
#   no_shadow = on
#   no_blur = on
#   pin = on
# }
```

## 4. PipeWire microphone verification & troubleshooting

Yomna's voice helper (`yomna-voice`) automatically prefers `default` / `pipewire` / `pulse` audio sources over raw ALSA hardware nodes so it works cleanly with PipeWire and Bluetooth headsets.

Verify your active PipeWire mic source:

```bash
pactl info | grep -E "Server Name|Default Source"
pactl list short sources
```

Verify what `yomna-voice` sees directly:

```bash
yomna-voice --perms
yomna-voice --devices
```

### Troubleshooting

- **Overlay click-through / hit regions:** Run with `YOMNA_TRACE=1 yomna` from a terminal to log GTK input-shape rectangles (`hit rects: [...]`) and unmanaged overlay transitions to `stderr`.
- **Testing voice without a mic (debug builds):** Run `YOMNA_TEST_AUDIO=/path/to/sample.wav yomna` to feed a WAV file into the speech pipeline.
- **Logs:** Check `~/Yomna/Data/logs/sidekick.log`, `~/Yomna/Data/logs/yomna.log`, and `~/Yomna/Data/logs/yomna-voice.log`, or use **Save diagnostics** in the Yomna panel.
