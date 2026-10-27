**English** · [简体中文](./README.zh-CN.md)

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
max 3 chips (newest first). `/task-status` lists all; `/task-status clear`
wipes.

## Env

`PI_TASK_STATUS_DIR` · `PI_TASK_MAX` · `PI_TASK_REFRESH_MS` ·
`PI_TASK_HIDE_MIN` · `PI_TASK_STALE_SEC`

## Install

```bash
pi install npm:pi-task-status
```

## License

0BSD — do whatever you want, no attribution required.
