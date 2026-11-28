# Task 03: Plumb `skipAllow` into every harness `send()` call

## Status

complete

## Wave

1

## Description

Yomna has two user toggles: "Allow File Edits & Commands" (`config.allowActions`) and "Skip Allow prompts" (`config.skipAllow`). Only `allowActions` reaches the CLI harness adapters. `skipAllow` is used inside Yomna's own tool layer but never passed to `agy` or `claude`, so the harness can't run in full-auto mode. This task passes a new `skipAllow` option into every `harnessManager.send()` call, for the main sidecar and for background agents. A later task (task-04) maps it to CLI flags. Passing the extra option is harmless before task-04 lands, because adapters ignore unknown options.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** task-04-harness-full-auto-flags.md

**Context from dependencies:** None.

## Files to Create

None.

## Files to Modify

- `showcase/tauri/sidecar/sidekick.mjs`: pass `skipAllow` at both `harnessManager.send` call sites, and include it in the background-agent toggle broadcast.
- `showcase/tauri/sidecar/agents.mjs`: include `skip` in the agent `start` payload and in `setAllow` broadcasts.
- `showcase/tauri/sidecar/agentrun.mjs`: track `skip` and pass `skipAllow` to `harnessMgr.send`.
- `showcase/tauri/sidecar/test/agents.test.mjs` (or `test/agentrun.test.mjs`, whichever already covers the start payload or `setAllow`): add an assertion.

## Technical Details

### Definition

`skipAllow` is effective **only when `allowActions` is also on**. The existing code already does this: `skipAllow: () => !!config.allowActions && !!config.skipAllow` (sidekick.mjs lines 461, 508, 518). Use the same expression everywhere.

### Implementation Steps

1. **`sidekick.mjs`**
   - Line ~1097 (Gemini Live `onDelegate` → `harnessManager.send({... allowActions: !!config.allowActions, signal: ac.signal })`): add `skipAllow: !!config.allowActions && !!config.skipAllow,`.
   - Line ~1230 (classic `prompt()` → `harnessManager.send({... allowActions: !!config.allowActions, images, signal: ctl.signal })`): add the same line.
   - Calls like `agents.setAllow(config.allowActions)` (lines ~2262, ~2267, ~2530): change the call to `agents.setAllow(config.allowActions, !!config.allowActions && !!config.skipAllow)`. Also find where `config.skipAllow` is toggled (`grep -n "skipAllow" sidekick.mjs`, e.g. a `set_skip_allow` handler) and call `agents.setAllow(...)` there with both values so running agents pick it up live.
   - Leave `brain.mjs` alone (its memory `oneShot` stays `allowActions: false`).
2. **`agents.mjs`**
   - Line ~377 `spawn(a, { t: 'start', agent: { …, allow: config.allowActions(), … } })`: add `skip: !!config.skipAllow?.()` to the agent object.
   - Line ~588: `setAllow: (on, skip = false) => { for (const p of procs.values()) if (p.child.connected) p.child.send({ t: 'allow', on: !!on, skip: !!on && !!skip }); },`
3. **`agentrun.mjs`**
   - Line ~33: `let allow = true, skip = false, agent = null, …`
   - Line ~45: `else if (m?.t === 'allow') { allow = !!m.on; skip = !!m.on && !!m.skip; }`
   - Line ~67 in `run()`: after `allow = a.allow !== false;`, add `skip = allow && a.skip === true;`
   - Line ~140 `harnessMgr.send({ … allowActions: allow, signal: ctl.signal })`: add `skipAllow: allow && skip,`.
4. **Test.** Add one assertion that `setAllow(true, true)` sends `{ t:'allow', on:true, skip:true }` and `setAllow(false, true)` sends `skip:false`. Look in `test/agents.test.mjs` for how procs/children are faked. If that's impractical, assert that the `start` payload includes `skip`.

## Acceptance Criteria

- [ ] Both `harnessManager.send` calls in `sidekick.mjs` pass `skipAllow` (true only when both toggles are on).
- [ ] Background agents get `skip` at start and on every toggle change, and pass `skipAllow` to `harnessMgr.send`.
- [ ] `skipAllow` is never true when `allowActions` is false.
- [ ] `npm test` passes.

## Notes

- Don't edit anything under `harnesses/`. Task-01 and task-04 own those files.
