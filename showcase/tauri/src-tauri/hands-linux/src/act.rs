//! Input automation (`act`) with strict `HANDS_OFF` protection,
//! Wayland (`wtype` / `ydotool` / `hyprctl`) and X11 (`xdotool`) execution.

use crate::atspi::{find_text_matches, press, read_window_ui, UiControl};
use crate::hyprland::{
    focus_window, front_window, is_hyprland, is_wayland, no_window, resolve, win_info, window_at, Win,
};
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
        let codes: &[&str] = match kind {
            ClickKind::Left => &["0xC0"],
            ClickKind::DoubleLeft => &["0xC0", "0xC0"],
            ClickKind::Right => &["0xC1"],
        };
        let out = Command::new("ydotool")
            .arg("click")
            .args(codes)
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

fn do_type(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    if wayland_session() {
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
                .args(["type", "--key-delay", "6", "--", text])
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("failed to run ydotool type: {e}"))?;
            if !out.status.success() {
                return Err(format!("ydotool type failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            sleep(Duration::from_millis(40));
            return Ok(());
        }
        return Err("Keyboard typing on Wayland requires wtype or ydotool (install wtype).".to_string());
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
        return Err("Key press on Wayland requires wtype (install wtype).".to_string());
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
    let w = resolve(&target)
        .ok_or_else(|| json!({ "ok": false, "error": no_window(&target), "done": [] }))?;

    if let Some(name) = check_win_hands_off(&w) {
        return Err(json!({
            "ok": false,
            "error": format!("Blocked for safety: I can point at things in {name}, but I never type or click in it. Show the user where to click instead."),
            "done": []
        }));
    }

    let mut ui = read_window_ui(&w);
    let mut done: Vec<String> = Vec::new();
    let mut borrowed = false;
    progress(json!({ "ev": "start", "window": win_info(&w), "steps": steps.len() }));

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
                    let (gx, gy) = coords_for_step(s, &w, &ui.controls)
                        .ok_or_else(|| format!("Step {n}: {what} needs x and y"))?;
                    verify_spot_safe(gx, gy)?;
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": what, "bounds": [gx - 6, gy - 6, 12, 12] }));
                    let kind = match what {
                        "double_click" => ClickKind::DoubleLeft,
                        "right_click" => ClickKind::Right,
                        _ => ClickKind::Left,
                    };
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
                    if what == "focus" || !press(c) {
                        do_click(gx, gy, ClickKind::Left)?;
                    }
                    done.push(format!("{what} {}", if c.label.is_empty() { format!("control {}", c.id) } else { c.label.clone() }));
                }
                "click_text" => {
                    let q = s_str(s, "text").unwrap_or("").trim();
                    if q.is_empty() {
                        return Err(format!("Step {n}: no visible text \"\" in {}.", w.app));
                    }
                    let matches = find_text_matches(&w, q);
                    let Some(m) = matches.first() else {
                        return Err(format!(
                            "Step {n}: no visible text \"{q}\" in {}. Check the exact words with a screenshot or read_window.",
                            w.app
                        ));
                    };
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
                    let pressed = ui.controls.iter().find(|c| c.id == id && (c.label == text || c.value == text)).is_some_and(press);
                    if !pressed {
                        do_click(gx, gy, ClickKind::Left)?;
                    }
                    done.push(format!("clicked \"{text}\""));
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
                    let c = find_control(&ui.controls, s).ok_or_else(|| {
                        format!(
                            "Step {n}: no text field called \"{}\" here. Check its label with read_window.",
                            s_str(s, "field").unwrap_or("")
                        )
                    })?;
                    if c.bounds.is_empty() {
                        return Err(format!("Step {n}: field \"{}\" has no screen bounds.", c.label));
                    }
                    let (gx, gy) = (c.bounds.mid_x(), c.bounds.mid_y());
                    verify_spot_safe(gx, gy)?;
                    ensure_focus()?;
                    progress(json!({ "ev": "step", "i": i, "do": what, "label": c.label, "bounds": c.bounds.to_arr() }));
                    do_click(gx, gy, ClickKind::Left)?;
                    do_key("ctrl+a")?;
                    do_type(text)?;
                    done.push(format!("{} = \"{}\"", c.label, text.chars().take(40).collect::<String>()));
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
    Ok(json!({
        "ok": true,
        "done": done,
        "window": win_info(&w),
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
}
