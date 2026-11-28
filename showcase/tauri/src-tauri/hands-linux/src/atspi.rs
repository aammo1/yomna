//! Lightweight AT-SPI2 reader via `zbus` (`org.a11y.Bus`).
//! Gracefully returns an unavailable/empty result when accessibility is disabled or unexposed.

use crate::hyprland::{monitor_scale_at, Rect, Win};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use zbus::OwnedObjectPath;
use zbus::{Connection, Proxy};

// AT-SPI2 state bit indices (from atspi-constants.h)
const STATE_DEFUNCT: u32 = 5;
const STATE_FOCUSED: u32 = 12;
const STATE_SHOWING: u32 = 25;
const STATE_VISIBLE: u32 = 28;

#[derive(Clone, Debug)]
pub struct UiControl {
    pub id: usize,
    pub role: String,
    pub label: String,
    pub value: String,
    pub focused: bool,
    pub offscreen: bool,
    pub bounds: Rect,
    /// Where it lives on the accessibility bus (bus name, object path), to press it without the mouse.
    pub node: Option<(String, String)>,
    /// It has the Action interface (buttons, links, menu items, checkboxes).
    pub actionable: bool,
}

impl UiControl {
    pub fn to_json(&self) -> Value {
        let mut obj = json!({
            "id": self.id,
            "role": self.role,
            "label": self.label,
            "bounds": self.bounds.to_arr(),
        });
        if !self.value.is_empty() {
            obj["value"] = json!(self.value);
        }
        if self.focused {
            obj["focused"] = json!(true);
        }
        if self.offscreen {
            obj["offscreen"] = json!(true);
        }
        obj
    }
}

#[derive(Clone, Debug, Default)]
pub struct UiTree {
    pub controls: Vec<UiControl>,
    pub texts: Vec<String>,
    pub note: &'static str,
}

impl UiTree {
    pub fn unavailable() -> Self {
        Self {
            controls: Vec::new(),
            texts: Vec::new(),
            note: "AT-SPI2 unavailable",
        }
    }
}

fn has_state(states: &[u32], bit: u32) -> bool {
    let idx = (bit / 32) as usize;
    let mask = 1u32 << (bit % 32);
    states.get(idx).is_some_and(|word| word & mask != 0)
}

fn map_role(role_name: &str) -> Option<&'static str> {
    Some(match role_name.trim().to_ascii_lowercase().as_str() {
        "button" | "push button" | "toggle button" | "menu button" | "split button" => "button",
        "check box" | "check menu item" => "checkbox",
        "radio button" | "radio menu item" => "radio",
        "text" | "entry" | "document text" | "autocomplete" | "search" => "text field",
        "password text" => "password field",
        "combo box" => "combo box",
        "menu item" => "menu item",
        "link" => "link",
        "page tab" => "tab",
        "slider" => "slider",
        "spin button" => "stepper",
        "list item" | "icon" | "table cell" | "list box item" => "list item",
        "tree item" => "tree item",
        _ => return None,
    })
}

