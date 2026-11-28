//! Lightweight AT-SPI2 reader via `zbus` (`org.a11y.Bus`).
//! Gracefully returns an unavailable/empty result when accessibility is disabled or unexposed.

use crate::hyprland::{Rect, Win};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use zbus::OwnedObjectPath;
use zbus::{Connection, Proxy};

// AT-SPI2 state bit indices (from atspi-constants.h)
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
        "push button" | "toggle button" => "button",
        "check box" | "check menu item" => "checkbox",
        "radio button" | "radio menu item" => "radio",
        "text" | "entry" | "document text" => "text field",
        "password text" => "password field",
        "combo box" => "combo box",
        "menu item" => "menu item",
        "link" => "link",
        "page tab" => "tab",
        "slider" => "slider",
        "spin button" => "stepper",
        "list item" => "list item",
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
    // apps register empty or not at all, so read_window found no controls anywhere. Turning it on is what a screen
    // reader does; apps started from now on (and Qt/GTK ones already open) fill in their controls.
    if let Ok(status) = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Status").await {
        if !status.get_property::<bool>("IsEnabled").await.unwrap_or(false) {
            let _ = status.set_property("IsEnabled", true).await;
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

async fn walk_app(conn: &zbus::Connection, win: &Win, app_bus: String, app_path: String) -> UiTree {
    let deadline = Instant::now() + Duration::from_millis(1200);
    let mut tree = UiTree {
        controls: Vec::new(),
        texts: Vec::new(),
        note: "",
    };
    let mut visited = 0usize;
    let mut stack: Vec<(String, String, usize)> = vec![(app_bus, app_path, 0)];

    while let Some((bus, path, depth)) = stack.pop() {
        if Instant::now() >= deadline || visited >= 450 || tree.controls.len() >= 220 {
            break;
        }
        visited += 1;
        let Ok(acc) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Accessible").await else {
            continue;
        };
        let role_name: String = acc.call("GetRoleName", &()).await.unwrap_or_default();
        let name: String = prop_str(conn, bus.as_str(), path.as_str(), "Name").await;
        let desc: String = prop_str(conn, bus.as_str(), path.as_str(), "Description").await;
        let states: Vec<u32> = acc.call("GetState", &()).await.unwrap_or_default();
        let ifaces: Vec<String> = acc.call("GetInterfaces", &()).await.unwrap_or_default();

        let showing = has_state(&states, STATE_SHOWING) || has_state(&states, STATE_VISIBLE);
        let focused = has_state(&states, STATE_FOCUSED);

        let mut bounds = Rect::default();
        if ifaces.iter().any(|i| i == "org.a11y.atspi.Component") {
            if let Ok(comp) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Component").await {
                // Window-relative (coord type 1), placed by the window's own position: on Wayland an app can't know
                // where it is on screen, so its "screen" coordinates are really window ones.
                if let Ok((x, y, w, h)) = comp.call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(1u32,)).await {
                    bounds = Rect::new(x + win.bounds.x, y + win.bounds.y, w, h);
                }
            }
        }

        let mut value = String::new();
        if ifaces.iter().any(|i| i == "org.a11y.atspi.Text") {
            if let Ok(txt) = Proxy::new(conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Text").await {
                if let Ok(t) = txt.call::<_, _, String>("GetText", &(0i32, -1i32)).await {
                    value = t.trim().chars().take(160).collect();
                }
            }
        }

        let label = if !name.trim().is_empty() {
            name.trim().to_string()
        } else {
            desc.trim().to_string()
        };

        if let Some(role) = map_role(&role_name) {
            if !bounds.is_empty() || !label.is_empty() {
                let id = tree.controls.len() + 1;
                let offscreen = !showing
                    || (!bounds.is_empty()
                        && !win.bounds.is_empty()
                        && !win.bounds.contains(bounds.mid_x(), bounds.mid_y()));
                tree.controls.push(UiControl {
                    id,
                    role: role.to_string(),
                    label: label.clone(),
                    value: if role == "password field" { String::new() } else { value.clone() },
                    focused,
                    offscreen,
                    bounds,
                    node: Some((bus.clone(), path.clone())),
                    actionable: ifaces.iter().any(|i| i == "org.a11y.atspi.Action"),
                });
            }
        } else if showing && !label.is_empty() && tree.texts.len() < 120 {
            if !tree.texts.contains(&label) {
                tree.texts.push(label);
            }
        }

        if depth < 10 {
            if let Ok(children) = acc.call::<_, _, Vec<(String, OwnedObjectPath)>>("GetChildren", &()).await {
                for (cbus, cpath) in children.into_iter().rev().take(60) {
                    if !cbus.is_empty() {
                        stack.push((cbus, cpath.to_string(), depth + 1));
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
        if matches.len() >= 8 {
            break;
        }
    }
    // Exact words first: "7" is the 7 key, not "17" or "Shift+7".
    matches.sort_by_key(|m| m["match"] != "exact");
    matches
}

#[cfg(test)]
mod tests {
    use super::key_aliases;

    #[test]
    fn symbols_find_their_named_keys() {
        assert!(key_aliases("+").contains(&"add"), "+ is the Add key");
        assert!(key_aliases("=").contains(&"equals"));
        assert!(key_aliases("×").contains(&"multiply"));
        assert!(key_aliases("add").contains(&"+"), "and the other way round");
        assert!(key_aliases("sign in").is_empty(), "ordinary words have no aliases");
    }
}
