// One background agent, in its own process (forked by agents.mjs): a crash or a heavy task here never slows the chat.
// It talks to the sidecar over Node's IPC channel and exits when the sidecar goes away.
//
// in:  {t:'start', agent, model, content} {t:'reply', id, value} {t:'steer', text} {t:'allow', on}
// out: {t:'beat'} {t:'tick'} {t:'tool', name} {t:'ui', m} (an operator's {kind:'hands'} overlay message) {t:'turn', usage} {t:'plan', text} {t:'ask', id, question} {t:'ask_cancel', id}
//      {t:'creds', id} {t:'finish', result} {t:'end', ok, error?}
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { agentEvents } from './agentstream.mjs';
import { agentSystem, checkFinish, toolsFor } from './agents.mjs';
import { HarnessManager } from './harnesses/index.mjs';
import { guardTools } from './loopguard.mjs';
import { createDesktopMcpBridge } from './mcp-desktop.mjs';
import { createTools } from './tools.mjs';

// stdout isn't the app's protocol here, but the sidecar only reads stderr from this process.
console.log = console.info = (...a) => console.error(...a);
const send = (m, done) => { try { if (process.connected) process.send(m, done); else done?.(); } catch { done?.(); } };
process.on('disconnect', () => process.exit(0));

let seq = 0;
const waiting = new Map();
// A question for the sidecar (a yes, credentials); null when the call is cut off.
function request(msg, signal) {
  return new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    send({ ...msg, id });
    signal?.addEventListener('abort', () => { if (waiting.delete(id)) { send({ t: 'ask_cancel', id }); resolve(null); } }, { once: true });
  });
}

let allow = true, agent = null, harnessMgr = null, started = false;
const queued = [];
function steer(text) {
  const t = `(Message from the user while you work: ${text})`;
  if (agent?.running) agent.steer({ role: 'user', content: t });
  else queued.push(t);
}

process.on('message', (m) => {
  if (m?.t === 'start' && !started) { started = true; run(m).catch((e) => end(false, String(e?.message ?? e).slice(0, 300))); }
  else if (m?.t === 'reply') { const r = waiting.get(m.id); waiting.delete(m.id); r?.(m.value ?? null); }
  else if (m?.t === 'steer' && typeof m.text === 'string') steer(m.text.slice(0, 4000));
  else if (m?.t === 'allow') allow = !!m.on;
});

function end(ok, error) {
  clearInterval(beat);
  harnessMgr?.dispose?.();
  send({ t: 'end', ok, ...(error ? { error } : {}) }, () => process.exit(0));
}
const beat = setInterval(() => send({ t: 'beat' }), 15_000);
send({ t: 'beat' });

// Old tool results shrink once the run outgrows its budget; the brief and the latest turns stay whole.
const sizeOf = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, p) => n + (p?.type === 'image' ? 6000 : String(p?.text ?? p?.content ?? '').length + JSON.stringify(p?.args ?? '').length), 0) : 0);
const msgSize = (m) => (m.role === 'tool' ? m.content.reduce((n, r) => n + sizeOf(r.content), 0) : sizeOf(m.content));
export function trimRun(msgs, budgetChars) {
  if (msgs.reduce((n, m) => n + msgSize(m), 0) <= budgetChars) return msgs;
  const keep = msgs.length - 12;
  const short = (c) => { const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : ''); return t.length > 300 ? `${t.slice(0, 300)}\n…(trimmed to save space; read it again if you need it)` : t; };
  return msgs.map((m, i) => (m.role === 'tool' && i > 1 && i < keep ? { ...m, content: m.content.map((r) => ({ ...r, content: short(r.content) })) } : m));
}

