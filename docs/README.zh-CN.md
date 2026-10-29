[English](../README.md) · **简体中文**

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
3 个任务（新的在前）。`/task-status` 列全部（含隐藏与问题文件）；
`/task-status clear` 清空。

## Agent 工具

扩展注册了 `task_progress` 工具（set/bump/done/remove），agent 可以自己
创建并驱动任务。`set` 的返回里嵌入脚本侧接线指南；系统提示还会加一条
准则，让 agent 在启动长任务前主动调用它——不需要你提醒。

## 对话隔离

状态目录是机器级全局的，但任务归属于创建它的对话：工具写入打上
`owner=<sessionId>`，footer 芯片与看门狗唤醒都限于"自己的 + 无主"任务；
无主的卡死任务在唤醒前先被恰好一个会话认领——不会跨对话重复唤醒。
`/task-status` 仍列出全部，外部对话的任务标 `[other]`。
`PI_TASK_ISOLATION=0` 关闭；脚本侧用 `--owner`（CLI）或 JSON 的 `owner`
字段保持归属（set 返回里有配方）。无主文件的行为与从前完全一致。

## 看门狗

可见任务超过 `PI_TASK_WAKE_MIN` 分钟（默认 5）无更新，会被唤醒**一次**（每个
进度级别仅一次）：扩展向会话注入唤醒消息（`followUp`，排队等待、绝不打断
正在跑的轮次），告诉 agent 什么任务卡住了、怎么处理。有真进展后重新武装。
卡住的任务自己会浮出水面。

## 环境变量

`PI_TASK_STATUS_DIR` · `PI_TASK_MAX` · `PI_TASK_REFRESH_MS`（下限 500ms）·
`PI_TASK_HIDE_MIN` · `PI_TASK_STALE_SEC` · `PI_TASK_WAKE`（"0" 关闭看门狗）·
`PI_TASK_WAKE_MIN` · `PI_TASK_MAX_FILE_KB` · `PI_TASK_MAX_FILES` · `PI_TASK_ISOLATION`

所有值都经消毒：垃圾值/零/负数回退到默认值，并在会话启动时报告被忽略的值。

## 保证

- **绝不阻塞** —— 全部文件访问异步；状态目录慢/巨大也不会卡住 TUI 事件循环
  （单文件大小上限 + 单轮文件数上限）。
- **绝不自旋、绝不泄漏** —— 自重排 unref 定时器；连续失败退避到 30 秒；
  泄漏的定时器永远不会拖住进程不退出。
- **绝不静默失败** —— 问题文件（持续损坏、超大、格式错误）被计数、公告一次、
  并列在 `/task-status`；刷新失败与看门狗投递失败会公告；无效环境变量会报告；
  CLI 误用（如 bump 不存在的任务）非零退出并带错误信息。

## 安装

```bash
pi install npm:pi-task-status
```

## 测试

```bash
npm test   # 77 项断言：工具往返、看门狗生命周期、防冻结、
           # 环境消毒、僵尸进程防护、失败暴露
```

## 许可证

MIT — 见 [LICENSE](../LICENSE)。
