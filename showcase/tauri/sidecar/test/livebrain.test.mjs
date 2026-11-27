// The Live brain: Jarvis's own prompt and tools inside a Gemini Live call. A fake Live transport plays Gemini's side;
// the tools are the real ones from tools.mjs, so Allow, allowActions and skipAllow are the real gates. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createTools } from '../tools.mjs';
import { createLiveBrain, liveDeclarations } from '../livebrain.mjs';
import { SLOW_TOOLS } from '../tools.mjs';

const noop = async () => {};
const base = { allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' };

// Gemini's side of the socket, in the SDK's shape: connect({model, config, callbacks}) → session.
const fakeTransport = () => {
  const calls = [];
  const connect = async (params) => {
    const sent = [];
    const s = {
      params, sent,
      sendRealtimeInput: (m) => sent.push({ realtime: m }),
      sendClientContent: (m) => sent.push({ content: m }),
      sendToolResponse: (m) => sent.push({ tool: m }),
      close: () => {},
      server: (msg) => params.callbacks.onmessage(msg),
    };
    calls.push(s);
    return s;
  };
  return { connect, calls };
};
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};
const responses = (s) => s.sent.filter((m) => m.tool).flatMap((m) => m.tool.functionResponses);
const callTool = (s, id, name, args) => s.server({ toolCall: { functionCalls: [{ id, name, args }] } });
const setup = ({ tools, system = () => 'You are Jarvis.', ...more } = {}) => {
  const t = fakeTransport();
  const out = [];
  const brain = createLiveBrain({ connect: t.connect, emit: (e) => out.push(e), key: 'k', tools, system, ...more });
  return { t, out, brain };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'livebrain-'));

{ // Every tool becomes one Live function declaration (JSON Schema, no zod), and the slow ones don't block the call.
  const { tools } = createTools({ ...base, ask: async () => null });
  const [{ functionDeclarations: decls }] = liveDeclarations(tools);
  assert.deepEqual(decls.map((d) => d.name), tools.map((t) => t.name));
  const read = decls.find((d) => d.name === 'read_file');
  assert.equal(read.parametersJsonSchema.type, 'object');
  assert.deepEqual(read.parametersJsonSchema.required, ['path']);
  assert.ok(read.description.startsWith('Read a text file.'));
  assert.equal(decls.find((d) => d.name === 'web_search').behavior, 'NON_BLOCKING');
  assert.equal(decls.find((d) => d.name === 'read_file').behavior, undefined);
  JSON.stringify(decls); // plain data, sendable as is
  assert.ok(SLOW_TOOLS.has('take_screenshot'));
}

{ // The call opens with Jarvis's own context plus the spoken-reply guidance, and with every tool declared.
  const { tools } = createTools({ ...base, ask: async () => null });
  const { t, brain } = setup({ tools, system: () => 'You are Jarvis. Memory: likes tea.' });
  await brain.start();
  const { config } = t.calls[0].params;
  assert.ok(config.systemInstruction.startsWith('You are Jarvis. Memory: likes tea.'));
  assert.match(config.systemInstruction, /out loud/i);
  assert.equal(config.tools[0].functionDeclarations.length, tools.length);
  brain.stop();
}

