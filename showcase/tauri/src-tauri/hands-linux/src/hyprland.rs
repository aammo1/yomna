//! Hyprland IPC client (`hyprctl`) with X11 EWMH fallback via `x11rb`.

use serde::Deserialize;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt, Window as XWindow, CLIENT_MESSAGE_EVENT};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    pub fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }

    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }

    pub fn mid_x(&self) -> i32 {
        self.x + self.w / 2
    }

    pub fn mid_y(&self) -> i32 {
        self.y + self.h / 2
    }

    pub fn to_obj(&self) -> Value {
        json!({ "x": self.x, "y": self.y, "w": self.w, "h": self.h })
    }

    pub fn to_arr(&self) -> Value {
        json!([self.x, self.y, self.w, self.h])
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Win {
    pub id: String,
    pub numeric_id: Option<u64>,
    pub app: String,
    pub class: String,
    pub exe: String,
    pub title: String,
    pub pid: u32,
    pub workspace: i64,
    pub focused: bool,
    pub bounds: Rect,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct HyprWorkspace {
    id: i64,
    name: String,
}

impl Default for HyprWorkspace {
    fn default() -> Self {
        Self { id: 0, name: String::new() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct HyprClient {
    address: String,
    mapped: bool,
    hidden: bool,
    at: [i32; 2],
    size: [i32; 2],
    workspace: HyprWorkspace,
    class: String,
    #[serde(rename = "initialClass")]
    initial_class: String,
    title: String,
    pid: u32,
    #[serde(rename = "focusHistoryID")]
    focus_history_id: i64,
}

impl Default for HyprClient {
    fn default() -> Self {
        Self {
            address: String::new(),
            mapped: true,
            hidden: false,
            at: [0, 0],
            size: [0, 0],
            workspace: HyprWorkspace::default(),
            class: String::new(),
            initial_class: String::new(),
            title: String::new(),
            pid: 0,
            focus_history_id: i64::MAX,
        }
    }
}

pub fn is_hyprland() -> bool {
    std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some_and(|v| !v.is_empty())
}

pub fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
}

/// Normalize an identifier for matching (`com.aammo1.yomna` / `/usr/bin/yomna` -> lowercase tokens).
fn proc_comm(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        let c = comm.trim();
        if !c.is_empty() {
            return c.to_string();
        }
    }
    if let Ok(exe) = std::fs::read_link(format!("/proc/{pid}/exe")) {
        if let Some(name) = exe.file_name().and_then(|s| s.to_str()) {
            return name.to_string();
        }
    }
    String::new()
}

pub fn is_yomna(app: &str, class: &str, exe: &str, pid: u32) -> bool {
    if pid != 0 && pid == std::process::id() {
        return true;
    }
    for raw in [app, class, exe] {
        let s = raw.trim().to_ascii_lowercase();
        if s.is_empty() {
            continue;
        }
        let stem = s.rsplit('/').next().unwrap_or(&s);
        let tail = stem.rsplit('.').next().unwrap_or(stem);
        if matches!(
            stem,
            "yomna" | "yomna-hands" | "yomna-voice" | "com.aammo1.yomna"
        ) || matches!(tail, "yomna" | "yomna-hands" | "yomna-voice")
        {
            return true;
        }
    }
    false
}

fn parse_numeric_id(id: &str) -> Option<u64> {
    let trimmed = id.trim();
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        trimmed.parse::<u64>().ok()
    }
}

fn client_to_win(c: HyprClient, exe_lookup: bool) -> Option<Win> {
    if c.address.is_empty() || !c.mapped || c.hidden || c.size[0] <= 0 || c.size[1] <= 0 {
        return None;
    }
    let class = if !c.class.is_empty() {
        c.class.clone()
    } else {
        c.initial_class.clone()
    };
    let app = if !class.is_empty() {
        class.clone()
    } else if !c.initial_class.is_empty() {
        c.initial_class.clone()
    } else {
        "unknown".to_string()
    };
    let exe = if exe_lookup { proc_comm(c.pid) } else { String::new() };
    let numeric_id = parse_numeric_id(&c.address);
    Some(Win {
        id: c.address,
        numeric_id,
        app,
        class,
        exe,
        title: c.title,
        pid: c.pid,
        workspace: c.workspace.id,
        focused: c.focus_history_id == 0,
        bounds: Rect::new(c.at[0], c.at[1], c.size[0], c.size[1]),
    })
}

pub fn parse_hypr_active_json(raw: &str, exe_lookup: bool) -> Result<Option<Win>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(None);
    }
    let mut client: HyprClient =
        serde_json::from_str(trimmed).map_err(|e| format!("invalid hyprctl activewindow JSON: {e}"))?;
    if client.address.is_empty() {
        return Ok(None);
    }
    client.focus_history_id = 0;
    client.mapped = true;
    Ok(client_to_win(client, exe_lookup))
}

