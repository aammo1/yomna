# Task 07: Build Keyless Local TTS (Kokoro/Piper + Edge) and Gemini Live-to-Harness Bridge

## Status

pending

## Wave

2

## Description

Replace the paid Fish Audio TTS stack with a **100% keyless, local-first TTS pipeline** (Kokoro ONNX / Piper local speech synthesis with automatic SHA-256 verified model download + optional keyless Edge TTS + existing local VoiceStudio), and upgrade **Gemini Live Mode** (`live.mjs` + `livebrain.mjs`) so it has zero `@kenkaiiii/gg-*` dependencies, works seamlessly with `voice-win` 16 kHz PCM on Linux & Windows, and exposes a **`delegate_to_harness`** non-blocking tool that hands real coding/research/desktop work to the active CLI harness (`agy`, `opencode`, `pi`, `claude`, custom ACP) while staying live on the voice call.

## Dependencies

**Depends on:** `task-04-linux-hyprland-overlay-and-voice-win.md`
**Blocks:** `task-09-sidecar-wireup-and-gg-removal.md`, `task-11-panel-and-onboarding-harness-ui.md`

**Context from dependencies:** `task-04` added `16 kHz` mono PCM streaming (`{"type":"pcm","data":"..."}`) to `yomna-voice` (`voice-win`) on Linux and Windows. This task builds the keyless TTS engines and decouples `livebrain.mjs` from `@kenkaiiii/gg-*` while adding `delegate_to_harness` so `task-09` can wire both Classic and Live modes cleanly.

## Files to Create

