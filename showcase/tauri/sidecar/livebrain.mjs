// Yomna's brain inside a Gemini Live call (live.mjs): the prompt Classic builds, plus guidance for talking out loud,
// and the active tools plus built-in delegate_to_harness for handing heavy work to the background CLI harness.
// Everything else (the hotkey, playback, captions, the panel) stays with the caller, which hears it through emit():
// every live.mjs event except toolCall/toolCancel (handled here), plus
//   {type:'tool', id, name, args}      a tool started (args as Gemini sent them)
//   {type:'toolEnd', id, name, ok, output}  it finished (ok false: it failed, was refused or was cancelled); output: its
//                                      answer's text or error (none when cancelled)
// A cancelled call (they cut in) is aborted and gets no answer. A picture in a tool's result (a screenshot) goes into
// the call as an image, its text as the answer. news() holds a background agent's report until the call is quiet.
import { z } from 'zod';
import { createLive, val } from './live.mjs';
import { SLOW_TOOLS } from './tools.mjs';

export const DELEGATE_TOOL_NAME = 'delegate_to_harness';
export const DELEGATE_TOOL = {
  name: DELEGATE_TOOL_NAME,
  description: 'Hand a task to the background CLI agent harness, which can really do it: create, edit or move files, run commands, write code, research, and multi-step work across apps. Call it whenever they ask you to DO something you have no direct tool for, instead of describing how. prompt: the full task in plain words, with every name, path, value and detail they gave (the harness hears nothing of the call).',
  parameters: z.object({
    prompt: z.string().min(1),
    context: z.string().optional(),
  }),
};

export const LIVE_SLOW_TOOLS = new Set([...SLOW_TOOLS, DELEGATE_TOOL_NAME]);

export const LIVE_GUIDANCE = `You're in a live voice call: everything you say is heard out loud, the moment you say it, and they can cut in any time. Talk like on the phone: one to three short sentences, plain words, contractions. No markdown, lists, emoji, links, code, file paths, bracketed cues or tags like [happy]: they'd be read aloud. Name the site, file or app instead. Before anything slow (the web, a page, the screen, an app, a command, or delegating to the coding harness), say a short beat like "On it, one sec." and keep talking with them while it runs. When a result comes back, tell them briefly. You are here to get things done, not to explain how: when they ask you to do something (make or change a file, run a command, install, code, set something up, research, anything with several steps) and no other tool of yours does it directly, call delegate_to_harness right away with the whole task, never just say what you would do or tell them to do it themselves. Never claim it's done until the harness's result says so. Never say you don't know something about them before looking it up with your tools (their second brain, if they have one). You HAVE a built-in draw tool that renders interactive diagrams, flowcharts, mindmaps, timelines, graphs, tables, math, molecules, and 3D models directly on their screen: whenever they ask to draw, visualize, or show a diagram/chart/mindmap/timeline, ALWAYS call draw right away — NEVER say you cannot draw diagrams, and NEVER use kind 'point' or x/y screen coordinates to draw a diagram (those are only for pointing at UI elements on a screenshot). Always use a card mark like kind 'flow' (with nodes and links, animate: true), 'mindmap', 'timeline', 'graph', 'bars', 'table', 'molecule', or 'model'. Example draw call: {"beats":[{"say":"Here is how it works.","marks":[{"kind":"flow","title":"Topic","animate":true,"nodes":[{"id":"a","text":"Start","shape":"round"},{"id":"b","text":"Process"},{"id":"c","text":"End","shape":"round"}],"links":[{"from":"a","to":"b","flow":true},{"from":"b","to":"c","flow":true}]}]}]}. Reply in the language they're speaking and keep that one language for the whole call: never switch because a bit of audio was unclear or sounded foreign, only when they clearly switch themselves. Never mishear accented English as Arabic, Urdu, or another script. If you're not sure, use English.`;

/** Convert a tool's Zod v4 schema (or JSON Schema object) into a plain JSON Schema for Gemini Live. */
export function resolveToolSchema(tool) {
  const params = tool?.parameters;
  if (!params) return { type: 'object', properties: {} };
  if (typeof params.safeParse === 'function' || params._zod || params._def) {
    const schema = z.toJSONSchema(params, { unrepresentable: 'any' });
    if (schema && typeof schema === 'object' && '$schema' in schema) {
      const { $schema, ...rest } = schema;
      return rest;
    }
    return schema;
  }
  if (typeof params === 'object') return params;
  throw new Error(`Unsupported schema for tool "${tool?.name ?? 'unknown'}"`);
}

