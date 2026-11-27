// Turns the agent's raw text stream into what the sidekick shows and does.
// - Emote tags like [hype] (anywhere, even split across chunks) become emote events and are removed.
// - A later turn that only repeats the previous turn's text (models do this after a tool call) is dropped.
// - Text from a new turn is separated from earlier text with a space.
export const EMOTES = ['hype', 'upset', 'remind', 'motivate', 'wave'];
const TAG = new RegExp(`\\[(${EMOTES.join('|')})\\]\\s*`, 'i');
const LONGEST = Math.max(...EMOTES.map((e) => e.length)) + 2;

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// A tool call written out as text ("[called read_window {…}]", "Tool use: …"): models copy it from a conversation
// handed over as a transcript. It's never something to show or say (in brackets the voice took it as a cue and read
// it out). Dropped from the stream, also when it comes split across chunks or mid-line.
const ECHO_STARTS = ['[called ', 'Tool use: ', 'Tool result: '];
const ECHO_LINE = /^[ \t]*(?:\[called [\w.-]+(?: [^\n]*)?\]|Tool (?:use|result): [^\n]*)[ \t]*$/;
export class EchoFilter {
  constructor() { this.buf = ''; }
  push(text) {
    this.buf += text;
    let out = '';
    for (;;) {
      const nl = this.buf.indexOf('\n');
      const line = nl < 0 ? this.buf : this.buf.slice(0, nl);
      // Where an echo might begin in this line: at its start for "Tool …", anywhere for "[called ".
      let at = this.#echoAt(line, nl < 0);
      // Spaces at the end of an unfinished line are held too: they belong to an echo if one follows.
      if (at < 0 && nl < 0) at = line.replace(/[ \t]+$/, '').length;
      if (at < 0) { out += line + '\n'; this.buf = this.buf.slice(nl + 1); continue; }
      const from = line.slice(0, at).replace(/[ \t]+$/, '').length; // the spaces before it go with it
      out += line.slice(0, from);
      if (nl < 0) { this.buf = line.slice(from); return out; } // held until the line ends
      const held = line.slice(from);
      if (!ECHO_LINE.test(held.slice(at - from))) out += held + '\n';
      else if (from) out += '\n';
      this.buf = this.buf.slice(nl + 1);
    }
  }
  /** At the end of a turn: what's held goes out, unless it's an echo. */
  flush() { const b = this.buf; this.buf = ''; return ECHO_LINE.test(b) ? '' : b; }
  #echoAt(line, open) {
    const i = line.indexOf('[called ');
    if (i >= 0) return i;
    const t = line.replace(/^[ \t]+/, '');
    if (ECHO_STARTS.some((s) => s !== '[called ' && t.startsWith(s))) return line.length - t.length;
    // An unfinished line that could still become one: hold its tail.
    if (open) for (const s of ECHO_STARTS) for (let k = Math.min(s.length - 1, line.length); k > 0; k--) {
      const tail = line.slice(line.length - k);
      if (s.startsWith(tail) && (s === '[called ' || !line.slice(0, line.length - k).trim())) return line.length - k;
    }
    return -1;
  }
}

