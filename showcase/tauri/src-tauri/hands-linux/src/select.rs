//! Interactive region selection (`slurp` + `grim`) and window/screen capture.

use crate::hyprland::{
    focus_window, is_hyprland, is_wayland, no_window, resolve, screen_bounds, win_info, Rect,
};
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, PartialEq, Eq)]
pub enum SelectOutcome {
    Selected { path: String, bounds: Rect },
    Cancelled,
}

/// Parses `"x,y wxh"` output from `slurp -d -f "%x,%y %wx%h"` (or `slop`).
pub fn parse_slurp_geometry(raw: &str) -> Result<Rect, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("empty selection geometry".to_string());
    }
    let mut parts = s.split_whitespace();
    let (Some(pos), Some(dim), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(format!("invalid selection geometry: {s:?}"));
    };
    let Some((xs, ys)) = pos.split_once(',') else {
        return Err(format!("invalid selection origin: {pos:?}"));
    };
    let Some((ws, hs)) = dim.split_once('x').or_else(|| dim.split_once('X')) else {
        return Err(format!("invalid selection dimensions: {dim:?}"));
    };
    let x: i32 = xs.parse().map_err(|_| format!("invalid x: {xs:?}"))?;
    let y: i32 = ys.parse().map_err(|_| format!("invalid y: {ys:?}"))?;
    let w: i32 = ws.parse().map_err(|_| format!("invalid width: {ws:?}"))?;
    let h: i32 = hs.parse().map_err(|_| format!("invalid height: {hs:?}"))?;
    if w <= 0 || h <= 0 {
        return Err(format!("selection has non-positive size: {w}x{h}"));
    }
    Ok(Rect::new(x, y, w, h))
}

fn default_crop_path() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::env::temp_dir()
        .join(format!("yomna-crop-{}-{ms}.png", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

fn ensure_parent(path: &str) {
    if let Some(p) = Path::new(path).parent() {
        if !p.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(p);
        }
    }
}

fn wayland_session() -> bool {
    is_wayland() || is_hyprland()
}

pub fn run_select(out_path: Option<&str>) -> Result<SelectOutcome, String> {
    let dest = out_path
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_crop_path);
    ensure_parent(&dest);

    if wayland_session() {
        let slurp = Command::new("slurp")
            .args(["-d", "-f", "%x,%y %wx%h"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| {
                if e.kind() == ErrorKind::NotFound {
                    "slurp is not installed. Install slurp and grim for interactive area selection on Wayland.".to_string()
                } else {
                    format!("failed to run slurp: {e}")
                }
            })?;

        if !slurp.status.success() {
            return Ok(SelectOutcome::Cancelled);
        }
        let geom_str = String::from_utf8_lossy(&slurp.stdout);
        let bounds = parse_slurp_geometry(&geom_str)?;
        let grim_geom = format!("{},{} {}x{}", bounds.x, bounds.y, bounds.w, bounds.h);
        let fmt = if dest.to_ascii_lowercase().ends_with(".jpg") || dest.to_ascii_lowercase().ends_with(".jpeg") {
            "jpeg"
        } else {
            "png"
        };
        let mut cmd = Command::new("grim");
        cmd.args(["-g", &grim_geom, "-t", fmt]);
        if fmt == "jpeg" {
            cmd.args(["-q", "85"]);
        }
        cmd.arg(&dest);
        let grim = cmd.stdin(Stdio::null()).output().map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                "grim is not installed. Install grim for screenshot capture on Wayland.".to_string()
            } else {
                format!("failed to run grim: {e}")
            }
        })?;
        if !grim.status.success() {
            let err = String::from_utf8_lossy(&grim.stderr);
            return Err(format!("grim failed: {}", err.trim()));
        }
        return Ok(SelectOutcome::Selected { path: dest, bounds });
    }

    // X11 fallback: slop + maim or import
    let slop = Command::new("slop")
        .args(["-f", "%x,%y %wx%h"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                "slop is not installed. Install slop and maim (or ImageMagick import) for interactive area selection on X11.".to_string()
            } else {
                format!("failed to run slop: {e}")
            }
        })?;
    if !slop.status.success() {
        return Ok(SelectOutcome::Cancelled);
    }
    let bounds = parse_slurp_geometry(&String::from_utf8_lossy(&slop.stdout))?;
    let x11_geom = format!("{}x{}+{}+{}", bounds.w, bounds.h, bounds.x, bounds.y);
    x11_capture_region(&dest, Some(&x11_geom))?;
    Ok(SelectOutcome::Selected { path: dest, bounds })
}

fn x11_capture_region(dest: &str, x11_geom: Option<&str>) -> Result<(), String> {
    let mut maim = Command::new("maim");
    if let Some(g) = x11_geom {
        maim.args(["-g", g]);
    }
    maim.arg(dest).stdin(Stdio::null());
    match maim.output() {
        Ok(o) if o.status.success() => return Ok(()),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            return Err(format!("maim capture failed: {}", err.trim()));
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("failed to run maim: {e}")),
    }

    let mut imp = Command::new("import");
    imp.args(["-window", "root"]);
    if let Some(g) = x11_geom {
        imp.args(["-crop", g, "+repage"]);
    }
    imp.arg(dest).stdin(Stdio::null());
    match imp.output() {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(format!("import capture failed: {}", String::from_utf8_lossy(&o.stderr).trim())),
        Err(e) if e.kind() == ErrorKind::NotFound => Err(
            "No X11 screenshot tool found. Install maim or ImageMagick (import) for X11 capture.".to_string(),
        ),
        Err(e) => Err(format!("failed to run import: {e}")),
    }
}