/// A string property read with Properties.Get: zbus's property cache is filled by GetAll, which AT-SPI apps don't
/// answer reliably, so cached reads came back empty (every button had no label).
async fn prop_str(conn: &zbus::Connection, bus: &str, path: &str, name: &str) -> String {
    let Ok(props) = Proxy::new(conn, bus, path, "org.freedesktop.DBus.Properties").await else {
        return String::new();
    };
    match props.call::<_, _, zbus::OwnedVariant>("Get", &("org.a11y.atspi.Accessible", name)).await {
        Ok(v) => String::try_from(v).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Presses a control through accessibility (its click/press/activate action), the way a screen reader does: no mouse,
/// so nothing on top of it (Yomna's overlay, a popup, another window) can take the click, and it works on any
/// workspace. false when it has no such action or the app refused; the caller then clicks with the mouse.
pub fn press(c: &UiControl) -> bool {
    let Some((bus, path)) = c.node.clone() else { return false };
    if !c.actionable {
        return false;
    }
    zbus::block_on(async move {
        let Ok(session) = Connection::session().await else { return false };
        let Ok(a11y) = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus").await else { return false };
        let Ok(addr) = a11y.call::<_, _, String>("GetAddress", &()).await else { return false };
        let Ok(conn) = zbus::connection::Builder::address(addr.as_str()).build().await else { return false };
        let Ok(act) = Proxy::new(&conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Action").await else { return false };
        // (name, description, key binding) per action: pick the one that clicks, else the first.
        let actions: Vec<(String, String, String)> = act.call("GetActions", &()).await.unwrap_or_default();
        if actions.is_empty() {
            return false;
        }
        let pick = actions
            .iter()
            .position(|(n, _, _)| matches!(n.to_ascii_lowercase().as_str(), "click" | "press" | "activate" | "jump" | "toggle"))
            .unwrap_or(0) as i32;
        act.call::<_, _, bool>("DoAction", &(pick,)).await.unwrap_or(false)
    })
}

pub fn read_window_ui(win: &Win) -> UiTree {
    zbus::block_on(read_window_ui_async(win)).unwrap_or_else(|_| UiTree::unavailable())
}

async fn read_window_ui_async(win: &Win) -> Result<UiTree, String> {
    let session = Connection::session().await.map_err(|e| e.to_string())?;
    let a11y_bus = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
        .await
        .map_err(|e| e.to_string())?;
    let addr: String = a11y_bus.call("GetAddress", &()).await.map_err(|e| e.to_string())?;
    // Accessibility is off by default on Hyprland/Omarchy (nothing like a screen reader turns it on), and with it off
    // apps register empty or not at all, so read_window found no controls anywhere. Turning both IsEnabled and
    // ScreenReaderEnabled on is what a screen reader does; Chromium/Chrome/Electron specifically watch
    // ScreenReaderEnabled to expose web page controls dynamically.
    if let Ok(status) = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Status").await {
        if !status.get_property::<bool>("IsEnabled").await.unwrap_or(false) {
            let _ = status.set_property("IsEnabled", true).await;
        }
        if !status.get_property::<bool>("ScreenReaderEnabled").await.unwrap_or(false) {
            let _ = status.set_property("ScreenReaderEnabled", true).await;
        }
    }
    if addr.trim().is_empty() {
        return Ok(UiTree::unavailable());
    }

    let conn = zbus::connection::Builder::address(addr.as_str())
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let dbus = Proxy::new(&conn, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus")
        .await
        .map_err(|e| e.to_string())?;
    let root = Proxy::new(
        &conn,
        "org.a11y.atspi.Registry",
        "/org/a11y/atspi/accessible/root",
        "org.a11y.atspi.Accessible",
    )
    .await
    .map_err(|e| e.to_string())?;

    let apps: Vec<(String, OwnedObjectPath)> = root.call("GetChildren", &()).await.map_err(|e| e.to_string())?;
    // Every registration that fits: by process id first, then by name. One app can register more than once under the
    // same pid (Qt/GTK apps often leave an empty one first), so each is read until one has something in it.
    let mut by_pid: Vec<(String, String)> = Vec::new();
    let mut by_name: Vec<(String, String)> = Vec::new();
    for (bus_name, path) in apps {
        if bus_name.is_empty() {
            continue;
        }
        if win.pid != 0 {
            if let Ok(pid) = dbus.call::<_, _, u32>("GetConnectionUnixProcessID", &(bus_name.as_str(),)).await {
                if pid == win.pid {
                    by_pid.push((bus_name, path.to_string()));
                    continue;
                }
            }
        }
        let nl = prop_str(&conn, bus_name.as_str(), path.as_str(), "Name").await.to_ascii_lowercase();
        let al = win.app.to_ascii_lowercase();
        let cl = win.class.to_ascii_lowercase();
        if !nl.is_empty() && (nl == al || nl == cl || al.contains(&nl) || nl.contains(&al)) {
            by_name.push((bus_name, path.to_string()));
        }
    }

    for (app_bus, app_path) in by_pid.into_iter().chain(by_name) {
        let tree = walk_app(&conn, win, app_bus, app_path).await;
        if !tree.controls.is_empty() || !tree.texts.is_empty() {
            return Ok(tree);
        }
    }
    Ok(UiTree::unavailable())
}

/// Detects per-frame AT-SPI GetExtents scale relative to Hyprland/X11 logical window bounds.
/// Chromium on Wayland with fractional scaling reports its native Aura `frame` in a different pixel space
/// (e.g. 1274x708 for a 1512x840 logical window, uniform ratio ~0.8426) than its `document web` subtree.
fn detect_frame_scale(fw: i32, fh: i32, win: Rect) -> Option<(f64, f64)> {
    if fw <= 0 || fh <= 0 || win.is_empty() {
        return None;
    }
    let rx = fw as f64 / win.w as f64;
    let ry = fh as f64 / win.h as f64;
    if (rx - ry).abs() < 0.08 && (rx - 1.0).abs() > 0.03 && (0.4..=3.0).contains(&rx) {
        Some((rx, ry))
    } else {
        None
    }
}

/// Detects the AT-SPI GetExtents scale inside a `document web` (or `document *`) subtree.
/// On Wayland fractional scaling (e.g. 1.25x), Chromium's Blink renderer reports physical pixels
/// (e.g. x=0, y=129, w=1892, h=922 inside a 1512x840 logical window -> (dx+dw)/w ≈ 1.25, (dy+dh)/h ≈ 1.25)
/// even when its native Aura `frame` reported a different scale.
fn detect_document_scale(dx: i32, dy: i32, dw: i32, dh: i32, win: Rect, mon_scale: f64) -> Option<(f64, f64)> {
    if dw <= 0 || dh <= 0 || win.is_empty() {
        return None;
    }
    let rx_end = (dx.max(0) + dw) as f64 / win.w as f64;
    let ry_end = (dy.max(0) + dh) as f64 / win.h as f64;
    let rx_w = dw as f64 / win.w as f64;
    if mon_scale > 1.01
        && ((rx_end - mon_scale).abs() < 0.15
            || (ry_end - mon_scale).abs() < 0.15
            || (rx_w - mon_scale).abs() < 0.15)
    {
        return Some((mon_scale, mon_scale));
    }
    if (rx_end - 1.0).abs() < 0.15 || (rx_w - 1.0).abs() < 0.15 {
        return Some((1.0, 1.0));
    }
    None
}

async fn walk_app(conn: &zbus::Connection, win: &Win, app_bus: String, app_path: String) -> UiTree {
    // Browsers: the page is a "document web" deep inside (often 20+ levels) after the browser's own bar and tabs, which
    // used to eat the whole budget, so web pages showed nothing. The page is read first, hidden parts (background
    // tabs, closed menus) are skipped, and the costly calls (position, text) are made only where they're needed.
    let deadline = Instant::now() + Duration::from_millis(3500);
    let mut tree = UiTree {
        controls: Vec::new(),
        texts: Vec::new(),
        note: "",
    };
    let mut visited = 0usize;
    let mon_scale = monitor_scale_at(win.bounds.mid_x(), win.bounds.mid_y());
    // (bus, path, depth, inside the page, scale_x, scale_y)
    let mut page: Vec<(String, String, usize, bool, f64, f64)> = Vec::new();
    let mut rest: Vec<(String, String, usize, bool, f64, f64)> = vec![(app_bus, app_path, 0, false, 1.0, 1.0)];

    while let Some((bus, path, depth, in_page, mut sx_div, mut sy_div)) = page.pop().or_else(|| rest.pop()) {
        if Instant::now() >= deadline || visited >= 4000 || tree.controls.len() >= 400 {
            break;
        }
        visited += 1;
        let Ok(acc) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Accessible").await else {
            continue;
        };
        let role_name: String = acc.call("GetRoleName", &()).await.unwrap_or_default();
        let role_low = role_name.trim().to_ascii_lowercase();
        let states: Vec<u32> = acc.call("GetState", &()).await.unwrap_or_default();
        if has_state(&states, STATE_DEFUNCT) {
            continue;
        }
        let showing = has_state(&states, STATE_SHOWING) || has_state(&states, STATE_VISIBLE);
        // Hidden below the window itself: a background tab's page, a closed menu. Nothing in it can be clicked.
        // Shallow GTK4/Qt layout containers sometimes omit STATE_SHOWING on wrapper panes even when children show.
        let wrapper_container = depth <= 6
            && matches!(
                role_low.as_str(),
                "application" | "frame" | "filler" | "panel" | "scroll pane" | "viewport" | "layered pane" | "root pane"
            );
        if !showing && depth > 2 && !wrapper_container {
            continue;
        }
        // Detect coordinate scale independently for native top-level `frame` vs web `document *` subtrees.
        if !in_page && role_low == "frame" && !win.bounds.is_empty() {
            if let Ok(comp) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Component").await {
                if let Ok((_, _, fw, fh)) = comp.call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(1u32,)).await {
                    if let Some((rx, ry)) = detect_frame_scale(fw, fh, win.bounds) {
                        sx_div = rx;
                        sy_div = ry;
                    }
                }
            }
        } else if role_low.starts_with("document") && !win.bounds.is_empty() {
            if let Ok(comp) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Component").await {
                if let Ok((dx, dy, dw, dh)) = comp.call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(1u32,)).await {
                    if let Some((rx, ry)) = detect_document_scale(dx, dy, dw, dh, win.bounds, mon_scale) {
                        sx_div = rx;
                        sy_div = ry;
                    }
                }
            }
        }
        let focused = has_state(&states, STATE_FOCUSED);
        let role = map_role(&role_name);
        let mut name: String = prop_str(conn, bus.as_str(), path.as_str(), "Name").await;
        if name.trim().is_empty() && role.is_some() {
            name = prop_str(conn, bus.as_str(), path.as_str(), "Description").await;
        }
        let label = name.trim().to_string();

        if let Some(role) = role {
            let ifaces: Vec<String> = acc.call("GetInterfaces", &()).await.unwrap_or_default();
            let mut bounds = Rect::default();
            if ifaces.iter().any(|i| i == "org.a11y.atspi.Component") {
                if let Ok(comp) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Component").await {
                    // Window-relative (coord type 1), placed by the window's own position: on Wayland an app can't
                    // know where it is on screen, so its "screen" coordinates are really window ones.
                    if let Ok((x, y, w, h)) = comp.call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(1u32,)).await {
                        if w > 0 && h > 0 {
                            let sx = (x as f64 / sx_div).round() as i32;
                            let sy = (y as f64 / sy_div).round() as i32;
                            let sw = (w as f64 / sx_div).round() as i32;
                            let sh = (h as f64 / sy_div).round() as i32;
                            bounds = Rect::new(sx + win.bounds.x, sy + win.bounds.y, sw, sh);
                        }
                    }
                }
            }
            let mut value = String::new();
            if role == "text field" || role == "combo box" {
                if let Ok(txt) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Text").await {
                    if let Ok(t) = txt.call::<_, _, String>("GetText", &(0i32, -1i32)).await {
                        value = t.trim().chars().take(160).collect();
                    }
                }
            }
            if !bounds.is_empty() || !label.is_empty() {
                let id = tree.controls.len() + 1;
                let offscreen = !showing
                    || (!bounds.is_empty()
                        && !win.bounds.is_empty()
                        && !win.bounds.contains(bounds.mid_x(), bounds.mid_y()));
                tree.controls.push(UiControl {
                    id,
                    role: role.to_string(),
                    label,
                    value: if role == "password field" { String::new() } else { value },
                    focused,
                    offscreen,
                    bounds,
                    node: Some((bus.clone(), path.clone())),
                    actionable: ifaces.iter().any(|i| i == "org.a11y.atspi.Action"),
                });
            }
        } else if showing && !label.is_empty() && tree.texts.len() < 160 && !tree.texts.contains(&label) {
            tree.texts.push(label);
        }

        if depth < 60 {
            let into_page = in_page || role_low.starts_with("document");
            if let Ok(children) = acc.call::<_, _, Vec<(String, OwnedObjectPath)>>("GetChildren", &()).await {
                let to = if into_page { &mut page } else { &mut rest };
                for (cbus, cpath) in children.into_iter().take(300).rev() {
                    if !cbus.is_empty() {
                        to.push((cbus, cpath.to_string(), depth + 1, into_page, sx_div, sy_div));
                    }
                }
            }
        }
    }

    tree
}