pub fn parse_hypr_clients_json(raw: &str, include_yomna: bool, exe_lookup: bool) -> Result<Vec<Win>, String> {
    let mut clients: Vec<HyprClient> =
        serde_json::from_str(raw.trim()).map_err(|e| format!("invalid hyprctl clients JSON: {e}"))?;
    clients.sort_by_key(|c| c.focus_history_id);
    let mut out = Vec::with_capacity(clients.len());
    for c in clients {
        if let Some(w) = client_to_win(c, exe_lookup) {
            if !include_yomna && is_yomna(&w.app, &w.class, &w.exe, w.pid) {
                continue;
            }
            out.push(w);
        }
    }
    Ok(out)
}

fn run_hyprctl(args: &[&str]) -> Result<String, String> {
    let out = Command::new("hyprctl")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run hyprctl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("hyprctl {} failed: {}", args.join(" "), err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One dispatch: the Lua form first (Hyprland 0.55+ with a Lua config only takes `hl.dsp.…(…)`, and answers the classic
/// form with an error but a zero exit code), then the classic `dispatch <name> <args>` for older setups.
pub fn hypr_dispatch(lua: &str, classic: &[&str]) -> Result<(), String> {
    let lua_out = run_hyprctl(&["dispatch", lua]).unwrap_or_default();
    if lua_out.trim_start().starts_with("ok") {
        return Ok(());
    }
    let mut args = vec!["dispatch"];
    args.extend_from_slice(classic);
    let out = run_hyprctl(&args)?;
    if out.trim_start().starts_with("ok") {
        Ok(())
    } else {
        Err(format!("hyprctl dispatch failed: {} / {}", lua_out.trim(), out.trim()))
    }
}

fn hypr_windows(include_yomna: bool) -> Result<Vec<Win>, String> {
    let raw = run_hyprctl(&["clients", "-j"])?;
    let mut list = parse_hypr_clients_json(&raw, include_yomna, true)?;
    if let Ok(active_raw) = run_hyprctl(&["activewindow", "-j"]) {
        if let Ok(Some(active)) = parse_hypr_active_json(&active_raw, true) {
            for w in &mut list {
                w.focused = w.id.eq_ignore_ascii_case(&active.id);
            }
        }
    }
    Ok(list)
}

fn hypr_front() -> Result<Option<Win>, String> {
    if let Ok(raw) = run_hyprctl(&["activewindow", "-j"]) {
        if let Ok(Some(w)) = parse_hypr_active_json(&raw, true) {
            if !is_yomna(&w.app, &w.class, &w.exe, w.pid) {
                return Ok(Some(w));
            }
        }
    }
    let list = hypr_windows(false)?;
    Ok(list.into_iter().next())
}

// ---------- X11 EWMH fallback ----------

fn x11_atom(conn: &impl Connection, name: &[u8]) -> Option<u32> {
    conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
}

fn x11_prop_u32_list(conn: &impl Connection, win: XWindow, atom: u32) -> Vec<u32> {
    let Ok(cookie) = conn.get_property(false, win, atom, AtomEnum::ANY, 0, 4096) else {
        return Vec::new();
    };
    let Ok(reply) = cookie.reply() else {
        return Vec::new();
    };
    if reply.format != 32 {
        return Vec::new();
    }
    reply.value32().map(|it| it.collect()).unwrap_or_default()
}

fn x11_prop_string(conn: &impl Connection, win: XWindow, atom: u32) -> Option<String> {
    let cookie = conn.get_property(false, win, atom, AtomEnum::ANY, 0, 1024).ok()?;
    let reply = cookie.reply().ok()?;
    if reply.value.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&reply.value).trim_end_matches('\0').to_string())
}

fn x11_wm_class(conn: &impl Connection, win: XWindow) -> (String, String) {
    let Ok(cookie) = conn.get_property(false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 512) else {
        return (String::new(), String::new());
    };
    let Ok(reply) = cookie.reply() else {
        return (String::new(), String::new());
    };
    let parts: Vec<String> = reply
        .value
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    let instance = parts.first().cloned().unwrap_or_default();
    let class = parts.get(1).cloned().unwrap_or_else(|| instance.clone());
    (instance, class)
}

fn x11_windows(include_yomna: bool) -> Result<Vec<Win>, String> {
    let (conn, screen_num) = x11rb::connect(None).map_err(|e| format!("X11 connect failed: {e}"))?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    let net_client_list_stacking = x11_atom(&conn, b"_NET_CLIENT_LIST_STACKING");
    let net_client_list = x11_atom(&conn, b"_NET_CLIENT_LIST");
    let net_active = x11_atom(&conn, b"_NET_ACTIVE_WINDOW");
    let net_wm_name = x11_atom(&conn, b"_NET_WM_NAME");
    let net_wm_pid = x11_atom(&conn, b"_NET_WM_PID");
    let net_wm_desktop = x11_atom(&conn, b"_NET_WM_DESKTOP");
    let net_wm_state = x11_atom(&conn, b"_NET_WM_STATE");
    let net_wm_state_hidden = x11_atom(&conn, b"_NET_WM_STATE_HIDDEN");

    let active_xid = net_active
        .and_then(|a| x11_prop_u32_list(&conn, root, a).into_iter().next())
        .filter(|&x| x != 0);

    let mut xids = net_client_list_stacking
        .map(|a| x11_prop_u32_list(&conn, root, a))
        .unwrap_or_default();
    if xids.is_empty() {
        if let Some(a) = net_client_list {
            xids = x11_prop_u32_list(&conn, root, a);
        }
    }
    // Stacking order is bottom-to-top; reverse so frontmost is first.
    xids.reverse();

    let mut out = Vec::new();
    for xid in xids {
        if xid == 0 {
            continue;
        }
        let Ok(attr) = conn.get_window_attributes(xid).and_then(|c| Ok(c.reply())) else {
            continue;
        };
        let Ok(attr) = attr else { continue };
        if attr.map_state != x11rb::protocol::xproto::MapState::VIEWABLE {
            continue;
        }
        if let (Some(sa), Some(ha)) = (net_wm_state, net_wm_state_hidden) {
            if x11_prop_u32_list(&conn, xid, sa).contains(&ha) {
                continue;
            }
        }
        let Ok(geom_c) = conn.get_geometry(xid) else { continue };
        let Ok(geom) = geom_c.reply() else { continue };
        if geom.width == 0 || geom.height == 0 {
            continue;
        }
        let (rx, ry) = conn
            .translate_coordinates(xid, root, 0, 0)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| (r.dst_x as i32, r.dst_y as i32))
            .unwrap_or((geom.x as i32, geom.y as i32));

        let title = net_wm_name
            .and_then(|a| x11_prop_string(&conn, xid, a))
            .or_else(|| x11_prop_string(&conn, xid, AtomEnum::WM_NAME.into()))
            .unwrap_or_default();
        let (instance, class) = x11_wm_class(&conn, xid);
        let pid = net_wm_pid
            .and_then(|a| x11_prop_u32_list(&conn, xid, a).into_iter().next())
            .unwrap_or(0);
        let desktop = net_wm_desktop
            .and_then(|a| x11_prop_u32_list(&conn, xid, a).into_iter().next())
            .map(|d| d as i64)
            .unwrap_or(0);
        let exe = proc_comm(pid);
        let app = if !class.is_empty() {
            class.clone()
        } else if !instance.is_empty() {
            instance.clone()
        } else if !exe.is_empty() {
            exe.clone()
        } else {
            "unknown".to_string()
        };
        if !include_yomna && is_yomna(&app, &class, &exe, pid) {
            continue;
        }
        out.push(Win {
            id: format!("0x{:x}", xid),
            numeric_id: Some(xid as u64),
            app,
            class,
            exe,
            title,
            pid,
            workspace: desktop,
            focused: active_xid == Some(xid),
            bounds: Rect::new(rx, ry, geom.width as i32, geom.height as i32),
        });
    }
    Ok(out)
}