pub fn image_dimensions(path: &str) -> Option<[u32; 2]> {
    let data = std::fs::read(path).ok()?;
    parse_png_dims(&data).or_else(|| parse_jpeg_dims(&data))
}

fn parse_png_dims(data: &[u8]) -> Option<[u32; 2]> {
    if data.len() < 24 || &data[0..8] != b"\x89PNG\r\n\x1a\n" || &data[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    (w > 0 && h > 0).then_some([w, h])
}

fn parse_jpeg_dims(data: &[u8]) -> Option<[u32; 2]> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 1 < data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        while i < data.len() && data[i] == 0xFF {
            i += 1;
        }
        if i >= data.len() {
            break;
        }
        let marker = data[i];
        i += 1;
        if marker == 0xD9 || marker == 0x00 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            continue;
        }
        if i + 2 > data.len() {
            break;
        }
        let len = u16::from_be_bytes([data[i], data[i + 1]]) as usize;
        if len < 2 || i + len > data.len() {
            break;
        }
        let is_sof = matches!(
            marker,
            0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF
        );
        if is_sof && len >= 7 {
            let h = u16::from_be_bytes([data[i + 3], data[i + 4]]) as u32;
            let w = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
            return (w > 0 && h > 0).then_some([w, h]);
        }
        i += len;
    }
    None
}

fn maybe_downscale(path: &str, max_dim: u32) {
    let Some([w, h]) = image_dimensions(path) else { return };
    if w.max(h) <= max_dim {
        return;
    }
    let scale_expr = if w >= h {
        format!("scale={max_dim}:-2")
    } else {
        format!("scale=-2:{max_dim}")
    };
    let tmp = format!("{path}.tmp.{}", if path.to_ascii_lowercase().ends_with(".png") { "png" } else { "jpg" });
    let ff = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i", path, "-vf", &scale_expr, &tmp])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if ff.is_ok_and(|s| s.success()) && Path::new(&tmp).is_file() {
        let _ = std::fs::rename(&tmp, path);
        return;
    }
    let _ = std::fs::remove_file(&tmp);

    let magick_arg = format!("{max_dim}x{max_dim}>");
    for tool in ["magick", "convert"] {
        let st = Command::new(tool)
            .args([path, "-resize", &magick_arg, path])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if st.is_ok_and(|s| s.success()) {
            return;
        }
    }
}

pub fn capture_target(out_path: &str, target: &str, max_dim: Option<u32>) -> Result<Value, String> {
    ensure_parent(out_path);
    let fmt = if out_path.to_ascii_lowercase().ends_with(".png") {
        "png"
    } else {
        "jpeg"
    };

    let (geom, mut out_json) = if target == "screen" {
        let sb = screen_bounds();
        (
            None,
            json!({
                "ok": true,
                "file": out_path,
                "path": out_path,
                "what": "screen",
                "bounds": sb.to_arr(),
            }),
        )
    } else {
        let w = resolve(target).ok_or_else(|| no_window(target))?;
        if !w.focused && target != "front" {
            let _ = focus_window(&w);
        }
        let g = (w.bounds.x, w.bounds.y, w.bounds.w, w.bounds.h);
        (
            Some(g),
            json!({
                "ok": true,
                "file": out_path,
                "path": out_path,
                "window": win_info(&w),
            }),
        )
    };

    if wayland_session() {
        let mut cmd = Command::new("grim");
        if let Some((x, y, w, h)) = geom {
            cmd.args(["-g", &format!("{x},{y} {w}x{h}")]);
        }
        cmd.args(["-t", fmt]);
        if fmt == "jpeg" {
            cmd.args(["-q", "85"]);
        }
        cmd.arg(out_path).stdin(Stdio::null());
        let out = cmd.output().map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                "grim is not installed. Install grim for screenshot capture on Wayland.".to_string()
            } else {
                format!("failed to run grim: {e}")
            }
        })?;
        if !out.status.success() {
            return Err(format!("grim failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    } else {
        let x11_geom = geom.map(|(x, y, w, h)| format!("{w}x{h}+{x}+{y}"));
        x11_capture_region(out_path, x11_geom.as_deref())?;
    }

    if let Some(m) = max_dim {
        maybe_downscale(out_path, m);
    }
    if let Some(px) = image_dimensions(out_path) {
        out_json["pixels"] = json!(px);
    }
    Ok(out_json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_slurp_geometries() {
        assert_eq!(parse_slurp_geometry("100,200 640x480\n").unwrap(), Rect::new(100, 200, 640, 480));
        assert_eq!(parse_slurp_geometry("-1920,0 800x600").unwrap(), Rect::new(-1920, 0, 800, 600));
        assert!(parse_slurp_geometry("").is_err());
        assert!(parse_slurp_geometry("10,20 0x100").is_err());
        assert!(parse_slurp_geometry("bad").is_err());
    }
}