/// Other names a key goes by: the screen shows "+", accessibility names it "Add" (calculators, keypads, toolbars).
pub fn key_aliases(q: &str) -> &'static [&'static str] {
    match q {
        "+" | "plus" | "add" => &["+", "plus", "add"],
        "-" | "−" | "minus" | "subtract" => &["-", "−", "minus", "subtract"],
        "×" | "*" | "x" | "times" | "multiply" => &["×", "*", "times", "multiply"],
        "÷" | "/" | "divide" | "divided by" => &["÷", "/", "divide"],
        "=" | "equals" | "equal" => &["=", "equals", "equal"],
        "%" | "percent" => &["%", "percent"],
        "." | "point" | "decimal" => &[".", "point", "decimal", "decimal point"],
        "ac" | "all clear" | "clear" | "c" => &["ac", "all clear", "clear"],
        "±" | "+/-" | "toggle sign" => &["±", "+/-", "toggle sign"],
        "⌫" | "backspace" | "delete" | "del" => &["⌫", "backspace", "delete"],
        _ => &[],
    }
}

pub fn find_text_matches(win: &Win, query: &str) -> Vec<Value> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let alts = key_aliases(q.as_str());
    let tree = read_window_ui(win);
    let mut matches = Vec::new();
    for c in tree.controls {
        if c.offscreen || c.bounds.is_empty() {
            continue;
        }
        let text = if !c.label.is_empty() { &c.label } else { &c.value };
        let tl = text.trim().to_ascii_lowercase();
        let alias = alts.iter().any(|a| tl == *a);
        if tl.is_empty() || (!alias && !tl.contains(&q)) {
            continue;
        }
        let kind = if tl == q || alias { "exact" } else { "contains" };
        matches.push(json!({
            "text": text,
            "match": kind,
            "role": c.role,
            "bounds": c.bounds.to_arr(),
            "id": c.id,
        }));
        if matches.len() >= 16 {
            break;
        }
    }
    // Exact words first; among equal matches prefer real clickable controls (button/link/menu item) over tabs or labels
    // so e.g. click_text("New Tab") in Chrome clicks the "+" New Tab button rather than an already-open tab named "New Tab".
    let role_rank = |r: &str| -> u8 {
        match r {
            "button" | "link" | "menu item" | "checkbox" | "radio button" => 0,
            "text field" | "combo box" | "password field" => 1,
            "tab" => 2,
            _ => 3,
        }
    };
    matches.sort_by_key(|m| (m["match"] != "exact", role_rank(m["role"].as_str().unwrap_or(""))));
    matches.truncate(8);
    matches
}

