// The two copy-paste starters in docs/ (settings.classic.example.json, settings.live.example.json) use only real
// settings, so they can't drift from DEFAULTS in sidekick.mjs, and each reads back as its own voice mode. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { voiceModeOf } from '../voicemode.mjs';
import { KEYS as BRAIN_KEYS } from '../secondbrain.mjs';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// sidekick.mjs runs at import, so DEFAULTS is read as text: its top-level keys, comments and nested objects dropped.
const side = src('../sidekick.mjs');
const start = side.indexOf('const DEFAULTS = {');
assert.ok(start >= 0, 'DEFAULTS is in sidekick.mjs');
const body = side.slice(start + 'const DEFAULTS = {'.length, side.indexOf('\n};', start))
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\{[^{}]*\}/g, '{}')
  .replace(/'[^'\n]*'/g, "''");
const DEFAULT_KEYS = new Set([...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
for (const k of ['provider', 'voiceMode', 'liveModel', 'liveVoice', 'allowActions', 'secondBrain', 'tts']) assert.ok(DEFAULT_KEYS.has(k), `the DEFAULTS reader finds ${k}`);
assert.ok(!DEFAULT_KEYS.has('code'), 'nested keys are not top-level ones');

const example = (name) => JSON.parse(src(`../../../../docs/${name}`));
const classic = example('settings.classic.example.json');
const live = example('settings.live.example.json');

for (const [name, c] of [['classic', classic], ['live', live]]) {
  for (const k of Object.keys(c)) assert.ok(DEFAULT_KEYS.has(k), `${name} example: ${k} is a real setting`);
  for (const k of Object.keys(c.secondBrain ?? {})) assert.ok(BRAIN_KEYS.includes(k), `${name} example: secondBrain.${k} is a real location`);
  assert.equal(typeof c.secondBrain?.root, 'string', `${name} example has a second brain root`);
  assert.equal(c.allowActions, false, `${name} example keeps actions off`);
}

assert.equal(voiceModeOf(classic), 'classic');
assert.equal(voiceModeOf(live), 'live');
assert.equal(live.liveModel, 'gemini-3.8-live');
assert.equal(live.liveVoice, 'Charon');

// The README points to both.
const readme = src('../../../../README.md');
assert.match(readme, /docs\/settings\.classic\.example\.json/);
assert.match(readme, /docs\/settings\.live\.example\.json/);
console.log('settings examples tests: passed');