// Gemini's reasoning summary sent as plain reply text (no thought flag on the part, so gg-ai can't tell it from the
// answer): a bold heading that starts with an -ing word, a blank line, its planning prose, then two blank lines and
// the real answer. Dropped only at the start of a model turn and only in that exact shape: the prose is one paragraph
// that reads as planning (it opens "I…", "My…" or "The user…"). A heading over anything else ("**Morning Briefing**",
// "You have 3 meetings") streams straight on, and planning-like prose with no gap after it is let out at the turn's end.
const HEADING = /^[A-Z][a-z]+ing(?: [^*\n]{1,80})?$/;
const BODY_MAX = 4000;
const PLANS = ['I ', "I'", 'I\u2019', 'My ', 'The user'];
function planning(b) { // → 1 when the prose under a heading opens like Gemini's planning, 0 when not, -1 while unsure
  if (PLANS.some((p) => b.startsWith(p))) return 1;
  return PLANS.some((p) => p.startsWith(b)) ? -1 : 0;
}
function summaryHead(b) { // → the length of a summary heading at b's start, 0 when it isn't one, -1 while it could be
  const lead = b.length - b.replace(/^\s+/, '').length, s = b.slice(lead);
  if (s.length < 2) return '**'.startsWith(s) ? -1 : 0;
  if (!s.startsWith('**')) return 0;
  const close = s.indexOf('**', 2);
  if (close < 0) {
    const h = s.slice(2).replace(/\*$/, '');
    return h.length <= 90 && (/^(?:[A-Z][a-z]*)?$/.test(h) || /^[A-Z][a-z]+ing(?: [^*\n]*)?$/.test(h)) ? -1 : 0;
  }
  if (!HEADING.test(s.slice(2, close))) return 0;
  const rest = s.slice(close + 2);
  if (rest.length < 3) return '\n\n'.startsWith(rest.slice(0, 2)) ? -1 : 0;
  return rest.startsWith('\n\n') && rest[2] !== '\n' ? lead + close + 4 : 0;
}
export class ThoughtFilter {
  constructor() { this.buf = ''; this.state = 'start'; } // start (a turn's first text), body (in a summary), pass
  push(text) {
    if (this.state === 'pass') return text;
    this.buf += text;
    let out = '';
    for (;;) {
      if (this.state === 'start') {
        const n = summaryHead(this.buf);
        if (n < 0) return out;
        if (n === 0) { this.state = 'pass'; out += this.buf; this.buf = ''; return out; }
        this.state = 'body'; this.held = this.buf.slice(0, n); this.buf = this.buf.slice(n);
      }
      const plan = planning(this.buf);
      if (plan < 0) return out;
      const para = this.buf.search(/\n\n[^\n]/); // a second paragraph before any gap: an answer, not a summary
      const gap = this.buf.indexOf('\n\n\n');
      if (!plan || (para >= 0 && (gap < 0 || para < gap))) { this.state = 'pass'; out += this.held + this.buf; this.buf = ''; this.held = ''; return out; }
      if (gap < 0) {
        if (this.held.length + this.buf.length > BODY_MAX) { this.state = 'pass'; out += this.held + this.buf; this.buf = ''; }
        return out;
      }
      this.buf = this.buf.slice(gap + 3).replace(/^\n+/, ''); this.state = 'start'; // dropped: look for another one
    }
  }
  /** At the end of a model turn: what's held goes out (a heading with no summary gap was a real answer). */
  flush() {
    const b = (this.state === 'body' ? this.held : '') + this.buf;
    this.buf = ''; this.held = ''; this.state = 'start';
    return b;
  }
}

export class ReplyStream {
  constructor(emit) {
    this.emit = emit; // ({ type: 'text', text } | { type: 'emote', action })
    this.pending = ''; // raw text that might still be the start of a tag
    this.turn = ''; // this turn's visible text so far
    this.held = ''; // visible text held back while it matches the previous turn
    this.prev = ''; // previous turn's visible text, normalised
    this.shown = false; // anything shown yet in this run
    this.started = false; // this turn has released text
  }

  push(delta) {
    this.pending += delta;
    for (;;) {
      const m = TAG.exec(this.pending);
      if (!m) break;
      this.visible(this.pending.slice(0, m.index));
      this.emit({ type: 'emote', action: m[1].toLowerCase() });
      this.pending = this.pending.slice(m.index + m[0].length);
    }
    // Hold back a trailing "[hyp" that could still become a tag.
    const open = this.pending.lastIndexOf('[');
    let keep = '';
    if (open >= 0 && this.pending.length - open <= LONGEST) {
      const tail = this.pending.slice(open + 1).toLowerCase();
      if (!tail.includes(']') && EMOTES.some((e) => e.startsWith(tail))) keep = this.pending.slice(open);
    }
    this.visible(this.pending.slice(0, this.pending.length - keep.length));
    this.pending = keep;
  }

  visible(text) {
    if (!text) return;
    this.turn += text;
    if (this.prev && !this.started) {
      // Still matching what was said last turn: hold it until it diverges.
      if (this.prev.startsWith(norm(this.turn))) { this.held += text; return; }
      text = this.held + text;
      this.held = '';
    }
    this.release(text);
  }

  release(text) {
    if (!this.started) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      if (this.shown) text = ' ' + text;
      this.started = true;
    }
    this.shown = true;
    this.emit({ type: 'text', text });
  }

  /** Call at each turn boundary (after the model's message and its tool results). */
  endTurn() {
    this.flushPending();
    // Whatever is still held only repeated the previous turn, so it is dropped.
    this.held = '';
    if (norm(this.turn)) this.prev = norm(this.turn);
    this.turn = '';
    this.started = false;
  }

  finish() { this.flushPending(); this.held = ''; }

  flushPending() {
    if (this.pending) { const p = this.pending; this.pending = ''; this.visible(p); }
  }
}