{ // Her reply follows the language they speak (English when unsure), so an English call never gets a Spanish or Chinese reply.
  const { tools } = createTools({ ...base, ask: async () => null });
  const { t, brain } = setup({ tools, voice: 'Charon' });
  await brain.start();
  const { config } = t.calls[0].params;
  assert.match(config.systemInstruction, /reply in the language they're speaking/i);
  assert.match(config.systemInstruction, /not sure, use English/i);
  assert.match(config.systemInstruction, /keep that one language for the whole call/i);
  assert.match(config.systemInstruction, /never switch because a bit of audio was unclear/i);
  assert.match(config.systemInstruction, /only when they clearly switch themselves/i);
  assert.doesNotMatch(config.systemInstruction, /set their language/i, "'auto' (the default) pins no language");
  assert.equal(config.speechConfig.languageCode, undefined, "'auto': no language code");
  brain.stop();
}

{ // A chosen speech language (Voice settings) is named in the prompt, read on every connect; the voice is untouched.
  // Native-audio Live models pick their language from the conversation and the system instruction (Live API guide), so
  // no speechConfig.languageCode is sent.
  const { tools } = createTools({ ...base, ask: async () => null });
  let lang = 'ar-SA';
  const { t, brain } = setup({ tools, voice: 'Charon', speechLang: () => lang });
  await brain.start();
  let { config } = t.calls[0].params;
  assert.match(config.systemInstruction, /set their language to Arabic \(Saudi Arabia\)/);
  assert.equal(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
  assert.equal(config.speechConfig.languageCode, undefined);
  brain.stop();
  lang = 'auto';
  await brain.start();
  ({ config } = t.calls[1].params);
  assert.doesNotMatch(config.systemInstruction, /set their language/i, 'back to auto: read again on the next connect');
  brain.stop();
}

{ // A tool call runs the real tool and the answer goes back under the same call id.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'note.txt'), 'buy milk');
  const { tools } = createTools({ ...base, ask: async () => null, workdir: dir });
  const { t, out, brain } = setup({ tools });
  await brain.start();
  const s = t.calls[0];
  callTool(s, 'c1', 'read_file', { path: path.join(dir, 'note.txt') });
  await until(() => responses(s).length);
  assert.deepEqual(responses(s), [{ id: 'c1', name: 'read_file', response: { output: 'buy milk' } }]);
  callTool(s, 'c2', 'nope', {});
  await until(() => responses(s).length === 2);
  assert.equal(responses(s)[1].id, 'c2');
  assert.match(responses(s)[1].response.error, /nope/);
  assert.ok(out.some((e) => e.type === 'tool' && e.name === 'read_file'), 'the caller hears which tool ran');
  brain.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// A risky tool (run_command with rm, an ASK step) raises the same Allow prompt as in Classic: Allow runs it, a no
// refuses it and tells Gemini so; with skipAllow on, it runs without asking.
for (const { skipAllow, answer, runs, asks } of [
  { skipAllow: false, answer: 'Allow', runs: true, asks: 1 },
  { skipAllow: false, answer: null, runs: false, asks: 1 },
  { skipAllow: true, answer: null, runs: true, asks: 0 },
]) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.txt'), 'hi');
  const asked = [];
  const { tools } = createTools({ ...base, workdir: dir, skipAllow: () => skipAllow, ask: async (o) => { asked.push(o.placeholder); return answer; } });
  const { t, brain } = setup({ tools });
  await brain.start();
  const s = t.calls[0];
  callTool(s, 'rm1', 'run_command', { command: 'rm -f x.txt' });
  await until(() => responses(s).length);
  const [r] = responses(s);
  assert.equal(r.id, 'rm1');
  assert.equal(asked.length, asks, `skipAllow ${skipAllow}: Allow asked ${asks}×`);
  assert.equal(!fs.existsSync(path.join(dir, 'x.txt')), runs, `answer ${answer}: ran ${runs}`);
  if (!runs) assert.match(r.response.error, /said no/);
  brain.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

{ // A call Gemini cancels (they cut in) is aborted, and no answer is sent for it.
  let seen = null;
  const slowTool = { name: 'web_fetch', description: 'Fetch a page.', parameters: z.object({ url: z.string() }),
    execute: (args, { signal }) => new Promise((_, rej) => { seen = signal; signal.addEventListener('abort', () => rej(new Error('aborted'))); }) };
  const { t, out, brain } = setup({ tools: [slowTool] });
  await brain.start();
  const s = t.calls[0];
  callTool(s, 'w1', 'web_fetch', { url: 'https://example.com' });
  await until(() => seen);
  s.server({ toolCallCancellation: { ids: ['w1'] } });
  await until(() => out.some((e) => e.type === 'toolEnd'));
  assert.equal(seen.aborted, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(responses(s), [], 'nothing answered for a cancelled call');
  brain.stop();
}

{ // A screenshot comes back to Gemini as a picture in the call, with its text as the tool's answer.
  const shot = { name: 'take_screenshot', description: 'Look at the screen.', parameters: z.object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'Screenshot of the main display.' }, { type: 'image', mediaType: 'image/jpeg', data: 'SlBH' }] }) };
  const { t, brain } = setup({ tools: [shot] });
  await brain.start();
  const s = t.calls[0];
  callTool(s, 's1', 'take_screenshot', {});
  await until(() => responses(s).length);
  assert.deepEqual(s.sent.filter((m) => m.realtime?.video), [{ realtime: { video: { data: 'SlBH', mimeType: 'image/jpeg' } } }]);
  assert.deepEqual(responses(s), [{ id: 's1', name: 'take_screenshot', response: { output: 'Screenshot of the main display.' } }]);
  brain.stop();
}

