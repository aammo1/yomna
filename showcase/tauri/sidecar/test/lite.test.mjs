// Lite mode (#73): a short prompt and a few flat tools for small and local models. Run: npm test
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createTools } from '../tools.mjs';
import { LITE_BUDGET, LITE_TOOLS, LITE_TURNS, liteSystem } from '../lite.mjs';

const noop = async () => {};
const { tools } = createTools({ allowActions: false, ui: () => {}, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', focus: { start: () => 'ok', stop: () => 'ok' } });
const size = (list) => list.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: z.toJSONSchema(t.parameters, { unrepresentable: 'any' }) }).length, 0);

// Every Lite tool is a real one (about_yomna is added by sidekick.mjs), and none of them sees, acts in apps or draws.
const lite = tools.filter((t) => LITE_TOOLS.has(t.name));
assert.deepEqual(lite.map((t) => t.name).sort(), [...LITE_TOOLS].filter((n) => n !== 'about_yomna').sort());
for (const n of ['draw', 'take_screenshot', 'act_in_app', 'read_window', 'run_command', 'write_file', 'read_file', 'start_focus']) assert.ok(!LITE_TOOLS.has(n), n);
// A fraction of what the full tool list costs on every request.
assert.ok(size(lite) < size(tools) / 4, `lite tools ${size(lite)} chars vs ${size(tools)}`);
assert.ok(LITE_BUDGET <= 16_000 && LITE_TURNS <= 8);

// The prompt: short, says what Lite mode can't do and to say so (with where to switch it off) instead of trying.
const o = { name: 'Yomna', body: 'a glowing sphere of light', user: 'Sam', version: '0.1.41', panel: 'the panel (click my icon)', voice: false };
const text = liteSystem(o), voice = liteSystem({ ...o, voice: true });
assert.ok(text.length < 3000, `${text.length} chars`);
assert.match(text, /Lite mode is on/);
assert.match(text, /can't see or read the screen, click or type in apps, draw/);
assert.match(text, /don't try it and don't pretend: say .*Lite mode is on.*switching Lite mode off in the panel \(click my icon\)/s);
assert.match(text, /"- " lines: they show on a card/);
assert.match(voice, /talk out loud.*no markdown/s); assert.doesNotMatch(voice, /\*\*bold\*\*/);
// The look's own way of talking, else the default.
assert.match(liteSystem({ ...o, style: 'deadpan and clinical.' }), /Personality: deadpan and clinical\. In your own way/);
assert.match(text, /Personality: warm, funny, a little cheeky\./);
console.log('lite tests: passed');
