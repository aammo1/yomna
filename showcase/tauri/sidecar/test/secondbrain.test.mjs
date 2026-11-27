// The second brain folder: checking the typed path, the system prompt's part (present, absent, capped, re-read when
// AGENTS.md changes), relative file paths starting there, secrets in it still blocked, and its read-only skills.
// Runs against a throwaway HOME. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-brain-test-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME; delete process.env.JARVIS_DATA_DIR;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const B = await import('../secondbrain.mjs');
const K = await import('../skills.mjs');
const { createTools, resolveAt } = await import('../tools.mjs');
const { BLOCK, checkRead, checkWrite } = await import('../safety.mjs');

const brain = path.join(HOME, 'SecondBrain');
fs.mkdirSync(path.join(brain, '_context'), { recursive: true });
fs.mkdirSync(path.join(brain, '_raw'));
fs.writeFileSync(path.join(brain, '_context', 'index.md'), '# Index');
fs.writeFileSync(path.join(brain, '_context', 'source-map.md'), '# Sources');
fs.writeFileSync(path.join(HOME, 'note.txt'), 'x');

// ---------- the typed path ----------
assert.equal(B.checkSecondBrain('', HOME).why, 'empty');
assert.equal(B.checkSecondBrain('  ', HOME).why, 'empty');
assert.deepEqual(B.checkSecondBrain('~/SecondBrain', HOME), { ok: true, dir: brain }, '~ is the home folder');
assert.deepEqual(B.checkSecondBrain(`"${brain}/"`, HOME), { ok: true, dir: brain }, 'quotes and a trailing slash are fine');
assert.equal(B.checkSecondBrain('SecondBrain', HOME).ok, false, 'a relative path is refused');
assert.equal(B.checkSecondBrain('~/Nope', HOME).ok, false, 'a missing folder is refused');
assert.match(B.checkSecondBrain('~/note.txt', HOME).why, /file, not a folder/);
assert.match(B.checkSecondBrain('~', HOME).why, /not your whole home folder/);
assert.match(B.checkSecondBrain(TMP, HOME).why, /inside your home folder/, 'outside home is refused');
if (process.platform !== 'win32') {
  fs.symlinkSync(TMP, path.join(HOME, 'out'));
  assert.equal(B.checkSecondBrain('~/out', HOME).ok, false, 'a link that leads out of home is refused');
}

