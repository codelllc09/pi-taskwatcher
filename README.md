**English** · [简体中文](./docs/README.zh-CN.md)

# pi-taskwatcher

Live progress chips in the Pi footer for **any background process** —
plus a watchdog that nudges the agent when a task stalls. Any language,
any machine, no Pi-side wiring: the job just writes a JSON file.

```
✓ Convert 153/153 100%   ◆ Transcribe 16/153 10% · 3.4h left
```

## Convention

`~/.pi/agent/status/<id>.json`, polled every 5 s. Atomic writes (tmp +
rename) recommended; partial JSON is tolerated.

```json
{"id":"asr","label":"Transcribe","done":16,"total":153,"note":"3.4h left","updated":1761234567}
```

```bash
echo '{"id":"x","label":"L","done":1,"total":10,"updated":'$(date +%s)'}' \
  > ~/.pi/agent/status/x.json
```

## CLI

`scripts/task_status.py` wraps the convention:

```bash
task_status.py bump --id asr --label Transcribe --total 153   # +1 per unit
task_status.py set  --id asr --done 16 --total 153 --note "3.4h left"
task_status.py sync --id asr --total 153 --done-file out/_done.json
task_status.py done --id asr      # or: rm / ls
```

## Rules

`✓` done · `◆` running · `stale` after 180 s silent · hidden after 30 min ·
max 3 chips (newest first). `/task-status` lists all (incl. hidden and
problem files); `/task-status clear` wipes.

## Agent tool

The extension registers a `task_progress` tool (set/bump/done/remove), so
the agent can create and drive tasks itself. The `set` result embeds the
script-side wiring recipe, and a system-prompt guideline makes the agent
reach for it before launching any long batch job — no user reminder needed.

## Conversation isolation

`STATUS_DIR` is machine-global, but tasks belong to the conversation that
created them: tool writes stamp `owner=<sessionId>` (creation only —
never adopted implicitly), and the footer and watchdog consider **only
this conversation's tasks**. Un-stamped files (legacy writers) are not
shown or watched here, but never silent: each *live* one is announced
once with the claim recipe (`/task-status claim <id>` or
`task_progress {action:"claim"}`); finished or aged-out ones — ghosts —
are not announced, just listed `[ownerless]` in `/task-status` (delete:
`task_progress {action:"remove"}`). `PI_TASK_SHOW_OWNERLESS=1` restores
legacy display; `PI_TASK_ISOLATION=0` disables isolation. Scripts keep
ownership via `--owner` (CLI) or the `owner` JSON field.

## Watchdog

A task owned by this conversation that stops updating for `PI_TASK_WAKE_MIN`
minutes (default 5) is nudged exactly **once per update-level**: the extension
injects a wake-up message into the session (`followUp`, queued behind a busy
run, never interrupts) telling the agent what stalled and how to close it out.
Progress re-arms the nudge. Stuck jobs surface themselves.

Since v0.4.0 the nudge set is **all own tasks**, not only the rendered ones:
`PI_TASK_HIDE_MIN` fades the chip but never removes a task from the watchdog —
a task hung for 35 min is nudged just like one hung for 6 min (previously the
longer it hung, the quieter it got). Tasks stamped `kind:"bg"` are skipped:
`autobg` delivers their completion wake itself.

## Autobg (v0.4.0) — long-running tool calls never stall the agent

**bash auto-detach.** Commands run synchronously exactly like the built-in
tool. Past `PI_AUTOBG_DEMOTE_MS` (default 120 s) the process is **not killed**:
output switches to `~/.pi/agent/bg/<id>.log`, the tool returns immediately
with an explanation, and the model gets control back. On exit a `followUp`
message wakes it with the exit code, duration and output tail. A `kind:"bg"`
status file shows the footer chip. Esc still kills during the synchronous
phase; a detached task is independent.

**Generic stall watch (MCP tools, other extensions).** Only bash exposes an
execution seam, so a hung non-bash tool is detected, not fixed: silent for
`PI_AUTOBG_STALL_S` (180 s) → the model is told (queued) and the user
informed; silent for `PI_AUTOBG_ABORT_S` (600 s) → the run is aborted — the
only channel that frees a model blocked on a hung tool — with an explanation
so it can retry differently. Per-tool cap `PI_AUTOBG_MAX_AUTO_ABORTS` (2)
prevents retry loops; `PI_AUTOBG_NEVER_ABORT` exempts legitimately slow
tools. MCP servers configured without a `timeout` are announced at startup:
with a timeout, a hung call returns an error result and the model continues
on its own.

## Env

`PI_TASK_STATUS_DIR` · `PI_TASK_MAX` · `PI_TASK_REFRESH_MS` (floor 500 ms) ·
`PI_TASK_HIDE_MIN` · `PI_TASK_STALE_SEC` · `PI_TASK_WAKE` ("0" disables the
watchdog) · `PI_TASK_WAKE_MIN` · `PI_TASK_MAX_FILE_KB` · `PI_TASK_MAX_FILES` ·
`PI_TASK_ISOLATION` · autobg: `PI_AUTOBG_DEMOTE_MS` · `PI_AUTOBG_STALL_S` ·
`PI_AUTOBG_ABORT_S` (0 disables) · `PI_AUTOBG_MAX_AUTO_ABORTS` ·
`PI_AUTOBG_NEVER_ABORT` (comma list) · `PI_AUTOBG_DIR`

All values are sanitized: garbage/zero/negative fall back to the default
and the ignored value is reported at session start.

## Guarantees

- **Never blocks** — all filesystem access is async; the TUI event loop
  stays responsive even on a slow or huge status dir (per-file size cap,
  per-tick file-count cap).
- **Never spins, never leaks** — self-rescheduling unref'd timer; repeated
  failures back off to 30 s; a leaked timer can never keep the process
  alive.
- **Never fails silently** — problem files (persistently corrupt,
  oversized, wrong schema) are counted, announced once, and listed by
  `/task-status`; refresh failures and watchdog delivery failures are
  announced; invalid env is reported; the CLI exits non-zero with a message
  on misuse (e.g. bumping an unknown task).

## Install

```bash
pi install npm:pi-taskwatcher
```

## Tests

```bash
npm test   # 140+ assertions: tool roundtrip, watchdog lifecycle, anti-freeze,
           # env sanitization, zombie-proof exit, failure surfacing
```

## License

MIT — see [LICENSE](LICENSE).
