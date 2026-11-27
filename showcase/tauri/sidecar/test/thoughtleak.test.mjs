// Gemini's reasoning summary arriving as reply text (Classic): "**Refining Communication**\n\n<planning prose>\n\n\n"
// before the real answer, with no thought flag on the part, so gg-ai passes it on as text_delta. ThoughtFilter drops
// that block at the start of a model turn, chunk by chunk as it streams; real bold text in answers stays.
// The chunks are the ones recorded on Eric's Mac (_tmp/2026-11-26-jarvis-real-tests c2-kb.jsonl:60-64, c3-web.jsonl).
// Run: npm test
import assert from 'node:assert/strict';
import { ThoughtFilter } from '../reply.mjs';

const run = (chunks) => { const f = new ThoughtFilter(); let out = ''; for (const c of chunks) out += f.push(c); return out + f.flush(); };

// c2-kb.jsonl: a write to _raw/ blocked, then the leak.
const c2 = [
  '**',
  'Refining Communication**\n\nThe user\'s direct attempt to write to `_raw/` was',
  ', predictably, blocked as an unauthorized modification. I now need to respond in my established persona: polite, concise, and adhering',
  ' to the bone-dry British AI butler style. The key is to state clearly what happened and reinforce that the `_raw/',
  '` directory remains strictly read-only for evidence integrity.\n\n\nWriting to `_raw/` is blocked: raw evidence in',
  ' your second brain is strictly read-only to keep the source records unedited.',
];
assert.equal(run(c2), 'Writing to `_raw/` is blocked: raw evidence in your second brain is strictly read-only to keep the source records unedited.', 'c2: only the answer is left');

// c3-web.jsonl: after a web search; the answer has real bold text of its own.
const c3 = [
  '**',
  'Synthesizing Search Findings**\n\nI\'ve gathered evidence pointing directly to Google\'s most',
  ' recent release: the "Gemini 4" series, with "Gemini 4 Neon" specifically highlighted. I\'ll',
  ' compose a single, concise sentence conveying this information, and directly link to the relevant official announcement.\n\n\nThe latest flagship model is **Gemini',
  ' 4 Neon** (alongside **Gemini 4 Hydrogen**), announced on [The Keyword](https://blog.google/x) and',
  ' [Google DeepMind](https://deepmind.google/models/gemini/).',
];
assert.equal(run(c3), 'The latest flagship model is **Gemini 4 Neon** (alongside **Gemini 4 Hydrogen**), announced on [The Keyword](https://blog.google/x) and [Google DeepMind](https://deepmind.google/models/gemini/).', 'c3: the answer keeps its bold');

// Two summaries in a row are both dropped; the same text in one chunk works the same.
assert.equal(run(['**Checking Files**\n\nI looked.\n\n\n**Drafting Reply**\n\nI will answer.\n\n\nDone.']), 'Done.');

// Nothing held back from a normal reply: it streams as it comes.
{ const f = new ThoughtFilter(); assert.equal(f.push('Sure, '), 'Sure, '); assert.equal(f.push('**done**.'), '**done**.'); }

// Real bold text stays: a bold opener that isn't a summary heading, a summary-like heading with no reasoning block
// after it (no blank-line gap before an answer), and bold mid-reply.
for (const real of [
  '**Note:** the folder is read-only.',
  '**Done!**\n\nI saved it to your notes.',
  '**Gemini 4 Neon** is the latest.\n\nIt came out this week.',
  '**Checking In**\n\nAll three tasks are finished.',
  'Here it is:\n\n**Refining Communication**\n\nI did that.\n\n\nOk.',
  '**Steps**\n\n1. Open it\n\n\n2. Save',
]) assert.equal(run([real]), real, `kept: ${JSON.stringify(real)}`);
// Split into single characters, the same.
for (const real of ['**Note:** the folder is read-only.', '**Checking In**\n\nAll three tasks are finished.']) assert.equal(run([...real]), real);
assert.equal(run([...c2.join('')]), run(c2), 'one character at a time, the same as the recorded chunks');
// A real answer under an -ing heading is never dropped, even with a triple-newline gap later in it: the prose under
// the heading has to read as Gemini planning (it opens "I…", "My…" or "The user…") and be one paragraph.
for (const real of [
  '**Morning Briefing**\n\nYou have 3 meetings today.\n\n\nWeather: sunny.',
  '**Shopping List**\n\n- eggs\n- milk\n\n\nAnything else?',
  '**Checking In**\n\nI finished all three tasks.\n\nThe report is saved.\n\n\nAnything else?',
]) {
  assert.equal(run([real]), real, `kept: ${JSON.stringify(real)}`);
  assert.equal(run([...real]), real, `kept, one character at a time: ${JSON.stringify(real)}`);
}
// And it streams: once the prose under the heading isn't planning, nothing waits for the turn's end.
{
  const f = new ThoughtFilter();
  assert.equal(f.push('**Meeting Notes**\n\n'), '', 'a heading alone could still be a summary');
  assert.equal(f.push('Here is a long answer. '), '**Meeting Notes**\n\nHere is a long answer. ');
  assert.equal(f.push('More text. '), 'More text. ');
  assert.equal(f.push('End.'), 'End.');
  assert.equal(f.flush(), '');
}
{
  const f = new ThoughtFilter();
  assert.equal(f.push('**Checking In**\n\nI finished the first task.\n\n'), '');
  assert.equal(f.push('Next'), '**Checking In**\n\nI finished the first task.\n\nNext', 'a second paragraph is an answer');
}
console.log('thoughtleak: reasoning summaries sent as text are dropped ok');