function unknownToolMessage(name, available = []) {
  const list = available.length ? ` Available tools: ${available.join(', ')}.` : '';
  return `Unknown tool "${name}".${list}`;
}

const withDelegateTool = (list) => {
  const items = Array.isArray(list) ? list : [];
  return items.some((t) => t?.name === DELEGATE_TOOL_NAME) ? items : [...items, DELEGATE_TOOL];
};

/** The tools as Live function declarations: [{functionDeclarations}] for the session's config.tools. */
export function liveDeclarations(tools = [], slow = LIVE_SLOW_TOOLS) {
  const functionDeclarations = [];
  for (const t of withDelegateTool(tools)) {
    let schema;
    try { schema = resolveToolSchema(t); } catch { continue; } // unconvertible schema: left out
    const nonBlocking = t.name === DELEGATE_TOOL_NAME || slow.has(t.name);
    functionDeclarations.push({
      name: t.name,
      description: t.description,
      parametersJsonSchema: schema,
      ...(nonBlocking ? { behavior: 'NON_BLOCKING' } : {}),
    });
  }
  return [{ functionDeclarations }];
}

const stripNulls = (v) => (Array.isArray(v) ? v.map(stripNulls)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)])) : v);
// A tool may also repair the shapes voice models get wrong (tool.normalize): tried last, so right calls are untouched.
const parse = (tool, args) => {
  try { return tool.parameters.parse(args); } catch (first) {
    try { return tool.parameters.parse(stripNulls(args)); } catch {
      if (typeof tool.normalize !== 'function') throw first;
      try { return tool.parameters.parse(tool.normalize(stripNulls(args))); } catch {
        throw new Error(tool.example ? `These arguments don't fit ${tool.name}. Send them as real JSON in this shape, not text: ${tool.example}` : first.message);
      }
    }
  }
};

// A chosen speech language (a locale like 'ar-SA'), as a prompt line; '' for 'auto'.
export const langLine = (code) => {
  if (!code || code === 'auto') return '';
  let name = code;
  try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch {}
  return `\nThey've set their language to ${name}: always understand, transcribe, and reply in ${name} unless they clearly speak another.`;
};

function pushResultImages(raw, live, signal) {
  if (!raw || typeof raw !== 'object' || signal?.aborted) return;
  if (raw.screenshot) {
    const img = typeof raw.screenshot === 'string' ? { data: raw.screenshot, mediaType: 'image/png' } : raw.screenshot;
    if (img?.data) live.pushImage(img.data, img.mediaType ?? 'image/png');
  }
  if (Array.isArray(raw.images)) {
    for (const item of raw.images) {
      if (signal?.aborted) break;
      const img = typeof item === 'string' ? { data: item, mediaType: 'image/png' } : item;
      if (img?.data) live.pushImage(img.data, img.mediaType ?? 'image/png');
    }
  }
}

/**
 * tools: the tool array (or a function returning it, read on every connect and call). system: a function returning the
 * prompt Classic would send (personality, memory, second brain, focus, crew). onDelegate: async ({ prompt, context }, opts) => summary
 * callback invoked by the built-in non-blocking delegate_to_harness tool. The rest goes to createLive (key, model,
 * voice, connect). speechLang: 'auto' or a locale like 'ar-SA' (a value or a function, read on every connect); a locale
 * is named in the prompt. Native-audio Live models take their language from the conversation and the system
 * instruction (the Live API guide), so it isn't sent as speechConfig.languageCode.
 */
