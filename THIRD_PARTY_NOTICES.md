# Third-party notices

Yomna is licensed under [AGPL-3.0](LICENSE). It is derived from [Roamies](https://github.com/KenKaiii/Roamies) by Ken Kai (licensed under AGPL-3.0) and builds on the components below, each under its own license.

| Component | How it's used | License |
| --------- | ------------- | ------- |
| [Roamies](https://github.com/KenKaiii/Roamies) (Ken Kai) | upstream desktop companion shell, overlay UI, and voice/hands architecture | AGPL-3.0 |
| [Tauri](https://tauri.app) 2 (`tauri`, `tauri-build`) and plugins (`tauri-plugin-single-instance`, `tauri-plugin-dialog`) | desktop shell, see `showcase/tauri/src-tauri/Cargo.toml` | MIT OR Apache-2.0 |
| [Node.js](https://nodejs.org) v24.22.2 | bundled runtime for the sidecar (version in `showcase/tauri/sidecar/fetch-node.sh`) | MIT |
| [@google/genai](https://www.npmjs.com/package/@google/genai) | optional Gemini Live API client in the sidecar | Apache-2.0 |
| [zod](https://zod.dev) 4.6.7 | schema validation in the sidecar and `yomna-desktop` MCP server | MIT |
| [Doto](https://github.com/oliverlalan/Doto), [Martian Mono](https://github.com/evilmartians/mono) and [Readex Pro](https://github.com/ThomasJockin/readexpro) (with Arabic script support) fonts | typography in the app | SIL Open Font License 1.1, texts in `showcase/onboarding/fonts/` |
| [Natural Earth](https://www.naturalearthdata.com) 1:110m countries | country outlines for map cards (`showcase/jarvis/world.js`) and country names (`showcase/tauri/sidecar/countries.mjs`) | Public domain |
| [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [ONNX export by istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) | local speech-to-text model on Linux and Windows, downloaded at setup, not bundled | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [parakeet-rs](https://github.com/altunenes/parakeet-rs) 0.4.3 | runs the speech model in the Linux and Windows voice helper | MIT OR Apache-2.0 |
| Kokoro / Piper local TTS models and runtimes | keyless local text-to-speech synthesis, downloaded on demand, not bundled | Apache-2.0 / MIT |
| Microsoft Visual C++ runtime (`msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`) | installed beside the Windows helpers, which need it | Microsoft Visual Studio redistributable code terms |

## Full dependency list

These are the main components. To see every dependency, including indirect ones:

```bash
cd showcase/tauri/sidecar && npm ls --all
cd showcase/tauri/src-tauri && cargo tree
cd showcase/tauri/src-tauri/voice-win && cargo tree
```
