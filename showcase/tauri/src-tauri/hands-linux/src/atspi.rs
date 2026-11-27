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

pub fn read_window_ui(win: &Win) -> UiTree {
    zbus::block_on(read_window_ui_async(win)).unwrap_or_else(|_| UiTree::unavailable())
}

async fn read_window_ui_async(win: &Win) -> Result<UiTree, String> {
    let session = Connection::session().await.map_err(|e| e.to_string())?;
    let a11y_bus = Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
        .await
        .map_err(|e| e.to_string())?;
    let addr: String = a11y_bus.call("GetAddress", &()).await.map_err(|e| e.to_string())?;
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
    let mut target_app: Option<(String, String)> = None;

    for (bus_name, path) in apps {
        if bus_name.is_empty() {
            continue;
        }
        if win.pid != 0 {
            if let Ok(pid) = dbus.call::<_, _, u32>("GetConnectionUnixProcessID", &(bus_name.as_str(),)).await {
                if pid == win.pid {
                    target_app = Some((bus_name, path.to_string()));
                    break;
                }
            }
        }
        if target_app.is_none() {
            if let Ok(p) = Proxy::new(&conn, bus_name.as_str(), path.as_str(), "org.a11y.atspi.Accessible").await {
                if let Ok(name) = p.get_property::<String>("Name").await {
                    let nl = name.to_ascii_lowercase();
                    let al = win.app.to_ascii_lowercase();
                    let cl = win.class.to_ascii_lowercase();
                    if !nl.is_empty() && (nl == al || nl == cl || al.contains(&nl) || nl.contains(&al)) {
                        target_app = Some((bus_name, path.to_string()));
                    }
                }
            }
        }
    }

    let Some((app_bus, app_path)) = target_app else {
        return Ok(UiTree::unavailable());
    };

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
        let Ok(acc) = Proxy::new(&conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Accessible").await else {
            continue;
        };
        let role_name: String = acc.call("GetRoleName", &()).await.unwrap_or_default();
        let name: String = acc.get_property("Name").await.unwrap_or_default();
        let desc: String = acc.get_property("Description").await.unwrap_or_default();
        let states: Vec<u32> = acc.call("GetState", &()).await.unwrap_or_default();
        let ifaces: Vec<String> = acc.call("GetInterfaces", &()).await.unwrap_or_default();

        let showing = has_state(&states, STATE_SHOWING) || has_state(&states, STATE_VISIBLE);
        let focused = has_state(&states, STATE_FOCUSED);

        let mut bounds = Rect::default();
        if ifaces.iter().any(|i| i == "org.a11y.atspi.Component") {
            if let Ok(comp) = Proxy::new(&conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Component").await {
                if let Ok((x, y, w, h)) = comp.call::<_, _, (i32, i32, i32, i32)>("GetExtents", &(0u32,)).await {
                    bounds = Rect::new(x, y, w, h);
                }
            }
        }

        let mut value = String::new();
        if ifaces.iter().any(|i| i == "org.a11y.atspi.Text") {
            if let Ok(txt) = Proxy::new(&conn, bus.as_str(), path.as_str(), "org.a11y.atspi.Text").await {
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

    if tree.controls.is_empty() && tree.texts.is_empty() {
        return Ok(UiTree::unavailable());
    }
    Ok(tree)
}

pub fn find_text_matches(win: &Win, query: &str) -> Vec<Value> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let tree = read_window_ui(win);
    let mut matches = Vec::new();
    for c in tree.controls {
        let text = if !c.label.is_empty() { &c.label } else { &c.value };
        let tl = text.trim().to_ascii_lowercase();
        if tl.is_empty() || !tl.contains(&q) {
            continue;
        }
        let kind = if tl == q { "exact" } else { "contains" };
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
    matches
}
