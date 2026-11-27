// The loop guard and every tool call's outcome line (loopguard.mjs), shared by Classic, Live and the operator agent.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FAIL_LIMIT, GOAL_LIMIT, LOOP_LIMIT, STUCK_MESSAGE, guardTools } from '../loopguard.mjs';

// A fake act_in_app whose window text is whatever `screen` holds, so a test says when the screen moved.
const setup = () => {
  const lines = [];
  const state = { screen: 'Now showing: Cards\n1 button "Video +"', runs: 0, fail: null };
  const tools = guardTools([
    { name: 'act_in_app', execute: async () => { state.runs++; if (state.fail) throw new Error(state.fail); return `In Chrome: scrolled.\n${state.screen}`; } },
    { name: 'take_screenshot', execute: async () => ({ content: [{ type: 'text', text: 'Screenshot of the front window.' }, { type: 'image', data: 'AAAA', mediaType: 'image/jpeg' }] }) },
  ], { log: (kind, data) => lines.push({ kind, ...data }) });
  const call = (name, args, id = 'c') => tools.find((t) => t.name === name).execute(args, { toolCallId: id });
  return { lines, state, call };
};
const scroll = (amount = 3) => ({ target: 'front', steps: [{ do: 'scroll', direction: 'down', amount }] });

assert.equal(LOOP_LIMIT, 3);

