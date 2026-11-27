// Voice helper (macOS: Apple speech; Windows: Parakeet on the PC) and the global shortcuts.

use super::*;
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::process::Child;
use std::sync::atomic::AtomicU32;

/// Id of the registered show/hide hotkey, read by the hotkey event handler.
static SUMMON_ID: AtomicU32 = AtomicU32::new(0);
/// Id of the registered "ask about an area" hotkey.
static SNAP_ID: AtomicU32 = AtomicU32::new(0);
static LIST_ID: AtomicU32 = AtomicU32::new(0);
/// Id of the Esc hotkey, held only while Yomna is on screen (0 when it isn't).
static ESC_ID: AtomicU32 = AtomicU32::new(0);

thread_local! {
    // The hotkey manager must live on the main thread; it also owns the current show/hide hotkey.
    static HOTKEYS: RefCell<Option<(global_hotkey::GlobalHotKeyManager, [Option<global_hotkey::hotkey::HotKey>; 3])>> = const { RefCell::new(None) };
    // The overlays that have Yomna (or its card, or its ask field) on screen right now.
    static ESC_UP: RefCell<std::collections::HashSet<String>> = RefCell::new(std::collections::HashSet::new());
}

pub(crate) fn voice_binary() -> Option<PathBuf> {
    helper_binary("yomna-voice")
}

pub(crate) fn start_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    if state.0.lock().unwrap().is_some() {
        return;
    }
    let Some(bin) = voice_binary() else {
        eprintln!("voice helper not found next to the app binary");
        return;
    };
    let chord = app.state::<TalkChord>().0.lock().unwrap().join(",");
    let mut cmd = Command::new(bin);
    cmd.arg("--chord").arg(chord);
    if cfg!(target_os = "macos") {
        let highlight = app.state::<HighlightChord>().0.lock().unwrap().join(",");
        cmd.arg("--highlight").arg(if highlight.is_empty() { "off".to_owned() } else { highlight });
    }
    if let Some(dir) = app.state::<VoiceModel>().0.lock().unwrap().clone() {
        cmd.arg("--model").arg(dir);
    }
    // Debug builds: YOMNA_TEST_AUDIO=<wav> stands in for the microphone, to test talking with no mic (CI, Docker).
    #[cfg(debug_assertions)]
    if let Some(wav) = std::env::var_os("YOMNA_TEST_AUDIO") {
        cmd.arg("--test-audio").arg(wav);
    }
    let mut child = match hide_console(&mut cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log_stdio("yomna-voice.log")).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("voice helper failed to start: {e}");
            return;
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let pid = child.id();
    *state.0.lock().unwrap() = Some(child);
    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            // Live mode: mic frames (25-50 a second) and the call's tap go straight to the sidecar from this thread,
            // not through the main thread or the setup guide.
            if let Some(m) = live_line(&msg) {
                to_sidecar(&app, &m);
                continue;
            }
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || handle_voice(&app2, msg));
        }
        // Exited: anything it was drawing is gone, so the page draws the sidekick again.
        {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || to_sidekick_buddy(&app2, &json!({ "state": "gone" })));
        }
        // If it is still the wanted helper, it died on its own: retry a few times.
        let state = app.state::<Voice>();
        let ours = {
            let mut slot = state.0.lock().unwrap();
            let ours = slot.as_ref().map(Child::id) == Some(pid);
            if ours {
                if let Some(mut c) = slot.take() {
                    let _ = c.wait();
                }
            }
            ours
        };
        if ours && state.1.fetch_add(1, Ordering::Relaxed) < 3 {
            thread::sleep(Duration::from_secs(1));
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || start_voice(&app2));
        }
    });
}

pub(crate) fn stop_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    let child = state.0.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    to_overlays(app, &json!({ "kind": "voice", "type": "state", "state": "idle" }));
}

pub(crate) fn to_voice(app: &AppHandle, msg: &Value) {
    if let Some(child) = app.state::<Voice>().0.lock().unwrap().as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = writeln!(stdin, "{msg}");
        }
    }
}

/// Tell the voice helper to drop a talk-chord press that turned out to be the show/hide shortcut.
fn cancel_voice(app: &AppHandle) {
    to_voice(app, &json!({ "cmd": "cancel" }));
}

