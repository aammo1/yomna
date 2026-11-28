//! Input automation (`act`) with strict `HANDS_OFF` protection,
//! Wayland (`wtype` / `ydotool` / `hyprctl`) and X11 (`xdotool`) execution.

use crate::atspi::{find_text_matches, press, read_window_ui, UiControl};
use crate::hyprland::{
    focus_window, front_window, is_browser, is_file_manager, is_hyprland, is_wayland, no_window, resolve, win_info,
    window_at, Win,
};
use crate::ocr::ocr_find_win;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

/// Apps Yomna may point at but NEVER type or click in: terminals, password managers, and Yomna itself.
pub fn hands_off_label(name: &str) -> Option<&'static str> {
    let raw = name.trim().to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }
    let stem = raw.rsplit('/').next().unwrap_or(&raw);
    let stem = stem
        .strip_suffix(".desktop")
        .or_else(|| stem.strip_suffix(".exe"))
        .unwrap_or(stem);
    let tail = stem.rsplit('.').next().unwrap_or(stem);

    for candidate in [stem, tail] {
        let hit = match candidate {
            "yomna" | "yomna-hands" | "yomna-voice" | "com.aammo1.yomna" => Some("Yomna"),
            "alacritty" => Some("Alacritty"),
            "kitty" => Some("kitty"),
            "ghostty" => Some("Ghostty"),
            "foot" | "footclient" => Some("foot"),
            "wezterm" | "wezterm-gui" => Some("WezTerm"),
            "gnome-terminal" | "gnome-terminal-server" | "terminal" if stem.contains("gnome") || candidate == "gnome-terminal" || candidate == "gnome-terminal-server" => {
                Some("GNOME Terminal")
            }
            "kgx" | "console" if stem == "kgx" || stem == "org.gnome.console" => Some("GNOME Console"),
            "ptyxis" => Some("Ptyxis"),
            "konsole" => Some("Konsole"),
            "xterm" | "uxterm" => Some("XTerm"),
            "urxvt" | "rxvt" | "rxvt-unicode" => Some("rxvt-unicode"),
            "tilix" => Some("Tilix"),
            "terminator" => Some("Terminator"),
            "xfce4-terminal" => Some("XFCE Terminal"),
            "mate-terminal" => Some("MATE Terminal"),
            "lxterminal" => Some("LXTerminal"),
            "sakura" => Some("sakura"),
            "hyper" => Some("Hyper"),
            "tabby" => Some("Tabby"),
            "warp" | "warp-terminal" => Some("Warp"),
            "st" => Some("st"),
            "rio" => Some("Rio"),
            "zutty" => Some("zutty"),
            "1password" => Some("1Password"),
            "bitwarden" => Some("Bitwarden"),
            "keepassxc" => Some("KeePassXC"),
            "keepass" | "keepass2" => Some("KeePass"),
            "enpass" => Some("Enpass"),
            "seahorse" => Some("Seahorse"),
            "kwalletmanager" | "kwalletmanager5" => Some("KWalletManager"),
            "proton-pass" | "protonpass" => Some("Proton Pass"),
            _ => None,
        };
        if hit.is_some() {
            return hit;
        }
    }

    // Also match compound class/app strings for multi-character terminal/password-manager names
    const COMPOUND: &[(&str, &str)] = &[
        ("com.aammo1.yomna", "Yomna"),
        ("alacritty", "Alacritty"),
        ("ghostty", "Ghostty"),
        ("wezterm", "WezTerm"),
        ("gnome-terminal", "GNOME Terminal"),
        ("konsole", "Konsole"),
        ("urxvt", "rxvt-unicode"),
        ("terminator", "Terminator"),
        ("xfce4-terminal", "XFCE Terminal"),
        ("mate-terminal", "MATE Terminal"),
        ("1password", "1Password"),
        ("bitwarden", "Bitwarden"),
        ("keepassxc", "KeePassXC"),
        ("kwalletmanager", "KWalletManager"),
    ];
    for &(needle, label) in COMPOUND {
        if stem.contains(needle) {
            return Some(label);
        }
    }
    None
}

pub fn check_win_hands_off(w: &Win) -> Option<&'static str> {
    for s in [&w.app, &w.class, &w.exe] {
        if let Some(label) = hands_off_label(s) {
            return Some(label);
        }
    }
    if w.pid != 0 {
        if let Ok(comm) = std::fs::read_to_string(format!("/proc/{}/comm", w.pid)) {
            if let Some(label) = hands_off_label(comm.trim()) {
                return Some(label);
            }
        }
        if let Ok(exe) = std::fs::read_link(format!("/proc/{}/exe", w.pid)) {
            if let Some(name) = exe.file_name().and_then(|s| s.to_str()) {
                if let Some(label) = hands_off_label(name) {
                    return Some(label);
                }
            }
        }
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mod {
    Ctrl,
    Shift,
    Alt,
    Super,
}

impl Mod {
    fn wtype_name(self) -> &'static str {
        match self {
            Mod::Ctrl => "ctrl",
            Mod::Shift => "shift",
            Mod::Alt => "alt",
            Mod::Super => "logo",
        }
    }

    fn xdotool_name(self) -> &'static str {
        match self {
            Mod::Ctrl => "ctrl",
            Mod::Shift => "shift",
            Mod::Alt => "alt",
            Mod::Super => "super",
        }
    }

    fn evdev_code(self) -> u16 {
        match self {
            Mod::Ctrl => 29,  // KEY_LEFTCTRL
            Mod::Shift => 42, // KEY_LEFTSHIFT
            Mod::Alt => 56,   // KEY_LEFTALT
            Mod::Super => 125, // KEY_LEFTMETA
        }
    }
}

