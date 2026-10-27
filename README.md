**English** · [简体中文](./README.zh-CN.md)

# pi-task-status

Show **any background process's progress** as live chips in the Pi footer —
transcription batches, downloads, crawlers, training jobs. The process does
not need to be a Pi task, a child process, or even on the same machine: it
just writes a tiny JSON file.

```
✓ Convert batch 153/153 100%    ◆ Transcribe 16/153 10% · RTF 0.06 · 3.4h left
```

Existing Pi background-task extensions manage tasks Pi spawns itself. This
one is the opposite direction: **your own scripts report in**, through a
language-agnostic file convention.

## How it works

1. Your process writes `~/.pi/agent/status/<id>.json`:

```json
{
  "id": "asr-batch",
  "label": "Transcribe",
  "done": 16,
  "total": 153,
  "note": "RTF 0.06 · 3.4h left",
  "updated": 1761234567
}
```

2. The extension polls the directory and renders up to 3 chips in the
   footer (any footer that shows `setStatus` chips works — the built-in one,
   pi-cc-extensions, etc.)

Direct writes are fine from anything:

```python
# python
json.dump({"id": "crawl", "label": "Crawl", "done": n, "total": total,
           "updated": int(time.time())},
          open(f"{STATUS_DIR}/crawl.json", "w"))
```

```bash
# shell
echo '{"id":"crawl","label":"Crawl","done":1,"total":10,"updated":'$(date +%s)'}' \
  > ~/.pi/agent/status/crawl.json
```

Atomic writes (tmp + rename) are recommended; partial JSON is tolerated.

## Companion CLI

`scripts/task_status.py` wraps the convention:

```bash
task_status.py bump --id asr --label Transcribe --total 153   # +1 per unit
task_status.py set  --id asr --done 16 --total 153 --note "3.4h left"
task_status.py sync --id asr --total 153 --done-file out/_done.json  # count from a file
task_status.py done --id asr
task_status.py rm   --id asr
task_status.py ls
```

## Rendering rules

| State | Marker |
|---|---|
| done ≥ total | `✓` green |
| in progress | `◆` accent |
| no update > 180 s and not done | ` · stale` yellow |
| no update > 30 min | hidden |

`/task-status` lists everything (including hidden); `/task-status clear`
deletes all status files.

## Configuration

| Env | Default |
|---|---|
| `PI_TASK_STATUS_DIR` | `~/.pi/agent/status` |
| `PI_TASK_MAX` | `3` |
| `PI_TASK_REFRESH_MS` | `5000` |
| `PI_TASK_HIDE_MIN` | `30` |
| `PI_TASK_STALE_SEC` | `180` |

## Install

```bash
pi install git:github.com/codelllc09/pi-task-status
```

## License

0BSD — do whatever you want, no attribution required.
