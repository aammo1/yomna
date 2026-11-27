// A stand-in for the Codex CLI (`codex exec --json …`), in Node so it runs on Windows CI too. It starts the MCP server
// it was given with -c mcp_servers.jarvis={…} the way Codex does, calls our tools through it, and prints --json events.
// The model picks the script: 'gpt-5.5' plans and finishes, 'gpt-nope' is refused, 'gpt-slow' works until stopped,
// 'gpt-twoturn' ends its first turn once FAKE_CODEX_GO exists and finishes on the next.
// `--version`, `login status` and `debug models` answer like the real one (FAKE_CODEX_NO_MODELS=1: no catalog); FAKE_CODEX_SIGNED_OUT=1 makes it signed out.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 0.155.1'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_SIGNED_OUT) { console.error('Not logged in'); process.exit(1); }
  console.error('Logged in using ChatGPT'); process.exit(0);
}
// The account's model catalog, as `codex debug models` prints it (refreshed from the server).
if (argv[0] === 'debug' && argv[1] === 'models') {
  if (process.env.FAKE_CODEX_NO_MODELS) { console.error("error: unrecognized subcommand 'debug'"); process.exit(2); }
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 1 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 9 },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 2 },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 5 },
  ] }));
  process.exit(0);
}
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const model = opt('-m') ?? opt('--model');
const resume = argv.includes('resume');
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ argv, pid: process.pid })}\n`);
let input = '';
for await (const c of process.stdin) input += c;

if (model === 'gpt-nope') {
  out({ type: 'thread.started', thread_id: 't-1' });
  out({ type: 'turn.started' });
  out({ type: 'error', message: "The 'gpt-nope' model is not supported when using Codex with a ChatGPT account." });
  out({ type: 'turn.failed', error: { message: "The 'gpt-nope' model is not supported when using Codex with a ChatGPT account." } });
  process.exit(1);
}

// The MCP server from the -c override, started as Codex starts a stdio server.
const cfg = argv.find((a, i) => argv[i - 1] === '-c' && a.startsWith('mcp_servers.jarvis='));
const command = JSON.parse(cfg.match(/command=("(?:[^"\\]|\\.)*")/)[1]);
const args = JSON.parse(cfg.match(/args=(\[.*?\])(?=,\w+=|})/)[1]);
const mcp = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', seq = 0;
const pending = new Map();
mcp.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    pending.get(m.id)?.(m); pending.delete(m.id);
  }
});
const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0' } });
mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const { result: { tools } } = await rpc('tools/list', {});
let n = 0;
const call = async (tool, args) => {
  const item = { id: `item_${++n}`, type: 'mcp_tool_call', server: 'jarvis', tool, arguments: args, status: 'in_progress' };
  out({ type: 'item.started', item });
  const r = await rpc('tools/call', { name: tool, arguments: args });
  out({ type: 'item.completed', item: { ...item, status: r.result?.isError ? 'failed' : 'completed', result: r.result } });
  return r.result;
};

out({ type: 'thread.started', thread_id: 't-1' });
out({ type: 'turn.started' });
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ input, tools: tools.map((t) => t.name), resume })}\n`);
if (model === 'gpt-twoturn' && !resume) {
  // Plans, waits until the test says go (FAKE_CODEX_GO exists), then ends its turn without finishing.
  await call('plan', { now: 'First turn' });
  while (!fs.existsSync(process.env.FAKE_CODEX_GO)) await new Promise((r) => setTimeout(r, 50));
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
  mcp.kill();
  process.exit(0);
} else if (model === 'gpt-twoturn') {
  await call('finish', { outcome: 'Done on the second turn.' });
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
  mcp.kill();
  process.exit(0);
} else if (model === 'gpt-slow') {
  await call('plan', { now: 'Working for a long time' });
  setInterval(() => out({ type: 'item.updated', item: { id: 'r', type: 'reasoning', text: '…' } }), 200);
} else {
  await call('plan', { now: 'Writing the note' });
  await new Promise((r) => setTimeout(r, 500)); // the row shows it (updates are batched for 300 ms)
  const w = await call('write_file', { path: 'files/note.md', content: '# Hi\n' });
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ write: w })}\n`);
  out({ type: 'item.completed', item: { id: `item_${++n}`, type: 'agent_message', text: 'Done.' } });
  await call('finish', { outcome: 'Wrote a short note.', files: [{ path: 'files/note.md', what: 'the note' }] });
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 10 } });
  mcp.kill();
  process.exit(0);
}
