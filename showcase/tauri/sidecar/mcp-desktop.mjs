// Lightweight local MCP (Model Context Protocol, JSON-RPC 2.0 / 2024-11-05) server for Yomna.
// Dual-mode:
//   1. Sidecar bridge (`createDesktopMcpBridge`): listens on a private Unix domain socket or Windows named pipe
//      and writes a temporary `{ mcpServers: { "yomna-desktop": ... } }` config for any CLI harness.
//   2. Stdio relay (`node mcp-desktop.mjs --relay <socketPath>` or `node mcp-desktop.mjs <socketPath>`):
//      pipes newline-delimited JSON-RPC between stdin/stdout and the sidecar's live IPC socket.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK, checkDrawAction, isRiskyClick, isYes, redactArgs, riskyKind } from './safety.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'yomna-desktop', version: '1.0.0' };
export const ACTIONS_OFF_ERROR = 'Allow Actions is off in Yomna Settings. Turn it on to let Yomna click or type inside apps.';

const TONES = ['accent', 'teal', 'amber', 'coral', 'lilac', 'sky', 'lime', 'red', 'white'];
const STEP_ACTIONS = ['click_text', 'fill', 'choose', 'scroll', 'set', 'focus', 'click', 'type', 'key', 'click_at', 'wait', 'read_window', 'take_screenshot', 'screenshot'];

