# Security policy

Yomna runs a local desktop companion that delegates agent turns to your installed CLI harness (`agy`, `opencode`, `pi`, `claude`, or a custom ACP/CLI harness), exposes local desktop tools over the `yomna-desktop` MCP server (screenshots, window inspection, overlay cards, and optional app control), and stores optional voice/connection keys in your operating system's keychain or keyring. Security reports are taken seriously.

## Supported versions

Only the latest release gets security fixes: [latest GitHub release](https://github.com/aammo1/yomna/releases/latest).

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through [GitHub security advisories](https://github.com/aammo1/yomna/security/advisories/new).

Include:

- what an attacker can do, and what they need first (e.g. "a malicious web page", "a file the user opens", "local access")
- steps to reproduce, or a proof of concept
- affected version and OS

You'll get an acknowledgement within 7 days. Once a fix ships, the advisory will be published with credit to you unless you'd rather stay anonymous.

## In scope

- the Node.js sidecar, harness adapters, and `yomna-desktop` MCP server
- the safety switches (`allowActions`, `skipAllow`, `_raw` read-only protection, risky click prompts)
- the Tauri shell, Content Security Policy (`tauri.conf.json`), and IPC commands
- platform voice and hands helpers (macOS Swift helpers, `voice-win` / `yomna-voice`, `hands-win`, `hands-linux`)
- installer verification (`get.sh` / `get.ps1` `SHA256SUMS` checks) and `~/Yomna/Data/` storage

## Out of scope

- an AI model or CLI harness choosing to do something you asked for or that your settings allow
- attacks that need an already-compromised user account or machine
