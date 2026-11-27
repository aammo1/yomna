// The default second brain's folder name: "<First> OS", from the first word of the account's full name, else the
// username, else "Second Brain", with characters a folder name can't hold taken out. Run: npm test
import assert from 'node:assert/strict';
import { accountNames, brainName } from '../secondbrain.mjs';

const cases = [
  [{ full: 'EricTech', user: 'erictech' }, 'EricTech OS', "Eric's Mac: id -F reads EricTech"],
  [{ full: 'Sam Lee', user: 'sam' }, 'Sam OS', 'the first word of the full name'],
  [{ full: '  Ana  María López ', user: 'ana' }, 'Ana OS', 'spaces around it are ignored'],
  [{ full: '', user: 'sam' }, 'sam OS', 'no full name: the username'],
  [{ full: null, user: 'sam' }, 'sam OS', 'nothing read: the username'],
  [{ full: '', user: '' }, 'Second Brain', 'neither: Second Brain'],
  [{}, 'Second Brain', 'nothing at all: Second Brain'],
  [{ full: 'Jo/Ann:"x"', user: 'jo' }, 'JoAnnx OS', 'slashes, colons and quotes are taken out'],
  [{ full: 'a<b>c|d?e*f\\g', user: 'x' }, 'abcdefg OS', 'and the rest of <>|?*\\'],
  [{ full: '...', user: 'sam' }, 'sam OS', 'a name of only dots falls back to the username'],
  [{ full: '//', user: '::' }, 'Second Brain', 'nothing usable left: Second Brain'],
  [{ full: 'Zoë\u0007', user: 'z' }, 'Zoë OS', 'control characters are taken out'],
];
for (const [who, want, why] of cases) assert.equal(brainName(who), want, why);

// Where the full name comes from: id -F on macOS, the passwd GECOS field on Linux, USERNAME on Windows.
const run = (out) => (cmd, args) => { run.calls.push([cmd, ...args].join(' ')); return out[cmd] ?? null; };
run.calls = [];
assert.deepEqual(accountNames({ platform: 'darwin', user: 'erictech', env: {}, run: run({ id: 'EricTech\n' }) }), { full: 'EricTech', user: 'erictech' });
assert.ok(run.calls.includes('id -F'), 'macOS asks id -F');
assert.deepEqual(accountNames({ platform: 'linux', user: 'sam', env: {}, run: run({ getent: 'sam:x:1000:1000:Sam Lee,,,:/home/sam:/bin/bash\n' }) }), { full: 'Sam Lee', user: 'sam' }, 'Linux: the GECOS name, before its first comma');
assert.ok(run.calls.includes('getent passwd sam'), 'Linux asks getent passwd');
assert.deepEqual(accountNames({ platform: 'win32', user: 'x', env: { USERNAME: 'Kim' }, run: run({}) }), { full: 'Kim', user: 'x' }, 'Windows: USERNAME');
assert.deepEqual(accountNames({ platform: 'darwin', user: 'sam', env: {}, run: () => { throw new Error('no id'); } }), { full: '', user: 'sam' }, 'a failing command just gives no full name');
console.log('brainname: "<First> OS" default name ok');