/// Map normalized keysym to Linux evdev keycode for `ydotool key` (works in Wayland, XWayland, and fcitx5).
fn evdev_keycode(key: &str) -> Option<u16> {
    Some(match key {
        "Escape" => 1,
        "1" => 2,
        "2" => 3,
        "3" => 4,
        "4" => 5,
        "5" => 6,
        "6" => 7,
        "7" => 8,
        "8" => 9,
        "9" => 10,
        "0" => 11,
        "minus" | "-" => 12,
        "=" => 13,
        "BackSpace" => 14,
        "Tab" => 15,
        "q" => 16,
        "w" => 17,
        "e" => 18,
        "r" => 19,
        "t" => 20,
        "y" => 21,
        "u" => 22,
        "i" => 23,
        "o" => 24,
        "p" => 25,
        "[" => 26,
        "]" => 27,
        "Return" => 28,
        "a" => 30,
        "s" => 31,
        "d" => 32,
        "f" => 33,
        "g" => 34,
        "h" => 35,
        "j" => 36,
        "k" => 37,
        "l" => 38,
        ";" => 39,
        "'" => 40,
        "`" => 41,
        "\\" => 43,
        "z" => 44,
        "x" => 45,
        "c" => 46,
        "v" => 47,
        "b" => 48,
        "n" => 49,
        "m" => 50,
        "," => 51,
        "." => 52,
        "/" => 53,
        "space" => 57,
        "F1" => 59,
        "F2" => 60,
        "F3" => 61,
        "F4" => 62,
        "F5" => 63,
        "F6" => 64,
        "F7" => 65,
        "F8" => 66,
        "F9" => 67,
        "F10" => 68,
        "F11" => 87,
        "F12" => 88,
        "Home" => 102,
        "Up" => 103,
        "Page_Up" => 104,
        "Left" => 105,
        "Right" => 106,
        "End" => 107,
        "Down" => 108,
        "Page_Down" => 109,
        "Insert" => 110,
        "Delete" => 111,
        _ => return None,
    })
}

fn ydotool_available() -> bool {
    if !has_cmd("ydotool") {
        return false;
    }
    if let Ok(sock) = std::env::var("YDOTOOL_SOCKET") {
        if std::path::Path::new(&sock).exists() {
            return true;
        }
    }
    if let Ok(rt) = std::env::var("XDG_RUNTIME_DIR") {
        if std::path::Path::new(&format!("{rt}/.ydotool_socket")).exists() {
            return true;
        }
    }
    std::path::Path::new("/tmp/.ydotool_socket").exists()
}

pub fn parse_key_combo(combo: &str) -> Result<(Vec<Mod>, String), String> {
    let raw = combo.trim();
    if raw.is_empty() {
        return Err("empty key".to_string());
    }
    let parts: Vec<&str> = raw.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(format!("unknown key {combo}"));
    }

    let mut mods = Vec::new();
    for &p in &parts[..parts.len() - 1] {
        let m = match p.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "ctl" | "cmd" | "command" => Mod::Ctrl,
            "shift" => Mod::Shift,
            "alt" | "option" | "opt" => Mod::Alt,
            "super" | "win" | "meta" | "logo" => Mod::Super,
            other => return Err(format!("unknown modifier {other} in {combo}")),
        };
        if !mods.contains(&m) {
            mods.push(m);
        }
    }

    let key_raw = parts[parts.len() - 1];
    let key = map_keysym(key_raw).ok_or_else(|| format!("unknown key {combo}"))?;
    Ok((mods, key))
}

fn map_keysym(k: &str) -> Option<String> {
    let kl = k.trim().to_ascii_lowercase();
    let named = match kl.as_str() {
        "return" | "enter" => "Return",
        "esc" | "escape" => "Escape",
        "tab" => "Tab",
        "space" => "space",
        "backspace" | "bksp" => "BackSpace",
        "del" | "delete" => "Delete",
        "insert" | "ins" => "Insert",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "home" => "Home",
        "end" => "End",
        "pageup" | "pgup" | "page_up" => "Page_Up",
        "pagedown" | "pgdn" | "page_down" => "Page_Down",
        "f1" => "F1",
        "f2" => "F2",
        "f3" => "F3",
        "f4" => "F4",
        "f5" => "F5",
        "f6" => "F6",
        "f7" => "F7",
        "f8" => "F8",
        "f9" => "F9",
        "f10" => "F10",
        "f11" => "F11",
        "f12" => "F12",
        "plus" => "plus",
        "minus" => "minus",
        _ => "",
    };
    if !named.is_empty() {
        return Some(named.to_string());
    }
    let mut chars = k.trim().chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_graphic() {
            return Some(c.to_ascii_lowercase().to_string());
        }
    }
    None
}

pub fn risky(label: &str) -> bool {
    let l = label.to_ascii_lowercase();
    const WORDS: &[&str] = &[
        "delete",
        "remove",
        "trash",
        "erase",
        "destroy",
        "pay",
        "buy",
        "purchase",
        "checkout",
        "place order",
        "submit payment",
        "send",
        "post",
        "publish",
        "reply",
        "sign out",
        "log out",
        "logout",
        "disconnect",
        "revoke",
        "transfer",
    ];
    WORDS.iter().any(|w| {
        l.split(|c: char| !c.is_ascii_alphanumeric() && c != ' ')
            .any(|seg| seg.trim() == *w || seg.split_whitespace().any(|tok| tok == *w))
            || (w.contains(' ') && l.contains(w))
    })
}

fn has_cmd(name: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_var).any(|dir| {
        let p: PathBuf = dir.join(name);
        p.is_file()
    })
}

fn wayland_session() -> bool {
    is_wayland() || is_hyprland()
}

fn progress(v: Value) {
    let mut e = std::io::stderr().lock();
    let _ = writeln!(e, "@{v}");
    let _ = e.flush();
}