// ---------- the prompt's part ----------
assert.equal(B.secondBrainBlock(''), '', 'off: nothing');
assert.equal(B.secondBrainBlock(path.join(HOME, 'gone')), '', 'a folder that is gone: nothing');
let block = B.secondBrainBlock(brain);
assert.ok(block.includes(brain), 'names the folder');
assert.match(block, /second brain/);
assert.match(block, /_context\/index\.md/);
assert.match(block, /_context\/source-map\.md[^\n]*_raw\//);
assert.match(block, /Never write[^\n]*_raw\//);
assert.match(block, /_context is memory, not proof/);
assert.ok(!block.includes('<second-brain-rules>'), 'no AGENTS.md: no rules part');
// Only what it has: a plain notes folder gets no _raw or _context advice.
const plainNotes = path.join(HOME, 'Notes');
fs.mkdirSync(plainNotes);
assert.deepEqual(B.brainLayout(plainNotes), []);
const plain = B.secondBrainBlock(plainNotes);
assert.ok(plain.includes(plainNotes) && !/_raw|_context|found in it/.test(plain), 'a plain folder: no layout, no _raw advice');

// ---------- its layout ----------
fs.mkdirSync(path.join(brain, '_research')); fs.mkdirSync(path.join(brain, 'Projects')); fs.writeFileSync(path.join(brain, 'Projects', 'index.md'), '# P');
fs.mkdirSync(path.join(brain, '.agents', 'skills'), { recursive: true }); fs.writeFileSync(path.join(brain, 'wiki'), 'a file, not the wiki folder');
let lay = B.brainLayout(brain);
assert.deepEqual(lay.map((x) => x.key), ['raw', 'context', 'research', 'projects', 'skills', 'index', 'sourceMap', 'projectsIndex'], 'in order, only what is there (a file named wiki is no wiki)');
assert.equal(lay.find((x) => x.key === 'projects').path, path.join(brain, 'Projects'), 'any letter case, with its real name');
assert.deepEqual(B.layoutFound(lay), ['raw', 'context (wiki)', 'research', 'projects', 'skills'], 'no wiki folder: the context is the wiki');
block = B.secondBrainBlock(brain);
assert.match(block, /Your second brain \(found in it\):/);
assert.ok(block.includes(`- ${path.join(brain, '_raw')}/: raw evidence`), 'full paths with one-line roles');
assert.ok(block.includes(`- ${path.join(brain, '_context', 'index.md')}: start here`));
assert.ok(!block.includes('the wiki: the summarised'), 'no wiki line without a wiki');
fs.mkdirSync(path.join(brain, '_context', 'Wiki'));
lay = B.brainLayout(brain);
assert.equal(lay.find((x) => x.key === 'wiki').path, path.join(brain, '_context', 'Wiki'), 'a wiki under _context');
assert.deepEqual(B.layoutFound(lay), ['raw', 'context', 'wiki', 'research', 'projects', 'skills']);
assert.ok(B.secondBrainBlock(brain).includes(`- ${path.join(brain, '_context', 'Wiki')}/: the wiki`), 'seen again on the next look (each new chat)');

fs.writeFileSync(path.join(brain, 'CLAUDE.md'), 'Claude rules here.');
block = B.secondBrainBlock(brain);
assert.match(block, /from CLAUDE\.md/, 'CLAUDE.md when there is no AGENTS.md');
assert.match(block, /Claude rules here\./);

fs.writeFileSync(path.join(brain, 'AGENTS.md'), '# AGENTS.md\n\nKeep replies short.');
block = B.secondBrainBlock(brain);
assert.match(block, /from AGENTS\.md/, 'AGENTS.md comes first');
assert.match(block, /Keep replies short\./);
assert.ok(!block.includes('Claude rules here.'));

// Read again when it changes (the cache goes by modification time and size).
fs.writeFileSync(path.join(brain, 'AGENTS.md'), '# AGENTS.md\n\nKeep replies long and detailed.');
fs.utimesSync(path.join(brain, 'AGENTS.md'), new Date(), new Date(Date.now() + 5000));
assert.match(B.secondBrainBlock(brain), /Keep replies long and detailed\./, 'a changed AGENTS.md is read again');

// Capped, so small local models still fit.
fs.writeFileSync(path.join(brain, 'AGENTS.md'), `START ${'word '.repeat(4000)}END`);
block = B.secondBrainBlock(brain);
assert.ok(!block.includes('END'), 'the tail is cut');
assert.match(block, /START/);
assert.match(block, /cut here; read_file AGENTS\.md for the rest/);
assert.ok(block.length < B.RULES_MAX + 1500, `the whole part stays small (${block.length})`);
assert.ok(block.includes('found in it') && block.includes('START'), 'the found list and the rules share the cap');
assert.ok(B.secondBrainBlock(brain, { max: 100 }).length < 1500, 'a small cap holds the found list too');
assert.ok(B.secondBrainBlock(brain, { max: 400 }).includes('_raw/: raw evidence'), 'its first lines when they fit');

// The chat's system prompt takes it last, from the folder that's set, and the file tools start there.
const side = fs.readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
assert.match(side, /const system = \(\) => \(config\.lite \? litePrompt\(\) : stablePrompt\(\)\) \+ secondBrainBlock\(brain\(\)\);/);
assert.match(side, /workdir: WORKDIR, fileDir: brainDir,/, 'the chat passes the folder to its file tools');
assert.match(side, /secondBrain: null,/, 'off by default');

// ---------- relative paths ----------
assert.equal(resolveAt('_context/index.md', brain), path.join(brain, '_context', 'index.md'));
assert.equal(resolveAt('', brain), brain);
assert.equal(resolveAt('/etc/hosts', brain), '/etc/hosts', 'full paths stay');
assert.equal(resolveAt('~/Downloads/a.txt', brain), '~/Downloads/a.txt', '~ paths stay');
assert.equal(resolveAt('C:\\x.txt', brain), 'C:\\x.txt');

// Secrets inside the second brain stay blocked, by a relative path as by a full one.
fs.writeFileSync(path.join(brain, '.env'), 'KEY=secret');
for (const p of ['.env', '.env.local', path.join(brain, '.env')]) {
  assert.equal(checkRead(resolveAt(p, brain), HOME).level, BLOCK, `reading ${p} is blocked`);
  assert.equal(checkWrite(resolveAt(p, brain), HOME, { exists: true }).level, BLOCK, `writing ${p} is blocked`);
}
assert.notEqual(checkRead(resolveAt('_context/index.md', brain), HOME).level, BLOCK, 'ordinary notes can be read');

// ---------- _raw is read-only (the chat's file tools and commands) ----------
assert.match(side, /readOnly: rawDirs,/, 'the chat passes _raw as read-only to its tools');
assert.match(side, /const rawDirs = \(\) => \{ const b = brain\(\); return b\?\.raw \? \[b\.raw\] : \[\]; \};/, 'the raw folder in use, not a guess');
assert.match(side, /setExtraSkillsDir\(\(\) => brain\(\)\?\.skills \?\? ''\)/, 'skills from <agents>/skills in use');
{
  const noop = () => {};
  const made = createTools({ allowActions: () => true, ui: noop, ask: async () => 'yes', openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', fileDir: () => brain, readOnly: () => [path.join(brain, '_raw')], skipAllow: () => true });
  const tool = (n) => made.tools.find((t) => t.name === n);
  fs.writeFileSync(path.join(brain, '_raw', 'call.md'), 'evidence');
  await assert.rejects(tool('write_file').execute({ path: '_raw/new.md', content: 'x' }, {}), /raw evidence in your second brain, so it is read-only/, 'no new file in _raw');
  await assert.rejects(tool('write_file').execute({ path: '_raw/call.md', content: 'x' }, {}), /raw evidence in your second brain/, 'no overwrite in _raw');
  await assert.rejects(tool('write_file').execute({ path: path.join(brain, '_RAW', 'x.md'), content: 'x' }, {}), /raw evidence in your second brain/, 'any letter case');
  await assert.rejects(tool('run_command').execute({ command: `rm ${path.join(brain, '_raw', 'call.md')}` }, {}), /raw evidence in your second brain/, 'no rm in _raw');
  await assert.rejects(tool('run_command').execute({ command: `mv ${path.join(brain, '_raw', 'call.md')} ${path.join(brain, 'x.md')}` }, {}), /raw evidence in your second brain/, 'no moving out of _raw');
  assert.equal(fs.readFileSync(path.join(brain, '_raw', 'call.md'), 'utf8'), 'evidence', 'left as it was');
  assert.match(await tool('read_file').execute({ path: '_raw/call.md' }, {}), /evidence/, 'reading it is fine');
  assert.match(await tool('write_file').execute({ path: '_context/new.md', content: 'note' }, {}), /Wrote/, 'the rest of the second brain is writable');
}

// ---------- its skills ----------
const sk = path.join(brain, '.agents', 'skills');
const addExtra = (folder, desc, files = {}) => {
  fs.mkdirSync(path.join(sk, folder), { recursive: true });
  fs.writeFileSync(path.join(sk, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${desc}\n---\n\nSteps for ${folder}.`);
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(sk, folder, f)), { recursive: true }); fs.writeFileSync(path.join(sk, folder, f), t); }
};
addExtra('sync-kb', 'When syncing the knowledge base.', { 'references/how.md': 'How to sync.' });
addExtra('alpha', 'First by name.');
addExtra('mine', 'The second brain copy.');
fs.mkdirSync(path.join(sk, 'no-skill-md'));
await K.saveSkill({ name: 'mine', description: 'My own copy.', steps: 'Mine.' });

assert.deepEqual(K.listSkills().map((s) => s.slug), ['mine'], 'none from the second brain until it is set');
K.setExtraSkillsDir(sk);
let list = K.listSkills();
assert.deepEqual(list.map((s) => s.slug), ['mine', 'alpha', 'sync-kb'], "their own first, then the second brain's by name; a folder without SKILL.md is skipped");
assert.ok(!list[0].readonly && list[1].readonly && list[2].readonly);
assert.equal(K.readSkill('mine').description, 'My own copy.', 'their own wins a clash');
const ex = K.readSkill('sync-kb');
assert.equal(ex.readonly, true);
assert.equal(ex.steps, 'Steps for sync-kb.');
assert.deepEqual(K.skillFiles('sync-kb'), ['references/how.md']);
assert.equal(K.readSkillFile('sync-kb', 'references/how.md'), 'How to sync.');
assert.equal(K.readSkillFile('sync-kb', '../alpha/SKILL.md'), null, 'not outside its folder');
await assert.rejects(K.deleteSkill('sync-kb'), /second brain/, "the second brain's skills can't be removed");
assert.ok(fs.existsSync(path.join(sk, 'sync-kb', 'SKILL.md')));
assert.match(K.skillIndex(), /- sync-kb: When syncing the knowledge base\./);

// No cap on the second brain's: every one is listed (a real .agents/skills holds 150+), their own first; MAX_SKILLS
// still caps their own, and the second brain's never stop them saving their own.
for (let i = 0; i < K.MAX_SKILLS + 5; i++) addExtra(`extra-${String(i).padStart(2, '0')}`, `Extra ${i}.`);
list = K.listSkills();
assert.equal(list.filter((s) => s.readonly).length, K.MAX_SKILLS + 5 + 2, "every second brain skill listed, past MAX_SKILLS");
assert.equal(list[0].slug, 'mine');
assert.match(K.skillIndex(), new RegExp(`- extra-${K.MAX_SKILLS + 4}: Extra ${K.MAX_SKILLS + 4}\\.`), 'the last one is in the index too');
assert.ok(K.readSkill(`extra-${K.MAX_SKILLS + 4}`), 'and readable');
await K.saveSkill({ name: 'another', description: 'Another of mine.', steps: 'Go.' });
assert.deepEqual(K.listSkills().slice(0, 2).map((s) => s.slug).sort(), ['another', 'mine'], 'their own still come first');
assert.equal(K.listSkills().length, 2 + K.MAX_SKILLS + 5 + 2);

// use_skill finds a second brain skill by its folder even when the index left it out (here: a second folder with the
// same slug); a name that leads out of the folder is no skill at all.
addExtra('deploy-app', 'The indexed one.');
addExtra('deploy_app', 'Left out of the index.', { 'notes.md': 'Hidden notes.' });
assert.equal(K.listSkills().filter((s) => s.slug === 'deploy-app').length, 1);
assert.ok(!K.skillIndex().includes('Left out of the index'));
const hidden = K.readSkill('deploy_app');
assert.equal(hidden?.description, 'Left out of the index.', 'read from <skills>/deploy_app/SKILL.md');
assert.equal(hidden.readonly, true);
assert.deepEqual(K.skillFiles(hidden.slug), ['notes.md'], 'its own files, not the indexed twin');
assert.equal(K.readSkillFile(hidden.slug, 'notes.md'), 'Hidden notes.');
assert.equal(K.readSkill('deploy-app').description, 'The indexed one.');
for (const bad of ['../alpha', '..', 'x/alpha', 'alpha/', 'x\\alpha', '../../.agents/skills/alpha']) assert.equal(K.readSkill(bad), null, `${bad} is refused`);

K.setExtraSkillsDir('');
assert.deepEqual(K.listSkills().map((s) => s.slug).sort(), ['another', 'mine'], 'cleared: only their own');
assert.equal(K.readSkill('sync-kb'), null);

// ---------- the setting: a map of locations ----------
// The old setting (the root alone) becomes the map, its locations found in it by name.
const oldRoot = path.join(HOME, 'SecondBrain');
let m = B.migrateBrain(oldRoot);
assert.deepEqual(m, { root: oldRoot, raw: path.join(oldRoot, '_raw'), context: path.join(oldRoot, '_context'), research: path.join(oldRoot, '_research'), projects: path.join(oldRoot, 'Projects'), agents: path.join(oldRoot, '.agents') }, 'string → map, found by name');
assert.equal(B.migrateBrain(''), null, 'off stays off');
assert.equal(B.migrateBrain(null), null);
assert.deepEqual(B.migrateBrain(m), m, 'a map is kept as it is');
assert.equal(B.migrateBrain({ raw: '/x' }), null, 'no root: off');
const gone = B.migrateBrain(path.join(HOME, 'Gone'));
assert.deepEqual(gone, { root: path.join(HOME, 'Gone'), raw: '', context: '', research: '', projects: '', agents: '' }, 'a folder that is gone: root kept, nothing found');
assert.equal(B.resolveBrain(gone, HOME), null, 'and not in use');
// In use: saved ones as they are, unset ones found in root at each look (never over one chosen by hand).
const notes = path.join(HOME, 'Notes2'), evidence = path.join(HOME, 'Evidence'), agentsDir = path.join(HOME, 'MyAgents');
fs.mkdirSync(path.join(notes, '_context'), { recursive: true }); fs.mkdirSync(evidence); fs.mkdirSync(path.join(agentsDir, 'skills', 'deploy'), { recursive: true });
fs.writeFileSync(path.join(agentsDir, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it.\n---\n\nGo.');
const custom = { root: notes, raw: evidence, context: '', research: '', projects: '', agents: agentsDir };
let use = B.resolveBrain(custom, HOME);
assert.equal(use.raw, evidence, 'a raw folder chosen by hand');
assert.equal(use.context, path.join(notes, '_context'), 'unset: found in root');
assert.equal(use.research, '', 'not there: none');
assert.equal(use.skills, path.join(agentsDir, 'skills'), 'skills are <agents>/skills');
fs.mkdirSync(path.join(notes, '_raw')); fs.mkdirSync(path.join(notes, '_research'));
use = B.resolveBrain(custom, HOME);
assert.equal(use.research, path.join(notes, '_research'), 'found at the next look');
assert.equal(use.raw, evidence, "one chosen by hand isn't replaced by what's found");
assert.equal(B.resolveBrain({ ...custom, raw: TMP }, HOME).raw, path.join(notes, '_raw'), 'a saved one outside home is not used');
// The prompt lists the locations in use.
block = B.secondBrainBlock(use);
assert.ok(block.includes(`- ${evidence}/: raw evidence`), 'the custom raw folder, with its role');
assert.ok(block.includes(`Never write, move or delete anything in ${evidence}/`), 'the raw rule names it');
assert.ok(block.includes(`- ${path.join(agentsDir, 'skills')}/: skills`));
assert.ok(!block.includes(`${path.join(notes, '_raw')}/: raw`), 'not the _raw it would have guessed');

// The raw rule on a custom raw folder (what the chat's tools get from rawDirs).
{
  const noop = () => {};
  const made = createTools({ allowActions: () => true, ui: noop, ask: async () => 'yes', openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', fileDir: () => use.root, readOnly: () => [use.raw], skipAllow: () => true });
  const tool = (n) => made.tools.find((t) => t.name === n);
  await assert.rejects(tool('write_file').execute({ path: path.join(evidence, 'x.md'), content: 'x' }, {}), /raw evidence in your second brain/, 'no writing in the custom raw folder');
  await assert.rejects(tool('run_command').execute({ command: `rm -rf ${evidence}` }, {}), /raw evidence/, 'no removing it');
  assert.match(await tool('write_file').execute({ path: '_raw/x.md', content: 'x' }, {}), /Wrote/, "root's _raw isn't the raw folder here");
  assert.equal(checkWrite(path.join(evidence, 'a.md'), HOME, { readOnly: [use.raw] }).level, BLOCK);
}
// Skills from a custom agents folder, followed as the setting changes.
let current = use;
K.setExtraSkillsDir(() => current?.skills ?? '');
assert.ok(K.listSkills().some((s) => s.slug === 'deploy' && s.readonly), "the custom agents folder's skills");
current = null;
assert.ok(!K.listSkills().some((s) => s.slug === 'deploy'), 'off: gone');
K.setExtraSkillsDir('');

// ---------- every location inside the home folder ----------
assert.deepEqual(B.checkLocation('~/Somewhere/New', HOME), { ok: true, dir: path.join(HOME, 'Somewhere', 'New') }, "needn't exist yet");
assert.match(B.checkLocation(TMP, HOME).why, /inside your home folder/);
assert.match(B.checkLocation(path.join(TMP, 'x'), HOME).why, /inside your home folder/, 'a new one outside home too');
assert.match(B.checkLocation('~', HOME).why, /not your whole home folder/);
assert.match(B.checkLocation('rel/path', HOME).why, /full path/);
assert.match(B.checkLocation('~/note.txt', HOME).why, /file, not a folder/);
assert.equal(B.checkLocation('', HOME).why, 'empty');
if (process.platform !== 'win32') assert.equal(B.checkLocation('~/out/new', HOME).ok, false, 'through a link that leads out of home');
let chk = B.checkForm({ root: notes, raw: evidence, context: path.join(notes, '_context'), research: path.join(notes, 'nope'), projects: TMP, agents: '' }, HOME);
assert.equal(chk.status.root.status, 'found');
assert.equal(chk.status.raw.status, 'found');
assert.match(chk.status.raw.warn, /Outside the root/, 'outside root: a warning, still allowed');
assert.equal(chk.status.context.warn, undefined);
assert.equal(chk.status.research.status, 'missing');
assert.equal(chk.status.projects.status, 'bad', 'outside home: refused');
assert.equal(chk.status.agents.status, 'unset');
assert.equal(chk.found.raw, path.join(notes, '_raw'), 'and what root holds by name');
assert.equal(B.checkForm({ root: path.join(HOME, 'New'), raw: path.join(HOME, 'New', '_raw') }, HOME, { create: true }).status.raw.status, 'will create');
assert.equal(B.checkForm({ root: HOME }, HOME).status.root.status, 'bad', 'not the home folder as root');

// ---------- making a new one never writes over anything ----------
const fresh = path.join(HOME, 'Brains', 'Mine');
const locs = { root: fresh, raw: path.join(fresh, '_raw'), context: path.join(fresh, '_context'), research: path.join(fresh, '_research'), projects: path.join(fresh, 'projects'), agents: path.join(fresh, '.agents') };
let made = B.createBrain(locs, HOME);
assert.equal(made.ok, true, made.why);
for (const d of [...Object.values(locs), path.join(fresh, '.agents', 'skills')]) assert.ok(fs.statSync(d).isDirectory(), `${d} made`);
for (const f of ['AGENTS.md', '_context/index.md', '_context/source-map.md', 'projects/index.md']) assert.ok(fs.statSync(path.join(fresh, f)).isFile(), `${f} made`);
const agentsMd = fs.readFileSync(path.join(fresh, 'AGENTS.md'), 'utf8');
assert.match(agentsMd, /_raw → _context → _research/, 'knowledge flows one way');
assert.match(agentsMd, /_raw is never edited/);
assert.match(agentsMd, /word-only memory/);
assert.match(agentsMd, /self-contained/);
assert.ok(agentsMd.length < 1500, 'short');
fs.writeFileSync(path.join(fresh, 'AGENTS.md'), 'MY OWN RULES');
fs.writeFileSync(path.join(fresh, '_context', 'index.md'), 'MY INDEX');
fs.writeFileSync(path.join(fresh, '_raw', 'call.md'), 'evidence');
made = B.createBrain(locs, HOME);
assert.equal(made.ok, true);
assert.equal(fs.readFileSync(path.join(fresh, 'AGENTS.md'), 'utf8'), 'MY OWN RULES', 'AGENTS.md kept');
assert.equal(fs.readFileSync(path.join(fresh, '_context', 'index.md'), 'utf8'), 'MY INDEX', 'index kept');
assert.equal(fs.readFileSync(path.join(fresh, '_raw', 'call.md'), 'utf8'), 'evidence', 'raw untouched');
assert.deepEqual(made.made, [], 'nothing new the second time');
assert.equal(made.kept.length, 4);
// Only the folders chosen, the files that go with them, and a subfolder elsewhere in home.
const lean = path.join(HOME, 'Lean'), ctxElse = path.join(HOME, 'Wiki');
made = B.createBrain({ root: lean, raw: '', context: ctxElse, research: '', projects: '', agents: '' }, HOME);
assert.equal(made.ok, true);
assert.deepEqual(fs.readdirSync(lean), ['AGENTS.md'], 'no folders it was not asked for');
assert.ok(fs.existsSync(path.join(ctxElse, 'index.md')) && !fs.existsSync(path.join(lean, 'projects')));
assert.deepEqual(made.locations, { root: lean, raw: '', context: ctxElse, research: '', projects: '', agents: '' });
assert.equal(B.createBrain({ root: path.join(TMP, 'Out') }, HOME).ok, false, 'outside home: refused');
assert.ok(!fs.existsSync(path.join(TMP, 'Out')), 'and nothing made');
assert.equal(B.createBrain({ root: path.join(HOME, 'X'), raw: TMP }, HOME).ok, false, 'a subfolder outside home: refused');
assert.ok(!fs.existsSync(path.join(HOME, 'X')), 'and nothing made, not even root');
assert.equal(B.createBrain({ root: '' }, HOME).ok, false);

console.log('secondbrain ok');