/// Show/hide shortcut (default ⌃⌥S): brings the sidekick forward, or sends it away if it's out.
/// Must run on the main thread.
pub(crate) fn init_hotkeys(app: &AppHandle) {
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
    match GlobalHotKeyManager::new() {
        Ok(m) => HOTKEYS.with(|h| *h.borrow_mut() = Some((m, [None, None, None]))),
        Err(e) => return eprintln!("hotkeys unavailable: {e}"),
    }
    let app = app.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
        if e.state() != HotKeyState::Pressed {
            return;
        }
        let summon = e.id() == SUMMON_ID.load(Ordering::Relaxed);
        let snap = e.id() == SNAP_ID.load(Ordering::Relaxed);
        let list = e.id() == LIST_ID.load(Ordering::Relaxed);
        let esc = e.id() != 0 && e.id() == ESC_ID.load(Ordering::Relaxed);
        if esc {
            // The panel has the keyboard: Esc closes it, as it would without this hotkey.
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                let panel = app2.get_webview_window(PANEL_LABEL).filter(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
                if panel.is_some() {
                    hide_panel(&app2, "esc");
                } else {
                    to_overlays(&app2, &json!({ "kind": "esc" }));
                }
            });
            return;
        }
        if !summon && !snap && !list {
            return;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Both shortcuts share modifiers with the talk chord; that press wasn't a request to talk.
            cancel_voice(&app2);
            if summon {
                to_overlays(&app2, &json!({ "kind": "summon" }));
            } else if list {
                to_sidecar(&app2, &json!({ "type": "show_list" }));
            } else {
                to_sidecar(&app2, &json!({ "type": "snap" }));
            }
        });
    }));
}

/// Swaps one global shortcut (0 = show/hide, 1 = ask about an area, 2 = show the list). On failure (bad format, or
/// another app owns it) the old one stays.
pub(crate) fn set_hotkey(slot: usize, accel: &str) -> Result<(), String> {
    use global_hotkey::hotkey::HotKey;
    let new: HotKey = accel.parse().map_err(|e| format!("{e}"))?;
    let id_slot = [&SUMMON_ID, &SNAP_ID, &LIST_ID][slot];
    HOTKEYS.with(|h| {
        let mut h = h.borrow_mut();
        let Some((manager, keys)) = h.as_mut() else { return Err("hotkeys unavailable".to_string()) };
        let current = keys[slot];
        if current.map(|c| c.id()) == Some(new.id()) {
            return Ok(());
        }
        if keys.iter().enumerate().any(|(i, k)| i != slot && k.map(|c| c.id()) == Some(new.id())) {
            return Err("already used by the other Yomna shortcut".to_string());
        }
        if let Some(old) = current {
            let _ = manager.unregister(old);
        }
        match manager.register(new) {
            Ok(()) => {
                keys[slot] = Some(new);
                id_slot.store(new.id(), Ordering::Relaxed);
                Ok(())
            }
            Err(e) => {
                if let Some(old) = current {
                    let _ = manager.register(old);
                }
                Err(format!("{e}"))
            }
        }
    })
}

/// Esc stops Yomna's answer, or sends it away when it's idle (overlay host.js decides which). Global, so it
/// works without clicking Yomna first; that means other apps don't get Esc meanwhile, so it's held only
/// while some overlay has Yomna on screen. Must run on the main thread.
pub(crate) fn set_esc(app: &AppHandle, label: &str, on: bool) {
    use global_hotkey::hotkey::{Code, HotKey};
    let any = ESC_UP.with(|up| {
        let mut up = up.borrow_mut();
        if on {
            up.insert(label.to_owned());
        } else {
            up.remove(label);
        }
        // An overlay that closed (its screen went away) can't say it's done.
        up.retain(|l| app.get_webview_window(l).is_some());
        !up.is_empty()
    });
    HOTKEYS.with(|h| {
        let mut h = h.borrow_mut();
        let Some((manager, _)) = h.as_mut() else { return };
        let key = HotKey::new(None, Code::Escape);
        let held = ESC_ID.load(Ordering::Relaxed) != 0;
        if any && !held {
            match manager.register(key) {
                Ok(()) => ESC_ID.store(key.id(), Ordering::Relaxed),
                Err(e) => eprintln!("esc hotkey: {e}"),
            }
        } else if !any && held {
            let _ = manager.unregister(key);
            ESC_ID.store(0, Ordering::Relaxed);
            // global-hotkey's X11 backend queues the ungrab without sending it, so Esc stayed grabbed from every app
            // until the next registration grabbed it again (#67). Registering anything sends the queue: a combo no one
            // presses (it stays registered, so later calls only send the queue and report it's already there).
            #[cfg(target_os = "linux")]
            {
                use global_hotkey::hotkey::Modifiers;
                let _ = manager.register(HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER), Code::F12));
            }
        }
    });
}

