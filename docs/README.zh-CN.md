[English](../README.md) · **简体中文**

# pi-taskwatcher

在 pi 底栏实时显示**任意外部进程**的进度，任务卡住时看门狗还会主动
提醒 agent。进程只需写一个 JSON 文件；任何语言、任何机器、无需 pi
侧任何配置。

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

状态目录机器级全局，但任务归属创建它的对话：工具写入打上
`owner=<sessionId>`（只在创建路径盖章——绝不隐式收养），footer 与
看门狗**只看本对话的任务**。未标记文件（旧代码写的）这里不显示、
不唤醒，但绝不静默：**活着的**首次出现公告一次并附认领方法
（`/task-status claim <id>` 或 `task_progress {action:"claim"}`）；
已结束或早已过期的“幽灵”不公告，只在 `/task-status` 列为
`[ownerless]`（清理：`task_progress {action:"remove"}`）。
`PI_TASK_SHOW_OWNERLESS=1` 恢复旧行为；`PI_TASK_ISOLATION=0` 彻底关闭
隔离。脚本侧用 `--owner`（CLI）或 JSON 的 `owner` 字段保持归属。

## 看门狗

可见任务超过 `PI_TASK_WAKE_MIN` 分钟（默认 5）无更新，会被唤醒**一次**（每个
进度级别仅一次）：扩展向会话注入唤醒消息（`followUp`，排队等待、绝不打断
正在跑的轮次），告诉 agent 什么任务卡住了、怎么处理。有真进展后重新武装。
卡住的任务自己会浮出水面。

每条排队通知（stale 唤醒、wake、autobg）都携带构建时刻的时间戳
（本地时钟 + 显式 UTC 偏移）：排队消息可能延迟很久才送达，时间戳
让 agent 能判断消息里“N 分钟无进展”这类数字到底有多旧。

排队通知的投递方式由 Pi 的 `followUpMode` 控制，默认 `"one-at-a-time"`
逐条投递：三个任务完成就是三次独立唤醒、各自触发一轮响应。若想合并
投递，在 `~/.pi/agent/settings.json` 里设置 `"followUpMode": "all"`——
它是 `steeringMode` 的姊妹设置：后者只管插话（steer），管不到这些
followUp 消息。

自 v0.4.0 起唤醒集是**全部本会话任务**，不再只是渲染集中的：
`PI_TASK_HIDE_MIN` 只淡出 chip，绝不把任务移出唤醒候选——挂了 35 分钟的
任务和挂了 6 分钟的一样会被提醒（旧行为：挂得越久越没人提醒）。
`kind:"bg"` 任务跳过 stale 唤醒：autobg 自带完成唤醒。脚本若直写状态
文件，必须读-改-写（`jq` 或 CLI 的 `--owner`）：部分覆盖式直写会静默
丢 `owner`，任务随即从本会话的看门狗里消失。

## Autobg（v0.4.0）— 长跑工具调用不再卡死 agent

**bash 自动降级。** 命令照常同步执行；超过 `PI_AUTOBG_DEMOTE_MS`（默认
120 秒）**进程不杀**，输出转写 `~/.pi/agent/bg/<id>.log`，工具立即返回
说明，模型拿回控制权；结束时 `followUp` 消息唤醒模型（exit code + 用时 +
日志尾部），footer 同步显示 `kind:"bg"` 状态 chip。同步期 Esc 照杀进程树；
降级后任务独立。

降级通知会让模型做一次性质核查（它最清楚这条命令本该早就跑完），另有
**卡死观察**守着降级任务：仍在跑且日志 `PI_AUTOBG_BG_STUCK_S`（默认
30 分钟）无增长 → 每个静默期一次检查唤醒（预期的安静长跑被告知忽略；
真卡死的拿到 pid 可杀）。

