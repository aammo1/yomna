// click_text read off the screen (tools.mjs, when the accessibility tree has no such words): the line that is the
// whole label wins over words inside longer lines, with "…" (U+2026) and "..." the same. Regression (v0.2.10,
// Classic, 2026-11-27): the model asked for "Add a reply..." on YouTube Studio, which writes "Add a reply…". Run: npm test
import assert from 'node:assert/strict';
import { sameWords, wholeLines } from '../draw.mjs';

assert.ok(sameWords('Add a reply…', 'add a reply...'), '… and ... are the same words');
assert.ok(sameWords('  Upload ', 'upload'));
assert.ok(!sameWords('Add a reply', 'Add a reply…'), 'the dots still count');
const hits = [{ text: 'Reply to Add a reply… later' }, { text: 'Add a reply…' }, { text: '2. Add a reply…' }];
assert.deepEqual(wholeLines(hits, ['Add a reply...']).map((h) => h.text), ['Add a reply…', '2. Add a reply…'], 'whole lines (bar a list number) win');
assert.deepEqual(wholeLines([{ text: 'Save draft' }, { text: 'Save' }], ['Save']).map((h) => h.text), ['Save']);
assert.deepEqual(wholeLines([{ text: 'one' }], ['two']), [], 'nothing whole: none');
console.log('dot spelling tests: passed');
