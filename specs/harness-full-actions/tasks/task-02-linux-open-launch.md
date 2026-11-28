# Task 02: Linux `open`/`launch` treats a running launcher as success

## Status

complete

## Wave

1

## Description

On Linux (Omarchy/Hyprland), Yomna's `open` tool reported a failure after exactly 30 s (`tool_outcome {"name":"open","ok":false,"ms":30013,"reason":"error"}`), even though the app or page usually did open. The `launch()` helper in `tools.mjs` waits for the launcher (`xdg-open`, `gio launch`, `gtk-launch`) to **exit**. Some launchers stay attached to the app they start, for example when the browser wasn't already running. The helper then kills the launcher at 30 s and returns a timeout error, which makes Yomna look broken and wastes the user's time. This task makes a launcher that's still running after a short grace period count as success.

## Dependencies

**Depends on:** None (Wave 1)
**Blocks:** None

**Context from dependencies:** None.

## Files to Create

- `showcase/tauri/sidecar/test/launch.test.mjs`: unit tests for the new `launch()` behaviour.

## Files to Modify

- `showcase/tauri/sidecar/tools.mjs`: change `launch()` (around lines 114–124).

## Technical Details

### Current code (`tools.mjs`, around line 114)

```js
/** Runs a launcher (gio, gtk-launch, xdg-open) and resolves when it exits, like run(). Not when its output closes:
 *  the app it starts inherits that output and keeps it open for as long as it runs. */
export const launch = (cmd, args, timeout = 30_000) => new Promise((res) => {
  let p, stderr = '', done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(t); p?.stderr?.destroy(); res({ stdout: '', stderr, ...r }); };
  const t = setTimeout(() => { p?.kill(); finish({ err: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }); }, timeout);
  try { p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return finish({ err: e }); }
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', (e) => finish({ err: e }));
  p.on('exit', (code, signal) => finish({ err: code === 0 ? null : Object.assign(new Error(`exit ${code ?? signal}`), { code: code ?? signal }) }));
});
```

Callers: the `open` tool (around line 1145, `launch('xdg-open', [path or url])`) and `openLinuxApp()` (around line 131, `launch('gio', ['launch', file])`, falling back to `gtk-launch` on `ENOENT`). They check `r.err?.code === 'ENOENT'` and `r.err` / `r.stderr`.

### Implementation Steps

1. Add a `grace` parameter: `launch(cmd, args, { grace = 4_000 } = {})`. Keep backwards compatibility if anything passes a number as the 3rd arg. Grep for `launch(` in `showcase/tauri/sidecar` first.
2. Behaviour:
   - `error` event (e.g. `ENOENT`) → resolve `{ err }` right away, as today.
   - `exit` before `grace` → as today: `code === 0` is success, anything else is `err` with `stderr`.
   - Still running at `grace` → resolve **success** (`err: null`). Then **do not kill it**: call `p.unref()`, detach the stderr listener and destroy `p.stderr` so the sidecar doesn't hold the app. Spawn with `detached: true` so the app survives if the sidecar exits. Keep `stdio: ['ignore','ignore','pipe']`.
3. Update the doc comment to explain the grace rule.
4. Make `grace` configurable for tests, e.g. through the options object.

### Test (`test/launch.test.mjs`)

Use `node:test` + `node:assert/strict`, with `process.execPath` as the "launcher":
- `launch(process.execPath, ['-e', 'process.exit(0)'])` → `err` is null.
- `launch(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'])` → `err` is set, and `stderr` contains `boom`.
- `launch(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { grace: 200 })` → resolves in under 1 s with `err` null. Kill the leftover child afterwards if you can get its PID; otherwise use a script that exits on its own after about 2 s so the test runner doesn't hang.
- `launch('/nonexistent/launcher-xyz', [])` → `err.code === 'ENOENT'`.

Import with `import { launch } from '../tools.mjs';`. If importing `tools.mjs` has heavy side effects, check how `test/toolschema.test.mjs` imports it and copy that approach.

## Acceptance Criteria

- [ ] A launcher that's still running after the grace period resolves as success within about 4 s, and the app isn't killed.
- [ ] Fast failures (non-zero exit, `ENOENT`) still return errors with `stderr`, so "Unable to find application" handling keeps working.
- [ ] `test/launch.test.mjs` passes under `npm test`, and the whole suite stays green.

## Notes

- Only the Linux path uses `launch()`. macOS and Windows use `run('open', …)` / `winOpen`, so they're untouched.
