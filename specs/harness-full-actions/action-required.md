# Action Required: Harness Full Actions

These steps need a human and can't be automated.

## Before Implementation

- [ ] **Back up `~/.gemini/config/mcp_config.json`.** Task-01 makes Yomna register `yomna-desktop` there with `agy mcp add`, and your `browseros-neo` entry lives in the same file.

## During Implementation

- [ ] **Check that `agy` passes its env to MCP children (task-01).** Run `agy mcp add envprobe node -e "require('fs').writeFileSync('/tmp/opencode/envprobe.txt', String(process.env.YOMNA_MCP_SOCKET))"`, then `YOMNA_MCP_SOCKET=hello agy -p "list your tools"`, then `cat /tmp/opencode/envprobe.txt`. If it prints `hello`, the env approach works. Otherwise tell the implementer to use the `-e` fallback. Clean up with `agy mcp remove envprobe`.

## After Implementation

- [ ] **Rebuild and restart Yomna:** `cd showcase/tauri && ./build.sh dev`, then relaunch the app.
- [ ] **Smoke test on agy:** ask Yomna "create a file ~/yomna-test.txt with hello in it" and "open github.com". Both should actually happen.
- [ ] **Check the log:** `grep -E 'mcpServers|tool_outcome' ~/Yomna/Data/logs/$(date +%F).log` should show no `unknown setting "mcpServers"` errors.
- [ ] **Check your normal agy use:** run plain `agy` in a terminal while Yomna is closed. `yomna-desktop` should show up with no tools and no error spam.

---

> These steps are also mentioned in the relevant task files.