fn x11_focus(xid: XWindow) -> Result<(), String> {
    let (conn, screen_num) = x11rb::connect(None).map_err(|e| format!("X11 connect failed: {e}"))?;
    let root = conn.setup().roots[screen_num].root;
    if let Some(net_active) = x11_atom(&conn, b"_NET_ACTIVE_WINDOW") {
        let ev = ClientMessageEvent {
            response_type: CLIENT_MESSAGE_EVENT,
            format: 32,
            sequence: 0,
            window: xid,
            type_: net_active,
            data: [1, x11rb::CURRENT_TIME, 0, 0, 0].into(),
        };
        let mask = x11rb::protocol::xproto::EventMask::SUBSTRUCTURE_REDIRECT
            | x11rb::protocol::xproto::EventMask::SUBSTRUCTURE_NOTIFY;
        let _ = conn.send_event(false, root, mask, ev);
    }
    let _ = conn.set_input_focus(x11rb::protocol::xproto::InputFocus::POINTER_ROOT, xid, x11rb::CURRENT_TIME);
    let _ = conn.flush();
    Ok(())
}

// ---------- Public window API ----------

pub fn all_windows_raw() -> Vec<Win> {
    if is_hyprland() {
        if let Ok(w) = hypr_windows(true) {
            return w;
        }
    }
    x11_windows(true).unwrap_or_default()
}