/// Helper lines that go straight to the sidecar: `pcm` (16 kHz 16-bit mono, base64) becomes `live_pcm`;
/// `live_toggle` (a tap of the talk chord: open or hang up the call), `live_wake` (the wake word: open one),
/// `live_open` (the highlight keys held in Live: open the call so it listens), `live_cancel` (that hold was a shortcut:
/// hang up the call it opened), `live_look` (a circle drawn with the
/// highlight keys in Live, with the circled area) and `highlight` (a Classic circle with no words yet, with its area)
/// pass as is; and `sleep` (the Mac is going to sleep) becomes `system_sleep`.
fn live_line(msg: &Value) -> Option<Value> {
    match msg.get("type").and_then(Value::as_str) {
        Some("pcm") => Some(json!({ "type": "live_pcm", "data": msg.get("data") })),
        Some("live_toggle") => Some(json!({ "type": "live_toggle" })),
        // The wake word heard in Live mode with no call open: the sidecar opens one.
        Some("live_wake") => Some(json!({ "type": "live_wake" })),
        Some("live_open") => Some(json!({ "type": "live_open" })),
        // That hold was a shortcut after all: the sidecar hangs up the call it opened.
        Some("live_cancel") => Some(json!({ "type": "live_cancel" })),
        // A circle drawn with the highlight keys in a call: the circled shot goes in as a look.
        Some("live_look") => Some(json!({ "type": "live_look", "area": msg.get("area") })),
        // Classic: a circle with nothing said yet; the sidecar listens for the question about it.
        Some("highlight") => Some(json!({ "type": "highlight", "area": msg.get("area") })),
        // The Mac is going to sleep: the sidecar hangs up an open Live call.
        Some("sleep") => Some(json!({ "type": "system_sleep" })),
        _ => None,
    }
}