/** Tool definitions exposed by the yomna-desktop MCP server. */
export const DESKTOP_TOOLS = [
  {
    name: 'take_screenshot',
    description: "Capture the user's screen or a specific window and return base64 image content plus screen bounds.",
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "Target to capture: 'front' (active window, default), an app name (e.g. 'Firefox', 'Figma'), 'window:<id>' from list_windows, or 'screen' for the whole desktop.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'area_crop',
    description: 'Trigger interactive area selection (yomna-hands select) and return the cropped image.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Optional short hint explaining what area to select.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'draw',
    description: 'Render circles, arrows, spotlights, flowcharts, math, chemistry, maps, 3D models, and interactive cards on Yomna’s overlay canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: "Target window or 'front' / 'screen'." },
        beats: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              say: { type: 'string', maxLength: 240 },
              wait: { type: 'string', enum: ['click', 'hover'] },
              marks: {
                type: 'array',
                maxItems: 40,
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string' },
                    tone: { type: 'string', enum: TONES },
                    at: { type: 'object' },
                    to: { type: 'object' },
                    tie: { type: 'object' },
                    text: { type: 'string' },
                    label: { type: 'string' },
                    title: { type: 'string' },
                    heading: { type: 'string' },
                    items: { type: 'array', items: { type: 'string' } },
                    action: {
                      type: 'object',
                      properties: {
                        do: { type: 'string', enum: ['ask', 'open', 'copy'] },
                        value: { type: 'string' },
                      },
                    },
                  },
                  required: ['kind'],
                },
              },
            },
            required: ['marks'],
          },
        },
        edit: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              do: { type: 'string', enum: ['recolor', 'move', 'erase', 'clear'] },
              part: { type: 'string' },
              tone: { type: 'string', enum: TONES },
              dx: { type: 'number' },
              dy: { type: 'number' },
            },
            required: ['do'],
          },
        },
        deep: { type: 'boolean' },
        keep: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_windows',
    description: 'List visible app windows (app, title, id), front to back, via yomna-hands.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'read_window',
    description: 'Read the focused or named window accessibility tree / OCR text and controls via yomna-hands.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "Target window: 'front' (default), an app name, 'browser', or 'window:<id>'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'act_in_app',
    description: 'Click, fill fields, choose options, scroll, type, or press keys inside another app via yomna-hands. Requires Allow Actions to be enabled and confirms risky UI clicks on the overlay.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "Target app or window: 'front' (default), an app name, 'browser', or 'window:<id>'.",
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              do: { type: 'string', enum: STEP_ACTIONS },
              id: { type: 'integer' },
              field: { type: 'string' },
              text: { type: 'string' },
              option: { type: 'string' },
              near: { type: 'string' },
              key: { type: 'string' },
              direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] },
              amount: { type: 'integer' },
              to_end: { type: 'boolean' },
              x: { type: 'number' },
              y: { type: 'number' },
              seconds: { type: 'number' },
              label: { type: 'string' },
            },
            required: ['do'],
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'remember_commitment',
    description: 'Save a commitment or reminder so Yomna can track and remind the user at the right time.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 2, maxLength: 200 },
        due: { type: 'string' },
        kind: { type: 'string', enum: ['reminder', 'commitment'] },
        repeat: { type: 'string', maxLength: 60 },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_commitment',
    description: 'Mark a saved commitment done or dropped, or update its due time or repeat schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'dropped'] },
        due: { type: 'string' },
        repeat: { type: 'string', maxLength: 60 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_commitments',
    description: 'List open commitments and reminders Yomna is tracking.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'forget_fact',
    description: 'Delete a saved memory fact by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_list',
    description: 'Show the user’s reminders and commitments checklist on the Yomna overlay.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'snooze_reminder',
    description: 'Snooze a fired reminder or commitment until a later time (defaults to 10 minutes).',
    inputSchema: {
      type: 'object',
      properties: {
        until: { type: 'string', maxLength: 40 },
        id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_job',
    description: 'Schedule a one-off or recurring background routine.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 60 },
        brief: { type: 'string', minLength: 1, maxLength: 8000 },
        due: { type: 'string', maxLength: 40 },
        repeat: { type: 'string', maxLength: 60 },
        type: { type: 'string', enum: ['maker', 'researcher', 'organizer'] },
        returns: { type: 'string', enum: ['files', 'answer'] },
        subagent: { type: 'string', maxLength: 40 },
      },
      required: ['title', 'brief', 'due'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_jobs',
    description: 'List scheduled background routines, next run times, and last run status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'start_focus',
    description: 'Start a timed focus session with distraction monitoring.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number' },
        task: { type: 'string', maxLength: 120 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'stop_focus',
    description: 'Stop the active focus session early.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

const TOOL_MAP = new Map(DESKTOP_TOOLS.map((t) => [t.name, t]));

/** Convert a tool handler return value into MCP CallToolResult content blocks. */
function toMcpResult(raw) {
  if (raw == null) return { content: [{ type: 'text', text: 'ok' }], isError: false };
  if (typeof raw === 'string') return { content: [{ type: 'text', text: raw }], isError: false };
  if (Array.isArray(raw?.content)) {
    const content = raw.content.map((item) => {
      if (item?.type === 'image') {
        return {
          type: 'image',
          data: String(item.data ?? ''),
          mimeType: item.mimeType || item.mediaType || 'image/png',
        };
      }
      if (item?.type === 'text') return { type: 'text', text: String(item.text ?? '') };
      return { type: 'text', text: typeof item === 'string' ? item : JSON.stringify(item) };
    });
    if (Array.isArray(raw.bounds) && !content.some((c) => c.type === 'text' && c.text.includes('bounds'))) {
      content.unshift({ type: 'text', text: `Screen bounds: ${JSON.stringify(raw.bounds)}` });
    }
    return { content, isError: Boolean(raw.isError) };
  }
  if (typeof raw === 'object' && typeof raw.data === 'string') {
    const mimeType = raw.mimeType || raw.mediaType || 'image/png';
    const parts = [];
    if (raw.text) parts.push(String(raw.text));
    if (Array.isArray(raw.bounds)) parts.push(`Screen bounds: ${JSON.stringify(raw.bounds)}`);
    const content = [];
    if (parts.length) content.push({ type: 'text', text: parts.join(' ') });
    content.push({ type: 'image', data: raw.data, mimeType });
    return { content, isError: false };
  }
  return { content: [{ type: 'text', text: JSON.stringify(raw) }], isError: false };
}

function isApproved(res) {
  if (res === true) return true;
  if (typeof res === 'string') return isYes(res);
  if (res && typeof res === 'object') return res.allowed === true || res.allow === true || res.confirmed === true;
  return false;
}

function validateDrawSafety(args, allowActions) {
  const beats = Array.isArray(args?.beats) ? args.beats : [];
  for (const beat of beats) {
    const marks = Array.isArray(beat?.marks) ? beat.marks : [];
    for (const m of marks) {
      if (m?.kind === 'button' || m?.action || m?.kind === 'open' || m?.kind === 'copy' || m?.kind === 'type' || m?.kind === 'handoff') {
        const v = checkDrawAction(
          { kind: m.action ? 'button' : m.kind, url: m.url, text: m.text, action: m.action },
          { allowActions },
        );
        if (v.level === BLOCK) throw new Error(`Blocked for safety: ${v.reason}`);
      }
    }
  }
}

function stepLabelCandidate(step) {
  if (!step || typeof step !== 'object') return null;
  if (step.do === 'click_text') return step.text ?? step.label ?? null;
  if (step.do === 'click') return step.label ?? step.text ?? null;
  if (step.do === 'choose') return step.option ?? step.label ?? null;
  return step.label ?? null;
}

/**
 * Creates a JSON-RPC 2.0 MCP message dispatcher backed by Yomna sidecar handlers.
 * Enforces two-level safety on `act_in_app` and `checkDrawAction` on `draw`.
 */
export function createDesktopMcpDispatcher(handlers = {}) {
  const isAllowActions = () => (typeof handlers.allowActions === 'function' ? Boolean(handlers.allowActions()) : Boolean(handlers.allowActions));

  const getHandler = (name) => {
    if (typeof handlers[name] === 'function') return handlers[name];
    const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return typeof handlers[camel] === 'function' ? handlers[camel] : null;
  };

  async function callTool(name, rawArgs) {
    if (!TOOL_MAP.has(name)) {
      const err = new Error(`Unknown tool: ${name}`);
      err.rpcCode = -32602;
      throw err;
    }
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    handlers.onToolCall?.({ name, args: redactArgs(name, args) });

    if (name === 'draw') {
      try {
        validateDrawSafety(args, isAllowActions());
      } catch (err) {
        return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true };
      }
    }

    if (name === 'act_in_app') {
      if (!isAllowActions()) {
        return { content: [{ type: 'text', text: ACTIONS_OFF_ERROR }], isError: true };
      }
      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        return { content: [{ type: 'text', text: 'steps must be a non-empty array.' }], isError: true };
      }
      const target = String(args.target || 'front');
      const checkedSteps = [];
      for (const rawStep of args.steps) {
        if (!rawStep || typeof rawStep !== 'object') {
          return { content: [{ type: 'text', text: 'Each step in act_in_app must be an object.' }], isError: true };
        }
        // Never trust caller-supplied `confirmed`; always check safety server-side.
        const { confirmed: _ignored, ...step } = rawStep;
        let candidate = stepLabelCandidate(step);
        if (!candidate && step.do === 'click' && step.id != null && typeof handlers.resolveControlLabel === 'function') {
          candidate = await handlers.resolveControlLabel(step.id, target);
        }
        if (candidate && isRiskyClick(candidate)) {
          if (typeof handlers.confirmOnOverlay !== 'function') {
            return {
              content: [{ type: 'text', text: `Blocked risky action "${candidate}": on-screen confirmation handler is unavailable.` }],
              isError: true,
            };
          }
          const kind = riskyKind(candidate);
          const where = target === 'front' ? '' : ` in ${target}`;
          const approved = await handlers.confirmOnOverlay({
            action: 'act_in_app',
            title: 'Allow risky action?',
            message: `Click "${candidate}"${where}? It could delete, pay, send, uninstall, or sign out.`,
            label: candidate,
            kind,
            target,
            step,
            choices: ['Allow', "Don't allow"],
          });
          if (!isApproved(approved)) {
            return {
              content: [{ type: 'text', text: `User declined risky action "${candidate}" — cancelled without executing.` }],
              isError: true,
            };
          }
          checkedSteps.push({ ...step, confirmed: true });
        } else {
          checkedSteps.push(step);
        }
      }
      const actHandler = getHandler('act_in_app');
      if (!actHandler) {
        return { content: [{ type: 'text', text: 'Tool act_in_app is not available right now.' }], isError: true };
      }
      try {
        return toMcpResult(await actHandler({ ...args, target, steps: checkedSteps }));
      } catch (err) {
        return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true };
      }
    }

    const fn = getHandler(name);
    if (!fn) {
      return { content: [{ type: 'text', text: `Tool ${name} is not available right now.` }], isError: true };
    }
    try {
      return toMcpResult(await fn(args));
    } catch (err) {
      return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true };
    }
  }

  async function handleOne(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const isNotification = !Object.hasOwn(msg, 'id') || msg.id === undefined;
    const { id, method, params } = msg;

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return isNotification ? null : { jsonrpc: '2.0', id, result: {} };
    }
    if (isNotification) return null;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: DESKTOP_TOOLS } };
    }
    if (method === 'tools/call') {
      const toolName = params?.name;
      if (typeof toolName !== 'string' || !toolName) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } };
      }
      try {
        const result = await callTool(toolName, params?.arguments);
        return { jsonrpc: '2.0', id, result };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: err?.rpcCode ?? -32603, message: err?.message || 'Internal error' },
        };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  async function handleMessage(msg) {
    if (Array.isArray(msg)) {
      if (msg.length === 0) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
      const out = (await Promise.all(msg.map(handleOne))).filter((r) => r !== null);
      return out.length ? out : null;
    }
    return handleOne(msg);
  }

  async function handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
    return handleMessage(parsed);
  }

  return { tools: DESKTOP_TOOLS, handleMessage, handleLine };
}