- `showcase/tauri/sidecar/localtts.mjs` — Local keyless TTS engine (`LocalVoice`) using **Piper / Kokoro ONNX** CLI or ONNX runtime (auto-downloading pinned, SHA-256 verified voice models into `~/Yomna/Data/models/tts/` on first use, supporting English + Arabic voices, emitting 24 kHz 16-bit LE mono PCM chunks matching `speaker.mjs`'s `open() / say() / end() / abort()` contract).
- `showcase/tauri/sidecar/edgetts.mjs` — Optional keyless **Edge TTS** WebSocket streaming adapter (`EdgeVoice`, zero API key, supports both English and Arabic/Moroccan voices like `ar-MA-MounaNeural` / `en-US-AvaNeural`, converts/streams PCM cleanly to `speaker.mjs`).

## Files to Modify

- `showcase/tauri/sidecar/speaker.mjs` — Remove Fish Audio (`fish.mjs`) imports and pre-baked `beats/*.pcm` filler playback; route `config.tts` across `'local'` (default, `LocalVoice`), `'edge'` (`EdgeVoice`), `'voicestudio'` (`VoiceStudio`), and optional `'gemini'` (`GeminiVoice` if user already added a free AI Studio key).
- `showcase/tauri/sidecar/voicemode.mjs` — Update `DEFAULT_LIVE_MODEL` to a valid current Gemini Live native-audio model ID (`'gemini-2.5-flash-native-audio-preview-09-2025'`, configurable via `config.liveModel`) and export `VOICE_MODES = ['classic', 'live']`.
- `showcase/tauri/sidecar/live.mjs` — Rebrand caption role `'jarvis'` → `'yomna'` (line 63, 112), remove `"on the keys card"` wording → `"in Settings → Speaking & Live"`, ensure clean reconnection and interruption handling.
- `showcase/tauri/sidecar/livebrain.mjs` — **Remove** `@kenkaiiii/gg-ai` (`resolveToolSchema`) and `@kenkaiiii/gg-agent` (`unknownToolMessage`) imports! Use Zod v4 native `z.toJSONSchema(t.parameters)` instead. Add built-in **`delegate_to_harness`** non-blocking tool declaration (`behavior: 'NON_BLOCKING'`) that calls an injected `onDelegate({ task, allowActions })` callback so Gemini Live says `"On it, handing that to your agent..."` and streams the finished summary back via `live.news(...)` when the background CLI harness finishes!
- `showcase/tauri/sidecar/voicemodel.mjs` — Update `modelDir()` from `'Jarvis'` → `'Yomna'` (line 25) and keep SHA-256 verified Parakeet TDT 0.6B v3 int8 ONNX download intact.
- `showcase/tauri/sidecar/fish.mjs` — **DELETE**.
- `showcase/tauri/sidecar/rebrand.mjs` — **DELETE** (GG Coder OAuth rebranding is no longer needed once `@kenkaiiii/gg-*` is removed).

## Technical Details

### Implementation Steps

1. **Local TTS (`localtts.mjs`)**:
   - Define `LOCAL_VOICES` catalog with curated English (`en_US-amy-medium` / Kokoro `af_heart`) and Arabic (`ar_JO-kareem-medium`) voices, plus a fallback to system `piper` / `kokoro-onnx` / `espeak-ng` if offline.
   - Implement `LocalVoice` matching the exact contract `speaker.mjs` expects: `open()`, `say(sentence)`, `end()`, `abort()`, invoking `onAudio(Uint8Array)`, `onEnd()`, `onError(err)` with `24000 Hz` 16-bit LE mono PCM (resampling from 22050 Hz if Piper outputs 22050 Hz).
   - Provide `isTtsReady(dir)` and `downloadTtsModel(dir, { onProgress, signal })` with SHA-256 verification (mirroring `voicemodel.mjs`).
2. **Keyless Edge TTS (`edgetts.mjs`)**:
   - Offer built-in voices including **`ar-MA-MounaNeural` (Moroccan Arabic / Darija!)**, `ar-MA-JamalNeural`, `en-US-AvaMultilingualNeural`, `en-GB-SoniaNeural`.
   - Zero API key required; cleanly fails over to `'local'` if offline.
3. **Remove `@kenkaiiii/gg-*` from `livebrain.mjs`**:
   ```js
   import { z } from 'zod';
   export function liveDeclarations(tools, slow = SLOW_TOOLS) {
     const functionDeclarations = [];
     for (const t of tools) {
       let schema;
       try { schema = z.toJSONSchema(t.parameters); } catch { continue; }
       functionDeclarations.push({
         name: t.name,
         description: t.description,
         parametersJsonSchema: schema,
         ...(slow.has(t.name) ? { behavior: 'NON_BLOCKING' } : {}),
       });
     }
     return [{ functionDeclarations }];
   }
   ```
4. **Add `delegate_to_harness` tool in `livebrain.mjs`**:
   - Parameters: `z.object({ prompt: z.string().min(1), context: z.string().optional() })`.
   - Marked `NON_BLOCKING` in `SLOW_TOOLS` so Gemini Live stays conversational while `agy` / `opencode` / `pi` / `claude` runs in the background.
   - When `onDelegate` resolves with `{ ok, summary }`, `livebrain.mjs` returns `{ output: summary }` (and pushes any generated screenshots via `live.pushImage`).

## Acceptance Criteria

- [ ] `fish.mjs` and `rebrand.mjs` are deleted; `speaker.mjs` defaults to `'local'` (`LocalVoice`), supports `'edge'` (`EdgeVoice`, including `ar-MA-MounaNeural`), `'voicestudio'`, and optional `'gemini'`.
- [ ] `livebrain.mjs` has zero imports from `@kenkaiiii/gg-ai` or `@kenkaiiii/gg-agent` and converts Zod schemas with `z.toJSONSchema`.
- [ ] `livebrain.mjs` declares and executes `delegate_to_harness` as a `NON_BLOCKING` tool.
- [ ] `live.mjs` emits caption role `'yomna'` (never `'jarvis'`), and `voicemodel.mjs` stores models under `Yomna`.
- [ ] `node --check showcase/tauri/sidecar/localtts.mjs showcase/tauri/sidecar/edgetts.mjs showcase/tauri/sidecar/speaker.mjs showcase/tauri/sidecar/live.mjs showcase/tauri/sidecar/livebrain.mjs` exits `0`.