pub fn windows() -> Vec<Win> {
    if is_hyprland() {
        if let Ok(w) = hypr_windows(false) {
            return w;
        }
    }
    x11_windows(false).unwrap_or_default()
}

pub fn front_window() -> Option<Win> {
    if is_hyprland() {
        if let Ok(w) = hypr_front() {
            return w;
        }
    }
    let list = x11_windows(false).ok()?;
    list.iter().find(|w| w.focused).cloned().or_else(|| list.into_iter().next())
}

const BROWSER_NAMES: &[&str] = &[
    "firefox",
    "zen",
    "zen-browser",
    "chromium",
    "google-chrome",
    "chrome",
    "brave",
    "brave-browser",
    "vivaldi",
    "opera",
    "librewolf",
    "floorp",
    "waterfox",
    "microsoft-edge",
    "epiphany",
    "thorium",
    "arc",
];

pub fn is_browser(app: &str, class: &str, exe: &str) -> bool {
    [app, class, exe].iter().any(|s| {
        let l = s.to_ascii_lowercase();
        let tail = l.rsplit('.').next().unwrap_or(&l);
        BROWSER_NAMES.iter().any(|b| l == *b || tail == *b || l.contains(b))
    })
}

pub fn app_matches(app: &str, class: &str, exe: &str, want: &str) -> bool {
    let w = want.trim().to_ascii_lowercase();
    if w.is_empty() {
        return false;
    }
    if matches!(w.as_str(), "browser" | "web browser" | "my browser") {
        return is_browser(app, class, exe);
    }
    [app, class, exe].iter().any(|cand| {
        let c = cand.trim().to_ascii_lowercase();
        !c.is_empty() && (c == w || c.contains(&w) || w.contains(c.as_str()))
    })
}

pub fn matches_window_id(w: &Win, spec: &str) -> bool {
    let s = spec.trim();
    if w.id.eq_ignore_ascii_case(s) {
        return true;
    }
    if let Some(num) = parse_numeric_id(s) {
        if w.numeric_id == Some(num) {
            return true;
        }
        if format!("0x{num:x}") == w.id.to_ascii_lowercase() {
            return true;
        }
    }
    false
}

pub fn resolve(target: &str) -> Option<Win> {
    let t = target.trim();
    if t.is_empty() || t == "front" {
        return front_window().or_else(|| windows().into_iter().next());
    }
    let all = windows();
    if let Some(id_spec) = t.strip_prefix("window:") {
        return all.into_iter().find(|w| matches_window_id(w, id_spec));
    }
    if let Some(name) = t.strip_prefix("app:") {
        return all
            .into_iter()
            .find(|w| app_matches(&w.app, &w.class, &w.exe, name));
    }
    // Bare id or app name fallback
    all.iter()
        .find(|w| matches_window_id(w, t))
        .cloned()
        .or_else(|| all.into_iter().find(|w| app_matches(&w.app, &w.class, &w.exe, t)))
}

pub fn window_at(x: i32, y: i32) -> Option<Win> {
    all_windows_raw().into_iter().find(|w| w.bounds.contains(x, y))
}