/// The sidecar's keybinds: the highlight pair for the voice helper (macOS), or none when it is off or missing.
pub(crate) fn highlight_mods(msg: &Value) -> Vec<String> {
    let mods: Vec<String> = msg.get("highlight").and_then(Value::as_array).map(|m| m.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    if mods.len() == 2 { mods } else { Vec::new() }
}

fn handle_voice(app: &AppHandle, msg: Value) {
    let mut ui = msg.clone();
    ui["kind"] = json!("voice");
    if msg.get("type").and_then(Value::as_str) == Some("buddy") {
        to_sidekick_buddy(app, &msg);
        return;
    }
    // A click in another app while a drawing is up (see watch_clicks); not one on Yomna's own cards.
    if msg.get("type").and_then(Value::as_str) == Some("click") {
        if !crate::OVERLAY_HOT.load(Ordering::Relaxed) {
            to_sidecar(app, &json!({ "type": "user_click", "x": msg.get("x"), "y": msg.get("y"), "role": msg.get("role"), "app": msg.get("app"), "acts": msg.get("acts") }));
        }
        return;
    }
    if msg.get("type").and_then(Value::as_str) == Some("ready") {
        app.state::<Voice>().1.store(0, Ordering::Relaxed);
        // A started (or restarted) helper doesn't know the picked mic yet: the sidecar sends it again.
        to_sidecar(app, &json!({ "type": "voice_ready" }));
        return;
    }
    // Windows: the pen trail while circling something (voice-win/src/ink.rs); the overlays draw it, also during setup.
    if msg.get("type").and_then(Value::as_str) == Some("ink") {
        to_overlays(app, &ui);
        return;
    }
    // While the setup guide is open, talking is just the "try it" test: it never reaches the agent.
    if ONBOARDING.load(Ordering::Relaxed) {
        // Nothing answers here, so the listening pill goes as soon as the words are in.
        if msg.get("type").and_then(Value::as_str) == Some("final") {
            to_voice(app, &json!({ "cmd": "handoff" }));
        }
        to_onboarding(app, &ui);
        return;
    }
    match msg.get("type").and_then(Value::as_str) {
        Some("state") => {
            to_overlays(app, &ui);
            to_sidecar(app, &json!({ "type": "voice_state", "state": msg.get("state") }));
        }
        Some("partial") | Some("level") => to_overlays(app, &ui),
        Some("final") => {
            to_overlays(app, &ui);
            // area: the part of the screen marked with the pen while talking (a PNG, its rect and the strokes).
            to_sidecar(app, &json!({ "type": "voice", "text": msg.get("text"), "area": msg.get("area"), "ms": msg.get("ms"), "via": msg.get("via") }));
        }
        Some("error") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_error");
            to_sidecar(app, &m);
        }
        // The speech language the helper settled on: its engine, and whether Apple's servers do the recognising.
        Some("lang") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_lang");
            to_sidecar(app, &m);
        }
        // The mic list, for the panel's picker.
        Some("mics") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_mics");
            to_sidecar(app, &m);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_mic_frames_go_to_the_sidecar_as_live_pcm() {
        let msg = json!({ "type": "pcm", "data": "AQACAA==" });
        assert_eq!(live_line(&msg), Some(json!({ "type": "live_pcm", "data": "AQACAA==" })));
    }

    #[test]
    fn sleep_goes_to_the_sidecar_as_system_sleep() {
        assert_eq!(live_line(&json!({ "type": "sleep" })), Some(json!({ "type": "system_sleep" })));
    }

    #[test]
    fn a_live_tap_goes_to_the_sidecar() {
        assert_eq!(live_line(&json!({ "type": "live_toggle" })), Some(json!({ "type": "live_toggle" })));
    }

    #[test]
    fn a_live_wake_goes_to_the_sidecar() {
        assert_eq!(live_line(&json!({ "type": "live_wake" })), Some(json!({ "type": "live_wake" })));
    }

    #[test]
    fn a_live_circle_goes_to_the_sidecar_with_its_area() {
        let area = json!({ "file": "/tmp/sidekick-marked-1.png", "rect": [0, 0, 320, 220], "strokes": [[[1, 2]]] });
        assert_eq!(live_line(&json!({ "type": "live_look", "area": area })), Some(json!({ "type": "live_look", "area": area })));
    }

    #[test]
    fn a_highlight_hold_in_live_opens_the_call() {
        assert_eq!(live_line(&json!({ "type": "live_open" })), Some(json!({ "type": "live_open" })));
    }

    #[test]
    fn a_highlight_hold_that_was_a_shortcut_cancels_the_call_it_opened() {
        assert_eq!(live_line(&json!({ "type": "live_cancel" })), Some(json!({ "type": "live_cancel" })));
    }

    #[test]
    fn a_classic_highlight_with_no_words_goes_to_the_sidecar_with_its_area() {
        let area = json!({ "file": "/tmp/sidekick-marked-2.png", "rect": [0, 0, 320, 220], "strokes": [[[1, 2]]] });
        assert_eq!(live_line(&json!({ "type": "highlight", "area": area })), Some(json!({ "type": "highlight", "area": area })));
    }

    #[test]
    fn the_keybinds_highlight_pair_goes_to_the_helper() {
        let on = json!({ "type": "keybinds", "talk": ["control", "option"], "highlight": ["control", "command"] });
        assert_eq!(highlight_mods(&on), vec!["control".to_owned(), "command".to_owned()]);
        // Off (both fallbacks taken), missing (not a Mac) or not a pair: no highlight keys.
        for off in [json!({ "highlight": null }), json!({}), json!({ "highlight": ["control"] }), json!({ "highlight": "control+command" })] {
            assert!(highlight_mods(&off).is_empty(), "{off}");
        }
    }

    #[test]
    fn other_helper_lines_take_the_usual_path() {
        assert_eq!(live_line(&json!({ "type": "final", "text": "hi" })), None);
    }
}
