**English** · [简体中文](./docs/README.zh-CN.md)

# pi-task-status

Live progress chips in the Pi footer for **any background process** — it
just writes a JSON file. Any language, any machine, no Pi-side wiring.

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
created them: tool writes stamp `owner=<sessionId>` (creation paths only —
an existing un-stamped file is never adopted implicitly), and the footer
and watchdog consider **only this conversation's tasks**. Un-stamped
files (legacy writers, manual echoes) may belong to another conversation,
so they are not shown or watched here — but they are never silent: each
one is announced once with the claim recipe, and `/task-status` lists
everything (`[other]`, `[ownerless]`). Adopt with
`/task-status claim <id>` or the tool action `task_progress {action:"claim",
id}` — the owning conversation's agent can reclaim pre-upgrade tasks in one
call (bump/done results note un-attributed tasks with the claim recipe);
give back with `release <id>`.
`PI_TASK_SHOW_OWNERLESS=1` restores legacy display + exactly-one-session
claim-and-nudge; `PI_TASK_ISOLATION=0` disables isolation entirely.
Scripts keep ownership via `--owner` (CLI) or the `owner` JSON field
(recipe in the set result).

## Watchdog

A visible task that stops updating for `PI_TASK_WAKE_MIN` minutes (default
5) is nudged exactly **once per update-level**: the extension injects a
wake-up message into the session (`followUp`, queued behind a busy run,
never interrupts) telling the agent what stalled and how to close it out.
Progress re-arms the nudge. Stuck jobs surface themselves.

## Env

`PI_TASK_STATUS_DIR` · `PI_TASK_MAX` · `PI_TASK_REFRESH_MS` (floor 500 ms) ·
`PI_TASK_HIDE_MIN` · `PI_TASK_STALE_SEC` · `PI_TASK_WAKE` ("0" disables the
watchdog) · `PI_TASK_WAKE_MIN` · `PI_TASK_MAX_FILE_KB` · `PI_TASK_MAX_FILES` ·
`PI_TASK_ISOLATION`

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
pi install npm:pi-task-status
```

## Tests

```bash
npm test   # 93 assertions: tool roundtrip, watchdog lifecycle, anti-freeze,
           # env sanitization, zombie-proof exit, failure surfacing
```

## License

MIT — see [LICENSE](LICENSE).