/**
 * Resolves the script path invoked by the stdio MCP relay.
 * When bundled into another entrypoint (e.g. `dist/sidekick.mjs`), prefers a
 * sibling `mcp-desktop.mjs` bundle if present before falling back to `selfPath`.
 */
export function resolveRelayScript(options = {}) {
  if (options.relayScript) return options.relayScript;
  const selfPath = options.selfPath || fileURLToPath(import.meta.url);
  if (path.basename(selfPath) !== 'mcp-desktop.mjs') {
    const sibling = path.join(path.dirname(selfPath), 'mcp-desktop.mjs');
    const exists = options.existsSync || fs.existsSync;
    if (exists(sibling)) return sibling;
  }
  return selfPath;
}

/**
 * Starts the local IPC MCP bridge for CLI harnesses and writes a temporary MCP config file.
 * Returns `{ socketPath, configPath, config, tools, close }`.
 */
export async function createDesktopMcpBridge(handlers = {}, options = {}) {
  const dispatcher = createDesktopMcpDispatcher(handlers);
  const rand = randomBytes(4).toString('hex');
  const id = `${process.pid}-${rand}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `yomna-mcp-${id}-`));
  fs.chmodSync(tempDir, 0o700);

  const isWin = (options.platform ?? process.platform) === 'win32';
  const socketPath = isWin ? `\\\\.\\pipe\\yomna-mcp-${id}` : path.join(tempDir, 'mcp.sock');
  const relayScript = resolveRelayScript(options);
  const configPath = path.join(tempDir, 'mcp-config.json');
  const config = {
    mcpServers: {
      'yomna-desktop': {
        command: options.nodePath || process.execPath,
        args: [relayScript, socketPath],
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    let buf = '';
    let chain = Promise.resolve();
    const processLine = (line) => {
      chain = chain.then(async () => {
        const res = await dispatcher.handleLine(line);
        if (res !== null && !socket.destroyed) {
          socket.write(`${JSON.stringify(res)}\n`);
        }
      }).catch((err) => {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err?.message || 'Internal error' } })}\n`);
        }
      });
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      for (let idx; (idx = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (line) processLine(line);
      }
    });
    socket.on('end', () => {
      const tail = buf.replace(/\r$/, '').trim();
      if (tail) processLine(tail);
      buf = '';
      chain.finally(() => {
        if (!socket.destroyed) socket.end();
      });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        if (!isWin) {
          try { fs.chmodSync(socketPath, 0o600); } catch {}
        }
        resolve();
      });
    });
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    throw err;
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  return {
    socketPath,
    configPath,
    config,
    tools: DESKTOP_TOOLS,
    close,
  };
}