pub fn focus_window(w: &Win) -> Result<(), String> {
    if is_hyprland() {
        let arg = format!("address:{}", w.id);
        hypr_dispatch(&format!("hl.dsp.focus({{ window = \"{arg}\" }})"), &["focuswindow", &arg])?;
        std::thread::sleep(std::time::Duration::from_millis(120));
        return Ok(());
    }
    if let Some(xid) = w.numeric_id.and_then(|n| u32::try_from(n).ok()) {
        x11_focus(xid)?;
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(())
}

pub fn screen_bounds() -> Rect {
    if is_hyprland() {
        if let Ok(raw) = run_hyprctl(&["monitors", "-j"]) {
            if let Ok(mons) = serde_json::from_str::<Vec<Value>>(&raw) {
                let mut min_x = i32::MAX;
                let mut min_y = i32::MAX;
                let mut max_x = i32::MIN;
                let mut max_y = i32::MIN;
                for m in &mons {
                    let x = m.get("x").and_then(Value::as_i64).unwrap_or(0) as i32;
                    let y = m.get("y").and_then(Value::as_i64).unwrap_or(0) as i32;
                    let w = m.get("width").and_then(Value::as_i64).unwrap_or(0) as i32;
                    let h = m.get("height").and_then(Value::as_i64).unwrap_or(0) as i32;
                    let scale = m.get("scale").and_then(Value::as_f64).unwrap_or(1.0).max(0.5);
                    let lw = (w as f64 / scale).round() as i32;
                    let lh = (h as f64 / scale).round() as i32;
                    if lw > 0 && lh > 0 {
                        min_x = min_x.min(x);
                        min_y = min_y.min(y);
                        max_x = max_x.max(x + lw);
                        max_y = max_y.max(y + lh);
                    }
                }
                if min_x < max_x && min_y < max_y {
                    return Rect::new(min_x, min_y, max_x - min_x, max_y - min_y);
                }
            }
        }
    }
    if let Ok((conn, screen_num)) = x11rb::connect(None) {
        let s = &conn.setup().roots[screen_num];
        return Rect::new(0, 0, s.width_in_pixels as i32, s.height_in_pixels as i32);
    }
    Rect::new(0, 0, 1920, 1080)
}

pub fn win_info(w: &Win) -> Value {
    json!({
        "id": w.id,
        "app": w.app,
        "title": w.title,
        "pid": w.pid,
        "workspace": w.workspace,
        "focused": w.focused,
        "bounds": w.bounds.to_arr()
    })
}

pub fn win_list_item(w: &Win) -> Value {
    let mut v = win_info(w);
    if w.focused {
        v["frontApp"] = json!(true);
    }
    v
}

pub fn front_info(w: &Win) -> Value {
    json!({
        "ok": true,
        "app": w.app,
        "title": w.title,
        "pid": w.pid,
        "id": w.id,
        "bounds": w.bounds.to_obj()
    })
}

pub fn no_window(target: &str) -> String {
    format!(
        "No matching window is open{}.",
        target
            .strip_prefix("app:")
            .map(|n| format!(" for {n}"))
            .unwrap_or_default()
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const SAMPLE_ACTIVE: &str = r#"{
        "address": "0x55c8ff01a540",
        "mapped": true,
        "hidden": false,
        "at": [12, 12],
        "size": [1512, 840],
        "workspace": { "id": 1, "name": "1" },
        "class": "zen",
        "title": "Repositories — Zen Browser",
        "initialClass": "zen",
        "pid": 7020,
        "focusHistoryID": 0
    }"#;

    pub const SAMPLE_CLIENTS: &str = r#"[
        {
            "address": "0x55c8ff01a540",
            "mapped": true,
            "hidden": false,
            "at": [12, 12],
            "size": [1512, 840],
            "workspace": { "id": 1, "name": "1" },
            "class": "zen",
            "title": "Repositories — Zen Browser",
            "initialClass": "zen",
            "pid": 7020,
            "focusHistoryID": 1
        },
        {
            "address": "0x55c8ff099999",
            "mapped": true,
            "hidden": false,
            "at": [0, 0],
            "size": [1920, 1080],
            "workspace": { "id": 1, "name": "1" },
            "class": "com.aammo1.yomna",
            "title": "Yomna",
            "initialClass": "com.aammo1.yomna",
            "pid": 9999,
            "focusHistoryID": 0
        },
        {
            "address": "0x55c8ff022222",
            "mapped": true,
            "hidden": false,
            "at": [40, 40],
            "size": [900, 600],
            "workspace": { "id": 2, "name": "2" },
            "class": "Alacritty",
            "title": "bash",
            "initialClass": "Alacritty",
            "pid": 8080,
            "focusHistoryID": 2
        }
    ]"#;

    #[test]
    fn parses_hypr_active_and_clients() {
        let w = parse_hypr_active_json(SAMPLE_ACTIVE, false).unwrap().unwrap();
        assert_eq!(w.app, "zen");
        assert_eq!(w.id, "0x55c8ff01a540");
        assert_eq!(w.bounds, Rect::new(12, 12, 1512, 840));
        assert!(w.focused);

        let list = parse_hypr_clients_json(SAMPLE_CLIENTS, false, false).unwrap();
        assert_eq!(list.len(), 2, "yomna window excluded");
        assert_eq!(list[0].id, "0x55c8ff01a540");
        assert_eq!(list[1].app, "Alacritty");
        assert!(matches_window_id(&list[0], "0x55c8ff01a540"));
        assert!(matches_window_id(&list[0], "94321760118080"), "decimal JS coercion matches hex address");
    }
}
