//! Local OCR text finder (`ocr-find`) for Linux via `grim` (or X11 capture) + `tesseract --psm 11 tsv`.
//! Gives `click_text`, `fill`, and `draw` exact logical screen boxes even in apps with no AT-SPI2 tree
//! (Chrome/Electron web pages, canvases, custom toolkits, file explorers).

use crate::hyprland::{resolve, screen_bounds, win_info, Rect, Win};
use crate::select::{capture_target, image_dimensions};
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
struct OcrWord {
    block: i32,
    par: i32,
    line: i32,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    text: String,
}

#[derive(Clone, Debug)]
pub struct OcrMatch {
    pub text: String,
    pub kind: &'static str, // "exact" | "contains"
    pub bounds: Rect,
}

impl OcrMatch {
    pub fn to_json(&self, win: Option<&Win>) -> Value {
        let mut obj = json!({
            "text": self.text,
            "match": self.kind,
            "role": "text",
            "bounds": self.bounds.to_arr(),
        });
        if let Some(w) = win {
            obj["window"] = win_info(w);
        }
        obj
    }
}

struct TempFile(String);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_png_path() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join(format!("yomna-ocr-{}-{ms}-{n}.png", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

fn parse_tsv_words(tsv: &str) -> Vec<OcrWord> {
    let mut words = Vec::new();
    for (idx, line) in tsv.lines().enumerate() {
        if idx == 0 {
            continue; // header
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 12 {
            continue;
        }
        let level: i32 = cols[0].parse().unwrap_or(0);
        if level != 5 {
            continue;
        }
        let conf: f32 = cols[10].parse().unwrap_or(-1.0);
        if conf < 15.0 {
            continue;
        }
        let text = cols[11].trim();
        if text.is_empty() {
            continue;
        }
        let left: i32 = cols[6].parse().unwrap_or(0);
        let top: i32 = cols[7].parse().unwrap_or(0);
        let width: i32 = cols[8].parse().unwrap_or(0);
        let height: i32 = cols[9].parse().unwrap_or(0);
        if width <= 0 || height <= 0 {
            continue;
        }
        words.push(OcrWord {
            block: cols[2].parse().unwrap_or(0),
            par: cols[3].parse().unwrap_or(0),
            line: cols[4].parse().unwrap_or(0),
            left,
            top,
            width,
            height,
            text: text.to_string(),
        });
    }
    words
}

/// Group OCR words into visual lines (merging adjacent words on the same row that `--psm 11` may split across blocks).
fn group_visual_lines(mut words: Vec<OcrWord>) -> Vec<Vec<OcrWord>> {
    words.sort_by_key(|w| (w.top, w.left));
    let mut lines: Vec<Vec<OcrWord>> = Vec::new();

    for w in words {
        let mut placed = false;
        for line in &mut lines {
            if let Some(last) = line.last() {
                let same_ts_line = last.block == w.block && last.par == w.par && last.line == w.line;
                let y_top = last.top.max(w.top);
                let y_bot = (last.top + last.height).min(w.top + w.height);
                let overlap = (y_bot - y_top).max(0);
                let min_h = last.height.min(w.height).max(1);
                let max_h = last.height.max(w.height).max(1);
                let h_gap = w.left - (last.left + last.width);
                let same_visual_row = overlap * 2 >= min_h && h_gap >= -(max_h / 2) && h_gap <= max_h * 2;
                if same_ts_line || same_visual_row {
                    line.push(w.clone());
                    placed = true;
                    break;
                }
            }
        }
        if !placed {
            lines.push(vec![w]);
        }
    }

    for line in &mut lines {
        line.sort_by_key(|w| w.left);
    }
    lines
}

fn norm_token(s: &str) -> String {
    s.trim()
        .trim_matches(|c: char| !c.is_alphanumeric() && !matches!(c, '+' | '-' | '=' | '%' | '.' | '/' | '*' | '@'))
        .to_ascii_lowercase()
}

fn map_box(px: Rect, origin: Rect, img_w: u32, img_h: u32) -> Rect {
    if img_w == 0 || img_h == 0 || origin.is_empty() {
        return px;
    }
    let sx = origin.w as f64 / img_w as f64;
    let sy = origin.h as f64 / img_h as f64;
    let x = origin.x + (px.x as f64 * sx).round() as i32;
    let y = origin.y + (px.y as f64 * sy).round() as i32;
    let w = (px.w as f64 * sx).round().max(8.0) as i32;
    let h = (px.h as f64 * sy).round().max(8.0) as i32;
    Rect::new(x, y, w, h)
}

fn union_words(slice: &[OcrWord]) -> Rect {
    let min_x = slice.iter().map(|w| w.left).min().unwrap_or(0);
    let min_y = slice.iter().map(|w| w.top).min().unwrap_or(0);
    let max_x = slice.iter().map(|w| w.left + w.width).max().unwrap_or(0);
    let max_y = slice.iter().map(|w| w.top + w.height).max().unwrap_or(0);
    Rect::new(min_x, min_y, (max_x - min_x).max(1), (max_y - min_y).max(1))
}

pub fn match_tsv_words(tsv: &str, query: &str, origin: Rect, img_w: u32, img_h: u32, all: bool) -> Vec<OcrMatch> {
    let q_raw = query.trim();
    if q_raw.is_empty() {
        return Vec::new();
    }
    let q_low = q_raw.to_ascii_lowercase();
    let q_tokens: Vec<String> = q_raw
        .split_whitespace()
        .map(norm_token)
        .filter(|s| !s.is_empty())
        .collect();
    if q_tokens.is_empty() {
        return Vec::new();
    }

    let words = parse_tsv_words(tsv);
    let lines = group_visual_lines(words);
    let mut hits: Vec<(u8, usize, OcrMatch)> = Vec::new();

    for line in &lines {
        let joined: String = line.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
        let joined_low = joined.to_ascii_lowercase();
        let line_tokens: Vec<String> = line.iter().map(|w| norm_token(&w.text)).collect();

        // 1. Exact whole-line match
        if joined_low == q_low || (line_tokens.len() == q_tokens.len() && line_tokens == q_tokens) {
            let bounds = map_box(union_words(line), origin, img_w, img_h);
            hits.push((0, joined.len(), OcrMatch { text: joined, kind: "exact", bounds }));
            continue;
        }

        // 2. Contiguous token sequence match inside the line
        let mut found_phrase = false;
        if q_tokens.len() <= line_tokens.len() {
            for i in 0..=(line_tokens.len() - q_tokens.len()) {
                let exact_seq = (0..q_tokens.len()).all(|j| line_tokens[i + j] == q_tokens[j]);
                let sub_seq = !exact_seq
                    && q_tokens.len() == 1
                    && q_tokens[0].len() >= 2
                    && line_tokens[i].contains(&q_tokens[0]);
                if exact_seq || sub_seq {
                    let slice = &line[i..i + q_tokens.len()];
                    let phrase: String = slice.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
                    let bounds = map_box(union_words(slice), origin, img_w, img_h);
                    let rank = if exact_seq { 1 } else { 2 };
                    let kind = if exact_seq { "exact" } else { "contains" };
                    hits.push((rank, joined.len(), OcrMatch { text: phrase, kind, bounds }));
                    found_phrase = true;
                    if !all {
                        break;
                    }
                }
            }
        }

        // 3. Fallback substring match on joined line (handles punctuation/no-space splits like "HelloBaby" vs "Hello Baby")
        if !found_phrase {
            let q_compact: String = q_low.chars().filter(|c| c.is_alphanumeric()).collect();
            let line_compact: String = joined_low.chars().filter(|c| c.is_alphanumeric()).collect();
            if joined_low.contains(&q_low) || (q_compact.len() >= 3 && line_compact.contains(&q_compact)) {
                let bounds = map_box(union_words(line), origin, img_w, img_h);
                hits.push((3, joined.len(), OcrMatch { text: joined, kind: "contains", bounds }));
            }
        }
    }

    hits.sort_by_key(|(rank, len, m)| (*rank, *len, m.bounds.y, m.bounds.x));

    // Deduplicate overlapping boxes
    let mut out: Vec<OcrMatch> = Vec::new();
    let cap = if all { 16 } else { 8 };
    for (_, _, m) in hits {
        let dup = out.iter().any(|prev| {
            (prev.bounds.mid_x() - m.bounds.mid_x()).abs() <= 10
                && (prev.bounds.mid_y() - m.bounds.mid_y()).abs() <= 10
        });
        if !dup {
            out.push(m);
            if out.len() >= cap {
                break;
            }
        }
    }
    out
}

fn run_tesseract_tsv(img_path: &str, psm: &str) -> Option<String> {
    let out = Command::new("tesseract")
        .args([img_path, "stdout", "--psm", psm, "-l", "eng", "tsv"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Capture `win` and find `query` on its pixels using Tesseract OCR.
pub fn ocr_find_win(win: &Win, query: &str, all: bool) -> Vec<OcrMatch> {
    if query.trim().is_empty() || win.bounds.is_empty() {
        return Vec::new();
    }
    let tmp = TempFile(temp_png_path());
    let target = format!("window:{}", win.id);
    if capture_target(&tmp.0, &target, None).is_err() {
        return Vec::new();
    }
    let Some([img_w, img_h]) = image_dimensions(&tmp.0) else {
        return Vec::new();
    };
    if let Some(tsv) = run_tesseract_tsv(&tmp.0, "11") {
        let hits = match_tsv_words(&tsv, query, win.bounds, img_w, img_h, all);
        if !hits.is_empty() {
            return hits;
        }
    }
    if let Some(tsv) = run_tesseract_tsv(&tmp.0, "3") {
        return match_tsv_words(&tsv, query, win.bounds, img_w, img_h, all);
    }
    Vec::new()
}

/// CLI handler for `ocr-find <target> <query> [all]`.
pub fn ocr_find_target(target: &str, query: &str, all: bool) -> Vec<Value> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    if target == "screen" {
        let tmp = TempFile(temp_png_path());
        if capture_target(&tmp.0, "screen", None).is_err() {
            return Vec::new();
        }
        let Some([img_w, img_h]) = image_dimensions(&tmp.0) else {
            return Vec::new();
        };
        let origin = screen_bounds();
        let mut hits = run_tesseract_tsv(&tmp.0, "11")
            .map(|tsv| match_tsv_words(&tsv, query, origin, img_w, img_h, all))
            .unwrap_or_default();
        if hits.is_empty() {
            hits = run_tesseract_tsv(&tmp.0, "3")
                .map(|tsv| match_tsv_words(&tsv, query, origin, img_w, img_h, all))
                .unwrap_or_default();
        }
        return hits.into_iter().map(|m| m.to_json(None)).collect();
    }

    let Some(w) = resolve(target) else {
        return Vec::new();
    };
    ocr_find_win(&w, query, all)
        .into_iter()
        .map(|m| m.to_json(Some(&w)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_TSV: &str = "\
level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
5\t1\t1\t1\t1\t1\t125\t250\t100\t25\t95.0\tSearch
5\t1\t2\t1\t1\t1\t235\t250\t100\t25\t92.0\tGoogle
5\t1\t3\t1\t1\t1\t500\t600\t125\t30\t96.0\tDocuments
5\t1\t4\t1\t1\t1\t50\t50\t80\t20\t5.0\tnoise
";

    #[test]
    fn maps_fractional_scale_and_merges_visual_lines() {
        // 1.25x scaled window: logical 1512x840 at (12, 12), physical capture 1890x1050.
        let origin = Rect::new(12, 12, 1512, 840);
        let hits = match_tsv_words(SAMPLE_TSV, "Search Google", origin, 1890, 1050, false);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "exact");
        // left 125 / 1.25 = 100 -> +12 = 112; top 250 / 1.25 = 200 -> +12 = 212
        assert_eq!(hits[0].bounds.x, 112);
        assert_eq!(hits[0].bounds.y, 212);

        let docs = match_tsv_words(SAMPLE_TSV, "documents", origin, 1890, 1050, false);
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].text, "Documents");
        assert_eq!(docs[0].bounds, Rect::new(412, 492, 100, 24));

        // Low-confidence noise is ignored
        assert!(match_tsv_words(SAMPLE_TSV, "noise", origin, 1890, 1050, false).is_empty());
    }
}
