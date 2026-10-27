[English](./README.md) · **简体中文**

# pi-task-status

把**任意外部进程的进度**显示为 pi 底栏的实时芯片——转写批任务、下载、爬虫、
训练任务都行。进程不需要是 pi 的任务、不需要是 pi 的子进程、甚至不需要在
同一台机器上：它只要写一个小 JSON 文件。

```
✓ Convert batch 153/153 100%    ◆ Transcribe 16/153 10% · RTF 0.06 · 3.4h left
```

现有的 pi 后台任务类扩展管理的都是「pi 自己派生的任务」；这个扩展方向相反：
**你自己的脚本往里汇报**，靠的是与语言无关的文件约定。

## 工作方式

1. 你的进程写 `~/.pi/agent/status/<id>.json`：

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

2. 扩展轮询该目录，在底栏渲染最多 3 个芯片（任何会显示 `setStatus` 芯片的
   底栏都兼容——内置底栏、pi-cc-extensions 等）

任何语言都能直接写：

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

推荐先写临时文件再 rename（原子写）；读到半截 JSON 会被容错跳过。

## 配套 CLI

`scripts/task_status.py` 封装了这套约定：

```bash
task_status.py bump --id asr --label Transcribe --total 153   # 每完成一个单元 +1
task_status.py set  --id asr --done 16 --total 153 --note "剩3.4h"
task_status.py sync --id asr --total 153 --done-file out/_done.json  # 从文件统计
task_status.py done --id asr
task_status.py rm   --id asr
task_status.py ls
```

## 显示规则

| 状态 | 标记 |
|---|---|
| done ≥ total | `✓` 绿色 |
| 进行中 | `◆` 强调色 |
| 超 180 秒未更新且未完成 | ` · stale` 黄色 |
| 超 30 分钟未更新 | 自动隐藏 |

`/task-status` 列出全部（含隐藏）；`/task-status clear` 清空所有状态文件。

## 配置

| 环境变量 | 默认值 |
|---|---|
| `PI_TASK_STATUS_DIR` | `~/.pi/agent/status` |
| `PI_TASK_MAX` | `3` |
| `PI_TASK_REFRESH_MS` | `5000` |
| `PI_TASK_HIDE_MIN` | `30` |
| `PI_TASK_STALE_SEC` | `180` |

## 安装

```bash
pi install git:github.com/codelllc09/pi-task-status
```

## 许可证

0BSD — 随便用，不用署名。
