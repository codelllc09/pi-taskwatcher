#!/usr/bin/env python3
"""task_status.py — generic task-progress writer (companion to the pi-taskwatcher Pi extension)

Design: any background job (transcription, downloads, batch conversion, …)
calls this script periodically and the Pi TUI footer shows live progress
chips. No extension code changes required.

Subcommands
-----------
  set     write / update progress
  bump    done += N (the common case: call once per completed unit)
  done    mark complete (done = total)
  rm      remove the status (task finished / abandoned)
  ls      list all statuses

Examples
--------
  # after each audio file is transcribed:
  task_status.py bump --id asr-batch --label "Transcribe" --total 153

  # with a note:
  task_status.py set --id asr --label "Transcribe" --done 16 --total 153 --note "RTF 0.06 3.4h left"

  # count from a done-file (JSON dict; dict values may carry an ok flag):
  task_status.py sync --id asr --label "Transcribe" --total 153 --done-file out/_done.json

  # finish:
  task_status.py done --id asr

Status file format (~/.pi/agent/status/<id>.json):
  {"id","label","done","total","note","updated"}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

STATUS_DIR = os.environ.get("PI_TASK_STATUS_DIR") or os.path.expanduser("~/.pi/agent/status")


def _path(task_id: str) -> str:
    return os.path.join(STATUS_DIR, task_id + ".json")


def _read(task_id: str) -> dict:
    try:
        with open(_path(task_id), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _write(task_id: str, data: dict) -> None:
    os.makedirs(STATUS_DIR, exist_ok=True)
    data["id"] = task_id
    data["updated"] = int(time.time())
    tmp = _path(task_id) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, _path(task_id))  # atomic replace: readers never see partial JSON


def _fmt(data: dict, unit: str = "") -> str:
    done = data.get("done", 0)
    total = data.get("total", 0)
    pct = round(done / total * 100) if total else 0
    mark = "✓" if total and done >= total else "◆"
    note = f" · {data['note']}" if data.get("note") else ""
    return f"{mark} {data.get('label', data.get('id'))} {done}/{total}{unit} {pct}%{note}"


def cmd_set(a) -> int:
    d = _read(a.id)
    d["label"] = a.label or d.get("label") or a.id
    d["total"] = a.total if a.total is not None else d.get("total", 0)
    d["done"] = a.done if a.done is not None else d.get("done", 0)
    if a.note is not None:
        d["note"] = a.note
    if a.unit:
        d["unit"] = a.unit
    if getattr(a, 'owner', None) and not d.get('owner'):
        d['owner'] = a.owner
    _write(a.id, d)
    if not a.quiet:
        print(_fmt(d, d.get("unit", "")))
    return 0


def cmd_bump(a) -> int:
    d = _read(a.id)
    if not d:
        if a.total is not None:
            d = {"label": a.label or a.id, "total": a.total, "done": 0}
        else:
            print(
                f"no such task: {a.id} "
                "(bump needs an existing task, or pass --total to create it)",
                file=sys.stderr,
            )
            return 1
    if a.label:
        d["label"] = a.label
    if a.total is not None:
        d["total"] = a.total
    d["done"] = int(d.get("done", 0)) + (a.by or 1)
    if a.note is not None:
        d["note"] = a.note
    if a.unit:
        d["unit"] = a.unit
    if getattr(a, 'owner', None) and not d.get('owner'):
        d['owner'] = a.owner
    _write(a.id, d)
    if not a.quiet:
        print(_fmt(d, d.get("unit", "")))
    return 0


def cmd_done(a) -> int:
    d = _read(a.id)
    if not d:
        print(f"no such task: {a.id}", file=sys.stderr)
        return 1
    d["done"] = int(d.get("total", 0))
    if a.note is not None:
        d["note"] = a.note
    if getattr(a, 'owner', None) and not d.get('owner'):
        d['owner'] = a.owner
    _write(a.id, d)
    if not a.quiet:
        print(_fmt(d, d.get("unit", "")))
    return 0


def cmd_sync(a) -> int:
    """Count progress from a done-file. The file must be a JSON object (dict);
    if values are dicts with an ok field, only ok=true entries count
    (unless --only-ok is omitted, in which case all keys count)."""
    try:
        with open(os.path.expanduser(a.done_file), encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as e:
        print(f"cannot read done-file: {e}", file=sys.stderr)
        return 1
    if isinstance(raw, dict):
        items = raw.values()
        if a.only_ok:
            n = sum(1 for v in items if isinstance(v, dict) and v.get("ok"))
        else:
            n = len(raw)
    elif isinstance(raw, list):
        n = len(raw)
    else:
        print("done-file must be a JSON object or array", file=sys.stderr)
        return 1
    d = _read(a.id)
    d["label"] = a.label or d.get("label") or a.id
    d["total"] = a.total if a.total is not None else d.get("total", n)
    d["done"] = n
    if a.note is not None:
        d["note"] = a.note
    if a.unit:
        d["unit"] = a.unit
    _write(a.id, d)
    if not a.quiet:
        print(_fmt(d, d.get("unit", "")))
    return 0


def cmd_rm(a) -> int:
    try:
        os.unlink(_path(a.id))
        print(f"removed {a.id}")
    except FileNotFoundError:
        print(f"no such task: {a.id}", file=sys.stderr)
        return 1
    return 0


def cmd_ls(a) -> int:
    if not os.path.isdir(STATUS_DIR):
        print("(no status dir)")
        return 0
    names = sorted(n for n in os.listdir(STATUS_DIR) if n.endswith(".json"))
    if not names:
        print("(empty)")
        return 0
    now = int(time.time())
    for n in names:
        d = _read(n[:-5])
        if not d:
            continue
        age = now - int(d.get("updated", now))
        flag = " [stale]" if age > 180 and d.get("done", 0) < d.get("total", 0) else ""
        print(f"{_fmt(d, d.get('unit', ''))}{flag}  ({age}s ago)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Generic task-progress writer (pairs with taskwatcher.ts)")
    ap.add_argument("--status-dir", help="override the status dir (default ~/.pi/agent/status)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--id", required=True, help="unique task id (file name)")
        p.add_argument("--label", help="footer display name")
        p.add_argument("--total", type=int, help="total units")
        p.add_argument("--note", help="extra info (≤24 chars advised)")
        p.add_argument("--unit", help="unit, e.g. lec/posts/MB (listing only)")
        p.add_argument("--owner", help="owning session id (conversation isolation; absent = ownerless)")
        p.add_argument("-q", "--quiet", action="store_true", help="no output")

    p = sub.add_parser("set", help="write/update progress")
    common(p)
    p.add_argument("--done", type=int)
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("bump", help="done += N (default +1)")
    common(p)
    p.add_argument("--by", type=int, default=1)
    p.set_defaults(func=cmd_bump)

    p = sub.add_parser("done", help="mark complete")
    common(p)
    p.set_defaults(func=cmd_done)

    p = sub.add_parser("sync", help="count progress from a done-file")
    common(p)
    p.add_argument("--done-file", required=True)
    p.add_argument("--only-ok", action="store_true", help="count only entries whose value is {ok:true}")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("rm", help="remove the status")
    p.add_argument("--id", required=True)
    p.set_defaults(func=cmd_rm)

    p = sub.add_parser("ls", help="list all statuses")
    p.set_defaults(func=cmd_ls)

    a = ap.parse_args()
    if a.status_dir:
        global STATUS_DIR
        STATUS_DIR = os.path.expanduser(a.status_dir)
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