{ // Agent news waits for a quiet moment: while she talks or a tool runs it's held, then it goes into the call as text.
  let finish;
  const wait = { name: 'list_windows', description: 'List windows.', parameters: z.object({}), execute: () => new Promise((r) => { finish = r; }) };
  const { t, brain } = setup({ tools: [wait] });
  await brain.start();
  const s = t.calls[0];
  const notes = () => s.sent.filter((m) => m.realtime?.text).map((m) => m.realtime.text);
  assert.equal(brain.quiet(), true);
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQID' } }] } } });
  assert.equal(brain.quiet(), false, 'speaking is not quiet');
  brain.news('Agent "docs" finished.');
  assert.deepEqual(notes(), []);
  s.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(notes(), ['Agent "docs" finished.'], 'sent once she stops talking');
  callTool(s, 'l1', 'list_windows', {});
  await until(() => finish);
  assert.equal(brain.quiet(), false, 'a running tool is not quiet');
  brain.news('Agent "mail" failed.');
  assert.equal(notes().length, 1);
  finish('Finder');
  await until(() => responses(s).length);
  assert.equal(notes().length, 1, 'still held while she answers the tool result');
  s.server({ serverContent: { turnComplete: true } });
  assert.equal(notes().length, 2);
  assert.equal(notes()[1], 'Agent "mail" failed.');
  brain.stop();
}

{ // Parallel calls in one turn get ONE toolResponse holding every answer, sent once the last is done: one per result
  // made her answer once per result (she said the same thing twice). A cancelled one is left out of the batch.
  const gates = {};
  const mk = (name) => ({ name, description: name, parameters: z.object({}), execute: (args, { signal, toolCallId }) => new Promise((res, rej) => { gates[toolCallId] = res; signal.addEventListener('abort', () => rej(new Error('aborted'))); }) });
  const { t, brain } = setup({ tools: [mk('read_window'), mk('list_windows'), mk('web_fetch')] });
  await brain.start();
  const s = t.calls[0];
  s.server({ toolCall: { functionCalls: [{ id: 'p1', name: 'read_window', args: {} }, { id: 'p2', name: 'list_windows', args: {} }, { id: 'p3', name: 'web_fetch', args: {} }] } });
  await until(() => gates.p1 && gates.p2 && gates.p3);
  gates.p1('window one');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.sent.filter((m) => m.tool).length, 0, 'nothing sent while one of the batch still runs');
  s.server({ toolCallCancellation: { ids: ['p3'] } });
  gates.p2('two windows');
  await until(() => s.sent.some((m) => m.tool));
  await new Promise((r) => setTimeout(r, 20));
  const sent = s.sent.filter((m) => m.tool);
  assert.equal(sent.length, 1, 'one toolResponse');
  assert.deepEqual(sent[0].tool.functionResponses.map((r) => [r.id, r.response.output]), [['p1', 'window one'], ['p2', 'two windows']]);
  brain.stop();
}

{ // A slow call (NON_BLOCKING) never holds back a quick one's answer: Gemini waits on the quick one, so she'd go silent
  // for as long as act_in_app sits on an Allow prompt. And a call they cut off, whose tool ignores the abort, holds
  // nothing back either. toolEnd fires as its answer goes out, so a held drawing starts its wait from the answer.
  const gates = {};
  const mk = (name, { ignoresAbort = false } = {}) => ({ name, description: name, parameters: z.object({}), execute: (args, { signal, toolCallId }) => new Promise((res, rej) => { gates[toolCallId] = res; if (!ignoresAbort) signal.addEventListener('abort', () => rej(new Error('aborted'))); }) });
  const slow = new Set(['act_in_app', 'read_window', 'list_windows']);
  const { t, out, brain } = setup({ slow, tools: [mk('remember_commitment'), mk('draw'), mk('act_in_app'), mk('read_window'), mk('list_windows', { ignoresAbort: true })] });
  await brain.start();
  const s = t.calls[0];
  const answered = () => responses(s).map((r) => r.id);
  const ended = () => out.filter((e) => e.type === 'toolEnd').map((e) => e.id);
  s.server({ toolCall: { functionCalls: [{ id: 'q1', name: 'remember_commitment', args: {} }, { id: 'q2', name: 'draw', args: {} }, { id: 's1', name: 'act_in_app', args: {} }] } });
  await until(() => gates.q1 && gates.q2 && gates.s1);
  gates.q1('saved');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ended(), [], 'no toolEnd before its answer goes out');
  gates.q2('drawn');
  await until(() => answered().length === 2);
  assert.deepEqual(answered(), ['q1', 'q2'], 'the quick ones are answered while act_in_app still runs');
  assert.deepEqual(ended(), ['q1', 'q2']);
  gates.s1('done');
  await until(() => answered().length === 3);
  s.server({ toolCall: { functionCalls: [{ id: 'r1', name: 'read_window', args: {} }, { id: 'r2', name: 'list_windows', args: {} }] } });
  await until(() => gates.r1 && gates.r2);
  s.server({ toolCallCancellation: { ids: ['r2'] } });
  gates.r1('the window');
  await until(() => answered().includes('r1'));
  assert.ok(!answered().includes('r2'), 'the cancelled call gets no answer');
  assert.equal(out.find((e) => e.type === 'toolEnd' && e.id === 'r2')?.ok, false);
  brain.stop();
}

console.log('livebrain: ok');
