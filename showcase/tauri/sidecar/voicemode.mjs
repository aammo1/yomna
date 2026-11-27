// Voice mode: how Yomna talks. 'classic' is on-device speech-to-text, the text brain, then text-to-speech; 'live' is a
// Gemini Live call (speech to speech). Stored in config as voiceMode; read at startup, flipped from Settings.
export const VOICE_MODES = ['classic', 'live'];
export const DEFAULT_VOICE_MODE = 'classic';
export const DEFAULT_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

// The active mode: anything but 'live' (a missing field, a hand-edit gone wrong) is Classic.
export const voiceModeOf = (config) => (config?.voiceMode === 'live' ? 'live' : DEFAULT_VOICE_MODE);

// The Gemini Live model: the one in config, else DEFAULT_LIVE_MODEL.
export const liveModelOf = (config) => config?.liveModel || DEFAULT_LIVE_MODEL;

// Sets the mode; false (nothing changed) for a value that is not a mode.
export function setVoiceMode(config, mode) {
  if (!VOICE_MODES.includes(mode)) return false;
  config.voiceMode = mode;
  return true;
}

// The Gemini Live voice: the one in config, else the Gemini voice the current look speaks in.
export const liveVoiceOf = (config, lookVoice) => config?.liveVoice || lookVoice;

// Picks the Live voice (setup's reply step in Live); false (nothing changed) for a name not in the prebuilt list.
export function setLiveVoice(config, voice, voices) {
  if (!voices.some((v) => v.id === voice)) return false;
  config.liveVoice = voice;
  return true;
}
