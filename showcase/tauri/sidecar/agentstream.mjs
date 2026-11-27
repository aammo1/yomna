// Safely consumes an async stream without unhandled rejections if the underlying promise rejects during iteration.
export function agentEvents(stream) {
  const events = stream[Symbol.asyncIterator](); // claim the events first so then() doesn't drain them
  if (typeof stream?.then === 'function') stream.then(undefined, () => {});
  return events;
}

/** Calls onStall once nothing has arrived for `ms`. A tool running (it may be waiting on the user) pauses it. */
export function stallWatch(ms, onStall) {
  const tools = new Set();
  let timer = null, done = false;
  const arm = () => {
    clearTimeout(timer); timer = null;
    if (!done && !tools.size) timer = setTimeout(() => { done = true; onStall(); }, ms);
  };
  arm();
  return {
    event(e) {
      const id = e?.toolCallId ?? e?.id ?? 'tool';
      if (e?.type === 'tool_call_start' || e?.type === 'tool_start') tools.add(id);
      else if (e?.type === 'tool_call_end' || e?.type === 'tool_end') tools.delete(id);
      arm();
    },
    stop() { done = true; clearTimeout(timer); },
  };
}
