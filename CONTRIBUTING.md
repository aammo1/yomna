# Contributing

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Setup

With Rust, Node.js 22+, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and, on macOS, the Xcode Command Line Tools installed:

```bash
git clone https://github.com/aammo1/yomna.git
cd yomna/showcase/tauri
(cd sidecar && npm ci && npm test)
./build.sh dev        # debug build
./build.sh            # release bundle for this OS
```

On Windows, run these in **Git Bash** (it comes with [Git for Windows](https://git-scm.com/download/win)), not PowerShell or Command Prompt: `build.sh` is a Bash script, and Windows PowerShell 5 doesn't accept `&&`.

## Development workflow

- Yomna's agent turns run through pluggable CLI harness adapters (`agy` default, `opencode`, `pi`, `claude`, or custom ACP/CLI) paired with the local `yomna-desktop` MCP server.
- Run `npm test` in `showcase/tauri/sidecar` before opening a PR.
- Run `shellcheck` on any shell script you changed.
- Write commit subjects and pull request titles as `<emoji> [type] scope: subject` (see the Commits section of [AGENTS.md](AGENTS.md)); `git config core.hooksPath .githooks` checks them for you.
- Keep CI (`.github/workflows/ci.yml`) green.
- Keep pull requests small and focused on one thing.

## The safety rule

Every tool that touches files, commands, URLs or other apps goes through `showcase/tauri/sidecar/safety.mjs` and the `yomna-desktop` MCP safety checks. Add a test case in `showcase/tauri/sidecar/test/safety.test.mjs` with every rule change, and keep `allowActions` off (`false`) by default.

## Security problems

Please don't open a public issue. Report them as described in [SECURITY.md](SECURITY.md).
