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

## 2. Hyprland keybindings

Wayland prevents apps from grabbing global shortcuts or reading modifier holds over other windows. Bind Yomna's CLI triggers and reload Hyprland (`hyprctl reload`).

**Omarchy Lua (`~/.config/hypr/bindings.lua`):**

```lua
-- Yomna AI desktop companion (avoids SUPER + SHIFT + Y, which Omarchy binds to YouTube)
o.bind("SUPER + Y", "Yomna Start / Pause talk", "yomna --talk")
o.bind("SUPER + ALT + Y", "Yomna Show / Hide", "yomna --summon")
o.bind("SUPER + CTRL + Y", "Yomna Settings panel", "yomna --panel")
o.bind("SUPER + CTRL + SHIFT + Y", "Yomna Stop completely", "pkill -x yomna")
```

**Classic Hyprland config (`~/.config/hypr/bindings.conf` or `~/.config/hypr/hyprland.conf`):**

```ini
# Yomna shortcuts (adjust modifiers/keys to match your setup)
bindd = SUPER, Y, Yomna Start / Pause talk, exec, yomna --talk
bindd = SUPER ALT, Y, Yomna Show / Hide, exec, yomna --summon
bindd = SUPER CTRL, Y, Yomna Settings panel, exec, yomna --panel
bindd = SUPER CTRL SHIFT, Y, Yomna Stop completely, exec, pkill -x yomna
bindd = SUPER ALT, L, Yomna reminders list, exec, yomna --list
```

If you prefer plain Hyprland `bind` syntax instead of `bindd`:

```ini
bind = SUPER, Y, exec, yomna --talk
bind = SUPER ALT, Y, exec, yomna --summon
bind = SUPER CTRL, Y, exec, yomna --panel
bind = SUPER CTRL SHIFT, Y, exec, pkill -x yomna
```

Note: In Wayland mode, `yomna --talk` starts Yomna and begins talking/Live call immediately; pressing it again pauses or hangs up.

## 3. Hyprland window rules (Prevent backdrop blur on Omarchy)

Omarchy enables Hyprland backdrop blur (`decoration.blur.enabled` and `blur.popups`) by default. Add this Lua rule to `~/.config/hypr/hyprland.lua` (and run `hyprctl reload`) so Yomna's transparent overlay never blurs your desktop:

```lua
-- ~/.config/hypr/hyprland.lua (Omarchy / Hyprland Lua)
o.window({ class = "^([Yy]omna|com\\.aammo1\\.yomna)$", title = "^Yomna$" }, {
  float = true,
  pin = true,
  decorate = false,
  border_size = 0,
  no_blur = true,
  no_shadow = true,
  no_anim = true,
})
```

For classic non-Lua Hyprland configs (`~/.config/hypr/hyprland.conf`), add:

```ini
# Hyprland < 0.53 (windowrulev2)
windowrulev2 = float, class:^(com\.aammo1\.yomna|[Yy]omna)$
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
