// Unit tests for Yomna's pluggable CLI harness adapter framework.
// Pure Node 22+ built-ins only (no node_modules required).
// Run: node --test showcase/tauri/sidecar/test/harnesses.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AcpAdapter,
  AgyAdapter,
  ClaudeAdapter,
  DEFAULT_HANG_TIMEOUT_MS,
  HARNESS_CATALOG,
  HarnessManager,
  OpenCodeAdapter,
  PiAdapter,
  detectHarnesses,
  hangTimeoutMs,
  probeHarness,
} from '../harnesses/index.mjs';
import { agyMcpAddArgs, buildAgyArgs, planAgyMcp } from '../harnesses/agy.mjs';
import { buildClaudeArgs } from '../harnesses/claude.mjs';
import { buildOpenCodeArgs, buildOpenCodeConfig } from '../harnesses/opencode.mjs';
import { buildPiArgs } from '../harnesses/pi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.resolve(HERE, '..', 'harnesses');

function makeTempDir(prefix = 'yomna-harness-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutableScript(dir, name, jsBody) {
  const isWin = process.platform === 'win32';
  const jsPath = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(jsPath, jsBody, 'utf8');
  if (isWin) {
    const cmdPath = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = path.join(dir, name);
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, { mode: 0o755 });
  return shPath;
}

test('harnesses/*.mjs use pure Node built-ins with zero forbidden imports or branding', () => {
  const files = fs.readdirSync(HARNESS_DIR).filter((f) => f.endsWith('.mjs'));
  for (const req of ['index.mjs', 'agy.mjs', 'opencode.mjs', 'pi.mjs', 'claude.mjs', 'acp.mjs']) {
    assert.ok(files.includes(req), `expected ${req} in harnesses/`);
  }
  for (const file of files) {
    const src = fs.readFileSync(path.join(HARNESS_DIR, file), 'utf8');
    assert.doesNotMatch(src, /@kenkaiiii\//, `${file} must not import @kenkaiiii/*`);
    assert.doesNotMatch(src, /@anthropic-ai\/claude-agent-sdk/, `${file} must not import claude-agent-sdk`);
    assert.doesNotMatch(src, new RegExp('Eric' + 'TechPro', 'i'), `${file} must not contain old branding`);
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `${file} has non-builtin import: ${spec}`);
    }
  }
  assert.equal(DEFAULT_HANG_TIMEOUT_MS, 120_000);
  assert.equal(HARNESS_CATALOG.agy.isDefault, true);
});

