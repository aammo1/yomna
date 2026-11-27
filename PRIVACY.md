# Privacy

Effective date: 27 November 2026

Yomna is an open-source desktop app derived from Roamies by Ken Kai. This page says, in plain words, what data Yomna handles and where it goes.

## The short version

- The developer runs no servers and collects nothing from you.
- There is no analytics or telemetry.
- Data leaves your computer only to the local CLI harness or optional voice/web services you choose to use, listed below.

## What leaves your computer, and where it goes

**The CLI agent harness you choose** (`agy`, `opencode`, `pi`, `claude`, or a custom ACP/CLI harness) runs locally using your existing CLI installation and configuration. When you talk or type to Yomna, your harness receives:

- your messages and the conversation context
- a "live state" block: the date and time, your time zone, the name or title of the app and window in front, and the facts and commitments Yomna has saved in memory
- screenshots or window text via the local `yomna-desktop` MCP server when Yomna looks at your screen to answer

**Voice synthesis (Classic Mode):** by default, Yomna speaks using local keyless Kokoro or Piper TTS models running on your computer, so reply audio never leaves your machine. If you optionally select Edge TTS or VoiceStudio, the text of spoken replies goes to that selected TTS provider.

**Google Gemini Live (optional Live Mode):** if you turn on Gemini Live Mode with your own Google AI Studio API key, your live 16 kHz PCM microphone stream and session context go to Google's Gemini Live API, and heavy tasks can be handed back to your local CLI harness via `delegate_to_harness`.

**GitHub** is used to download a skill when you ask Yomna to install one (the link you gave, or the page it found for it).

**Hugging Face** is used once, on Linux and Windows, to download the Parakeet speech-to-text model and local Kokoro/Piper voice models.

**Wikipedia** is used to fetch photos for photo cards, and websites' `favicon.ico` is fetched for source cards.

**Websites and search engines** that your chosen CLI harness opens or searches using its own native tools follow that harness's configuration and each website's privacy policy.

**Connected apps and services (MCP servers):** only the ones you ask Yomna or your harness to connect. A remote server is run by that service; a local MCP server (including `yomna-desktop`) runs on your computer. Yomna never sends your conversation, memory, or files to external services on its own.

Each harness or external service provider's own privacy policy applies to what is sent to it.

## Speech, microphone and screen

- **macOS:** speech is turned into text on your Mac by Apple's on-device recognizer. On Macs where on-device recognition isn't available, Apple's recognizer may use Apple's servers under Apple's terms.
- **Linux and Windows:** speech is turned into text locally on your computer (Parakeet ONNX).
- The microphone is used only while you hold the talk keys (or, on Linux with Wayland, from your `yomna --talk` toggle until you press it again or pause; and while Gemini Live Mode is active).
- **Wake word (macOS, off by default):** when you turn it on, the microphone stays open so Yomna can hear `"Hey Yomna"`, and macOS shows its microphone indicator the whole time. Audio is transcribed only on-device; nothing is kept or sent anywhere until you say the phrase.
- **Memory sync (off by default):** if you choose a sync folder, Yomna writes your reminders, commitments and remembered facts to `Yomna Sync/<random id>.json` in it, so your other computer can read them. Everything in that folder is encrypted (AES-256-GCM) with a key derived from a passphrase you type on each computer; the key is kept in your Keychain (macOS), with DPAPI (Windows), or in your keyring (Linux), and the passphrase itself isn't stored. Conversations and API keys are never written there.
- The screen is captured only when Yomna answers something about your screen, when the harness calls `take_screenshot`, or when you mark an area. On Linux with Wayland/Hyprland, captures use `grim`/`slurp` or the desktop screenshot portal without leaving stray copies behind.

## What's stored on your computer

Everything lives in one **Yomna** folder in your home folder (`~/Yomna`, on Windows `%USERPROFILE%\Yomna`) and stays on your computer:

| File or folder       | What's in it                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Data/settings.json` | your settings (chosen harness, voice mode, safety switches, second-brain root)                                                                           |
| `Data/memory.json`   | facts Yomna learned and your commitments                                                                                                                 |
| `Data/sessions/`     | conversations (the newest 60 are kept)                                                                                                                   |
| `Data/logs/`         | activity logs: tool names, timings, errors and short snippets of tool results; text typed into apps or files is reduced to its length; kept 7 days       |
| `Data/usage.jsonl`   | timings and session counts only, never content                                                                                                           |
| `Data/jobs.json`     | your scheduled jobs (never synced to another computer)                                                                                                   |
| `Data/mcp.json`      | your MCP server connections; any secrets are kept in your OS keyring, not here                                                                           |
| `Data/models/`       | local speech and TTS models on Linux (on Windows, stored in `%LOCALAPPDATA%\Yomna\models`)                                                               |
| `Skills/`            | the skills you installed, one folder each with its `SKILL.md`                                                                                            |
| `Agents/`            | what background agents made                                                                                                                              |

**Save Diagnostics** (from the panel's General page under Help, or the tray menu) writes one `yomna-diagnostics-….log` file to your Downloads folder only when you ask. Keys, tokens, email addresses, names, your home folder and user name are scrubbed before saving. Nothing is uploaded unless you choose to share it (for example by attaching it to a GitHub issue).

Optional keys (such as a Google AI Studio key for Gemini Live Mode or tokens for external MCP connections) are kept in the macOS Keychain, encrypted with DPAPI on Windows, or stored in your desktop's Secret Service keyring on Linux.

You can see what Yomna remembers on the panel's **Memory** page and remove items with **Forget** or **Forget Everything**. Skills, connections, and scheduled jobs are managed on the **Abilities** page.

## Children

Yomna isn't made for children under 13 (or the minimum age in their country), and it doesn't ask about age. Parents should supervise any use by children.

## Changes

Changes to this notice are made in this file on GitHub, so its history shows what changed and when.

## Questions

[Open an issue](https://github.com/aammo1/yomna/issues).
