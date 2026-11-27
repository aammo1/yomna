// Right-to-left text (showcase/jarvis/core.js: Jarvis.rtl): Arabic and Hebrew lines are drawn whole and right-aligned
// in the speech bubble so letters join (#69). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const noop = () => {};
const window = {};
vm.runInNewContext(fs.readFileSync(new URL('../../../jarvis/core.js', import.meta.url), 'utf8'), {
  window, Math, Map, performance, matchMedia: () => ({ matches: false, addEventListener: noop }), addEventListener: noop, document: { addEventListener: noop },
});
const { rtl } = window.Jarvis;
for (const s of ['مرحبا بك', 'שלום', 'Jarvis يعمل الآن', 'ﻻ', 'ܫܠܡܐ']) assert.equal(rtl(s), true, s);
for (const s of ['Hello there', 'Привет', '你好', 'café 42', '', null, undefined]) assert.equal(rtl(s), false, String(s));
console.log('rtl tests: passed');