**通用静默观察（MCP 工具、其他扩展）。** 只有 bash 有执行层接缝，其他工具
挂死只能"检测+解脱"：静默 `PI_AUTOBG_STALL_S`（180 秒）→ 提示用户，并向模型
发 **steer** 插队提示——busy 的 agent 困在连环工具调用里时 followUp 要到
它彻底停下才投递，而 steer 在下一决策点之前送达；静默
`PI_AUTOBG_ABORT_S`（600 秒）→ 中止 run（被挂死工具阻塞的模型唯一的解脱
通道）并附说明让模型换法重试。静默提示按工具限预算
（`PI_AUTOBG_MAX_STALL_NOTES`，默认 2）：单次调用本就要几分钟的工具（如
单次长 VLM 请求）否则每次调用都会被重复教育——第二条提示附静默预告，
之后不再提示，自动中止保险丝始终在。静默过的调用结束时只有一种结局
追加消息：正常完成发一条简短"建议分步/后台化"回顾（followUp）；中止
有自己的说明，失败的结果本身就在上下文里。每工具自动中止上限（默认
2 次）防重试死循环；`PI_AUTOBG_NEVER_ABORT` 白名单豁免合法慢工具。未配
timeout 的 MCP server 开屏提醒——配了 timeout，挂死调用会自动返回错误
结果，模型可自行继续。

## Wake（v0.5.0）— 一次性闹钟，由你设定

看门狗家族都在**条件**触发（任务停滞、工具挂死、后台命令退出），`/wake`
补上缺的那根轴：**时间**，由用户指定。一次性设计——没有循环税；"这次唤醒值
不值这些 token"的判断权留给设闹钟的人。

```text
/wake 30m 检查构建结果        # 相对时间:30s|30m|2h
/wake 14:00 看看测试跑完没有  # 绝对 HH:MM;已过则明天
/wake list                    # 查看待触发列表
/wake cancel w1               # 取消
```

`/wake` 是 v0.5.1 起的名称——动词不带介词，两种时间格式都读得通
（"at" 只匹配绝对时刻形式）。旧名 `/wake-at` 已直接移除：
包没有需要兼容的外部用户。

投递走与 stale 唤醒相同的 followUp 通道：空闲立即唤醒，忙时排队——绝不
打断；消息自带"可能已过时"提示。落在 `PI_WAKE_MIN_S` 下限窗口内的绝对
时刻顺延到明天（闹钟永远绕不过下限）。闹钟**会话内、纯内存**：随会话结束作废
（会公告丢弃数，绝不静默），不落盘。跨会话调度是 cron 的活——写个状态
文件，footer/看门狗自会接手。延迟下限 `PI_WAKE_MIN_S`（60 秒）、上限 24
小时；每会话最多 `PI_WAKE_MAX`（5）个待触发闹钟。

## 环境变量

`PI_TASK_STATUS_DIR` · `PI_TASK_MAX` · `PI_TASK_REFRESH_MS`（下限 500ms）·
`PI_TASK_HIDE_MIN` · `PI_TASK_STALE_SEC` · `PI_TASK_WAKE`（"0" 关闭看门狗）·
`PI_TASK_WAKE_MIN` · `PI_TASK_MAX_FILE_KB` · `PI_TASK_MAX_FILES` · `PI_TASK_ISOLATION` · autobg: `PI_AUTOBG_DEMOTE_MS` · `PI_AUTOBG_STALL_S` · `PI_AUTOBG_ABORT_S`(0 关闭) · `PI_AUTOBG_MAX_AUTO_ABORTS` · `PI_AUTOBG_NEVER_ABORT`(逗号列表) · `PI_AUTOBG_MAX_STALL_NOTES`(每工具静默
提示预算，默认 2) · `PI_AUTOBG_BG_STUCK_S`(0 关闭) · `PI_AUTOBG_DIR` · wake: `PI_WAKE_MAX`(5) · `PI_WAKE_MIN_S`(60)

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
pi install npm:pi-taskwatcher
```

## 测试

```bash
npm test   # 199 项断言：工具往返、看门狗生命周期、防冻结、
           # 环境消毒、僵尸进程防护、失败暴露、wake 闹钟
```

## 许可证

MIT — 见 [LICENSE](../LICENSE)。