async function run({ agent: a, model: md, content }) {
  allow = a.allow !== false;
  let result = null;
  const { tools: all, desktopHandlers } = createTools({
    allowActions: () => allow, ui: (m) => { if (m?.kind === 'hands') send({ t: 'ui', m }); }, openUrl: () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: (ms) => new Date(ms).toLocaleString(),
    commitmentsText: () => '', userName: a.userName || 'The user', workdir: a.dir, own: a.dir, readOnly: () => a.readOnly ?? [], pointScale: () => 'pixels',
    rememberAllow: false,
    ask: (opts, signal) => request({ t: 'ask', question: String(opts?.placeholder ?? '').slice(0, 300) }, signal).then((yes) => (yes ? 'yes' : null)),
  });
  const tools = [
    ...guardTools(toolsFor(a.type, all)),
    {
      name: 'plan', description: 'Say what you are doing now, in one short line (under 60 characters). It shows on your row in the corner of their screen. Call it at the start of each new stage.',
      parameters: z.object({ now: z.string().min(1).max(120) }),
      execute: async ({ now }) => { send({ t: 'plan', text: String(now).replace(/\s+/g, ' ').trim().slice(0, 60) }); return 'ok'; },
    },
    {
      name: 'finish', description: `Report the result, once, when the work is done (or can't be done). outcome: one plain sentence under 90 characters. report: what you found or did, plain text under 1,200 characters, answer first${a.returns === 'answer' ? ' (required: it is passed on to them)' : ' (optional)'}. place: the folder, file or http(s) web address you worked on, if any. files: what they should open, paths from your folder (files/…), each with a few words on what it is. needs_you: under 70 characters, only if they must do something. Then stop.`,
      parameters: z.object({ outcome: z.string(), report: z.string().optional(), place: z.string().optional(), files: z.array(z.object({ path: z.string(), what: z.string().optional() })).max(20).optional(), needs_you: z.string().optional() }),
      execute: async (args) => {
        const r = checkFinish(args, { dir: a.dir, deliverTo: a.deliverTo, returns: a.returns });
        if (r.error) throw new Error(r.error);
        result = r.result;
        send({ t: 'finish', result });
        return 'Saved: that is what they see. You are done; stop now and write nothing more.';
      },
    },
  ];

  const ctl = new AbortController();
  const sys = agentSystem(a.type, { dir: a.dir, userName: a.userName, deliverTo: a.deliverTo, returns: a.returns });
  const maxTurns = a.maxTurns ?? 80;
  const fakePath = process.env.YOMNA_FAKE_AGENT || process.env.JARVIS_FAKE_AGENT;
  const Fake = fakePath ? (await import(pathToFileURL(fakePath).href)).default : null;

  let lastTick = 0, outOfTurns = false;
  const tick = () => { const n = Date.now(); if (n - lastTick > 5000) { lastTick = n; send({ t: 'tick' }); } };

  if (Fake) {
    const budget = (md?.budget ?? 100_000) * 3.6;
    const common = {
      model: md?.model, system: sys, tools, maxTurns,
      thinking: md?.thinking ?? undefined, signal: ctl.signal, priorMessages: [], transformContext: (msgs) => trimRun(msgs, budget),
    };
    agent = new Fake({ ...common, provider: md?.provider });
    const once = async (input) => {
      for await (const e of agentEvents(agent.prompt(input))) {
        if (e.type === 'text_delta' || e.type === 'thinking_delta' || e.type === 'toolcall_delta') tick();
        else if (e.type === 'tool_call_start') send({ t: 'tool', name: e.name });
        else if (e.type === 'tool_call_end') tick();
        else if (e.type === 'server_tool_call') send({ t: 'tool', name: 'web_search' });
        else if (e.type === 'turn_end') { const u = e.usage ?? {}; send({ t: 'turn', usage: { in: (u.inputTokens ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), out: u.outputTokens ?? 0 } }); }
        else if (e.type === 'max_turns') outOfTurns = true;
        else if (e.type === 'error') throw e.error;
      }
    };
    await once(content);
    while (queued.length && !outOfTurns) await once(queued.splice(0).join('\n'));
    if (!result && !outOfTurns) await once('(You stopped without calling finish. Call finish now with what you made. If you couldn\'t make it, finish with an outcome that says so in plain words.)');
    if (result) return end(true);
    return end(false, outOfTurns ? `Used all its ${maxTurns} turns` : 'Ended without a result');
  }

  // Real background agent execution through the configured CLI harness + local yomna-desktop MCP bridge.
  const bridge = await createDesktopMcpBridge(desktopHandlers);
  try {
    const harnessId = md?.harness || 'agy';
    const customOpts = md?.customHarness?.command ? { custom: { binary: md.customHarness.command, args: md.customHarness.args, mode: md.customHarness.protocol === 'cli' ? 'cli' : 'acp' } } : {};
    harnessMgr = new HarnessManager({ harness: harnessId, options: customOpts });

    const runTurn = async (promptText) => {
      const promptStr = typeof promptText === 'string' ? promptText : Array.isArray(promptText) ? promptText.map((p) => p?.text ?? '').join('\n') : String(promptText ?? '');
      let text = '';
      let doneText = null;
      for await (const ev of harnessMgr.send({
        prompt: promptStr,
        systemPrompt: sys,
        cwd: a.dir,
        mcpConfigPath: bridge.configPath,
        allowActions: allow,
        signal: ctl.signal,
      })) {
        if (ev.type === 'text_delta' || ev.type === 'thinking_delta') { tick(); if (ev.type === 'text_delta') text += ev.text; }
        else if (ev.type === 'tool_start') send({ t: 'tool', name: String(ev.name ?? 'tool').replace(/^(?:mcp__)?yomna-desktop__/, '') });
        else if (ev.type === 'tool_end') tick();
        else if (ev.type === 'done') doneText = ev.text;
        else if (ev.type === 'error') throw new Error(ev.message);
      }
      return (doneText ?? text).trim();
    };

    let finalReply = await runTurn(content);
    while (queued.length) {
      const next = await runTurn(queued.splice(0).join('\n'));
      if (next) finalReply = next;
    }
    if (!result && finalReply) {
      const outcome = finalReply.split(/[\n.!?]/)[0].trim().slice(0, 88) || 'Completed background task.';
      const checked = checkFinish({ outcome, ...(a.returns === 'answer' ? { report: finalReply.slice(0, 1180) } : {}) }, { dir: a.dir, deliverTo: a.deliverTo, returns: a.returns });
      if (!checked.error) {
        result = checked.result;
        send({ t: 'finish', result });
      }
    }
    if (result) return end(true);
    return end(false, 'Ended without a result');
  } finally {
    await bridge.close().catch(() => {});
  }
}
