import assert from 'node:assert/strict';
import { aboutYomna } from '../about.mjs';

const base = { name: 'Yomna', looks: ['Yomna', 'GlayOS', 'Sarah'], mac: false, linux: false, snap: false, pointer: false, voice: false, hotkeys: false };
const mac = aboutYomna({ ...base, mac: true, snap: true, pointer: true, voice: true, hotkeys: true, wake: true });
const win = aboutYomna(base);
const linux = aboutYomna({ ...base, linux: true, voice: true, wake: true });
assert.match(mac, /lives in the menu bar at the top of the screen/);
assert.match(mac, /Show Yomna, Ask Yomna…, Ask About an Area…, Stop, Quit Yomna/);
assert.match(mac, /Look: Yomna, GlayOS or Sarah/);
assert.match(mac, /Wake word \(say "Hey Yomna"/);
assert.match(mac, /Voice Provider: Local TTS \([^)]+\), Edge TTS \([^)]+\), VoiceStudio \([^)]+\), or Gemini \([^)]+\)/);
assert.match(win, /bottom right of the taskbar/);
assert.ok(!/Ask About an Area|Wake word|Voice Control|Cursor, a little arrow/.test(win), 'features this copy lacks are left out');
assert.match(linux, /lives in the system tray/);
assert.match(linux, /In-app updates are off in this build/);
assert.match(linux, /Wake word \(say "Hey Yomna"/, 'the wake word on Windows and Linux too');
assert.match(mac, /Speaking \(Voice mode:.*Replies:.*Listening \(Voice Control.*Shortcuts \(.*General \(Sound Effects/);
assert.match(linux, /Shortcuts \(the commands to bind/, 'no global keys there: the commands to bind');
for (const t of [mac, win, linux]) assert.ok(!/Behavior \(|, Voice \(/.test(t), 'no old page names');
assert.match(win, /Harness \(.*Antigravity \(agy\).*OpenCode.*Pi.*Claude Code.*Custom ACP\/CLI/);
for (const t of [mac, win, linux]) {
  assert.match(t, /Save Diagnostics/);
  assert.match(t, /github\.com\/aammo1\/yomna/);
  assert.ok(!/\$\{|undefined/.test(t), 'every part is filled in');
  assert.match(t, /Memory:.*What I Remember[^]*Commitments \(/);
  assert.match(t, /Abilities:.*Skills \(how-tos you learned, each with View[^]*Learn Skills on the General page[^]*Connections \([^]*Routines \(Morning Briefing/);
  assert.match(t, /yomna-desktop MCP server/);
  assert.match(t, /Second brain \(/);
}
assert.match(mac, /kept in the Keychain\) and Routines/);
assert.match(win, /kept in the Windows key store\) and Routines/);
console.log('about tests: passed');
