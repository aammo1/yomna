// CP-13 stand-in for the Claude Code CLI's sign-in commands, in Node so it runs on every CI OS. `auth status --json`
// reports the state file; `auth login --claudeai` prints the visit line, plays the browser's localhost callback into
// GG_CLAUDE_CODE_URL_FILE (what gg-core's BROWSER hook would capture), then signs in, or refuses with
// FAKE_CLAUDE_MODE=deny. No network, no browser.
import fs from 'node:fs';

const argv = process.argv.slice(2), state = process.env.FAKE_CLAUDE_STATE;
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify(fs.existsSync(state) ? { loggedIn: true, authMethod: 'claude.ai', email: 'ken@example.com' } : { loggedIn: false }));
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'login') {
  console.log("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1");
  if (process.env.GG_CLAUDE_CODE_URL_FILE) fs.appendFileSync(process.env.GG_CLAUDE_CODE_URL_FILE, 'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback\n');
  setTimeout(() => {
    if (process.env.FAKE_CLAUDE_MODE === 'deny') { console.error('Error: OAuth access was denied'); process.exit(1); }
    fs.writeFileSync(state, 'in');
    process.exit(0);
  }, 400);
} else { console.error(`fake claude: unexpected ${argv.join(' ')}`); process.exit(2); }