#[cfg(test)]
mod tests {
    use super::{detect_document_scale, detect_frame_scale, key_aliases};
    use crate::hyprland::Rect;

    #[test]
    fn symbols_find_their_named_keys() {
        assert!(key_aliases("+").contains(&"add"), "+ is the Add key");
        assert!(key_aliases("=").contains(&"equals"));
        assert!(key_aliases("×").contains(&"multiply"));
        assert!(key_aliases("add").contains(&"+"), "and the other way round");
        assert!(key_aliases("sign in").is_empty(), "ordinary words have no aliases");
    }

    #[test]
    fn detects_chrome_dual_scale_on_fractional_wayland() {
        let win = Rect::new(12, 12, 1512, 840);
        // Native Aura frame reports 1274x708 (~0.8426x of logical window).
        let (fx, fy) = detect_frame_scale(1274, 708, win).expect("frame scale");
        assert!((fx - 0.8426).abs() < 0.005);
        assert!((fy - 0.8429).abs() < 0.005);
        // Blink document web reports physical pixels (0, 129, 1892, 922) at 1.25x monitor scale.
        let (dx, dy) = detect_document_scale(0, 129, 1892, 922, win, 1.25).expect("doc scale");
        assert_eq!((dx, dy), (1.25, 1.25));
        // Logical document web stays 1.0.
        assert_eq!(detect_document_scale(0, 96, 1512, 744, win, 1.25), Some((1.0, 1.0)));
    }
}