function readJsonLines(stdin, onLine, onEnd) {
  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buf += chunk;
    for (let idx; (idx = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  });
  stdin.on('end', () => {
    const tail = buf.replace(/\r$/, '').trim();
    if (tail) onLine(tail);
    buf = '';
    onEnd();
  });
}

function emptyRelayOne(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const isNotification = !Object.hasOwn(msg, 'id') || msg.id === undefined;
  if (isNotification) return null;
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: [] } };
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Yomna is not running.' } };
}

function emptyRelayResponse(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const out = parsed.map(emptyRelayOne).filter((r) => r !== null);
    return out.length ? out : null;
  }
  return emptyRelayOne(parsed);
}

/**
 * Minimal stdio MCP server used when Yomna is not running (missing or dead socket)
 * so external CLI sessions don't fail startup with a broken MCP server.
 */
export function runEmptyRelay({
  stdin = process.stdin,
  stdout = process.stdout,
  onExit = (code) => { process.exitCode = code; },
  initialLines = [],
  stdinEnded = false,
  attachStdin = true,
} = {}) {
  let exited = false;
  const finish = () => {
    if (exited) return;
    exited = true;
    onExit(0);
  };
  const handleLine = (line) => {
    const res = emptyRelayResponse(line);
    if (res !== null) stdout.write(`${JSON.stringify(res)}\n`);
  };

  stdout.on('error', () => {});
  for (const line of initialLines) {
    const trimmed = String(line).replace(/\r$/, '').trim();
    if (trimmed) handleLine(trimmed);
  }
  if (stdinEnded) {
    finish();
  } else if (attachStdin) {
    readJsonLines(stdin, handleLine, finish);
  }
  return { handleLine, finish };
}

