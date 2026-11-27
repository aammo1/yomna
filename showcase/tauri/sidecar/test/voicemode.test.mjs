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
assert.equal(DEFAULT_LIVE_MODEL, 'gemini-3.8-live');

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

// Wiring (sidekick.mjs runs at import, so it is read as text): defaults, menu pick that saves, panel state, panel row.
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
assert.match(panel, /picks\('Voice mode', \[\['classic', 'Classic'\], \['live', 'Live'\]\], state\.voiceMode/);
assert.match(panel, /act\(`voicemode_\$\{x\}`\)/);
// Setup's "Give me a brain" step asks Classic or Live first: the pick goes through switchVoiceMode, obState reports it,
// Live opens the Gemini key field (and Continue needs that key), and Classic's sign-in row has a Gemini card.
const guide = src('../../../onboarding/onboarding.js'), page = src('../../../onboarding/index.html');
assert.match(side, /m\.type === 'ob_voicemode'\) \{ switchVoiceMode\(m\.mode\); obState\(\); \}/, 'the setup pick saves through switchVoiceMode');
const ob = side.slice(side.indexOf('function obState()'), side.indexOf('\n}\n', side.indexOf('function obState()')));
assert.match(ob, /voiceMode: voiceModeOf\(config\)/, 'obState reports the mode, so setup starts on the saved one');
assert.match(page, /id="ai-version" role="radiogroup"/);
assert.match(page, /class="providers" id="providers"/, 'three sign-in cards a row, not two');
assert.match(guide, /send\(\{ type: 'ob_voicemode', mode: id \}\)/);
assert.match(guide, /\['classic', 'Classic', 'Type or talk, any AI you have'\], \['live', 'Live', 'Talk out loud in real time, uses Gemini'\]/);
assert.match(guide, /ver: \(\) => ai\.version \?\? \(state\?\.voiceMode === 'live' \? 'live' : 'classic'\)/, 'Classic unless Live was saved');
assert.match(guide, /ready: \(\) => \(ai\.ver\(\) === 'live' \? ai\.geminiOn\(\) : !!state\?\.connected\)/, 'Live continues on a Gemini key');
assert.match(guide, /if \(live\) ai\.key = 'gemini';/, 'Live shows the Gemini key field straight away');
assert.match(guide, /\.\.\.\(gem \? \[ai\.geminiCard\(gem\)\] : \[\]\)/, 'Classic lists a Gemini card after the sign-ins');
assert.match(guide, /name: 'ai',[^\n]*ready: \(\) => ai\.ready\(\)/);
assert.match(guide, /'sizes', 'ai-version'\]\)/, 'arrow keys move between Classic and Live');
// Setup's "How should I reply?" step in Live: no Text or Voice pick, Continue on, and the voice picker saves the Live
// voice (ob_livevoice → setLiveVoice → config.liveVoice, which the Live call reads), shown from obState's liveVoice.
assert.match(side, /m\.type === 'ob_livevoice'\) \{ if \(setLiveVoice\(config, m\.voice, GEMINI_VOICES\)\) saveConfig\(\); obState\(\); \}/);
assert.match(ob, /liveVoice: liveVoiceOf\(config, geminiVoice\(\)\)/, 'obState reports the voice Live speaks in');
assert.match(side, /voice: liveVoiceOf\(config, geminiVoice\(\)\), tools, system: liveSystem/, 'the Live call speaks in that same voice');
assert.match(guide, /ready: \(\) => replies\.live\(\) \|\| replies\.mode\(\) === 'text' \|\| replies\.on\(\)/, 'Live continues straight away');
assert.match(guide, /if \(replies\.live\(\)\) return replies\.renderLive\(\);/);
const rl = guide.slice(guide.indexOf('renderLive() {'), guide.indexOf('choose(id) {'));
assert.match(rl, /\$\('replies'\)\.hidden = true;/, 'Live hides Text only and Voice + text');
assert.match(rl, /\['tts-row', 'studio-row', 'fish-form', 'fish-change'\]/, 'and the services and key field');
assert.match(rl, /\$\('gvoice'\)\.value = state\.liveVoice/);
assert.match(guide, /if \(replies\.live\(\)\) \{ state\.liveVoice = v; send\(\{ type: 'ob_livevoice', voice: v \}\); \}/);
assert.match(page, /<p class="lead" id="voice-lead">/);
assert.match(src('../../../onboarding/onboarding.css'), /\.rows\[hidden\] \{ display: none; \}/, 'Live hides the mic rows (a grid ignores hidden)');
console.log('voice mode tests: passed');