fn move_pointer(x: i32, y: i32) -> Result<(), String> {
    if wayland_session() {
        if is_hyprland() {
            let (xs, ys) = (x.to_string(), y.to_string());
            if crate::hyprland::hypr_dispatch(&format!("hl.dsp.cursor.move({{ x = {x}, y = {y} }})"), &["movecursor", &xs, &ys]).is_ok() {
                sleep(Duration::from_millis(30));
                return Ok(());
            }
        }
        if has_cmd("ydotool") {
            let out = Command::new("ydotool")
                .args(["mousemove", "--absolute", "-x", &x.to_string(), "-y", &y.to_string()])
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("failed to run ydotool: {e}"))?;
            if !out.status.success() {
                return Err(format!("ydotool mousemove failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            sleep(Duration::from_millis(30));
            return Ok(());
        }
        return Err(
            "Pointer movement on Wayland requires ydotool (install ydotool and start ydotoold) or Hyprland.".to_string(),
        );
    }

    if !has_cmd("xdotool") {
        return Err("Input automation on X11 requires xdotool (install xdotool).".to_string());
    }
    let out = Command::new("xdotool")
        .args(["mousemove", "--sync", &x.to_string(), &y.to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run xdotool: {e}"))?;
    if !out.status.success() {
        return Err(format!("xdotool mousemove failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    sleep(Duration::from_millis(30));
    Ok(())
}

#[derive(Clone, Copy)]
enum ClickKind {
    Left,
    DoubleLeft,
    Right,
}

fn do_click(x: i32, y: i32, kind: ClickKind) -> Result<(), String> {
    if wayland_session() {
        if !has_cmd("ydotool") {
            return Err(
                "Pointer clicks on Wayland require ydotool (install ydotool and start ydotoold, or run under X11 with xdotool)."
                    .to_string(),
            );
        }
        move_pointer(x, y)?;
        let args: &[&str] = match kind {
            ClickKind::Left => &["click", "0xC0"],
            ClickKind::DoubleLeft => &["click", "-r", "2", "-D", "25", "0xC0"],
            ClickKind::Right => &["click", "0xC1"],
        };
        let out = Command::new("ydotool")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("failed to run ydotool click: {e}"))?;
        if !out.status.success() {
            return Err(format!("ydotool click failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        sleep(Duration::from_millis(50));
        return Ok(());
    }

    if !has_cmd("xdotool") {
        return Err("Pointer clicks on X11 require xdotool (install xdotool).".to_string());
    }
    move_pointer(x, y)?;
    let mut cmd = Command::new("xdotool");
    cmd.arg("click");
    match kind {
        ClickKind::Left => {
            cmd.arg("1");
        }
        ClickKind::DoubleLeft => {
            cmd.args(["--repeat", "2", "--delay", "50", "1"]);
        }
        ClickKind::Right => {
            cmd.arg("3");
        }
    }
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run xdotool click: {e}"))?;
    if !out.status.success() {
        return Err(format!("xdotool click failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    sleep(Duration::from_millis(50));
    Ok(())
}

fn do_scroll(x: i32, y: i32, dir: &str, amount: i32) -> Result<(), String> {
    let steps = amount.clamp(1, 30);
    if wayland_session() {
        if !has_cmd("ydotool") {
            return Err(
                "Scrolling on Wayland requires ydotool (install ydotool and start ydotoold).".to_string(),
            );
        }
        move_pointer(x, y)?;
        let (dx, dy) = match dir {
            "up" => (0, steps),
            "left" => (-steps, 0),
            "right" => (steps, 0),
            _ => (0, -steps),
        };
        let out = Command::new("ydotool")
            .args(["mousemove", "-w", "--", "-x", &dx.to_string(), "-y", &dy.to_string()])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("failed to run ydotool scroll: {e}"))?;
        if !out.status.success() {
            return Err(format!("ydotool scroll failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        sleep(Duration::from_millis(80));
        return Ok(());
    }

    if !has_cmd("xdotool") {
        return Err("Scrolling on X11 requires xdotool (install xdotool).".to_string());
    }
    move_pointer(x, y)?;
    let button = match dir {
        "up" => "4",
        "left" => "6",
        "right" => "7",
        _ => "5",
    };
    let out = Command::new("xdotool")
        .args(["click", "--repeat", &steps.to_string(), "--delay", "25", button])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run xdotool scroll: {e}"))?;
    if !out.status.success() {
        return Err(format!("xdotool scroll failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    sleep(Duration::from_millis(80));
    Ok(())
}

fn ydotool_key(mods: &[Mod], code: u16) -> Result<(), String> {
    let mut args: Vec<String> = vec!["key".to_string(), "-d".to_string(), "15".to_string()];
    for m in mods {
        args.push(format!("{}:1", m.evdev_code()));
    }
    args.push(format!("{code}:1"));
    args.push(format!("{code}:0"));
    for m in mods.iter().rev() {
        args.push(format!("{}:0", m.evdev_code()));
    }
    let out = Command::new("ydotool")
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run ydotool key: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ydotool key failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    sleep(Duration::from_millis(50));
    Ok(())
}

fn paste_via_clipboard(text: &str) -> Result<(), String> {
    if !has_cmd("wl-copy") || !ydotool_available() {
        return Err("clipboard paste unavailable".to_string());
    }
    let mut child = Command::new("wl-copy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn wl-copy: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| format!("wl-copy wait failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("wl-copy failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    sleep(Duration::from_millis(40));
    // Ctrl+V via evdev (29 = Ctrl, 47 = V)
    ydotool_key(&[Mod::Ctrl], 47)?;
    sleep(Duration::from_millis(40));
    Ok(())
}

fn do_type(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    if wayland_session() {
        let ascii_only = text.bytes().all(|b| matches!(b, b'\n' | b'\t' | 0x20..=0x7E));
        // Prefer ydotool (kernel uinput) for ASCII: works reliably in Chrome, Electron, XWayland, GTK4, Qt, and with
        // fcitx5 active, whereas wtype's virtual-keyboard protocol is ignored by XWayland and conflicts with fcitx5.
        if ascii_only && ydotool_available() {
            let out = Command::new("ydotool")
                .args(["type", "-e", "0", "-d", "15", "-H", "15", "--", text])
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("failed to run ydotool type: {e}"))?;
            if out.status.success() {
                sleep(Duration::from_millis(50));
                return Ok(());
            }
        }
        // Non-ASCII text (Arabic, accented letters, emoji): paste via wl-copy + Ctrl+V when ydotoold is running.
        if !ascii_only && paste_via_clipboard(text).is_ok() {
            return Ok(());
        }
        if has_cmd("wtype") {
            let mut child = Command::new("wtype")
                .args(["-d", "6", "-"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("failed to spawn wtype: {e}"))?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let out = child.wait_with_output().map_err(|e| format!("wtype wait failed: {e}"))?;
            if !out.status.success() {
                return Err(format!("wtype failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            sleep(Duration::from_millis(40));
            return Ok(());
        }
        if has_cmd("ydotool") {
            let out = Command::new("ydotool")
                .args(["type", "--key-delay", "8", "--", text])
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("failed to run ydotool type: {e}"))?;
            if !out.status.success() {
                return Err(format!("ydotool type failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            sleep(Duration::from_millis(40));
            return Ok(());
        }
        return Err("Keyboard typing on Wayland requires ydotool or wtype.".to_string());
    }

    if !has_cmd("xdotool") {
        return Err("Keyboard typing on X11 requires xdotool (install xdotool).".to_string());
    }
    let mut child = Command::new("xdotool")
        .args(["type", "--clearmodifiers", "--delay", "6", "--file", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn xdotool: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| format!("xdotool type wait failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("xdotool type failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    sleep(Duration::from_millis(40));
    Ok(())
}

fn do_key(combo: &str) -> Result<(), String> {
    let (mods, key) = parse_key_combo(combo)?;
    if wayland_session() {
        if ydotool_available() {
            if let Some(code) = evdev_keycode(&key) {
                if ydotool_key(&mods, code).is_ok() {
                    return Ok(());
                }
            }
        }
        if has_cmd("wtype") {
            let mut args: Vec<String> = Vec::new();
            for m in &mods {
                args.push("-M".to_string());
                args.push(m.wtype_name().to_string());
            }
            args.push("-k".to_string());
            args.push(key);
            for m in mods.iter().rev() {
                args.push("-m".to_string());
                args.push(m.wtype_name().to_string());
            }
            let out = Command::new("wtype")
                .args(&args)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("failed to run wtype: {e}"))?;
            if !out.status.success() {
                return Err(format!("wtype key failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            sleep(Duration::from_millis(50));
            return Ok(());
        }
        return Err("Key press on Wayland requires ydotool or wtype.".to_string());
    }

    if !has_cmd("xdotool") {
        return Err("Key press on X11 requires xdotool (install xdotool).".to_string());
    }
    let mut combo_parts: Vec<String> = mods.iter().map(|m| m.xdotool_name().to_string()).collect();
    combo_parts.push(key);
    let xdo_combo = combo_parts.join("+");
    let out = Command::new("xdotool")
        .args(["key", "--clearmodifiers", &xdo_combo])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run xdotool key: {e}"))?;
    if !out.status.success() {
        return Err(format!("xdotool key failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    sleep(Duration::from_millis(50));
    Ok(())
}

fn s_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn resolve_plan_target(plan: &Value) -> String {
    if let Some(id_val) = plan.get("window") {
        if let Some(s) = id_val.as_str() {
            return if s.starts_with("window:") {
                s.to_string()
            } else {
                format!("window:{s}")
            };
        }
        if let Some(n) = id_val.as_u64() {
            return format!("window:{n}");
        }
        if let Some(n) = id_val.as_i64() {
            return format!("window:{n}");
        }
    }
    if let Some(app) = s_str(plan, "app") {
        return format!("app:{app}");
    }
    "front".to_string()
}

fn find_control<'a>(controls: &'a [UiControl], s: &Value) -> Option<&'a UiControl> {
    if let Some(id) = s.get("id").and_then(Value::as_i64) {
        if id >= 1 {
            if let Some(c) = controls.get(id as usize - 1) {
                return Some(c);
            }
        }
    }
    let name = s_str(s, "field").or_else(|| s_str(s, "text")).unwrap_or("").trim();
    if let Ok(id) = name.parse::<usize>() {
        if id >= 1 {
            if let Some(c) = controls.get(id - 1) {
                return Some(c);
            }
        }
    }
    if name.is_empty() {
        return None;
    }
    let nl = name.to_ascii_lowercase();
    controls
        .iter()
        .find(|c| c.label.to_ascii_lowercase() == nl)
        .or_else(|| controls.iter().find(|c| c.label.to_ascii_lowercase().contains(&nl)))
        .or_else(|| controls.iter().find(|c| !c.value.is_empty() && c.value.to_ascii_lowercase().contains(&nl)))
}

fn is_input_role(role: &str) -> bool {
    matches!(role, "text field" | "combo box" | "password field")
}

fn is_url_bar_field(field_low: &str) -> bool {
    ["url", "address", "omnibox", "location bar", "search or type", "type a url", "web address"]
        .iter()
        .any(|k| field_low.contains(k))
}

fn find_text_field<'a>(controls: &'a [UiControl], s: &Value) -> Option<&'a UiControl> {
    if let Some(id) = s.get("id").and_then(Value::as_i64) {
        if id >= 1 {
            if let Some(c) = controls.get(id as usize - 1) {
                return Some(c);
            }
        }
    }
    let name = s_str(s, "field").or_else(|| s_str(s, "text")).unwrap_or("").trim();
    if let Ok(id) = name.parse::<usize>() {
        if id >= 1 {
            if let Some(c) = controls.get(id - 1) {
                return Some(c);
            }
        }
    }
    let inputs: Vec<&UiControl> = controls
        .iter()
        .filter(|c| is_input_role(&c.role) && ((!c.offscreen && !c.bounds.is_empty()) || c.focused))
        .collect();
    if inputs.is_empty() {
        return None;
    }
    // Prefer inputs with valid screen bounds first, then fall back to already-focused inputs whose
    // AT-SPI bounds are transiently [0, 0, 0, 0] right after page load (Zen/Firefox).
    let match_in = |pool: &[&'a UiControl]| -> Option<&'a UiControl> {
        let nl = name.to_ascii_lowercase();
        if !nl.is_empty() {
            if let Some(c) = pool.iter().find(|c| c.label.to_ascii_lowercase() == nl) {
                return Some(*c);
            }
            if let Some(c) = pool.iter().find(|c| c.label.to_ascii_lowercase().contains(&nl)) {
                return Some(*c);
            }
            if let Some(c) = pool
                .iter()
                .find(|c| !c.value.is_empty() && c.value.to_ascii_lowercase().contains(&nl))
            {
                return Some(*c);
            }
            const STOP: &[&str] = &["the", "and", "for", "with", "type", "bar", "box", "field", "input", "here"];
            let tokens: Vec<&str> = nl
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|t| t.len() >= 3 && !STOP.contains(t))
                .collect();
            if !tokens.is_empty() {
                if let Some(c) = pool.iter().find(|c| {
                    let cl = c.label.to_ascii_lowercase();
                    tokens.iter().any(|t| cl.contains(t))
                }) {
                    return Some(*c);
                }
            }
        }
        if pool.len() == 1
            && (nl.is_empty()
                || ["search", "query", "input", "text", "box", "field", "address", "url", "message"]
                    .iter()
                    .any(|w| nl.contains(w)))
        {
            return Some(pool[0]);
        }
        None
    };
    let bounded: Vec<&UiControl> = inputs.iter().copied().filter(|c| !c.bounds.is_empty()).collect();
    if let Some(c) = match_in(&bounded) {
        return Some(c);
    }
    let focused_only: Vec<&UiControl> = inputs.iter().copied().filter(|c| c.bounds.is_empty() && c.focused).collect();
    match_in(&focused_only)
}

fn is_file_entry_click(w: &Win, texts: &[String], label: &str, gx: i32, gy: i32) -> bool {
    if !is_file_manager(&w.app, &w.class, &w.exe) {
        return false;
    }
    // Header/toolbar at top or status bar at bottom: single-click buttons, never double-click.
    if gy < w.bounds.y + 52 || gy > w.bounds.y + w.bounds.h - 46 {
        return false;
    }
    let ll = label.trim().to_ascii_lowercase();
    if !ll.is_empty()
        && texts.iter().any(|t| {
            let tl = t.trim().to_ascii_lowercase();
            tl == format!("{ll}. folder") || tl == format!("{ll}. file")
        })
    {
        return true;
    }
    // Main file pane (right of a typical 200px sidebar, or anywhere when sidebar is collapsed)
    gx >= w.bounds.x + 12
}

fn point_inside_non_input_control(controls: &[UiControl], gx: i32, gy: i32) -> bool {
    controls.iter().any(|c| {
        !c.offscreen
            && !c.bounds.is_empty()
            && matches!(c.role.as_str(), "link" | "button" | "menu item" | "tab")
            && c.bounds.contains(gx, gy)
    })
}

fn coords_for_step(s: &Value, w: &Win, controls: &[UiControl]) -> Option<(i32, i32)> {
    if let (Some(x), Some(y)) = (
        s.get("x").and_then(Value::as_f64),
        s.get("y").and_then(Value::as_f64),
    ) {
        let global = s.get("global").and_then(Value::as_bool) == Some(true);
        let gx = if global { x.round() as i32 } else { w.bounds.x + x.round() as i32 };
        let gy = if global { y.round() as i32 } else { w.bounds.y + y.round() as i32 };
        return Some((gx, gy));
    }
    if let Some(c) = find_control(controls, s) {
        if !c.bounds.is_empty() {
            return Some((c.bounds.mid_x(), c.bounds.mid_y()));
        }
    }
    None
}

fn verify_spot_safe(gx: i32, gy: i32) -> Result<(), String> {
    if let Some(u) = window_at(gx, gy) {
        if let Some(name) = check_win_hands_off(&u) {
            return Err(format!(
                "Blocked for safety: that spot is on {name}, and I never click in it."
            ));
        }
    }
    Ok(())
}

fn verify_front_safe() -> Result<(), String> {
    if let Some(fw) = front_window() {
        if let Some(name) = check_win_hands_off(&fw) {
            return Err(format!(
                "Blocked for safety: {name} came to the front, and I never type or click in it."
            ));
        }
    }
    Ok(())
}

pub fn run_act(arg: &str) -> Result<Value, Value> {
    let plan: Value = serde_json::from_str(arg)
        .map_err(|e| json!({ "ok": false, "error": format!("bad plan: {e}"), "done": [] }))?;
    let Some(steps) = plan.get("steps").and_then(Value::as_array).cloned() else {
        return Err(json!({ "ok": false, "error": "bad plan: missing steps", "done": [] }));
    };

    let target = resolve_plan_target(&plan);
    let mut w = resolve(&target)
        .ok_or_else(|| json!({ "ok": false, "error": no_window(&target), "done": [] }))?;

    if let Some(name) = check_win_hands_off(&w) {
        return Err(json!({
            "ok": false,
            "error": format!("Blocked for safety: I can point at things in {name}, but I never type or click in it. Show the user where to click instead."),
            "done": []
        }));
    }

    let mut done: Vec<String> = Vec::new();
    let mut borrowed = false;
    progress(json!({ "ev": "start", "window": win_info(&w), "steps": steps.len() }));

    // Focus before reading UI so tiling/scrolling WMs (Hyprland) bring the window on-screen
    // before we cache control coordinates.
    if !w.focused && steps.iter().any(|s| s_str(s, "do") != Some("wait")) {
        progress(json!({ "ev": "borrow" }));
        borrowed = true;
        if let Err(e) = focus_window(&w) {
            progress(json!({ "ev": "return" }));
            return Err(json!({ "ok": false, "error": e, "done": done }));
        }
        if let Some(nw) = resolve(&target) {
            w = nw;
        }
    }

    let mut ui = read_window_ui(&w);

    let mut ensure_focus = || -> Result<(), String> {
        if !borrowed {
            progress(json!({ "ev": "borrow" }));
            borrowed = true;
        }
        if !w.focused {
            focus_window(&w)?;
        }
        verify_front_safe()
    };

    for (i, s) in steps.iter().enumerate() {
        let n = i + 1;
        let what = s_str(s, "do").unwrap_or("");
        let confirmed = s.get("confirmed").and_then(Value::as_bool) == Some(true);

        if what != "wait" {
            if let Err(e) = verify_front_safe() {
                if borrowed {
                    progress(json!({ "ev": "return" }));
                }
                return Err(json!({ "ok": false, "error": e, "done": done }));
            }
        }

        let step_res: Result<(), String> = (|| {
            match what {
                "click_at" | "double_click" | "right_click" => {
                    let kind = match what {
                        "double_click" => ClickKind::DoubleLeft,
                        "right_click" => ClickKind::Right,
                        _ => ClickKind::Left,
                    };
                    let mut spot = coords_for_step(s, &w, &ui.controls);
                    if spot.is_none() {
                        if let Some(q) = s_str(s, "text").map(str::trim).filter(|q| !q.is_empty()) {
                            let matches = find_text_matches(&w, q);
                            if let Some(m) = matches.first() {
                                if let Some(b) = m["bounds"].as_array() {
                                    let (x, y, bw, bh) = (
                                        b.first().and_then(Value::as_i64).unwrap_or(0) as i32,
                                        b.get(1).and_then(Value::as_i64).unwrap_or(0) as i32,
                                        b.get(2).and_then(Value::as_i64).unwrap_or(0) as i32,
                                        b.get(3).and_then(Value::as_i64).unwrap_or(0) as i32,
                                    );
                                    if bw > 0 && bh > 0 {
                                        spot = Some((x + bw / 2, y + bh / 2));
                                    }
                                }
                            }
                            if spot.is_none() {
                                ensure_focus()?;
                                sleep(Duration::from_millis(60));
                                if let Some(hit) = ocr_find_win(&w, q, false).first() {
                                    spot = Some((hit.bounds.mid_x(), hit.bounds.mid_y()));
                                }
                            }
                        }
                    }
                    let (gx, gy) = spot.ok_or_else(|| format!("Step {n}: {what} needs x and y (or visible text)"))?;
                    verify_spot_safe(gx, gy)?;
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": what, "bounds": [gx - 6, gy - 6, 12, 12] }));
                    do_click(gx, gy, kind)?;
                    done.push(format!("{what} at {gx},{gy}"));
                }
                "click" | "press_button" | "focus" => {
                    let c = find_control(&ui.controls, s).ok_or_else(|| {
                        format!(
                            "Step {n}: no control with id {}. Call read_window again.",
                            s.get("id").map_or("?".into(), |v| v.to_string())
                        )
                    })?;
                    if (what == "click" || what == "press_button") && risky(&c.label) && !confirmed {
                        return Err(format!(
                            "Stopped before clicking \"{}\": it could delete, pay, send or sign out, and the user hasn't said yes to that. Tell them, and let them click it themselves.",
                            c.label
                        ));
                    }
                    if c.bounds.is_empty() {
                        return Err(format!("Step {n}: control \"{}\" has no screen bounds.", c.label));
                    }
                    let (gx, gy) = (c.bounds.mid_x(), c.bounds.mid_y());
                    verify_spot_safe(gx, gy)?;
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": what, "label": c.label, "bounds": c.bounds.to_arr() }));
                    // Real pointer click is far more reliable than AT-SPI DoAction on Wayland/GTK4/Gecko
                    // (many web/GTK buttons return true from DoAction without firing real click events).
                    if do_click(gx, gy, ClickKind::Left).is_err() && what != "focus" {
                        if !press(c) {
                            return Err(format!("Step {n}: couldn't click \"{}\".", c.label));
                        }
                    }
                    done.push(format!("{what} {}", if c.label.is_empty() { format!("control {}", c.id) } else { c.label.clone() }));
                }
                "click_text" => {
                    let q = s_str(s, "text").unwrap_or("").trim();
                    if q.is_empty() {
                        return Err(format!("Step {n}: no visible text \"\" in {}.", w.app));
                    }
                    let matches = find_text_matches(&w, q);
                    if let Some(m) = matches.first() {
                        let text = m["text"].as_str().unwrap_or(q);
                        if risky(text) && !confirmed {
                            return Err(format!(
                                "Stopped before clicking \"{text}\": it could delete, pay, send or sign out, and the user hasn't said yes to that. Tell them, and let them click it themselves."
                            ));
                        }
                        let b = m["bounds"].as_array().ok_or_else(|| format!("Step {n}: no visible text \"{q}\" in {}.", w.app))?;
                        let (x, y, bw, bh) = (
                            b.first().and_then(Value::as_i64).unwrap_or(0) as i32,
                            b.get(1).and_then(Value::as_i64).unwrap_or(0) as i32,
                            b.get(2).and_then(Value::as_i64).unwrap_or(0) as i32,
                            b.get(3).and_then(Value::as_i64).unwrap_or(0) as i32,
                        );
                        if bw <= 0 || bh <= 0 {
                            return Err(format!("Step {n}: couldn't click \"{q}\"."));
                        }
                        let (gx, gy) = (x + bw / 2, y + bh / 2);
                        verify_spot_safe(gx, gy)?;
                        ensure_focus()?;
                        progress(json!({ "ev": "step", "i": i, "do": "click_text", "label": text, "bounds": [x, y, bw, bh] }));
                        let id = m["id"].as_u64().unwrap_or(0) as usize;
                        let double_entry = is_file_entry_click(&w, &ui.texts, text, gx, gy);
                        let click_kind = if double_entry { ClickKind::DoubleLeft } else { ClickKind::Left };
                        if do_click(gx, gy, click_kind).is_err() {
                            let pressed = !double_entry
                                && ui
                                    .controls
                                    .iter()
                                    .find(|c| c.id == id && !matches!(c.role.as_str(), "text field" | "combo box") && (c.label == text || c.value == text))
                                    .is_some_and(press);
                            if !pressed {
                                return Err(format!("Step {n}: couldn't click \"{text}\"."));
                            }
                        }
                        done.push(format!("clicked \"{text}\""));
                    } else {
                        // OCR fallback (Tesseract on grim capture): ensure the window is focused and visible first.
                        ensure_focus()?;
                        sleep(Duration::from_millis(60));
                        let ocr_hits = ocr_find_win(&w, q, false);
                        let Some(hit) = ocr_hits.first() else {
                            return Err(format!(
                                "Step {n}: no visible text \"{q}\" in {}. Check the exact words with a screenshot or read_window.",
                                w.app
                            ));
                        };
                        if risky(&hit.text) && !confirmed {
                            return Err(format!(
                                "Stopped before clicking \"{}\": it could delete, pay, send or sign out, and the user hasn't said yes to that. Tell them, and let them click it themselves.",
                                hit.text
                            ));
                        }
                        let (gx, gy) = (hit.bounds.mid_x(), hit.bounds.mid_y());
                        verify_spot_safe(gx, gy)?;
                        let double_entry = is_file_entry_click(&w, &ui.texts, &hit.text, gx, gy);
                        progress(json!({ "ev": "step", "i": i, "do": "click_text", "label": hit.text, "bounds": hit.bounds.to_arr() }));
                        do_click(gx, gy, if double_entry { ClickKind::DoubleLeft } else { ClickKind::Left })?;
                        done.push(format!("clicked \"{}\"", hit.text));
                    }
                }
                "type" => {
                    let text = s_str(s, "text").unwrap_or("");
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": "type", "text": text.chars().take(80).collect::<String>() }));
                    do_type(text)?;
                    done.push("typed text".to_string());
                }
                "fill" | "set" => {
                    let text = s_str(s, "text").unwrap_or("");
                    let field_name = s_str(s, "field").unwrap_or("").trim();
                    let field_low = field_name.to_ascii_lowercase();
                    // Browser address bar: Ctrl+L reliably focuses and selects the entire URL bar across Chrome,
                    // Chromium, Zen, and Firefox even when autocomplete popups are open or AT-SPI lags.
                    if is_browser(&w.app, &w.class, &w.exe) && is_url_bar_field(&field_low) {
                        ensure_focus()?;
                        progress(json!({ "ev": "step", "i": i, "do": what, "label": field_name }));
                        do_key("ctrl+l")?;
                        sleep(Duration::from_millis(180));
                        let _ = do_key("ctrl+a");
                        sleep(Duration::from_millis(40));
                        let _ = do_key("BackSpace");
                        sleep(Duration::from_millis(40));
                        do_type(text)?;
                        done.push(format!("{field_name} = \"{}\"", text.chars().take(40).collect::<String>()));
                    } else {
                    let mut matched_field = find_text_field(&ui.controls, s).cloned();
                    // Browsers (Zen/Firefox/Chrome) populate their document-web AT-SPI subtree ~200-350 ms after
                    // focus/a11y activation; retry once before falling back to OCR.
                    if matched_field.is_none() && (is_browser(&w.app, &w.class, &w.exe) || ui.controls.len() < 5) {
                        ensure_focus()?;
                        sleep(Duration::from_millis(350));
                        ui = read_window_ui(&w);
                        matched_field = find_text_field(&ui.controls, s).cloned();
                    }
                    if let Some(mut c) = matched_field {
                        if c.bounds.is_empty() && c.focused {
                            // Zen/Firefox can transiently report [0,0,0,0] right after page load for an already-focused field.
                            sleep(Duration::from_millis(120));
                            let fresh = read_window_ui(&w);
                            if let Some(fc) = find_text_field(&fresh.controls, s) {
                                if !fc.bounds.is_empty() {
                                    c = fc.clone();
                                }
                            }
                        }
                        ensure_focus()?;
                        if !c.bounds.is_empty() {
                            let (gx, gy) = (c.bounds.mid_x(), c.bounds.mid_y());
                            verify_spot_safe(gx, gy)?;
                            progress(json!({ "ev": "step", "i": i, "do": what, "label": c.label, "bounds": c.bounds.to_arr() }));
                            do_click(gx, gy, ClickKind::Left)?;
                            sleep(Duration::from_millis(100));
                        } else if c.focused {
                            progress(json!({ "ev": "step", "i": i, "do": what, "label": c.label }));
                        } else {
                            return Err(format!("Step {n}: field \"{}\" has no screen bounds.", c.label));
                        }
                        let _ = do_key("ctrl+a");
                        sleep(Duration::from_millis(40));
                        let _ = do_key("BackSpace");
                        sleep(Duration::from_millis(40));
                        do_type(text)?;
                        done.push(format!("{} = \"{}\"", c.label, text.chars().take(40).collect::<String>()));
                    } else if !field_name.is_empty() {
                        // OCR fallback for web/Electron/GTK4 fields, ignoring hits inside non-input links/buttons (e.g. "How Search works").
                        ensure_focus()?;
                        sleep(Duration::from_millis(60));
                        let ocr_hits = ocr_find_win(&w, field_name, true);
                        let safe_hit = ocr_hits
                            .iter()
                            .find(|h| !point_inside_non_input_control(&ui.controls, h.bounds.mid_x(), h.bounds.mid_y()));
                        if let Some(hit) = safe_hit {
                            let (gx, gy) = (hit.bounds.mid_x(), hit.bounds.mid_y());
                            verify_spot_safe(gx, gy)?;
                            progress(json!({ "ev": "step", "i": i, "do": what, "label": hit.text, "bounds": hit.bounds.to_arr() }));
                            do_click(gx, gy, ClickKind::Left)?;
                            sleep(Duration::from_millis(100));
                            let _ = do_key("ctrl+a");
                            sleep(Duration::from_millis(40));
                            let _ = do_key("BackSpace");
                            sleep(Duration::from_millis(40));
                            do_type(text)?;
                            done.push(format!("{} = \"{}\"", hit.text, text.chars().take(40).collect::<String>()));
                        } else if let Some(fc) = ui.controls.iter().find(|c| c.focused && is_input_role(&c.role)) {
                            progress(json!({ "ev": "step", "i": i, "do": what, "label": fc.label }));
                            let _ = do_key("ctrl+a");
                            sleep(Duration::from_millis(40));
                            let _ = do_key("BackSpace");
                            sleep(Duration::from_millis(40));
                            do_type(text)?;
                            done.push(format!("{} = \"{}\"", fc.label, text.chars().take(40).collect::<String>()));
                        } else {
                            return Err(format!(
                                "Step {n}: no text field called \"{field_name}\" here. Check its label with read_window or take_screenshot and click_at."
                            ));
                        }
                    } else {
                        return Err(format!("Step {n}: no text field called \"\" here. Check its label with read_window."));
                    }
                    }
                }
                "choose" => {
                    let option = s_str(s, "option").or_else(|| s_str(s, "text")).unwrap_or("");
                    if risky(option) && !confirmed {
                        return Err(format!(
                            "Stopped before choosing \"{option}\": it could delete, pay, send or sign out, and the user hasn't said yes to that."
                        ));
                    }
                    let c = find_control(&ui.controls, s).ok_or_else(|| {
                        format!(
                            "Step {n}: no dropdown called \"{}\" here.",
                            s_str(s, "field").unwrap_or("")
                        )
                    })?;
                    if c.bounds.is_empty() {
                        return Err(format!("Step {n}: dropdown \"{}\" has no screen bounds.", c.label));
                    }
                    let (gx, gy) = (c.bounds.mid_x(), c.bounds.mid_y());
                    verify_spot_safe(gx, gy)?;
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": "choose", "label": c.label, "bounds": c.bounds.to_arr() }));
                    do_click(gx, gy, ClickKind::Left)?;
                    sleep(Duration::from_millis(200));
                    if !option.is_empty() {
                        do_type(option)?;
                        do_key("return")?;
                    }
                    done.push(format!("chose \"{option}\" in {}", c.label));
                }
                "key" => {
                    let key = s_str(s, "key").unwrap_or("");
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": "key", "label": key }));
                    do_key(key).map_err(|e| format!("Step {n}: {e}"))?;
                    done.push(format!("pressed {key}"));
                }
                "scroll" => {
                    let dir = s_str(s, "direction").unwrap_or("down").to_ascii_lowercase();
                    let amount = s.get("amount").and_then(Value::as_i64).unwrap_or(5) as i32;
                    let (gx, gy) = coords_for_step(s, &w, &ui.controls)
                        .unwrap_or((w.bounds.mid_x(), w.bounds.mid_y()));
                    verify_spot_safe(gx, gy)?;
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": "scroll", "label": dir, "bounds": [gx - 6, gy - 6, 12, 12] }));
                    do_scroll(gx, gy, &dir, amount)?;
                    done.push(format!("scrolled {dir}"));
                }
                "wait" => {
                    let secs = s.get("seconds").and_then(Value::as_f64).unwrap_or(0.5).clamp(0.0, 5.0);
                    sleep(Duration::from_secs_f64(secs));
                    done.push("waited".to_string());
                }
                other => return Err(format!("Step {n}: unknown action {other}")),
            }
            Ok(())
        })();

        if let Err(e) = step_res {
            if borrowed {
                progress(json!({ "ev": "return" }));
            }
            return Err(json!({ "ok": false, "error": e, "done": done }));
        }

        if matches!(what, "click" | "click_text" | "click_at" | "double_click" | "choose" | "fill" | "set") {
            ui = read_window_ui(&w);
        }
    }

    if borrowed {
        progress(json!({ "ev": "return" }));
    }
    let controls: Vec<Value> = ui.controls.iter().map(|c| c.to_json()).collect();
    Ok(json!({
        "ok": true,
        "done": done,
        "window": win_info(&w),
        "controls": controls,
        "texts": ui.texts,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_off_blocks_terminals_password_managers_and_yomna() {
        for blocked in [
            "yomna",
            "Yomna",
            "com.aammo1.yomna",
            "alacritty",
            "Alacritty",
            "kitty",
            "ghostty",
            "com.mitchellh.ghostty",
            "foot",
            "wezterm",
            "wezterm-gui",
            "org.wezfurlong.wezterm",
            "gnome-terminal",
            "gnome-terminal-server",
            "org.gnome.Terminal",
            "konsole",
            "org.kde.konsole",
            "xterm",
            "urxvt",
            "tilix",
            "terminator",
            "1password",
            "1Password",
            "bitwarden",
            "Bitwarden",
            "keepassxc",
            "org.keepassxc.KeePassXC",
            "keepass",
            "enpass",
            "seahorse",
            "kwalletmanager",
        ] {
            assert!(hands_off_label(blocked).is_some(), "expected {blocked} to be blocked");
        }
        for allowed in ["zen", "firefox", "chromium", "code", "libreoffice", "steam", "gimp"] {
            assert!(hands_off_label(allowed).is_none(), "expected {allowed} to be allowed");
        }
    }

    #[test]
    fn parses_key_combos() {
        assert_eq!(parse_key_combo("cmd+a").unwrap(), (vec![Mod::Ctrl], "a".to_string()));
        assert_eq!(parse_key_combo("ctrl+shift+t").unwrap(), (vec![Mod::Ctrl, Mod::Shift], "t".to_string()));
        assert_eq!(parse_key_combo("Return").unwrap(), (vec![], "Return".to_string()));
        assert_eq!(parse_key_combo("escape").unwrap(), (vec![], "Escape".to_string()));
        assert!(parse_key_combo("").is_err());
    }

    #[test]
    fn find_text_field_ignores_buttons_and_short_stop_words() {
        use crate::Rect;
        let mk = |id, role: &str, label: &str| UiControl {
            id,
            role: role.to_string(),
            label: label.to_string(),
            value: String::new(),
            focused: false,
            offscreen: false,
            bounds: Rect { x: 10, y: 10, w: 120, h: 30 },
            node: None,
            actionable: true,
        };
        let controls = vec![
            mk(1, "button", "More options"),
            mk(2, "button", "History"),
            mk(3, "text field", "Address and search bar"),
        ];
        // "Search or type a URL" must not match "More options" or "History" via "or"; it must match the text field.
        let found = find_text_field(&controls, &json!({ "field": "Search or type a URL" }));
        assert_eq!(found.map(|c| c.id), Some(3));

        // When only buttons exist, find_text_field must return None so URL-bar Ctrl+L or OCR fallback runs.
        let buttons_only = vec![mk(1, "button", "More options"), mk(2, "button", "History")];
        assert!(find_text_field(&buttons_only, &json!({ "field": "Search or type a URL" })).is_none());

        assert!(is_url_bar_field("search or type a url"));
        assert!(is_url_bar_field("url bar"));
        assert!(is_url_bar_field("address bar"));
        assert!(!is_url_bar_field("email"));

        // Zen/Firefox transiently reports [0,0,0,0] bounds for an already-focused Search box right after page load.
        let mut zen_search = mk(3, "combo box", "Search");
        zen_search.focused = true;
        zen_search.bounds = Rect { x: 0, y: 0, w: 0, h: 0 };
        let zen_controls = vec![mk(1, "link", "How Search works"), zen_search];
        assert_eq!(find_text_field(&zen_controls, &json!({ "field": "Search" })).map(|c| c.id), Some(3));
        assert!(point_inside_non_input_control(&zen_controls, 50, 20));
    }
}