test('detectHarnesses detects installed agy and marks absent CLIs with install hints', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    writeExecutableScript(
      binDir,
      'agy',
      `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('1.5.18'); process.exit(0); }
      if (args[0] === 'models') { console.log('gemini-4-neon-high\\tGemini 4 Neon'); process.exit(0); }
      `,
    );

    const env = { PATH: binDir, HOME: tmp, USERPROFILE: tmp };
    const res = await detectHarnesses({ env });
    assert.equal(res.recommended, 'agy');
    assert.deepEqual(
      res.harnesses.map((h) => h.id),
      ['agy', 'opencode', 'pi', 'claude'],
    );

    const agy = res.harnesses.find((h) => h.id === 'agy');
    assert.equal(agy.installed, true);
    assert.equal(agy.authenticated, true);
    assert.equal(agy.version, '1.5.18');

    for (const absentId of ['opencode', 'pi', 'claude']) {
      const h = res.harnesses.find((x) => x.id === absentId);
      assert.equal(h.installed, false, `${absentId} should be absent`);
      assert.equal(h.authenticated, false);
      assert.ok(h.installCmd && h.installCmd.length > 0, `${absentId} should include installCmd`);
      assert.ok(h.installUrl && h.installUrl.startsWith('https://'), `${absentId} should include installUrl`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectHarnesses recommends opencode when agy is missing and opencode is authenticated', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    writeExecutableScript(
      binDir,
      'opencode',
      `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('opencode v2.1.4'); process.exit(0); }
      if (args[0] === 'auth' && args[1] === 'list') { console.log('OpenRouter  API key  stored'); process.exit(0); }
      `,
    );

    const res = await detectHarnesses({ env: { PATH: binDir, HOME: tmp, USERPROFILE: tmp } });
    assert.equal(res.recommended, 'opencode');
    const oc = res.harnesses.find((h) => h.id === 'opencode');
    assert.equal(oc.installed, true);
    assert.equal(oc.authenticated, true);
    assert.equal(oc.version, '2.1.4');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('safety flag mapping enforces read-only when allowActions=false and edit/skipAllow auto when true', () => {
  // Antigravity (agy)
  const agySafe = buildAgyArgs({ allowActions: false, skipAllow: true, secondBrainDirs: ['/notes'], sessionId: 'c-1' });
  assert.ok(agySafe.includes('--mode') && agySafe[agySafe.indexOf('--mode') + 1] === 'plan');
  assert.ok(agySafe.includes('--sandbox'));
  assert.equal(agySafe.includes('--dangerously-skip-permissions'), false);
  assert.ok(agySafe.includes('--conversation') && agySafe[agySafe.indexOf('--conversation') + 1] === 'c-1');
  assert.ok(agySafe.includes('--add-dir') && agySafe[agySafe.indexOf('--add-dir') + 1] === '/notes');

  const agyEdit = buildAgyArgs({ allowActions: true });
  assert.ok(agyEdit.includes('--mode') && agyEdit[agyEdit.indexOf('--mode') + 1] === 'accept-edits');
  assert.equal(agyEdit.includes('--sandbox'), false);
  assert.equal(agyEdit.includes('--dangerously-skip-permissions'), false);

  const agyFull = buildAgyArgs({ allowActions: true, skipAllow: true });
  assert.ok(agyFull.includes('--mode') && agyFull[agyFull.indexOf('--mode') + 1] === 'auto');
  assert.ok(agyFull.includes('--dangerously-skip-permissions'));
  assert.equal(agyFull.includes('--sandbox'), false);

  // Claude Code
  const claudeSafe = buildClaudeArgs({ allowActions: false, skipAllow: true, mcpConfigPath: '/tmp/mcp.json', sessionId: 's-1' });
  assert.equal(claudeSafe[claudeSafe.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(claudeSafe[claudeSafe.indexOf('--mcp-config') + 1], '/tmp/mcp.json');
  assert.equal(claudeSafe[claudeSafe.indexOf('--allowedTools') + 1], 'mcp__yomna-desktop');
  assert.equal(claudeSafe[claudeSafe.indexOf('--resume') + 1], 's-1');

  const claudeEdit = buildClaudeArgs({ allowActions: true });
  assert.equal(claudeEdit[claudeEdit.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(claudeEdit.includes('--allowedTools'), false);

  const claudeFull = buildClaudeArgs({ allowActions: true, skipAllow: true, mcpConfigPath: '/tmp/mcp.json' });
  assert.equal(claudeFull[claudeFull.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(claudeFull[claudeFull.indexOf('--allowedTools') + 1], 'mcp__yomna-desktop');

  // OpenCode
  const ocSafe = buildOpenCodeArgs({ prompt: 'hi', allowActions: false, sessionId: 'oc-1' });
  assert.ok(ocSafe.includes('--agent') && ocSafe[ocSafe.indexOf('--agent') + 1] === 'plan');
  assert.equal(ocSafe.includes('--auto'), false);
  const ocSafeCfg = buildOpenCodeConfig({ allowActions: false, mcpServer: { command: 'node', args: ['mcp.mjs'] } });
  assert.deepEqual(ocSafeCfg.permission, { edit: 'deny', bash: 'deny', webfetch: 'deny' });
  assert.deepEqual(ocSafeCfg.mcp['yomna-desktop'].command, ['node', 'mcp.mjs']);

  const ocEdit = buildOpenCodeArgs({ prompt: 'hi', allowActions: true });
  assert.ok(ocEdit.includes('--auto'));
  const ocEditCfg = buildOpenCodeConfig({ allowActions: true });
  assert.equal(ocEditCfg.permission, undefined);

  // Pi
  const piSafe = buildPiArgs({ prompt: 'hi', allowActions: false, sessionId: 'pi-1' });
  assert.equal(piSafe[piSafe.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.equal(piSafe[piSafe.indexOf('--session') + 1], 'pi-1');
  const piEdit = buildPiArgs({ prompt: 'hi', allowActions: true });
  assert.equal(piEdit[piEdit.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls');
});

test('planAgyMcp splits yomna-desktop socket into env and formats agy mcp add args', () => {
  assert.deepEqual(planAgyMcp(null), { register: [], env: {} });
  assert.deepEqual(
    planAgyMcp({
      'yomna-desktop': { command: 'node', args: ['/app/mcp-desktop.mjs', '/tmp/yomna-1.sock'] },
      helper: { command: 'npx', args: ['-y', '@example/mcp'] },
    }),
    {
      register: [
        { name: 'yomna-desktop', command: 'node', args: ['/app/mcp-desktop.mjs'] },
        { name: 'helper', command: 'npx', args: ['-y', '@example/mcp'] },
      ],
      env: { YOMNA_MCP_SOCKET: '/tmp/yomna-1.sock' },
    },
  );
  assert.deepEqual(
    planAgyMcp({ 'yomna-desktop': { command: 'node', args: ['/app/mcp-desktop.mjs'] } }),
    {
      register: [{ name: 'yomna-desktop', command: 'node', args: ['/app/mcp-desktop.mjs'] }],
      env: {},
    },
  );
  assert.deepEqual(
    agyMcpAddArgs({ name: 'yomna-desktop', command: 'node', args: ['/app/mcp-desktop.mjs'] }),
    ['mcp', 'add', 'yomna-desktop', '--', 'node', '/app/mcp-desktop.mjs'],
  );
});

test('AgyAdapter registers MCP via "agy mcp add" and passes YOMNA_MCP_SOCKET', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    const mcpPath = path.join(tmp, 'yomna-mcp.json');
    const capturedPath = path.join(tmp, 'captured.jsonl');
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { 'yomna-desktop': { command: 'node', args: ['mcp-desktop.mjs', '/tmp/x.sock'] } } }),
    );

    writeExecutableScript(
      binDir,
      'agy',
      `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(capturedPath)}, JSON.stringify({ args, socket: process.env.YOMNA_MCP_SOCKET ?? null }) + '\\n');
      if (args[0] === 'mcp') process.exit(0);
      console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-sess-42' }));
      console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello ' } }));
      console.log(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'world!' } }));
      console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-sess-42', status: 'SUCCESS', response: 'Hello world!' } }));
      `,
    );

    const adapter = new AgyAdapter({ env: { PATH: binDir, HOME: tmp, USERPROFILE: tmp } });
    const events = [];
    for await (const ev of adapter.send({
      prompt: 'What is on screen?',
      systemPrompt: 'Be concise.',
      secondBrainDirs: [tmp],
      mcpConfigPath: mcpPath,
      allowActions: false,
    })) {
      events.push(ev);
    }

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'agy-sess-42' },
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world!' },
      { type: 'done', text: 'Hello world!' },
    ]);

    // Second send with the same config must not invoke `agy mcp add` again.
    const secondEvents = [];
    for await (const ev of adapter.send({
      prompt: 'Follow up?',
      mcpConfigPath: mcpPath,
      allowActions: false,
    })) {
      secondEvents.push(ev);
    }
    assert.equal(secondEvents.at(-1)?.type, 'done');

    const calls = fs.readFileSync(capturedPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const mcpCalls = calls.filter((c) => c.args[0] === 'mcp');
    const turnCalls = calls.filter((c) => c.args[0] !== 'mcp');

    assert.equal(mcpCalls.length, 1);
    assert.deepEqual(mcpCalls[0].args, ['mcp', 'add', 'yomna-desktop', '--', 'node', 'mcp-desktop.mjs']);
    assert.equal(mcpCalls[0].args.includes('/tmp/x.sock'), false);

    assert.equal(turnCalls.length, 2);
    assert.equal(turnCalls[0].args.includes('--settings'), false);
    assert.equal(turnCalls[0].args.includes('--input-format'), false, 'must not pass --input-format after --print');
    assert.equal(turnCalls[0].socket, '/tmp/x.sock');
    assert.equal(turnCalls[1].socket, '/tmp/x.sock');

    const pIdx = turnCalls[0].args.indexOf('-p');
    const promptArg = pIdx >= 0 ? turnCalls[0].args[pIdx + 1] : '';
    assert.match(promptArg, /<system_instructions>[\s\S]*Be concise\.[\s\S]*What is on screen\?/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgyAdapter continues the turn even when "agy mcp add" fails', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    writeExecutableScript(
      binDir,
      'agy',
      `
      const args = process.argv.slice(2);
      if (args[0] === 'mcp') { console.error('write failed'); process.exit(1); }
      console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-1', status: 'SUCCESS', response: 'Still works' } }));
      `,
    );

    const adapter = new AgyAdapter({ env: { PATH: binDir, HOME: tmp, USERPROFILE: tmp } });
    const events = [];
    for await (const ev of adapter.send({
      prompt: 'hi',
      mcpServer: { command: 'node', args: ['mcp-desktop.mjs', '/tmp/x.sock'] },
    })) {
      events.push(ev);
    }
    assert.deepEqual(events, [
      { type: 'session', sessionId: 'agy-1' },
      { type: 'done', text: 'Still works' },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('OpenCodeAdapter, PiAdapter, and ClaudeAdapter normalize JSON events and inject MCP', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    const mcpServer = { command: 'node', args: ['yomna-mcp.mjs'] };

    writeExecutableScript(
      binDir,
      'opencode',
      `
      if (!process.env.OPENCODE_CONFIG_CONTENT?.includes('yomna-desktop')) process.exit(2);
      console.log(JSON.stringify({ type: 'text', sessionID: 'oc-1', part: { text: 'From OpenCode' } }));
      console.log(JSON.stringify({ type: 'tool_use', sessionID: 'oc-1', part: { callID: 'c1', tool: 'read_notes', state: { status: 'completed', input: { q: 'hi' }, output: 'found' } } }));
      `,
    );
    writeExecutableScript(
      binDir,
      'pi',
      `
      import fs from 'node:fs';
      const cfg = process.env.YOMNA_MCP_CONFIG && JSON.parse(fs.readFileSync(process.env.YOMNA_MCP_CONFIG, 'utf8'));
      if (!cfg?.mcpServers?.['yomna-desktop']) process.exit(2);
      console.log(JSON.stringify({ type: 'session', id: 'pi-1' }));
      console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'From Pi' } }));
      console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'search', args: { q: 'x' } }));
      console.log(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'p1', toolName: 'search', isError: false, result: 'done' }));
      console.log(JSON.stringify({ type: 'agent_end', messages: [] }));
      `,
    );
    writeExecutableScript(
      binDir,
      'claude',
      `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      const mIdx = args.indexOf('--mcp-config');
      const cfg = mIdx >= 0 && JSON.parse(fs.readFileSync(args[mIdx + 1], 'utf8'));
      if (!cfg?.mcpServers?.['yomna-desktop']) process.exit(2);
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-1' }));
      console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'From Claude' }] } }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'From Claude' }));
      `,
    );

    const env = { PATH: binDir, HOME: tmp, USERPROFILE: tmp };

    const ocEvents = [];
    for await (const ev of new OpenCodeAdapter({ env }).send({ prompt: 'hi', mcpServer })) ocEvents.push(ev);
    assert.deepEqual(ocEvents, [
      { type: 'session', sessionId: 'oc-1' },
      { type: 'text_delta', text: 'From OpenCode' },
      { type: 'tool_start', id: 'c1', name: 'read_notes', args: { q: 'hi' } },
      { type: 'tool_end', id: 'c1', name: 'read_notes', ok: true, output: 'found' },
      { type: 'done', text: 'From OpenCode' },
    ]);

    const piEvents = [];
    for await (const ev of new PiAdapter({ env }).send({ prompt: 'hi', mcpServer })) piEvents.push(ev);
    assert.deepEqual(piEvents, [
      { type: 'session', sessionId: 'pi-1' },
      { type: 'text_delta', text: 'From Pi' },
      { type: 'tool_start', id: 'p1', name: 'search', args: { q: 'x' } },
      { type: 'tool_end', id: 'p1', name: 'search', ok: true, output: 'done' },
      { type: 'done', text: 'From Pi' },
    ]);

    const clEvents = [];
    for await (const ev of new ClaudeAdapter({ env }).send({ prompt: 'hi', mcpServer })) clEvents.push(ev);
    assert.deepEqual(clEvents, [
      { type: 'session', sessionId: 'cl-1' },
      { type: 'text_delta', text: 'From Claude' },
      { type: 'done', text: 'From Claude' },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AcpAdapter performs JSON-RPC 2.0 ACP handshake, passes MCP servers, and enforces allowActions', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    writeExecutableScript(
      binDir,
      'mock-acp',
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      let seenMcp = false;
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          seenMcp = msg.params?.mcpServers?.some((s) => s.name === 'yomna-desktop');
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-99' } });
        } else if (msg.method === 'session/prompt') {
          send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { options: [{ optionId: 'allow', kind: 'allow_once' }] } });
          rl.once('line', (permLine) => {
            const perm = JSON.parse(permLine);
            const allowed = perm.result?.outcome?.outcome === 'selected';
            send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: seenMcp ? ('mcp:' + (allowed ? 'edit' : 'readonly')) : 'no-mcp' } } } });
            send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          });
        }
      });
      `,
    );

    const env = { PATH: binDir, HOME: tmp, USERPROFILE: tmp };
    const acp = new AcpAdapter({ binary: 'mock-acp', args: ['acp', '--stdio'], env });

    const roReply = await acp.oneShot({
      prompt: 'test',
      allowActions: false,
      mcpServer: { command: 'node', args: ['mcp.mjs'] },
    });
    assert.equal(roReply, 'mcp:readonly');

    const rwReply = await acp.oneShot({
      prompt: 'test',
      allowActions: true,
      mcpServer: { command: 'node', args: ['mcp.mjs'] },
    });
    assert.equal(rwReply, 'mcp:edit');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hang watchdog kills stalled child process and emits timeout error with suggestSwitch', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.YOMNA_HANG_TIMEOUT_MS;
  process.env.YOMNA_HANG_TIMEOUT_MS = '60';
  try {
    assert.equal(hangTimeoutMs(), 60);
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    const pidFile = path.join(tmp, 'stalled.pid');
    writeExecutableScript(
      binDir,
      'agy',
      `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 10_000);
      `,
    );

    const mgr = new HarnessManager({
      harness: 'agy',
      options: { agy: { env: { PATH: binDir, HOME: tmp, USERPROFILE: tmp } } },
    });

    const events = [];
    for await (const ev of mgr.send({ prompt: 'hang forever' })) events.push(ev);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].reason, 'timeout');
    assert.equal(events[0].suggestSwitch, true);
    assert.match(events[0].message, /stopped responding/);

    // Wait briefly for SIGTERM to reap the child process.
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 150));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'stalled child process should be killed');
    mgr.dispose();
  } finally {
    if (prevEnv === undefined) delete process.env.YOMNA_HANG_TIMEOUT_MS;
    else process.env.YOMNA_HANG_TIMEOUT_MS = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('auth failures emit reason="auth" with suggestSwitch=true and HarnessManager tracks sessions', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    writeExecutableScript(
      binDir,
      'agy',
      `
      const args = process.argv.slice(2);
      const convIdx = args.indexOf('--conversation');
      if (convIdx >= 0) {
        console.error('401 Unauthorized: sign in required');
        process.exit(1);
      }
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-100' }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Turn 1 ok' }));
      `,
    );

    const mgr = new HarnessManager({
      harness: 'agy',
      options: { agy: { env: { PATH: binDir, HOME: tmp, USERPROFILE: tmp } } },
    });

    const first = await mgr.oneShot({ prompt: 'first' });
    assert.equal(first, 'Turn 1 ok');
    assert.equal(mgr.getSessionId(), 'sess-100');

    const secondEvents = [];
    for await (const ev of mgr.send({ prompt: 'second' })) secondEvents.push(ev);
    assert.equal(secondEvents.length, 1);
    assert.equal(secondEvents[0].type, 'error');
    assert.equal(secondEvents[0].reason, 'auth');
    assert.equal(secondEvents[0].suggestSwitch, true);

    mgr.dispose();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('probeHarness detects real agy on this machine cleanly without triggering mise shims', async () => {
  const res = await probeHarness('agy');
  if (res.installed) {
    assert.ok(res.path, 'installed agy should include resolved path');
    assert.ok(res.version, 'installed agy should include version');
  }
  const unknown = await probeHarness('custom', { binary: 'definitely-not-installed-yomna-bin' });
  assert.equal(unknown.installed, false);
  assert.equal(unknown.authenticated, false);
});

test('immediate child exit before consuming stdin does not crash with unhandled EPIPE', async () => {
  const tmp = makeTempDir();
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    // Exit immediately without reading stdin (use #!/bin/sh on POSIX or fast node exit).
    writeExecutableScript(binDir, 'agy', 'process.exit(1);');
    writeExecutableScript(binDir, 'mock-acp', 'process.exit(1);');

    const env = { PATH: binDir, HOME: tmp, USERPROFILE: tmp };

    // 1. CLI turn (base.mjs runCliTurn) with large stdin payload exceeding typical pipe buffer.
    const agy = new AgyAdapter({ env });
    const agyEvents = [];
    for await (const ev of agy.send({ prompt: 'x'.repeat(512 * 1024) })) {
      agyEvents.push(ev);
    }
    assert.ok(agyEvents.some((e) => e.type === 'error'), 'expected error event from crashed CLI');

    // 2. ACP turn (acp.mjs #sendAcp) exiting before consuming JSON-RPC initialize write.
    const acp = new AcpAdapter({ binary: 'mock-acp', args: ['acp'], env });
    const acpEvents = [];
    for await (const ev of acp.send({ prompt: 'y'.repeat(512 * 1024) })) {
      acpEvents.push(ev);
    }
    assert.ok(acpEvents.some((e) => e.type === 'error'), 'expected error event from crashed ACP');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
