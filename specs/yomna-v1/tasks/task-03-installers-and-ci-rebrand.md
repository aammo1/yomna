# Task 03: Rebrand Installers, Build Scripts, and CI/Release Workflows with SHA-256 Verification

## Status

complete

## Wave

1

## Description

Update the one-line installers (`get.sh`, `get.ps1`), build and bundling scripts (`build.sh`, `bundle.sh`, `fetch-node.sh`), and GitHub Actions workflows (`ci.yml`, `release.yml`, `dependabot.yml`) to build, test, and ship **Yomna** (`aammo1/yomna`) with versionless release asset names (`Yomna-linux-x64.AppImage`, `Yomna-windows-x64-setup.exe`, etc.), cryptographic `SHA256SUMS` verification during installation, and first-class Linux CI/release status (removing `continue-on-error: true`).

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** `task-12-build-wiring-and-omarchy-packaging.md`

**Context from dependencies:** None — Wave 1 foundation task. Note that `hands-linux` build compilation will be appended into `build.sh` in Wave 4 (`task-12`) once `task-08` creates the `hands-linux` crate.

## Files to Create

- None.

## Files to Modify

- `get.sh` — Rebrand `EricTechPro/jarvis` → `aammo1/yomna`, `com.erictech.jarvis` → `com.aammo1.yomna`, `Jarvis` → `Yomna`, `JARVIS_*` env vars → `YOMNA_*`, add `Icon=yomna` to `yomna.desktop`, and download + verify `SHA256SUMS` via `sha256sum`/`shasum -a 256` before installing.
- `get.ps1` — Rebrand `EricTechPro/jarvis` → `aammo1/yomna`, `Jarvis` → `Yomna`, `JARVIS_*` env vars → `YOMNA_*`, remove `roamies*.exe` cleanup, and verify downloaded `.exe` against `SHA256SUMS` using `Get-FileHash -Algorithm SHA256`.
- `showcase/tauri/build.sh` — Rename `jarvis-voice` / `jarvis-hands` → `yomna-voice` / `yomna-hands` and `"Jarvis Self-Signed"` → `"Yomna Self-Signed"`.
- `showcase/tauri/sidecar/bundle.sh` — Remove `node rebrand.mjs ...` step (GG Coder is being removed), remove `cp -R beats dist/` (Fish Audio beats removed in Task 01), and bundle `sidekick.mjs` + `mcp-desktop.mjs` (when present) cleanly with `esbuild`.
- `showcase/tauri/sidecar/fetch-node.sh` — Rename output binary `jarvis-node-$TRIPLE` → `yomna-node-$TRIPLE`.
- `.github/workflows/ci.yml` — Update all binary names (`yomna`, `yomna-voice`, `yomna-hands`), env vars (`YOMNA_DATA_DIR`, `YOMNA_TRACE`), and data folder paths (`Yomna/Data/logs`) in the Linux/macOS/Windows jobs.
- `.github/workflows/release.yml` — Rename all asset names (`Yomna-macos-arm64.dmg`, `Yomna-macos-x64.dmg`, `Yomna-windows-x64-setup.exe`, `Yomna-linux-x64.AppImage`, `Yomna-linux-x64.deb`, `Yomna-linux-x64.rpm`), remove `continue-on-error: true` on Linux (line 56), remove dead updater `manifest` / `latest.json` job, and add a release step generating and attaching `SHA256SUMS`.
- `.github/workflows/update-feed.yml` — **DELETE** neutralized Roamies updater workflow.
- `.github/dependabot.yml` — Remove `@anthropic-ai/claude-agent-sdk` and `@kenkaiiii/*` group patterns; add `voice-win`, `hands-win`, and `hands-linux` Cargo workspaces.

## Technical Details

### Implementation Steps

