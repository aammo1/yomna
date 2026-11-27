# Task 01: Debloat Repo Media and Rebrand Root Documentation

## Status

complete

## Wave

1

## Description

Purge ~51 MB of non-app media bloat inherited from the upstream DevFest talk and paid Fish Audio voice clips (`slides/`, unused `docs/art/hero.{gif,png}`, and `showcase/tauri/sidecar/beats/`), and rewrite all top-level documentation, issue templates, and example settings files for **Yomna** (`aammo1/yomna`). This establishes a clean, legally compliant open-source identity with zero `EricTechPro` or `Claude Code` creator mentions while preserving AGPL-3.0 `LICENSE` and accurate `THIRD_PARTY_NOTICES.md`.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** `task-05-harness-adapter-framework.md`

**Context from dependencies:** None — Wave 1 foundation task.

## Files to Create

- None (modifies existing root docs and removes unused bloat directories/files).

## Files to Modify

- `slides/` — **DELETE** entire directory (`34 MB` DevFest Vancouver 2026 deck, `eric-avatar.jpg`, YouTube/Skool QR codes, `~/EricOS` slides).
- `docs/art/hero.gif` & `docs/art/hero.png` — **DELETE** unreferenced `1.65 MB` legacy assets.
- `showcase/tauri/sidecar/beats/` — **DELETE** entire directory (`15 MB` pre-baked Fish Audio `.pcm` filler clips and `index.json`/`make.mjs`).
- `README.md` — Rewrite for **Yomna** (`aammo1/yomna`), documenting background CLI harnesses (`agy` default, `opencode`, `pi`, `claude`, custom ACP), keyless local voice + optional Gemini Live, Omarchy/Linux + Windows + macOS install commands, placeholders for the owner's YouTube & Skool community links, and zero `EricTechPro` / `Claude Code` creator credits.
- `PRIVACY.md` — Update product name to **Yomna**, data folder to `~/Yomna`, issue link to `https://github.com/aammo1/yomna/issues`, remove `~/.gg/auth.json` / GG Coder / Fish Audio sections, and document CLI harness + local TTS + optional Gemini Live data flow.
- `SECURITY.md` — Point release & security advisory links to `https://github.com/aammo1/yomna/releases/latest` and `https://github.com/aammo1/yomna/security/advisories/new`.
- `CONTRIBUTING.md` — Point clone URL to `https://github.com/aammo1/yomna.git`, remove `EricTechPro` references, document Antigravity/Yomna dev workflow.
- `AGENTS.md` — Rewrite workspace instructions for **Yomna** (harness architecture, `hands-linux`, `yomna-desktop` MCP, no in-app updater, no `~/.gg/auth.json`, updated build commands).
- `THIRD_PARTY_NOTICES.md` — Fix line 3 (`"Roamies is licensed under AGPL-3.0"` → `"Yomna is licensed under AGPL-3.0"`), document upstream Roamies (Ken Kai) lineage accurately for AGPL-3.0 §5 compliance, remove `@kenkaiiii/gg-*` and `@anthropic-ai/claude-agent-sdk` rows, and add Kokoro/Piper local TTS & `@google/genai` rows.
- `.github/ISSUE_TEMPLATE/config.yml` — Point security advisory link to `https://github.com/aammo1/yomna/security/advisories/new`.
- `docs/settings.classic.example.json` — Update schema to harness-based Classic Mode (`"harness": "agy"`, `"voiceMode": "classic"`, `"tts": "local"`, `"allowActions": false`, `"secondBrain": { "root": "~/Notes" }`).
- `docs/settings.live.example.json` — Update schema to Gemini Live + Harness Mode (`"harness": "agy"`, `"voiceMode": "live"`, `"liveModel": "gemini-2.5-flash-native-audio-preview-09-2025"`, `"liveVoice": "Charon"`, `"allowActions": false`, `"secondBrain": { "root": "~/Notes" }`).

## Technical Details

### Implementation Steps

1. Remove dead/bloated directories and files:
   ```bash
   rm -rf slides docs/art/hero.gif docs/art/hero.png showcase/tauri/sidecar/beats
   ```
2. Keep `LICENSE` (AGPL-3.0) **100% untouched** for public GitHub legal compliance.
3. Update `README.md`:
   - Title: `Yomna` (`Talk to your computer like Yomna.`)
   - Community line: `<p>⭐ Star it · <a href="YOUR_YOUTUBE_URL">YouTube</a> · <a href="YOUR_SKOOL_URL">Join the Skool community →</a></p>` (using `YOUR_YOUTUBE_URL` / `YOUR_SKOOL_URL` placeholders unless provided by the owner).
   - Install one-liners pointing to `https://raw.githubusercontent.com/aammo1/yomna/main/get.sh` and `get.ps1`.
   - Harnesses section listing `Antigravity (agy)` (default), `OpenCode`, `Pi`, `Claude Code` (optional runtime harness), and `Custom ACP/CLI` — explicitly stating **no LLM API keys required** for Classic Mode and optional free Google AI Studio key for Gemini Live Mode.
   - Footer: `"Created with Antigravity."` — zero mention of `EricTechPro`, `Eric Tech`, `skool.com/erictech`, or `Claude Code` as creator/contributor.
4. Update `docs/settings.classic.example.json` and `docs/settings.live.example.json` to match the new config keys defined in the Yomna harness architecture.
5. Update `THIRD_PARTY_NOTICES.md` to accurately list: Tauri 2 (MIT/Apache-2.0), Node.js v24.22.2 (MIT), `@google/genai` (Apache-2.0), `zod` (MIT), Parakeet TDT 0.6B v3 ONNX (CC BY 4.0), `parakeet-rs` (MIT/Apache-2.0), Kokoro/Piper local TTS models (Apache-2.0/MIT), bundled fonts Doto / Martian Mono / Readex Pro (OFL 1.1), Natural Earth 1:110m (Public domain), and upstream desktop shell origins (Roamies, AGPL-3.0).

### Code Snippets

`docs/settings.classic.example.json`:
```json
{
  "voiceMode": "classic",
  "harness": "agy",
  "voice": true,
  "replies": "voice",
  "tts": "local",
  "allowActions": false,
  "secondBrain": { "root": "~/Notes" }
}
```

`docs/settings.live.example.json`:
```json
{
  "voiceMode": "live",
  "harness": "agy",
  "liveVoice": "Charon",
  "allowActions": false,
  "secondBrain": { "root": "~/Notes" }
}
```

## Acceptance Criteria

- [ ] `slides/`, `docs/art/hero.gif`, `docs/art/hero.png`, and `showcase/tauri/sidecar/beats/` no longer exist.
- [ ] `grep -rnIiE "erictech|ericwtech|ericos|skool\.com/eric" README.md PRIVACY.md SECURITY.md CONTRIBUTING.md AGENTS.md THIRD_PARTY_NOTICES.md .github/ISSUE_TEMPLATE docs/` returns 0 matches.
- [ ] `LICENSE` remains intact as AGPL-3.0, and `THIRD_PARTY_NOTICES.md` names **Yomna** (not `"Roamies is licensed..."`) with no `@kenkaiiii/gg-*` or `@anthropic-ai/claude-agent-sdk` rows.
- [ ] All GitHub links across root docs and `.github/ISSUE_TEMPLATE/config.yml` point to `https://github.com/aammo1/yomna`.
- [ ] `docs/settings.classic.example.json` and `docs/settings.live.example.json` are valid JSON with `"harness": "agy"`.
