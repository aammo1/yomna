// Tests for yomna-desktop local MCP bridge + stdio relay, safety gating, and rebranded core modules.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACTIONS_OFF_ERROR,
  DESKTOP_TOOLS,
  MCP_PROTOCOL_VERSION,
  createDesktopMcpBridge,
  createDesktopMcpDispatcher,
  resolveRelayScript,
} from '../mcp-desktop.mjs';
import { AGENTS_DIR, CONFIG_PATH, DATA_DIR, SKILLS_DIR, YOMNA_DIR, dataPaths, yomnaDir } from '../datadir.mjs';
import { createSecrets } from '../secrets.mjs';
import { DEFAULT_WAKE_NAME, cleanWakeName, wakeName } from '../wakename.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(HERE, '../mcp-desktop.mjs');

function spawnRelayClient(args) {
  const child = spawn(process.execPath, [MCP_SCRIPT, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let outBuf = '';
  let stderr = '';
  const waiters = [];
  const queue = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outBuf += chunk;
    for (let idx; (idx = outBuf.indexOf('\n')) >= 0;) {
      const line = outBuf.slice(0, idx).replace(/\r$/, '').trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiters.length) waiters.shift()(msg);
      else queue.push(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });

  const nextResponse = (timeoutMs = 5000) => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Relay response timed out. stderr=${stderr}`)), timeoutMs);
      waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  };

  const send = (msg) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  const request = async (id, method, params = {}) => {
    send({ jsonrpc: '2.0', id, method, params });
    return nextResponse();
  };

  const close = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('close', (code) => resolve(code));
    child.stdin.end();
  });

  return { child, send, request, nextResponse, close, getStderr: () => stderr };
}

test('rebranded datadir, secrets, and wakename exports', async () => {
  const customHome = path.join(os.tmpdir(), 'yomna-datadir-check');
  const paths = dataPaths({ YOMNA_DATA_DIR: customHome });
  assert.equal(paths.root, path.join(customHome, 'Yomna'));
  assert.equal(paths.dir, path.join(customHome, 'Yomna', 'Data'));
  assert.equal(paths.config, path.join(customHome, 'Yomna', 'Data', 'settings.json'));
  assert.equal(paths.skills, path.join(customHome, 'Yomna', 'Skills'));
  assert.equal(paths.agents, path.join(customHome, 'Yomna', 'Agents'));
  assert.equal(yomnaDir({ YOMNA_DATA_DIR: customHome }), paths.root);
  assert.ok(YOMNA_DIR.endsWith(`${path.sep}Yomna`));
  assert.ok(DATA_DIR.endsWith(`${path.sep}Yomna${path.sep}Data`));
  assert.ok(CONFIG_PATH.endsWith(`${path.sep}Yomna${path.sep}Data${path.sep}settings.json`));
  assert.ok(SKILLS_DIR.endsWith(`${path.sep}Yomna${path.sep}Skills`));
  assert.ok(AGENTS_DIR.endsWith(`${path.sep}Yomna${path.sep}Agents`));

  const calls = [];
  const linuxSecrets = createSecrets({
    platform: 'linux',
    exec: async (cmd, args, input = '') => {
      calls.push({ cmd, args, input });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  await linuxSecrets.set('demo-key', 'secret-val');
  assert.deepEqual(calls[0].args, ['store', '--label', 'Yomna: demo-key', 'service', 'com.aammo1.yomna', 'account', 'demo-key']);

  assert.equal(DEFAULT_WAKE_NAME, 'Yomna');
  assert.equal(wakeName({}), 'Yomna');
  assert.deepEqual(cleanWakeName('Yomna'), { ok: true, name: '' });
  assert.deepEqual(cleanWakeName('hey yomna'), { ok: true, name: '' });
  assert.deepEqual(cleanWakeName('Hey Friday'), { ok: true, name: 'Friday' });
});

test('mcp-desktop bridge + stdio relay serves initialize, tools/list, tools/call and cleans up', async () => {
  let allow = false;
  let confirmResponse = false;
  const confirmedPrompts = [];
  const executedActs = [];
  const memoryCalls = [];

  const bridge = await createDesktopMcpBridge({
    allowActions: () => allow,
    confirmOnOverlay: async (req) => {
      confirmedPrompts.push(req);
      return confirmResponse;
    },
    take_screenshot: async ({ target = 'front' }) => ({
      text: `Captured ${target}`,
      bounds: [10, 20, 800, 600],
      data: Buffer.from('fake-png').toString('base64'),
      mediaType: 'image/png',
    }),
    area_crop: async () => ({
      text: 'Cropped area',
      bounds: [50, 60, 200, 100],
      data: Buffer.from('crop-png').toString('base64'),
      mimeType: 'image/png',
    }),
    draw: async ({ beats }) => `Drew ${beats?.length ?? 0} beat(s).`,
    list_windows: async () => 'window:1  Firefox — Docs  (frontmost app)',
    read_window: async ({ target = 'front' }) => `Controls for ${target}`,
    act_in_app: async (plan) => {
      executedActs.push(plan);
      return `Executed ${plan.steps.length} step(s) in ${plan.target}`;
    },
    remember_commitment: async (args) => { memoryCalls.push(['remember_commitment', args]); return 'Saved c1'; },
    update_commitment: async (args) => { memoryCalls.push(['update_commitment', args]); return 'Updated c1'; },
    list_commitments: async () => 'c1: Buy milk',
    forget_fact: async (args) => { memoryCalls.push(['forget_fact', args]); return `Forgot ${args.id}`; },
    show_list: async () => 'The list is on screen.',
    snooze_reminder: async (args) => `Snoozed ${args.until || 'in 10m'}`,
    schedule_job: async (args) => `Scheduled ${args.title}`,
    list_jobs: async () => 'No scheduled jobs.',
    start_focus: async ({ minutes = 25 }) => `Focus started for ${minutes}m`,
    stop_focus: async () => 'Focus stopped.',
  });

  const configRaw = JSON.parse(fs.readFileSync(bridge.configPath, 'utf8'));
  assert.equal(configRaw.mcpServers['yomna-desktop'].command, process.execPath);
  assert.deepEqual(configRaw.mcpServers['yomna-desktop'].args, [MCP_SCRIPT, bridge.socketPath]);
  const tempDir = path.dirname(bridge.configPath);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(bridge.socketPath).mode & 0o777, 0o600);
  }

  // Test stdio relay with `--relay <socketPath>`
  const client = spawnRelayClient(['--relay', bridge.socketPath]);
  try {
    const init = await client.request(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-harness', version: '0.1.0' },
    });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(init.result.serverInfo.name, 'yomna-desktop');

    // Notifications must not emit a response
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const ping = await client.request(2, 'ping');
    assert.equal(ping.id, 2);
    assert.deepEqual(ping.result, {});

    const listed = await client.request(3, 'tools/list');
    assert.equal(listed.result.tools.length, 16);
    const names = listed.result.tools.map((t) => t.name);
    for (const expected of [
      'take_screenshot', 'area_crop', 'draw', 'list_windows', 'read_window', 'act_in_app',
      'remember_commitment', 'update_commitment', 'list_commitments', 'forget_fact',
      'show_list', 'snooze_reminder', 'schedule_job', 'list_jobs', 'start_focus', 'stop_focus',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    // take_screenshot returns base64 image content + bounds
    const shot = await client.request(4, 'tools/call', {
      name: 'take_screenshot',
      arguments: { target: 'front' },
    });
    assert.equal(shot.result.isError, false);
    assert.equal(shot.result.content[0].type, 'text');
    assert.match(shot.result.content[0].text, /\[10,20,800,600\]/);
    assert.equal(shot.result.content[1].type, 'image');
    assert.equal(shot.result.content[1].mimeType, 'image/png');
    assert.equal(shot.result.content[1].data, Buffer.from('fake-png').toString('base64'));

    // Level 1 safety: allowActions() === false -> act_in_app refused, other tools still work
    const actBlocked = await client.request(5, 'tools/call', {
      name: 'act_in_app',
      arguments: { target: 'Firefox', steps: [{ do: 'click_text', text: 'Next' }] },
    });
    assert.equal(actBlocked.result.isError, true);
    assert.equal(actBlocked.result.content[0].text, ACTIONS_OFF_ERROR);
    assert.equal(executedActs.length, 0);

    // Other tools work when allowActions() is false
    const crop = await client.request(6, 'tools/call', { name: 'area_crop', arguments: {} });
    assert.equal(crop.result.isError, false);
    assert.equal(crop.result.content[1].type, 'image');

    const mem = await client.request(7, 'tools/call', {
      name: 'remember_commitment',
      arguments: { text: 'Publish video', due: 'in 10m', kind: 'reminder' },
    });
    assert.equal(mem.result.isError, false);
    assert.equal(mem.result.content[0].text, 'Saved c1');

    // Level 2 safety: allowActions() === true, risky click triggers confirmOnOverlay (even if caller passes confirmed: true)
    allow = true;
    confirmResponse = false;
    const riskyDeclined = await client.request(8, 'tools/call', {
      name: 'act_in_app',
      arguments: {
        target: 'Settings',
        steps: [{ do: 'click_text', text: 'Delete account', confirmed: true }],
      },
    });
    assert.equal(riskyDeclined.result.isError, true);
    assert.match(riskyDeclined.result.content[0].text, /declined/i);
    assert.equal(confirmedPrompts.length, 1);
    assert.equal(confirmedPrompts[0].label, 'Delete account');
    assert.equal(confirmedPrompts[0].kind, 'delete');
    assert.equal(executedActs.length, 0);

    confirmResponse = true;
    const riskyApproved = await client.request(9, 'tools/call', {
      name: 'act_in_app',
      arguments: {
        target: 'Settings',
        steps: [{ do: 'click_text', text: 'Delete account' }],
      },
    });
    assert.equal(riskyApproved.result.isError, false);
    assert.equal(confirmedPrompts.length, 2);
    assert.equal(executedActs.length, 1);
    assert.equal(executedActs[0].steps[0].confirmed, true);

    // Non-risky click with allowActions() === true does not prompt
    const safeClick = await client.request(10, 'tools/call', {
      name: 'act_in_app',
      arguments: { target: 'Firefox', steps: [{ do: 'click_text', text: 'Next' }] },
    });
    assert.equal(safeClick.result.isError, false);
    assert.equal(confirmedPrompts.length, 2);
    assert.equal(executedActs.length, 2);
  } finally {
    const code = await client.close();
    assert.equal(code, 0);
    await bridge.close();
  }

  assert.equal(fs.existsSync(tempDir), false, 'bridge.close() removes temp dir and socket');
});

test('mcp-desktop dispatcher blocks unsafe draw actions and unknown tools cleanly', async () => {
  const dispatcher = createDesktopMcpDispatcher({
    allowActions: () => false,
    draw: async () => 'ok',
  });
  assert.equal(dispatcher.tools.length, DESKTOP_TOOLS.length);

  const badDraw = await dispatcher.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'draw',
      arguments: {
        beats: [{ say: 'Click here', marks: [{ kind: 'open', url: 'javascript:alert(1)' }] }],
      },
    },
  });
  assert.equal(badDraw.result.isError, true);
  assert.match(badDraw.result.content[0].text, /Blocked for safety/);

  const unknown = await dispatcher.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
});

test('stdio relay handles immediate stdin half-close before socket connect and async tools/call completion', async () => {
  const bridge = await createDesktopMcpBridge({
    list_windows: async () => {
      await new Promise((r) => setTimeout(r, 60));
      return 'window:42  Async Terminal  (frontmost app)';
    },
  });

  try {
    const client = spawnRelayClient(['--relay', bridge.socketPath]);
    client.child.stdin.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'eof-client', version: '1.0' } },
      })}\n` +
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_windows', arguments: {} },
      })}\n`,
    );

    const init = await client.nextResponse();
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, 'yomna-desktop');

    const windows = await client.nextResponse();
    assert.equal(windows.id, 2);
    assert.equal(windows.result.isError, false);
    assert.equal(windows.result.content[0].text, 'window:42  Async Terminal  (frontmost app)');

    const code = await client.close();
    assert.equal(code, 0);
    assert.equal(client.getStderr(), '');
  } finally {
    await bridge.close();
  }
});

test('resolveRelayScript prefers sibling mcp-desktop.mjs when bundled into another entrypoint', () => {
  const distDir = path.join('/tmp', 'yomna-dist-test');
  const bundledSidekick = path.join(distDir, 'sidekick.mjs');
  const bundledRelay = path.join(distDir, 'mcp-desktop.mjs');

  assert.equal(
    resolveRelayScript({ relayScript: '/custom/relay.mjs', selfPath: bundledSidekick, existsSync: () => true }),
    '/custom/relay.mjs',
  );
  assert.equal(
    resolveRelayScript({ selfPath: bundledSidekick, existsSync: (p) => p === bundledRelay }),
    bundledRelay,
  );
  assert.equal(
    resolveRelayScript({ selfPath: bundledSidekick, existsSync: () => false }),
    bundledSidekick,
  );
  assert.equal(
    resolveRelayScript({ selfPath: bundledRelay, existsSync: () => false }),
    bundledRelay,
  );
});
