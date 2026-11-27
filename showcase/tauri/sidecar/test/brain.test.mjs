// Side calls: oneShot over CLI harnessManager, the transcript they read, and what's kept of their reply.
import assert from 'node:assert/strict';
import { foldInput, foldPrompt, memoryInput, memoryPrompt, oneShot, parseBrain, transcript } from '../brain.mjs';

// oneShot routes through a provided run() override or harnessManager.oneShot().
{
  const seen = [];
  const fakeManager = {
    activeId: 'agy',
    async oneShot(opts) {
      seen.push(opts);
      return '{"facts":[]}';
    },
  };
  const r = await oneShot({ harnessManager: fakeManager, system: 's', text: 't', cwd: '/tmp' });
  assert.equal(seen.length, 1);
  assert.equal(r.model, 'agy');
  assert.equal(r.text, '{"facts":[]}');

  const r2 = await oneShot({ model: 'custom', system: 's', text: 't', run: async () => '{"facts":[]}' });
  assert.equal(r2.model, 'custom');
  assert.equal(r2.text, '{"facts":[]}');
  await assert.rejects(oneShot({ system: 's', text: 't', run: async () => { throw new Error('down'); } }), /down/);
}

// The reply: JSON (fenced or not), facts redacted and checked, replaces only for ids that exist.
{
  const reply = '```json\n{"summary": "Ken asked to tidy the Downloads folder and it was done.", "facts": [' +
    '{"text": "Ken edits videos in Final Cut Pro"}, {"text": "Ken now lives in Lisbon", "replaces": "f111111"}, {"text": "Ken likes tea", "replaces": "f999999"},' +
    '{"text": "Ken\'s API key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}, {"text": "Ken\'s password is hunter2"}, {"text": "Card 4111 1111 1111 1111"}, {"text": "x"}, "Ken has a dog called Rex"]}\n```';
  const out = parseBrain(reply, { knownIds: ['f111111'], wantSummary: true });
  assert.match(out.summary, /Downloads/);
  assert.deepEqual(out.facts, [
    { text: 'Ken edits videos in Final Cut Pro' },
    { text: 'Ken now lives in Lisbon', replaces: 'f111111' },
    { text: 'Ken likes tea' }, // an id that doesn't exist replaces nothing
    { text: 'Ken has a dog called Rex' },
  ], 'secrets, card numbers and scraps are dropped');
  assert.deepEqual(parseBrain('Sure! {"facts": []}').facts, [], 'nothing new');
  assert.throws(() => parseBrain('no json here'), /no JSON/);
  assert.throws(() => parseBrain('{"facts": []}', { wantSummary: true }), /no summary/, 'a fold needs its summary');
  assert.ok(!/sk-ant/.test(parseBrain('{"summary": "They pasted sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 by mistake and were told to rotate it."}', { wantSummary: true }).summary), 'the summary is redacted too');
}

// What the side calls read: words and tool names, results cut short, notes stripped.
{
  const msgs = [
    { role: 'user', content: '[note] hidden\n\nKen said: I make videos' },
    { role: 'assistant', content: [{ type: 'text', text: 'Nice.' }, { type: 'tool_call', id: 'a', name: 'read_file', args: { path: '/x' } }] },
    { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'a', content: 'r'.repeat(1000) }] },
    { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
  ];
  const t = transcript(msgs, 'Ken', (x) => x.replace(/^\[note\][\s\S]*?said: /, ''));
  assert.match(t, /^Ken: I make videos\nAssistant: Nice\. \[used read_file \{"path":"\/x"\}\]\n\[tool result\] r{300}…\nKen: what is this \[image\]$/);
  assert.ok(!t.includes('AAAA'), 'no image data');
  const facts = [{ id: 'f1', text: 'Ken makes videos' }];
  assert.match(foldInput({ facts, summary: 'Earlier.', turns: t, name: 'Ken' }), /- f1: Ken makes videos[\s\S]*Earlier summary:\nEarlier\.[\s\S]*Turns to fold/);
  assert.match(memoryInput({ facts: [], turns: t }), /\(none yet\)/);
  for (const p of [foldPrompt('Ken'), memoryPrompt('Ken')]) assert.match(p, /JSON[\s\S]*Never secrets[\s\S]*replaces/, 'both prompts carry the fact rules');
}
console.log('brain tests: passed');

// The skill pass: when it may run, what stops it, and what's kept of its reply.
{
  const { parseSkill, shouldLearn, skillInput, skillPrompt, soundsWrong } = await import('../brain.mjs');
  assert.ok(shouldLearn({ okTools: 5 }), 'five tools that worked');
  assert.ok(!shouldLearn({ okTools: 4 }), 'too short to be a how-to');
  assert.ok(!shouldLearn({ okTools: 9, errors: 1 }), 'a tool failed');
  assert.ok(!shouldLearn({ okTools: 9, aborted: true }), 'stopped');
  assert.ok(!shouldLearn({ okTools: 9, system: true }), 'a reminder or news turn');
  assert.ok(!shouldLearn({ okTools: 9, saved: true }), 'saved by hand already');
  assert.ok(!shouldLearn({ okTools: 9, on: false }), 'switched off');
  for (const t of ['no, that\'s wrong', 'Nope', 'that is not what I asked', 'it didn\'t work', 'undo that', 'you got the wrong file, wrong one']) assert.ok(soundsWrong(t), t);
  for (const t of ['thanks!', 'now do the same for March', 'nothing else', 'not bad at all, cheers']) assert.ok(!soundsWrong(t), t);
  assert.equal(parseSkill('{"skill": null}'), null);
  assert.deepEqual(parseSkill('```json\n{"skill": {"name": "Export Figma frames", "description": "When they want Figma frames as PNGs.", "steps": "1. Select the frames.\\n2. Export at 2x."}}\n```'),
    { name: 'Export Figma frames', description: 'When they want Figma frames as PNGs.', steps: '1. Select the frames.\n2. Export at 2x.' });
  assert.equal(parseSkill('{"skill": {"name": "Pay", "description": "When paying the bill online.", "steps": "1. Enter card 4111 1111 1111 1111 and pay."}}'), null, 'no card numbers');
  assert.equal(parseSkill('{"skill": {"name": "x", "description": "y", "steps": "z"}}'), null, 'scraps');
  assert.throws(() => parseSkill('nothing'), /no JSON/);
  assert.match(skillPrompt('Ken'), /Never passwords[^]*skip asking Ken[^]*When in doubt, null/);
  assert.match(skillInput({ index: '- tidy: When tidying', used: [{ slug: 'tidy', steps: '1. Sort.' }], turns: 'Ken: tidy' }), /- tidy: When tidying[^]*followed in this request[^]*tidy:\n1\. Sort\.[^]*Ken: tidy/);
  console.log('skill pass tests: passed');
}