/**
 * Stdio-to-IPC relay entrypoint: pipes newline-delimited JSON-RPC between stdin/stdout
 * and the sidecar's live socket/pipe. Falls back to `runEmptyRelay` when the socket is absent.
 */
export function runStdioRelay(socketPath, { stdin = process.stdin, stdout = process.stdout, onExit = (code) => process.exit(code) } = {}) {
  const socket = net.createConnection(socketPath);
  let outBuf = '';
  let connected = false;
  let stdinEnded = false;
  let emptyRelay = null;
  const pending = [];

  stdout.on('error', () => {});

  const maybeHalfClose = () => {
    if (stdinEnded && connected && pending.length === 0 && !socket.destroyed && !socket.writableEnded) {
      socket.end();
    }
  };

  const sendToSocket = (line) => {
    if (connected && !socket.destroyed) socket.write(`${line}\n`);
    else pending.push(line);
  };

  socket.on('connect', () => {
    connected = true;
    while (pending.length && !socket.destroyed) socket.write(`${pending.shift()}\n`);
    maybeHalfClose();
  });

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    outBuf += chunk;
    for (let idx; (idx = outBuf.indexOf('\n')) >= 0;) {
      const line = outBuf.slice(0, idx).replace(/\r$/, '');
      outBuf = outBuf.slice(idx + 1);
      if (line) stdout.write(`${line}\n`);
    }
  });

  socket.on('end', () => {
    const tail = outBuf.replace(/\r$/, '').trim();
    if (tail) stdout.write(`${tail}\n`);
    outBuf = '';
  });

  readJsonLines(
    stdin,
    (line) => {
      if (emptyRelay) emptyRelay.handleLine(line);
      else sendToSocket(line);
    },
    () => {
      stdinEnded = true;
      if (emptyRelay) emptyRelay.finish();
      else maybeHalfClose();
    },
  );

  socket.on('close', (hadError) => {
    if (!emptyRelay) onExit(hadError ? 1 : 0);
  });
  socket.on('error', (err) => {
    if (!connected && !emptyRelay && (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED')) {
      emptyRelay = runEmptyRelay({
        stdout,
        onExit,
        initialLines: pending.splice(0),
        stdinEnded,
        attachStdin: false,
      });
      return;
    }
    process.stderr.write(`yomna-desktop relay error: ${err?.message || err}\n`);
    onExit(1);
  });

  return socket;
}

const isMain = (() => {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  let resolved = '';
  try {
    resolved = fs.realpathSync(arg1);
  } catch {
    resolved = path.resolve(arg1);
  }
  const sameFile = fileURLToPath(import.meta.url) === resolved;
  if (!sameFile) return false;
  // When bundled into dist/sidekick.mjs, import.meta.url matches sidekick.mjs; only run CLI relay when invoked as mcp-desktop.mjs or with --relay.
  return path.basename(resolved) === 'mcp-desktop.mjs' || process.argv[2] === '--relay';
})();

if (isMain) {
  const args = process.argv.slice(2);
  const socketPath = args[0] === '--relay' ? args[1] : (args[0] || process.env.YOMNA_MCP_SOCKET || '');
  if (!socketPath) {
    runEmptyRelay();
  } else {
    runStdioRelay(socketPath, {
      onExit: (code) => {
        if (code === 0) {
          process.exitCode = 0;
          process.stdin.pause();
        } else {
          process.exit(code);
        }
      },
    });
  }
}