1. In `get.sh`:
   - Default `repo="${YOMNA_REPO:-aammo1/yomna}"`.
   - Asset table: `Darwin-arm64 -> Yomna-macos-arm64.dmg`, `Darwin-x86_64 -> Yomna-macos-x64.dmg`, `Linux-x86_64 -> Yomna-linux-x64.AppImage`.
   - After downloading `$tmp/$name`, unless `YOMNA_URL` is a `file://` test override, fetch `SHA256SUMS` from the same release URL base and verify the matching line before installing (`sha256sum` on Linux, `shasum -a 256` on macOS). Abort with a clear error if checksum verification fails.
   - Add `Icon=yomna` to the generated `~/.local/share/applications/yomna.desktop`.
2. In `get.ps1`:
   - Default `$repo = if ($env:YOMNA_REPO) { $env:YOMNA_REPO } else { 'aammo1/yomna' }`.
   - Fetch `SHA256SUMS`, parse expected SHA-256 for `Yomna-windows-x64-setup.exe`, compare against `(Get-FileHash $file -Algorithm SHA256).Hash.ToLower()`, and abort on mismatch.
3. In `showcase/tauri/sidecar/bundle.sh`:
   - Bundle `sidekick.mjs` → `dist/sidekick.mjs` (and `mcp-desktop.mjs` → `dist/mcp-desktop.mjs` if file exists).
   - Remove `node rebrand.mjs` invocation and `beats/` copy.
4. In `.github/workflows/release.yml`:
   - Keep `TAG == "v" + tauri.conf.json.version` check.
   - In the final release assembly job, run `sha256sum Yomna-* > SHA256SUMS` and upload `SHA256SUMS` alongside the platform binaries.
   - Remove `continue-on-error: true` from the `ubuntu-24.04` build leg so Linux failures block broken releases.

### Code Snippets

SHA-256 verification helper for `get.sh`:
```bash
verify_sha256() {
  local file="$1" name="$2" sums_url="$3" expected actual
  curl -fsSL "$sums_url" -o "$file.sums" || die "couldn't download SHA256SUMS for verification." 1
  expected="$(awk -v n="$name" '$2 == n || $2 == "*"n { print tolower($1); exit }' "$file.sums")"
  [ -n "$expected" ] || die "no checksum entry for $name in SHA256SUMS." 1
  if have sha256sum; then actual="$(sha256sum "$file" | awk '{print tolower($1)}')"
  elif have shasum; then actual="$(shasum -a 256 "$file" | awk '{print tolower($1)}')"
  else die "sha256sum/shasum not found; cannot verify download." 69; fi
  [ "$actual" = "$expected" ] || die "checksum mismatch for $name (expected $expected, got $actual)." 1
}
```

### Environment Variables

- `YOMNA_REPO` — GitHub `owner/repo` override (default `aammo1/yomna`).
- `YOMNA_VERSION` — Specific release tag (e.g. `v1.0.0`).
- `YOMNA_URL` — Direct artifact URL override for local testing.
- `YOMNA_APP_DIR` — Target install directory override.
- `YOMNA_NO_OPEN` — Install without launching (`get.ps1`).

## Acceptance Criteria

- [ ] `grep -rnIiE "erictech|roamies|jarvis" get.sh get.ps1 showcase/tauri/build.sh showcase/tauri/sidecar/bundle.sh showcase/tauri/sidecar/fetch-node.sh .github/workflows/ .github/dependabot.yml` returns 0 matches.
- [ ] `get.sh` and `get.ps1` both verify `SHA256SUMS` before executing/installing downloaded binaries.
- [ ] `.github/workflows/release.yml` generates and attaches `SHA256SUMS`, has `continue-on-error` removed from Linux, and removes the dead `latest.json` updater job.
- [ ] `.github/workflows/update-feed.yml` is deleted.
- [ ] `bash -n get.sh showcase/tauri/build.sh showcase/tauri/sidecar/bundle.sh showcase/tauri/sidecar/fetch-node.sh` exits `0`.
