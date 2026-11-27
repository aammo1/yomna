# Task 10: Rebrand Desktop Overlay to Yomna, Prune Dead Code, and Fix Arabic/Darija RTL

## Status

complete

## Wave

3

## Description

Rebrand the desktop overlay webview (`showcase/desktop.html` and `showcase/jarvis/*`) to **Yomna**, prune ~550 LOC of orphaned legacy Roamies dead code (`core.js` unused creature painters, `agent.js` unused dot-matrix glyph rasterizer, `people.js` unused `ken` hologram sprite), and fix **Arabic / Moroccan Darija RTL & BiDi text rendering** inside both canvas speech bubbles (`agent.js`) and DOM research cards (`agent-panel.js`).

## Dependencies

**Depends on:** `task-02-rust-shell-rebrand-and-csp.md`
**Blocks:** `task-12-build-wiring-and-omarchy-packaging.md`

**Context from dependencies:** `task-02` updated the Rust shell to enforce a strict Tauri CSP and inject `window.YOMNA_LINUX` (alongside `window.JARVIS_LINUX` during migration). This task owns `showcase/desktop.html` and `showcase/jarvis/*` exclusively (zero overlap with `task-11` which owns `showcase/panel/*` and `showcase/onboarding/*`).

## Files to Create

- None.

## Files to Modify

- `showcase/desktop.html` — Update `<title>Yomna</title>`, ensure CSP compliance (no remote script URLs), keep bundled `Readex Pro` Arabic font preload.
- `showcase/jarvis/core.js` — Expose `window.Yomna` (aliasing `window.Jarvis = window.Yomna` only for backwards-compatible internal script load order within `showcase/jarvis/` until all scripts migrate cleanly, or migrate all references in this task), and delete ~450 LOC of confirmed dead Roamies code: `R.drawEyes` (lines 164–214), `R.drawMouth` (217–253), `R.drawEyesPro` (256–356), `R.drawMouthPro` (359–402), `R.drawVisorEyes` (405–445), `R.blobPath` (448–458), `R.noise` (461–462), `ICON` (464–467), and `R.boot` multi-card gallery booter (711–856).
- `showcase/jarvis/jarvis.js` — Rename default orb look id `'jarvis'` → `'yomna'` (while accepting `'jarvis'` as a fallback alias in `10-dither.js` / `core.js` if needed), update comment header to describe Yomna's glowing orb.
- `showcase/jarvis/people.js` — Delete the dead `ken` hologram sprite & eye tables (lines 156–180, 215–219, 322, 328, 365; `"Ken Kai, who made Roamies"`), keeping the 5 selectable looks (`sarah`, `adrian`, `rita`, `ultren`, `glayos`).
- `showcase/jarvis/agent.js` — Delete dead `glyph()` and `emojiGlyph()` functions (lines 9–62); fix **Arabic / Darija RTL & BiDi rendering** in `wrapLines()` (lines 542–558) and `drawBubble()` (lines 704–725):
  - Detect RTL paragraphs (`const isRtl = (s) => /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(s);`).
  - Use `Intl.Segmenter` (word granularity fallback to whitespace) so mixed Arabic/Darija + English tech words wrap cleanly without clipping.
  - Set `ctx.direction = rtl ? 'rtl' : 'ltr'` and `ctx.textAlign = rtl ? 'right' : 'left'`, drawing from `bx + bw - PAD_X` when RTL vs `bx + PAD_X` when LTR, then restoring `ctx.direction = 'ltr'` and `ctx.textAlign = 'left'`.
- `showcase/jarvis/host.js` — Read `window.YOMNA_LINUX || window.JARVIS_LINUX`, fix RTL caret measurement (line 97) when the hidden `<input>` holds Arabic text, add handling for `{ kind: 'harness_error', reason, message, suggestSwitch }` to show a clickable **"Switch Harness"** button inside the bubble, and rename default look `'yomna'`.
- `showcase/jarvis/agent-panel.js` — Add `dir="auto"` to `.rp` research card container and markdown blocks so Arabic/Darija paragraphs align right automatically while English code blocks stay `dir="ltr"`; rename `localStorage` key `'jarvis.cardPos'` → `'yomna.cardPos'` and remove legacy `'roamies.cardPos'` cleanup (line 130).
- `showcase/jarvis/sfx.js` — Rename `localStorage` key to `'yomna-sound'` and remove legacy `'roamie-sound'` fallback (lines 9–10).

## Technical Details

### Implementation Steps

1. **RTL Canvas Bubble Helper (`showcase/jarvis/agent.js`):**
   ```js
   const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
   const hasRtl = (s) => RTL_RE.test(String(s ?? ''));
   ```
   Inside `drawBubble` loop over wrapped lines:
   ```js
   const rtl = hasRtl(ln);
   ctx.save();
   ctx.direction = rtl ? 'rtl' : 'ltr';
   ctx.textAlign = rtl ? 'right' : 'left';
   ctx.fillText(ln, rtl ? bx + bw - PAD_X : bx + PAD_X, ly);
   ctx.restore();
   ```
   Ensure `Readex Pro` stays early in the canvas font stack (`'Readex Pro', 'Martian Mono', system-ui, sans-serif`) whenever `hasRtl(text)` is true so Arabic glyphs never fall back to broken system bitmap fonts.
2. **DOM Research Card BiDi (`showcase/jarvis/agent-panel.js`):**
   - Set `body.setAttribute('dir', 'auto')` on the `.rp` content element and explicitly `codeEl.setAttribute('dir', 'ltr')` on `<pre>` / `<code>` elements so mixed Darija + code replies look crisp.
3. **Prune dead code safely:**
   - Before removing `R.drawEyes*`, `R.boot`, `glyph()`, `emojiGlyph()`, and `people.ken`, run `grep -rn` across `showcase/` to confirm zero active callers remain.
4. **Verify syntax** with `node --check showcase/jarvis/*.js`.

## Acceptance Criteria

- [ ] Arabic and Moroccan Darija strings render right-aligned with `ctx.direction = 'rtl'` and `Readex Pro` inside `agent.js` speech bubbles, while English strings render left-aligned and `<pre>/<code>` stays LTR in `agent-panel.js`.
- [ ] Dead Roamies code (`core.js` unused painters + `R.boot`, `agent.js` `glyph`/`emojiGlyph`, `people.js` `ken` sprite) is removed with zero runtime regressions.
- [ ] `grep -rnIiE "roamie|ken kai|erictech" showcase/desktop.html showcase/jarvis/` returns 0 matches.
- [ ] `node --check showcase/jarvis/*.js` exits `0`.
