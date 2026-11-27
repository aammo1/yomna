// Where the default second brain goes: the user's real Desktop folder, not always ~/Desktop. Windows with OneDrive
// backup moves it (the registry's User Shell Folders says where), and Linux names it per language (XDG_DESKTOP_DIR in
// ~/.config/user-dirs.dirs). No system calls: the registry query and the file read are stand-ins. Run: npm test
import assert from 'node:assert/strict';
import { desktopBrainDir, desktopDir } from '../secondbrain.mjs';

const REG = (value) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Desktop    REG_EXPAND_SZ    ${value}\r\n\r\n`;
const reg = (out) => (cmd, args) => { reg.calls.push([cmd, ...args].join(' ')); return out; };
reg.calls = [];

// Windows: OneDrive's Known Folder Move. %USERPROFILE% is the home folder.
const kim = 'C:\\Users\\kim';
assert.equal(desktopDir(kim, { platform: 'win32', env: {}, run: reg(REG('%USERPROFILE%\\OneDrive\\Desktop')) }), 'C:\\Users\\kim\\OneDrive\\Desktop', 'OneDrive Desktop');
assert.ok(reg.calls.some((c) => c.startsWith('reg query') && c.includes('User Shell Folders') && c.includes('Desktop')), 'asks the registry');
assert.equal(desktopBrainDir(kim, 'Kim OS', { platform: 'win32', env: {}, run: reg(REG('%USERPROFILE%\\OneDrive\\Desktop')) }), 'C:\\Users\\kim\\OneDrive\\Desktop\\Kim OS', 'the brain goes on that Desktop');
// Other variables come from the environment; an absolute path is used as it is.
assert.equal(desktopDir(kim, { platform: 'win32', env: { OneDrive: 'D:\\OneDrive - Work' }, run: reg(REG('%OneDrive%\\Desktop')) }), 'D:\\OneDrive - Work\\Desktop');
assert.equal(desktopDir(kim, { platform: 'win32', env: {}, run: reg(REG('E:\\Desk')) }), 'E:\\Desk');
// Nothing usable (no answer, a variable it can't fill, a failing command): ~\Desktop.
for (const run of [reg(''), reg(REG('%NOPE%\\Desktop')), () => { throw new Error('no reg'); }]) {
  assert.equal(desktopDir(kim, { platform: 'win32', env: {}, run }), 'C:\\Users\\kim\\Desktop');
}

// Linux: XDG_DESKTOP_DIR from user-dirs.dirs ($HOME is the home folder), or from the environment.
const dirs = (text) => (f) => { dirs.read = f; return text; };
assert.equal(desktopDir('/home/kim', { platform: 'linux', env: {}, read: dirs('# written by xdg-user-dirs-update\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_DESKTOP_DIR="$HOME/Schreibtisch"\n') }), '/home/kim/Schreibtisch', 'a German Desktop');
assert.equal(dirs.read, '/home/kim/.config/user-dirs.dirs');
assert.equal(desktopDir('/home/kim', { platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, read: dirs('XDG_DESKTOP_DIR="/data/desk"\n') }), '/data/desk', 'an absolute one');
assert.equal(dirs.read, '/cfg/user-dirs.dirs', 'XDG_CONFIG_HOME is where the file is');
assert.equal(desktopDir('/home/kim', { platform: 'linux', env: { XDG_DESKTOP_DIR: '/home/kim/Bureau' }, read: dirs('XDG_DESKTOP_DIR="$HOME/Schreibtisch"\n') }), '/home/kim/Bureau', 'the environment first');
for (const read of [dirs(''), () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }]) {
  assert.equal(desktopDir('/home/kim', { platform: 'linux', env: {}, read }), '/home/kim/Desktop', 'no setting: ~/Desktop');
}

// macOS: always ~/Desktop.
assert.equal(desktopDir('/Users/kim', { platform: 'darwin', env: {} }), '/Users/kim/Desktop');
assert.equal(desktopBrainDir('/Users/kim', 'Kim OS', { platform: 'darwin', env: {} }), '/Users/kim/Desktop/Kim OS');
console.log('desktopdir: the real Desktop on Windows, Linux and macOS ok');