export function createLiveBrain({ emit, tools = [], system, slow = LIVE_SLOW_TOOLS, speechLang = 'auto', onDelegate = null, ...liveOpts }) {
  const running = new Map(); // call id → AbortController
  const held = []; // agent news waiting for a quiet moment
  const quiet = () => live.state === 'listening' && !running.size;
  const flush = () => { while (held.length && quiet()) live.pushNote(held.shift()); };
  const isSlow = (name) => name === DELEGATE_TOOL_NAME || slow.has(name);
  const resolvedTools = () => withDelegateTool(val(tools));

  const live = createLive({
    ...liveOpts,
    systemInstruction: () => `${val(system) ?? ''}\n\n${LIVE_GUIDANCE}${langLine(val(speechLang))}`,
    tools: () => liveDeclarations(val(tools), slow),
    emit: (e) => {
      if (e.type === 'toolCall') return batch(e.calls);
      if (e.type === 'toolCancel') return e.ids.forEach((id) => running.get(id)?.abort());
      emit(e);
      if (e.type === 'state') flush();
    },
  });

  const news = (text) => { held.push(String(text)); flush(); };

  // Parallel calls in one turn are answered together, one toolResponse per kind once the last of that kind is done:
  // one per result made her answer once per result. The quick (blocking) ones and the slow (NON_BLOCKING) ones go
  // separately, so a slow one never holds back what Gemini is waiting on. toolEnd fires as the answer goes out. A
  // cancelled call is dropped at once (its tool may ignore the abort) and gets no answer.
  function batch(calls) {
    for (const group of [calls.filter((c) => !isSlow(c.name)), calls.filter((c) => isSlow(c.name))]) if (group.length) answer(group);
  }
  async function answer(group) {
    const done = (await Promise.all(group.map(run))).filter(Boolean);
    for (const { id, name, ok, response, badArgs } of done) emit({ type: 'toolEnd', id, name, ok, output: response.output ?? response.error, ...(badArgs ? { badArgs: true } : {}) });
    if (done.length) live.respond(done.map(({ id, name, response }) => ({ id, name, response })));
    flush();
  }

  async function runDelegate(parsed, { signal, toolCallId }) {
    if (typeof onDelegate !== 'function') throw new Error('Background harness delegation is not configured.');
    const raw = await onDelegate(
      { prompt: parsed.prompt, context: parsed.context },
      { signal, toolCallId, news, pushImage: (data, mediaType = 'image/png') => { if (!signal.aborted) live.pushImage(data, mediaType); } },
    );
    pushResultImages(raw, live, signal);
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.content)) return raw;
      const summary = raw.summary ?? raw.output ?? raw.text ?? raw.content;
      if (summary != null) return String(summary);
    }
    return 'Delegated to background harness.';
  }

  async function run({ id, name, args }) {
    const ac = new AbortController();
    running.set(id, ac);
    emit({ type: 'tool', id, name, args });
    const cancelled = new Promise((res) => ac.signal.addEventListener('abort', () => res(null), { once: true }));
    const work = (async () => {
      let response, ok = false, badArgs = false;
      try {
        const list = resolvedTools();
        const tool = list.find((t) => t.name === name);
        if (!tool) throw new Error(unknownToolMessage(name, list.map((t) => t.name)));
        let parsed;
        try { parsed = parse(tool, args); } catch (e) { badArgs = true; throw e; }
        const raw = name === DELEGATE_TOOL_NAME && !tool.execute
          ? await runDelegate(parsed, { signal: ac.signal, toolCallId: id })
          : await tool.execute(parsed, { signal: ac.signal, toolCallId: id });
        const content = typeof raw === 'string' ? raw : raw?.content ?? '';
        const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
        for (const b of parts) if (b.type === 'image' && !ac.signal.aborted) live.pushImage(b.data, b.mediaType);
        const text = parts.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        response = { output: text };
        ok = true;
      } catch (err) {
        response = { error: err?.message || String(err) };
      }
      running.delete(id);
      if (ac.signal.aborted) flush();
      return ac.signal.aborted ? null : { id, name, ok, response, badArgs };
    })();
    const r = await Promise.race([work, cancelled]);
    if (!r) emit({ type: 'toolEnd', id, name, ok: false });
    return r;
  }

  return {
    get state() { return live.state; },
    start: () => live.start(),
    stop() {
      live.stop();
      held.length = 0;
      for (const ac of running.values()) ac.abort();
    },
    /** True when nothing is going on in the call: she isn't talking or thinking and no tool is running. */
    quiet,
    /** A background agent's news: into the call now if quiet, else at the next quiet moment. */
    news,
    pushAudio: (pcm) => live.pushAudio(pcm),
    pushImage: (data, mimeType) => live.pushImage(data, mimeType),
  };
}
