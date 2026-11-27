# Action Required: Yomna v1

Manual steps that must be completed by a human. These cannot be automated by agents.

## Before Implementation

- [x] **Install Rust toolchain on your Omarchy laptop** — Installed via `rustup` (`rustc 1.100.0`, `cargo 1.100.0`, symlinked into `~/.local/bin`; `sudo pacman -S rust` skipped because `sudo` requires interactive password).
- [x] **Create the new standalone `yomna` working folder & GitHub repo** — Created empty public repo `https://github.com/aammo1/yomna`, copied `/home/tal7a/Work/ja` (without `.git`) to `/home/tal7a/Work/yomna`, initialized `main`, enabled `.githooks`, and pointed `origin` to `https://github.com/aammo1/yomna.git`.
- [x] **Verify `agy` login on this machine** — Verified live with `agy -p "ping" --output-format json` (`status: SUCCESS`, `2.83s`).

## During Implementation

- [ ] **Provide your community links (optional, for Task 01)** — Share your exact YouTube channel URL and Skool community URL if you want them placed directly in `README.md` instead of placeholders.
- [ ] **Install Linux Wayland helper tools for live `hands-linux` testing (Task 08)** — On Omarchy, confirm `grim`, `slurp`, and `wtype` (or `ydotool`) are installed (`pacman -Q grim slurp wtype` or `sudo pacman -S grim slurp wtype`).

## After Implementation

- [ ] **Optional: Add a free Google AI Studio key inside Yomna Settings** — Only needed if you want to test **Gemini Live Mode** (`https://aistudio.google.com/apikey`); Classic Harness Mode works with zero keys.
- [ ] **Configure GitHub Actions release secrets on `aammo1/yomna` (optional)** — Only needed if you want signed/notarized macOS DMGs (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`); Windows NSIS and Linux AppImage/.deb/.rpm build without secrets.
- [ ] **Push `main` and tag `v1.0.0`** — Once local `./build.sh dev` and sidecar/Rust checks pass, push to `aammo1/yomna` and push tag `v1.0.0` to trigger the cross-platform release workflow.

---

> These tasks are also referenced in context within the relevant task files.