// The same scroll on the same target, three times with nothing changing: the fourth never runs, and says what to do.
{
  const { state, call, lines } = setup();
  for (let i = 0; i < 3; i++) await call('act_in_app', scroll(i + 1)); // amount differs: still the same scroll
  assert.equal(state.runs, 3);
  await assert.rejects(call('act_in_app', scroll()), /nothing changed after 3 tries: stop, take_screenshot, look at what's actually on screen and try a different step \(e\.g\. open the control first\), or ask the user/);
  assert.equal(state.runs, 3, 'the blocked call did not run');
  const last = lines.at(-1);
  assert.equal(last.kind, 'tool_outcome');
  assert.equal(last.ok, false); assert.equal(last.reason, 'loop_guard');
}

// Anything changing on screen resets the count.
{
  const { state, call } = setup();
  await call('act_in_app', scroll()); await call('act_in_app', scroll());
  state.screen = 'Now showing: Cards\n1 button "Video +"\n2 link "My video"';
  await call('act_in_app', scroll()); await call('act_in_app', scroll()); await call('act_in_app', scroll());
  assert.equal(state.runs, 5, 'the screen moved, so the scrolls after it count from one');
}

// A different action in between (a screenshot, the step the guard asks for) resets it too.
{
  const { state, call } = setup();
  for (let i = 0; i < 3; i++) await call('act_in_app', scroll());
  await call('take_screenshot', { target: 'front' });
  await call('act_in_app', scroll());
  assert.equal(state.runs, 4);
}

// A step that fails the same way three times is a loop too.
{
  const { state, call } = setup();
  state.fail = 'No "My video" on screen.';
  const click = { target: 'front', steps: [{ do: 'click_text', text: 'My video' }] };
  for (let i = 0; i < 3; i++) await assert.rejects(call('act_in_app', click), /No "My video"/);
  await assert.rejects(call('act_in_app', click), /nothing changed after 3 tries/);
  assert.equal(state.runs, 3);
}

// Each call's outcome is logged: ok or error, whether the window changed, how many repeats, a short reason. Never what
// the screen or the user said: no window text, no step text, no error message.
{
  const { state, call, lines } = setup();
  await call('act_in_app', scroll(), 'a1');
  await call('act_in_app', scroll(), 'a2');
  state.screen = 'Now showing: Studio\n1 button "Save"';
  await call('act_in_app', scroll(), 'a3');
  state.fail = 'Could not find "secret words"';
  await call('act_in_app', { target: 'front', steps: [{ do: 'fill', field: 'Title', text: 'my private text' }] }, 'a4').catch(() => {});
  const out = lines.filter((l) => l.kind === 'tool_outcome');
  assert.deepEqual(out.map((l) => [l.id, l.name, l.ok, l.changed]), [['a1', 'act_in_app', true, null], ['a2', 'act_in_app', true, false], ['a3', 'act_in_app', true, true], ['a4', 'act_in_app', false, null]]);
  assert.equal(out[1].same, 2, 'the second identical call with no change');
  assert.equal(out[3].reason, 'error');
  const text = JSON.stringify(lines);
  for (const w of ['Studio', 'Save', 'secret words', 'my private text', 'Cards']) assert.ok(!text.includes(w), `${w} is not logged`);
}

// An aborted call (they cut in) neither counts nor blocks.
{
  const { state, call } = setup();
  const tools = guardTools([{ name: 'act_in_app', execute: async () => { state.runs++; return 'same'; } }]);
  const ac = new AbortController(); ac.abort();
  for (let i = 0; i < 5; i++) await tools[0].execute(scroll(), { signal: ac.signal });
  assert.equal(state.runs, 5);
  void call;
}

// Wired once on the chat's shared tools, so Classic and Live both log outcomes and both stop loops.
{
  const side = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
  assert.match(side, /\nguardTools\(tools, \{ log: [^\n]*request: \(\) => requestNo/, 'each request (a Classic message or a Live turn) counts from zero');
  assert.match(side, /tools, system: liveSystem/, 'the Live brain gets the same tools array');
  assert.match(side, /\nguardTools\(tools, \{[^\n]*goals: true/, 'the chat and Live stop failing app steps by goal');
}

// Regression: looking is never refused. A screenshot's text is a fixed caption, so "what's on screen now?" asked four
// times as they move through slides looked like four identical calls and the fourth was refused, by a message that
// says to take a screenshot. The picture itself is the change signal.
{
  const lines = [];
  let pixels = 'AAAA';
  const tools = guardTools([{ name: 'take_screenshot', execute: async () => ({ content: [{ type: 'text', text: 'Screenshot of the Chrome window "Cards".' }, { type: 'image', data: pixels, mediaType: 'image/jpeg' }] }) }], { log: (kind, data) => lines.push({ kind, ...data }) });
  for (let i = 0; i < 6; i++) await tools[0].execute({ target: 'front' }, { toolCallId: `s${i}` });
  pixels = 'BBBB';
  await tools[0].execute({ target: 'front' }, { toolCallId: 's6' });
  const out = lines.filter((l) => l.kind === 'tool_outcome');
  assert.ok(out.every((l) => l.ok), 'no screenshot refused, even of a screen that did not change');
  assert.equal(out.at(-1).changed, true, 'a new picture counts as a change');
  assert.equal(out[1].changed, false);
}

// Regression: each request counts from zero. Four "scroll down" messages in a row (a PDF whose text doesn't follow the
// scroll) used to add up across requests and the fourth was refused.
{
  const { state, call } = (() => {
    const st = { runs: 0 }; let req = 1;
    const tools = guardTools([{ name: 'act_in_app', execute: async () => { st.runs++; return 'In Preview: scrolled.\nNow showing: doc.pdf\n1 text "Page"'; } }], { request: () => req });
    return { state: st, call: async (args) => { await tools[0].execute(args, {}); req++; } };
  })();
  for (let i = 0; i < 5; i++) await call(scroll());
  assert.equal(state.runs, 5, 'one scroll per request is never a loop');
}

// Regression: a result that says nothing about the screen (the helper returned no controls: "In Preview: scrolled.")
// is no evidence that nothing changed, so it never counts toward a loop.
{
  const state = { runs: 0 };
  const tools = guardTools([{ name: 'act_in_app', execute: async () => { state.runs++; return 'In Preview: scrolled.'; } }]);
  for (let i = 0; i < 5; i++) await tools[0].execute(scroll(), {});
  assert.equal(state.runs, 5);
}

// A failed call logs a short code for why, mapped from the helper's errors: never the error's own words, which hold
// screen text and what was asked for.
{
  const { state, call, lines } = setup();
  const cases = [
    ['Step 1: no visible text "Public secret" in Google Chrome. Check the exact words with a screenshot or read_window.', 'no_visible_text'],
    ['Step 2: no text "Visibility secret" on this page to find "Public" near.', 'no_visible_text'],
    ['No matching window is open for Notes.', 'no_window'],
    ['Accessibility is off for Jarvis, so I can\'t read or control other apps yet.', 'permission'],
    ['Jarvis needs Accessibility permission to control other apps.', 'permission'],
    ['Window capture failed. Jarvis may need Screen Recording permission.', 'permission'],
    ['timed out', 'timeout'],
    ['Blocked for safety: that spot is on 1Password, and I never click in it.', 'blocked'],
    ['Stopped before clicking "Delete secret": it could delete, pay, send or sign out, and the user hasn\'t said yes to that.', 'needs_yes'],
    ['Step 1: no control with id 7. Call read_window again.', 'stale_id'],
    ['The page changed since read_window, so that id is out of date. Call read_window again and use the new ids.', 'stale_id'],
    ['Step 1: Safari is in front instead of Google Chrome, so I stopped before typing into the wrong app.', 'wrong_app'],
    ['Step 1: no text field called "secret" here. Check its label with read_window.', 'no_field'],
    ['Ken said no, so I didn\'t click "secret" (nothing after it ran either).', 'declined'],
    ['Step 1: "secret" appears 3 times on screen, so I didn\'t guess which. Take a screenshot and use click_at on the one you mean.', 'ambiguous'],
    ['Step 4: typed, but the text field still shows "secret", so I stopped before the next step.', 'not_typed'],
    ['Step 2: the cursor isn\'t in a text field, so typing would go nowhere.', 'not_typed'],
    ['Something was clicked or opened since that screenshot, so it may be out of date. Take a new screenshot.', 'needs_look'],
    ['Take a screenshot first, then give x, y in its pixels.', 'needs_look'],
    ['Something nobody planned for: "secret"', 'error'],
  ];
  for (const [i, [msg]] of cases.entries()) { state.fail = msg; await call('act_in_app', { target: 'front', steps: [{ do: 'click_text', text: `t${i}` }] }, `e${i}`).catch(() => {}); }
  const out = lines.filter((l) => l.kind === 'tool_outcome' && l.ok === false);
  assert.deepEqual(out.map((l) => l.reason), cases.map(([, code]) => code));
  assert.ok(!JSON.stringify(lines).includes('secret'), 'no screen or user text is logged (app names are)');
}

// By goal (Eric's Live call, 2026-11-26): 12 act_in_app calls in one turn chasing one goal (tick Public, then Save),
// each phrased differently, so no two were identical and the guard above never tripped. With goals on (the chat and
// Live), the same first click failing twice, or three failed act_in_app calls in one request, stops act_in_app until
// the next request; a screenshot still runs.
{
  const ct = (text) => ({ do: 'click_text', text });
  const sc = (text, more = {}) => ({ do: 'scroll', direction: 'down', ...(text ? { text } : {}), ...more });
  // Their shapes, in order, from the log; ok: the ones that worked.
  const replay = [
    [[ct('public'), ct('Save')]], [[ct('Public'), ct('Save')]], [[ct('Make your video'), sc('Make your video', { amount: 300 }), ct('public')]],
    [[ct('Visibility'), sc('Visibility'), ct('Public')]], [[sc(null, { to_end: true })], 'ok'], [[ct('Private'), ct('Public'), ct('Save')]],
    [[sc('Private'), ct('Public'), ct('Save')]], [[sc('Private'), ct('Private'), ct('Public'), ct('Done'), ct('Save')]],
    [[sc('Dashboard'), ct('Dashboard')], 'ok'], [[ct('Content')], 'ok'], [[sc('Save as private'), ct('Save as private')]],
    [[sc('Visibility'), ct('Private'), ct('Public'), ct('Save')]],
  ];
  const run = async (calls, { goals = true } = {}) => {
    const lines = [], ran = []; let req = 17, shots = 0;
    const tools = guardTools([
      { name: 'act_in_app', execute: async (args) => { ran.push(args); if (!args.ok) throw new Error('Step 1: no visible text "x" in Google Chrome.'); return 'In Chrome: done.\nNow showing: Studio'; } },
      { name: 'take_screenshot', execute: async () => { shots++; return 'Screenshot.'; } },
    ], { log: (kind, data) => lines.push({ kind, ...data }), request: () => req, goals });
    const results = [];
    for (const [steps, ok] of calls) {
      results.push(await tools[0].execute({ target: 'front', steps, ...(ok ? { ok: true } : {}) }, {}).then(() => 'ok', (e) => e.message));
      await tools[1].execute({ target: 'front' }, {});
    }
    return { lines, ran, results, shots, next: () => { req++; }, tools };
  };
  assert.equal(GOAL_LIMIT, 2); assert.equal(FAIL_LIMIT, 3);
  const r = await run(replay);
  assert.equal(r.ran.length, 3, 'the 4th call is refused');
  assert.equal(r.results[3], STUCK_MESSAGE);
  assert.ok(r.results.slice(3).every((x) => x === STUCK_MESSAGE), 'and every act_in_app after it, this request');
  assert.equal(r.shots, replay.length, 'screenshots are never refused');
  assert.equal(r.lines.filter((l) => l.name === 'act_in_app' && l.reason === 'loop_guard').length, replay.length - 3);
  assert.match(STUCK_MESSAGE, /stop[^.]*take_screenshot once[^.]*hand it to the operator \(send_agent with type operator[^)]*\) or tell the user what's blocking it/);
  // The same goal failing twice: its third try is refused, whatever the wording.
  const g = await run([[[ct('Public'), ct('Save')]], [[sc('Visibility'), ct('PUBLIC')]], [[ct('public ')]]]);
  assert.equal(g.ran.length, 2, 'the 3rd try at "public" is refused');
  // A new request starts over.
  r.next();
  assert.equal(await r.tools[0].execute({ target: 'front', steps: [ct('Public')], ok: true }, {}), 'In Chrome: done.\nNow showing: Studio');
  // Without goals (the operator agent: its whole long job is one request), only identical calls count.
  assert.equal((await run(replay, { goals: false })).ran.length, replay.length);
}

// A goal that moves forward starts over: every page of a wizard ends in "Next", so its first click is one goal for
// the whole wizard. Two failures on different pages, each followed by a retry that worked, never block a retry.
{
  const lines = []; let fail = false;
  const [act] = guardTools([{ name: 'act_in_app', execute: async () => { if (fail) throw new Error('Step 1: no text field called "x" here.'); return 'done.\nNow showing: Form'; } }],
    { log: (kind, data) => lines.push({ kind, ...data }), request: () => 1, goals: true });
  const page = async (label, ok) => { fail = !ok; return act.execute({ target: 'front', steps: [{ do: 'fill', label, text: 'x' }, { do: 'click_text', text: 'Next' }] }, {}).then(() => 'ok', (e) => e.message); };
  await page('Email', false); assert.equal(await page('Email address', true), 'ok');
  assert.equal(await page('Name', true), 'ok');
  await page('Phone', false);
  assert.equal(await page('Phone number', true), 'ok', 'the retry on the next page still runs');
}

// A call counts toward the request it started in. Live's act_in_app doesn't block the call, so Eric can speak (a new
// request) while one still runs; when it fails late, it doesn't eat into the new request's tries.
{
  let req = 1; const gates = [];
  const [act] = guardTools([{ name: 'act_in_app', execute: () => new Promise((res, rej) => gates.push(rej)) }],
    { request: () => req, goals: true });
  const go = (text) => act.execute({ target: 'front', steps: [{ do: 'click_text', text }] }, {}).then(() => 'ok', (e) => e.message);
  const old = go('Old');
  req = 2;
  const a = go('A'); gates[1](new Error('timed out')); await a;
  gates[0](new Error('timed out')); await old; // turn 1's call, failing late
  const b = go('B'); gates[2](new Error('timed out')); await b;
  const c = go('C');
  assert.equal(gates.length, 4, "turn 2's third try runs after only two of its own failures");
  gates[3](new Error('timed out')); await c;
}

// Eric's Google Doc (v0.2.8 Live): click_text on the question failed three times (the page is a canvas), then a
// click_at from a fresh screenshot, a different way to reach it, was refused before it ran. Clicking by screenshot
// pixels gets its own two tries once the text tries are spent; words keep their limit, and so do the pixels.
{
  let ok = false; const ran = [];
  const [act, shot] = guardTools([
    { name: 'act_in_app', execute: async (args) => { ran.push(args.steps[0].do); if (!ok) throw new Error('Step 1: no visible text "What is my name?" in Google Chrome.'); return 'In Chrome: done.\nNow showing: Doc'; } },
    { name: 'take_screenshot', execute: async () => 'Screenshot.' },
  ], { request: () => 1, goals: true });
  const go = (steps) => act.execute({ target: 'browser', steps }, {}).then(() => 'ok', (e) => e.message);
  const ct = (text) => [{ do: 'click_text', text }, { do: 'key', key: 'down' }, { do: 'type', text: 'Eric Tech' }];
  const at = (x, y) => [{ do: 'click_at', x, y }, { do: 'key', key: 'down' }, { do: 'type', text: 'Eric Tech' }];
  await go(ct('What is my name?')); await shot.execute({}, {}); await go(ct('What is my name?')); await go(ct('1. What is my name?'));
  await shot.execute({}, {});
  assert.notEqual(await go(at(405, 170)), STUCK_MESSAGE, 'the click_at after the text tries runs');
  assert.equal(ran.at(-1), 'click_at');
  assert.notEqual(await go(at(405, 172)), STUCK_MESSAGE, 'a second spot runs too');
  assert.equal(await go(at(405, 174)), STUCK_MESSAGE, 'a third failed spot is refused');
  assert.equal(await go(ct('Untitled document')), STUCK_MESSAGE, 'and words stay refused');
  // Once stuck, the pixels get two tries in all, worked or not (a click_at rarely fails, so counting failures left
  // them unbounded), and never a plan that selects all or deletes.
  const [act2] = guardTools([{ name: 'act_in_app', execute: async () => 'done.\nNow showing: Doc' }], { request: () => 1, goals: true });
  const [act3] = guardTools([{ name: 'act_in_app', execute: async (args) => { if (args.steps[0].do !== 'click_at') throw new Error('Step 1: no visible text "x" in Chrome.'); return 'done.\nNow showing: Doc'; } }], { request: () => 1, goals: true });
  const go3 = (steps) => act3.execute({ target: 'front', steps }, {}).then(() => 'ok', (e) => (e.message === STUCK_MESSAGE ? 'stuck' : e.message));
  for (const t of ['a', 'b', 'c']) await go3(ct(t));
  assert.deepEqual([await go3(at(1, 1)), await go3(at(1, 2)), await go3(at(1, 3))], ['ok', 'ok', 'stuck'], 'two click_at after stuck, even when they work');
  const [act4] = guardTools([{ name: 'act_in_app', execute: async (args) => { if (args.steps[0].do !== 'click_at') throw new Error('Step 1: no visible text "x" in Chrome.'); return 'done.\nNow showing: Doc'; } }], { request: () => 1, goals: true });
  const go4 = (steps) => act4.execute({ target: 'front', steps }, {}).then(() => 'ok', (e) => (e.message === STUCK_MESSAGE ? 'stuck' : e.message));
  for (const t of ['a', 'b', 'c']) await go4(ct(t));
  for (const k of ['cmd+a', 'Command + A', 'delete', 'backspace']) assert.equal(await go4([{ do: 'click_at', x: 1, y: 1 }, { do: 'key', key: k }, { do: 'type', text: 'x' }]), 'stuck', `no ${k} once stuck`);
  // Before stuck, a click that works still starts its goal over.
  assert.equal(await act2.execute({ target: 'front', steps: at(1, 1) }, {}), 'done.\nNow showing: Doc');
}

// v0.2.9 Live log (2026-11-27): reason "error" said nothing, so each failure's own words are logged too, with
// anything quoted (screen text, what was typed), web addresses, emails and paths taken out, at most 200 characters.
{
  const { state, call, lines } = setup();
  state.fail = 'Step 1: "What is my name?" appears 2 times on screen, so I didn\'t guess which. Take a screenshot and use click_at on the one you mean. See https://docs.google.com/x for eric@example.com in /Users/eric/Doc.txt ' + 'x'.repeat(300);
  await call('act_in_app', { target: 'browser', steps: [{ do: 'click_text', text: 'What is my name?' }] }, 'r1').catch(() => {});
  const out = lines.at(-1);
  assert.equal(out.reason, 'ambiguous');
  assert.match(out.error, /^Step 1: "…" appears 2 times on screen, so I didn't guess which\./);
  assert.ok(out.error.length <= 200, `${out.error.length} chars`);
  for (const w of ['What is my name', 'docs.google', 'eric@', '/Users/eric']) assert.ok(!JSON.stringify(lines).includes(w), `${w} is not logged`);
  // A tool that isn't a screen tool (run_command's errors hold command output) logs only the code.
  const [cmd] = guardTools([{ name: 'run_command', execute: async () => { throw new Error('ls: private-folder: No such file'); } }], { log: (k, d) => lines.push(d) });
  await cmd.execute({ command: 'ls' }, {}).catch(() => {});
  assert.equal(lines.at(-1).error, undefined);
}

// v0.2.9 Live log (02:37:05-02:37:12): a click_at whose screenshot was used up failed in 0 ms without running
// ("Take a new screenshot"), the model took one, the click_at failed for real, and the guard refused the next click_at
// as the pixels' second failure. A check that ran nothing isn't a try: it doesn't count toward the limits.
{
  const lines = [];
  let fail = null;
  const [act] = guardTools([{ name: 'act_in_app', execute: async () => { if (fail) throw fail; return 'done.\nNow showing: Doc'; } }], { log: (k, d) => lines.push(d), request: () => 1, goals: true });
  const go = (steps) => act.execute({ target: 'front', steps }, {}).then(() => 'ok', (e) => (e.message === STUCK_MESSAGE ? 'stuck' : 'failed'));
  const at = (x, y) => [{ do: 'click_at', x, y }, { do: 'type', text: 'hello' }];
  fail = Object.assign(new Error('Something was clicked or opened since that screenshot, so it may be out of date. Take a new screenshot.'), { ranNothing: true });
  assert.equal(await go(at(300, 100)), 'failed');
  assert.equal(lines.at(-1).reason, 'needs_look');
  fail = new Error('Step 2: typed, but the text field still shows "", so I stopped before the next step.');
  assert.equal(await go(at(300, 100)), 'failed');
  fail = null;
  assert.equal(await go(at(405, 193)), 'ok', 'one real failure of the pixels: the next click_at runs');
  // Checks that ran nothing don't add up to stuck either.
  const [act2] = guardTools([{ name: 'act_in_app', execute: async () => { throw Object.assign(new Error('Take a screenshot first, then give x, y in its pixels.'), { ranNothing: true }); } }], { request: () => 1, goals: true });
  for (let i = 0; i < 5; i++) await assert.rejects(act2.execute({ target: 'front', steps: [{ do: 'click_text', text: `t${i}` }] }, {}), /Take a screenshot first/);
}

// v0.2.9 Live log (02:38:21): three failed fills, then a plain Escape (closing whatever popped up) was refused as
// stuck. A plan of only harmless keys (escape) changes nothing anyone wanted: it always runs.
{
  const ran = [];
  const [act] = guardTools([{ name: 'act_in_app', execute: async (args) => { ran.push(args.steps[0].do); if (args.steps[0].do === 'click_text') throw new Error('Step 1: no visible text "x" in Chrome.'); return 'done.\nNow showing: Doc'; } }], { request: () => 1, goals: true });
  const go = (steps) => act.execute({ target: 'browser', steps }, {}).then(() => 'ok', (e) => (e.message === STUCK_MESSAGE ? 'stuck' : 'failed'));
  for (const t of ['a', 'b', 'c']) await go([{ do: 'click_text', text: t }]);
  assert.equal(await go([{ do: 'key', key: 'escape' }]), 'ok', 'escape runs once stuck');
  assert.equal(await go([{ do: 'key', key: 'Esc' }, { do: 'wait', seconds: 1 }]), 'ok', 'esc and a wait too');
  assert.equal(await go([{ do: 'key', key: 'escape' }, { do: 'key', key: 'return' }]), 'stuck', 'not with another key');
  assert.equal(await go([{ do: 'click_text', text: 'd' }]), 'stuck', 'and app steps stay refused');
}

// Review of #33: quotes inside the quoted text (a field showing 5' 11" tall) must not let the rest out, and the other
// spots where the user's own words sit unquoted are taken out too.
{
  const { errorText } = await import('../loopguard.mjs');
  const leaks = [
    ['Step 3: typed, but the text field still shows "5\' 11" tall secretword", so I stopped before the next step.', /^Step 3: typed, but the text field still shows "…"/],
    ['Step 1: no visible text "a "quoted" secretword" in Chrome.', /^Step 1: no visible text "…"/],
    ['Step 1: "say "hi" secretword" appears 2 times on screen, so I didn\'t guess which.', /^Step 1: "…"/],
    ['No button, label or heading reads "x" (it only appears inside longer text: "secretword one", "two"). Use the exact words shown on screen.', /^No button, label or heading reads "…"/],
    ['Step 2: only a "dangling secretword quote', /^Step 2: only a "…"$/],
    ['Blocked for safety: C:\\Users\\secretword\\file.txt is off limits.', /\[path\] is off limits/],
    ['Could not open secretword.example.com in time.', /Could not open \[domain\] in time/],
    ['No matching window is open for secretword.', /^No matching window is open for …\.$/],
    ['No matching window is open.', /^No matching window is open\.$/],
    ['Step 2: the password field shows 7 characters, not 9. Fill it again.', /^Step 2: the password field shows … Fill it again\.$/],
    ['Step 1: unknown key secretword', /^Step 1: unknown key …$/],
    ['Secretword said no, so I didn\'t click "x" (nothing after it ran either).', /^… said no, so I didn't click "…"/],
  ];
  for (const [msg, want] of leaks) {
    const out = errorText(msg);
    assert.match(out, want, `${msg} -> ${out}`);
    assert.ok(!/secretword|7 characters/i.test(out), `${msg} -> ${out}`);
  }
}

// Review of #33: a check that ran nothing is free only a few times a request (take_screenshot then a stale click_at,
// over and over, would otherwise never stop): after RAN_NOTHING_FREE of them, they count like any failure.
{
  const { RAN_NOTHING_FREE } = await import('../loopguard.mjs');
  assert.equal(RAN_NOTHING_FREE, 3);
  const [act] = guardTools([{ name: 'act_in_app', execute: async () => { throw Object.assign(new Error('Take a new screenshot.'), { ranNothing: true }); } }], { request: () => 1, goals: true });
  const go = (x) => act.execute({ target: 'front', steps: [{ do: 'click_at', x, y: 1 }] }, {}).then(() => 'ok', (e) => (e.message === STUCK_MESSAGE ? 'stuck' : 'failed'));
  const got = [];
  for (let i = 0; i < 6; i++) got.push(await go(i));
  assert.deepEqual(got, ['failed', 'failed', 'failed', 'failed', 'failed', 'stuck'], 'three free, then two count toward the click_at goal');
}

console.log('loop guard tests: passed');
