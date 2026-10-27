[English](./README.md) · **简体中文**

# pi-task-status

在 pi 底栏实时显示**任意外部进程**的进度——进程只需写一个 JSON 文件。
任何语言、任何机器、无需 pi 侧任何配置。

```
✓ Convert 153/153 100%   ◆ Transcribe 16/153 10% · 3.4h left
```

## 约定

`~/.pi/agent/status/<id>.json`，每 5 秒轮询。建议原子写（临时文件 + rename）；
半截 JSON 会被容错跳过。

```json
{"id":"asr","label":"Transcribe","done":16,"total":153,"note":"3.4h left","updated":1761234567}
```

```bash
echo '{"id":"x","label":"L","done":1,"total":10,"updated":'$(date +%s)'}' \
  > ~/.pi/agent/status/x.json
```

## CLI

`scripts/task_status.py` 封装以上约定：

```bash
task_status.py bump --id asr --label Transcribe --total 153   # 每单元 +1
task_status.py set  --id asr --done 16 --total 153 --note "剩3.4h"
task_status.py sync --id asr --total 153 --done-file out/_done.json
task_status.py done --id asr      # 还有：rm / ls
```

## 规则

`✓` 完成 · `◆` 进行中 · 180 秒无更新标 `stale` · 30 分钟无更新隐藏 · 最多
3 个任务（新的在前）。`/task-status` 列全部；`/task-status clear` 清空。

## 环境变量

`PI_TASK_STATUS_DIR` · `PI_TASK_MAX` · `PI_TASK_REFRESH_MS` ·
`PI_TASK_HIDE_MIN` · `PI_TASK_STALE_SEC`

## 安装

```bash
pi install git:github.com/codelllc09/pi-task-status
```

## 许可证

0BSD — 随便用，不用署名。
