// Yomna data directory resolution: ~/Yomna with Data/, Skills/, Agents/ (and YOMNA_DATA_DIR override). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yomna-datadir-test-'));
process.env.YOMNA_DATA_DIR = path.join(TMP, 'import');
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { baseDir, dataPaths, layout, yomnaDir, AGENTS_DIR, CONFIG_PATH, DATA_DIR, SKILLS_DIR, YOMNA_DIR } = await import('../datadir.mjs');

assert.equal(YOMNA_DIR, path.join(TMP, 'import', 'Yomna'), 'YOMNA_DATA_DIR stands in for the home folder');
assert.equal(DATA_DIR, path.join(TMP, 'import', 'Yomna', 'Data'));
assert.equal(CONFIG_PATH, path.join(DATA_DIR, 'settings.json'));
assert.equal(SKILLS_DIR, path.join(YOMNA_DIR, 'Skills'));
assert.equal(AGENTS_DIR, path.join(YOMNA_DIR, 'Agents'));
assert.equal(yomnaDir(), YOMNA_DIR);
assert.equal(baseDir({}), os.homedir());

const custom = layout(path.join(TMP, 'custom'));
assert.deepEqual(custom, {
  root: path.join(TMP, 'custom', 'Yomna'),
  dir: path.join(TMP, 'custom', 'Yomna', 'Data'),
  config: path.join(TMP, 'custom', 'Yomna', 'Data', 'settings.json'),
  skills: path.join(TMP, 'custom', 'Yomna', 'Skills'),
  agents: path.join(TMP, 'custom', 'Yomna', 'Agents'),
});
assert.equal(dataPaths({ YOMNA_DATA_DIR: path.join(TMP, 'env') }), dataPaths({ YOMNA_DATA_DIR: path.join(TMP, 'env') }), 'resolved once per folder');
console.log('datadir tests: passed');
