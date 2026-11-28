//! `yomna-hands` for Linux (Omarchy / Hyprland Wayland + X11 fallback).
//! Implements the same JSON CLI contract as macOS `hands/main.swift` and Windows `hands-win`.

mod act;
mod atspi;
mod hyprland;
mod ocr;
mod select;

use act::{hands_off_label, parse_key_combo, run_act};
use atspi::{find_text_matches, read_window_ui};
use hyprland::{
    front_info, front_window, matches_window_id, no_window, parse_hypr_active_json,
    parse_hypr_clients_json, resolve, win_info, win_list_item, windows, Rect,
};
use select::{capture_target, parse_slurp_geometry, run_select, SelectOutcome};
use serde_json::{json, Value};
use std::io::Write;

fn out(v: Value) -> ! {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
    std::process::exit(0);
}

fn fail(msg: &str) -> ! {
    out(json!({ "ok": false, "error": msg }))
}

fn self_test() -> ! {
    let mut checks: Vec<(&str, bool)> = Vec::new();

    // 1. HANDS_OFF blocklist coverage
    let must_block = [
        "yomna",
        "com.aammo1.yomna",
        "alacritty",
        "kitty",
        "ghostty",
        "foot",
        "wezterm",
        "gnome-terminal",
        "konsole",
        "xterm",
        "urxvt",
        "tilix",
        "terminator",
        "1password",
        "bitwarden",
        "keepassxc",
        "keepass",
        "enpass",
        "seahorse",
        "kwalletmanager",
    ];
    let must_allow = ["zen", "firefox", "chromium", "libreoffice", "steam"];
    let block_ok = must_block.iter().all(|a| hands_off_label(a).is_some())
        && must_allow.iter().all(|a| hands_off_label(a).is_none());
    checks.push(("hands_off_blocklist", block_ok));

    // 2. Hyprland activewindow & clients JSON parser (with Yomna exclusion + focus order)
    let sample_active = r#"{
        "address": "0x55c8ff01a540",
        "mapped": true,
        "hidden": false,
        "at": [12, 12],
        "size": [1512, 840],
        "workspace": { "id": 1, "name": "1" },
        "class": "zen",
        "title": "Docs",
        "initialClass": "zen",
        "pid": 7020,
        "focusHistoryID": 0
    }"#;
    let sample_clients = r#"[
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
            "address": "0x55c8ff01a540",
            "mapped": true,
            "hidden": false,
            "at": [12, 12],
            "size": [1512, 840],
            "workspace": { "id": 1, "name": "1" },
            "class": "zen",
            "title": "Docs",
            "initialClass": "zen",
            "pid": 7020,
            "focusHistoryID": 1
        },
        {
            "address": "0x55c8ff022222",
            "mapped": true,
            "hidden": false,
            "at": [40, 40],
            "size": [900, 600],
            "workspace": { "id": 2, "name": "2" },
            "class": "kitty",
            "title": "shell",
            "initialClass": "kitty",
            "pid": 8080,
            "focusHistoryID": 2
        }
    ]"#;
    let hypr_ok = parse_hypr_active_json(sample_active, false)
        .ok()
        .flatten()
        .is_some_and(|w| w.app == "zen" && w.bounds == Rect::new(12, 12, 1512, 840))
        && parse_hypr_clients_json(sample_clients, false, false).is_ok_and(|list| {
            list.len() == 2
                && list[0].app == "zen"
                && list[1].app == "kitty"
                && matches_window_id(&list[0], "0x55c8ff01a540")
                && matches_window_id(&list[0], "94321760118080")
        });
    checks.push(("hyprland_json_parser", hypr_ok));

    // 3. slurp geometry parser
    let slurp_ok = parse_slurp_geometry("100,200 640x480\n") == Ok(Rect::new(100, 200, 640, 480))
        && parse_slurp_geometry("-1920,50 800x600") == Ok(Rect::new(-1920, 50, 800, 600))
        && parse_slurp_geometry("0,0 0x100").is_err()
        && parse_slurp_geometry("cancelled").is_err();
    checks.push(("slurp_geometry_parser", slurp_ok));

    // 4. key combo parser
    let key_ok = parse_key_combo("cmd+a").is_ok()
        && parse_key_combo("ctrl+shift+Return").is_ok()
        && parse_key_combo("").is_err();
    checks.push(("key_combo_parser", key_ok));

    let mut bad = 0usize;
    for (name, ok) in checks {
        println!("{} {name}", if ok { "ok" } else { "FAIL" });
        if !ok {
            bad += 1;
        }
    }
    std::process::exit(i32::from(bad > 0));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        fail("no command");
    };
    let arg = |i: usize| args.get(i).map(String::as_str);

    match cmd {
        "--self-test" => self_test(),
        "--help" | "-h" => {
            println!("yomna-hands (Linux): front | windows | locate | select | capture | act | ui | locate-control | find-text | --self-test");
            std::process::exit(0);
        }
        "trusted" => out(json!({ "ok": true, "trusted": true })),
        "guide" | "screencheck" => {
            out(json!({ "ok": false, "unsupported": true, "error": "Not needed on Linux." }))
        }
        "front" => match front_window() {
            Some(w) => out(front_info(&w)),
            None => out(json!({ "ok": true })),
        },
        "windows" => {
            let list: Vec<Value> = windows().iter().take(30).map(win_list_item).collect();
            out(json!({ "ok": true, "windows": list }))
        }
        "locate" => {
            let Some(t) = arg(1) else {
                fail("usage: locate <target>");
            };
            if t == "screen" {
                out(json!({ "ok": true, "what": "screen" }));
            }
            let Some(w) = resolve(t) else {
                fail(&no_window(t));
            };
            out(json!({ "ok": true, "window": win_info(&w) }))
        }
        "select" => match run_select(arg(1)) {
            Ok(SelectOutcome::Selected { path, bounds }) => out(json!({
                "ok": true,
                "path": path,
                "file": path,
                "bounds": bounds.to_obj()
            })),
            Ok(SelectOutcome::Cancelled) => out(json!({ "ok": false, "cancelled": true })),
            Err(e) => fail(&e),
        },
        "capture" => {
            let (Some(file), Some(target)) = (arg(1), arg(2)) else {
                fail("usage: capture <out> <target> [max]");
            };
            let max_dim = arg(3).and_then(|s| s.parse::<u32>().ok());
            match capture_target(file, target, max_dim) {
                Ok(v) => out(v),
                Err(e) => fail(&e),
            }
        }
        "act" => {
            let plan_arg = if arg(1) == Some("--json") { arg(2) } else { arg(1) };
            let Some(plan) = plan_arg else {
                fail("usage: act <json> | act --json '<plan>'");
            };
            match run_act(plan) {
                Ok(v) | Err(v) => out(v),
            }
        }
        "ui" => {
            let target = arg(1).unwrap_or("front");
            let Some(w) = resolve(target) else {
                fail(&no_window(target));
            };
            let tree = read_window_ui(&w);
            let controls: Vec<Value> = tree.controls.iter().map(|c| c.to_json()).collect();
            if arg(2) == Some("controls") {
                out(json!({
                    "ok": true,
                    "window": win_info(&w),
                    "controls": controls,
                    "note": tree.note
                }));
            }
            out(json!({
                "ok": true,
                "window": win_info(&w),
                "controls": controls,
                "texts": tree.texts,
                "note": tree.note
            }))
        }
        "locate-control" => {
            let (Some(target), Some(id)) = (arg(1), arg(2).and_then(|s| s.parse::<usize>().ok()))
            else {
                fail("usage: locate-control <target> <id>");
            };
            let Some(w) = resolve(target) else {
                fail(&no_window(target));
            };
            let tree = read_window_ui(&w);
            if id < 1 || id > tree.controls.len() {
                fail(&format!("No control {id} in {}. Read the window again.", w.app));
            }
            out(json!({
                "ok": true,
                "window": win_info(&w),
                "control": tree.controls[id - 1].to_json()
            }))
        }
        "find-text" => {
            let (Some(target), Some(q)) = (arg(1), arg(2)) else {
                fail("usage: find-text <target> <text>");
            };
            let wins: Vec<_> = if target == "screen" {
                windows()
            } else {
                resolve(target).into_iter().collect()
            };
            if wins.is_empty() {
                fail(&no_window(target));
            }
            let mut all = Vec::new();
            for w in wins.iter().take(8) {
                for mut m in find_text_matches(w, q) {
                    m["window"] = win_info(w);
                    all.push(m);
                }
            }
            out(json!({ "ok": true, "matches": all.into_iter().take(8).collect::<Vec<_>>() }))
        }
        "ocr-find" => {
            let (Some(t), Some(q)) = (arg(1), arg(2)) else {
                fail("usage: ocr-find <target> <text> [all]");
            };
            let all = arg(3) == Some("all");
            let matches = ocr::ocr_find_target(t, q, all);
            out(json!({ "ok": true, "matches": matches }))
        }
        "refine" => {
            let Some(raw) = arg(1) else {
                fail("usage: refine '[[x,y,w,h],...]' [window:<id>]");
            };
            let count = serde_json::from_str::<Vec<Value>>(raw)
                .map(|v| v.len())
                .unwrap_or(0);
            out(json!({ "ok": true, "boxes": vec![Value::Null; count] }))
        }
        other => fail(&format!("unknown command {other}")),
    }
}
