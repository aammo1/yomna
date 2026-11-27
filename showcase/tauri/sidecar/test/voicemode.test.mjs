// Voice mode: Classic (default) or Live, stored in config; the Settings switch and the panel show it. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE_MODE, DEFAULT_LIVE_MODEL, voiceModeOf, setVoiceMode, liveVoiceOf, setLiveVoice } from '../voicemode.mjs';
import { GEMINI_VOICES } from '../gemini.mjs';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// A fresh config, an old config with no field, or a hand-edited bad value is Classic.
assert.equal(DEFAULT_VOICE_MODE, 'classic');
assert.equal(voiceModeOf({}), 'classic');
assert.equal(voiceModeOf({ voiceMode: 'banana' }), 'classic');
assert.equal(voiceModeOf({ voiceMode: 'live' }), 'live');
assert.equal(DEFAULT_LIVE_MODEL, 'gemini-2.5-flash-native-audio-preview-09-2025');

// Picking a mode sets it; a bad pick changes nothing and says so.
const c = {};
assert.equal(setVoiceMode(c, 'live'), true);
assert.equal(c.voiceMode, 'live');
assert.equal(setVoiceMode(c, 'classic'), true);
assert.equal(c.voiceMode, 'classic');
assert.equal(setVoiceMode(c, 'nope'), false);
assert.equal(c.voiceMode, 'classic');

// The Live voice: the configured one, else the one closest to the current look's voice.
assert.equal(liveVoiceOf({ liveVoice: 'Kore' }, 'Charon'), 'Kore');
assert.equal(liveVoiceOf({ liveVoice: null }, 'Charon'), 'Charon');
assert.equal(liveVoiceOf({}, 'Puck'), 'Puck');
// Picking the Live voice saves a prebuilt one to liveVoice (what a Live call reads); anything else changes nothing.
const lv = {};
assert.equal(setLiveVoice(lv, 'Puck', GEMINI_VOICES), true);
assert.equal(liveVoiceOf(lv, 'Charon'), 'Puck');
assert.equal(setLiveVoice(lv, 'Nobody', GEMINI_VOICES), false);
assert.equal(lv.liveVoice, 'Puck');

// Wiring (sidekick.mjs runs at import, so it is read as text): defaults, menu pick that saves, panel state.
const side = src('../sidekick.mjs'), panel = src('../../../panel/panel.js');
assert.match(side, /voiceMode: DEFAULT_VOICE_MODE/);
assert.match(side, /liveVoice: null/);
assert.match(side, /liveModel: DEFAULT_LIVE_MODEL/);
const branch = side.match(/\/\^voicemode_\(classic\|live\)\$\/\.test\(id\)\)[^\n]*/)?.[0] ?? '';
assert.match(branch, /switchVoiceMode\(id\.slice\(10\)\)/, 'the menu pick goes through switchVoiceMode');
const sw = side.slice(side.indexOf('function switchVoiceMode(mode)'), side.indexOf('\n}\n', side.indexOf('function switchVoiceMode(mode)')));
assert.match(sw, /setVoiceMode\(config, mode\)/);
assert.match(sw, /saveConfig\(\)/);
assert.match(sw, /menu\(\)/);
assert.match(side, /voiceMode: voiceModeOf\(config\)/, 'panelState reports the active mode');
assert.match(panel, /picks\('Voice mode'/);
const guide = src('../../../onboarding/onboarding.js');
assert.match(side, /m\.type === 'ob_voicemode'\) \{ switchVoiceMode\(m\.mode\); obState\(\); \}/);
const ob = side.slice(side.indexOf('function obState()'), side.indexOf('\n}\n', side.indexOf('function obState()')));
assert.match(ob, /voiceMode: voiceModeOf\(config\)/);
assert.match(side, /m\.type === 'ob_livevoice'\) \{ if \(setLiveVoice\(config, m\.voice, GEMINI_VOICES\)\) saveConfig\(\); obState\(\); \}/);
assert.match(ob, /liveVoice: liveVoiceOf\(config, geminiVoice\(\)\)/);
assert.match(side, /voice: liveVoiceOf\(config, geminiVoice\(\)\),/);
assert.match(guide, /ob_livevoice/);
console.log('voice mode tests: passed');
