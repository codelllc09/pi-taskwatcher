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

Every queued notice (stale nudge, wake, autobg) stamps its build time —
local clock with an explicit UTC offset — because a queued message may reach
the agent long after it was built; the stamp lets it judge how stale the
"N min" figures in it really are.

Since v0.4.0 the nudge set is **all own tasks**, not only the rendered ones:
`PI_TASK_HIDE_MIN` fades the chip but never removes a task from the watchdog —
a task hung for 35 min is nudged just like one hung for 6 min (previously the
longer it hung, the quieter it got). Tasks stamped `kind:"bg"` are skipped:
`autobg` delivers their completion wake itself. Scripts that update status
files directly must read-modify-write (jq, or the CLI's `--owner`): a partial
overwrite silently drops `owner` and the task falls out of this
conversation's watchdog.

## Autobg (v0.4.0) — long-running tool calls never stall the agent

**bash auto-detach.** Commands run synchronously exactly like the built-in
tool. Past `PI_AUTOBG_DEMOTE_MS` (default 120 s) the process is **not killed**:
output switches to `~/.pi/agent/bg/<id>.log`, the tool returns immediately
with an explanation, and the model gets control back. On exit a `followUp`
message wakes it with the exit code, duration and output tail. A `kind:"bg"`
status file shows the footer chip. Esc still kills during the synchronous
phase; a detached task is independent.

The demote notice asks the model for a one-shot sanity check (it knows best
whether this command should have finished long ago), and a **stuck watch**
guards detached tasks: still running with no log growth for
`PI_AUTOBG_BG_STUCK_S` (default 30 min) → one check-up wake per silent
period (expected quiet runs are told to ignore it; stuck ones get the pid to
kill).

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

## Wake (v0.5.0) — one-shot alarms, set by you

The watchdog family wakes the agent on *conditions* (stalled task, hung
tool, exited bg command). `/wake` adds the missing axis: *time*,
chosen by the user. One-shot by design — no loop tax; the "is this wake
worth the tokens?" decision stays with the person who set it.

```text
/wake 30m check the build result      # relative: 30s|30m|2h
/wake 14:00 review the test run       # absolute HH:MM; tomorrow if past
/wake list                            # pending wakes
/wake cancel w1                       # cancel
```

`/wake` is the name since v0.5.1 — the bare verb fits both spec forms
("at" only matched the absolute one). The old `/wake-at` name was
removed outright: the package has no external users to carry.

Delivery uses the same follow-up channel as the stale nudge: an idle
agent wakes immediately, a busy one gets it queued — never interrupted;
the message carries a may-be-stale hint. An absolute time inside the
`PI_WAKE_MIN_S` floor window rolls to tomorrow (an alarm can never sneak
past the floor). Wakes are **session-scoped and in-memory**: they die with
the session (announced, never silently), and nothing touches disk.
Cross-session scheduling is cron's job — write a status file and let the
footer/nudge pick it up. Delays are floored at `PI_WAKE_MIN_S` (60 s) and
capped at 24 h; at most `PI_WAKE_MAX` (5) wakes pending per session.

## Env

`PI_TASK_STATUS_DIR` · `PI_TASK_MAX` · `PI_TASK_REFRESH_MS` (floor 500 ms) ·
`PI_TASK_HIDE_MIN` · `PI_TASK_STALE_SEC` · `PI_TASK_WAKE` ("0" disables the
watchdog) · `PI_TASK_WAKE_MIN` · `PI_TASK_MAX_FILE_KB` · `PI_TASK_MAX_FILES` ·
`PI_TASK_ISOLATION` · autobg: `PI_AUTOBG_DEMOTE_MS` · `PI_AUTOBG_STALL_S` ·
`PI_AUTOBG_ABORT_S` (0 disables) · `PI_AUTOBG_MAX_AUTO_ABORTS` ·
`PI_AUTOBG_NEVER_ABORT` (comma list) · `PI_AUTOBG_BG_STUCK_S` (bg stuck
watch, 0 disables) · `PI_AUTOBG_DIR` · wake: `PI_WAKE_MAX` (5) · `PI_WAKE_MIN_S`
(60)

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
npm test   # 199 assertions: tool roundtrip, watchdog lifecycle, anti-freeze,
           # env sanitization, zombie-proof exit, failure surfacing, wake
```

## License

MIT — see [LICENSE](LICENSE).
