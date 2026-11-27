// The wake word's name: what can be saved, and why not. Run: npm test
import assert from 'node:assert/strict';
import { cleanWakeName, wakeName } from '../wakename.mjs';

assert.deepEqual(cleanWakeName('Friday'), { ok: true, name: 'Friday' });
assert.deepEqual(cleanWakeName('  friday '), { ok: true, name: 'Friday' });
assert.deepEqual(cleanWakeName('Hey Friday'), { ok: true, name: 'Friday' }, 'the greeting is dropped');
assert.deepEqual(cleanWakeName('hi, NOVA'), { ok: true, name: 'Nova' });
assert.equal(cleanWakeName('Zoë').ok, false, 'under 4 letters');
assert.deepEqual(cleanWakeName('Chloë'), { ok: true, name: 'Chloë' }, 'letters beyond English');
assert.deepEqual(cleanWakeName(''), { ok: true, name: '' }, 'empty: back to Jarvis');
assert.deepEqual(cleanWakeName('Jarvis'), { ok: true, name: '' }, 'the default name');
assert.deepEqual(cleanWakeName('hey jarvis'), { ok: true, name: '' });
for (const bad of ['Bob', 'Mr Friday', 'R2D2', 'Fri-day', 'okay', 'Alexa', 'x'.repeat(21)]) {
  const r = cleanWakeName(bad);
  assert.equal(r.ok, false, `${bad} is refused`);
  assert.ok(r.why.length > 5, 'with a reason');
}
assert.equal(wakeName({}), 'Jarvis');
assert.equal(wakeName({ wakeName: 'Friday' }), 'Friday');
console.log('wake name tests: passed');
