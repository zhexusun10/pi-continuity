# pi-continuity

**在不重放损坏协议状态、不注入隐藏提示词的前提下恢复 Pi 轮次。**

[English](../README.md) · [设计](design.md) · [研究与源码依据](evidence.md) · [源码](../extensions/index.ts)

## 为什么需要它？

设计动机来自论文 [Finding the Right Fit: Model–Harness Interactions across Agent Tasks](https://arxiv.org/html/2610.00917) 的 **Terminal-Bench 4.0** 分析：openJiuwen 在输出上限后恢复了 **100 个 run**，其中 **48 个后来获得非零 reward**；人工检查的 **6 个 matched pair 中，2 个的恢复机制是决定性因素**。同一分析记录 Kimi 在 PI 的 62 个 TB4 run 中有 **25 个 provider stream failure**。

这些是论文的观测，不是本扩展的成功率。仓库的确定性测试只验证控制流和包加载；详见[研究与源码依据](evidence.md)。

## 安装

```bash
pi install npm:pi-continuity
```

npm 包 **pi-continuity** 支持 **Pi 1.5.2**；本源码构建版本为 **0.5.0**。

也可以通过 GitHub 安装：

```bash
pi install git:github.com/zhexusun10/pi-continuity
```

安装后重新启动 Pi，或执行 `/reload`。需要具有可操作 session boundary 的 **Pi 1.0.1+** 和 Node.js 22.19+；当前开发依赖固定为 **Pi 1.5.2**。适用于 Pi CLI，以及正确加载并绑定扩展的 `AgentSession` SDK 程序。扩展不修改 Pi 安装、不直接访问 provider、不安装运行时依赖。

## 恢复策略

| 场景 | 处理 |
| --- | --- |
| `stopReason: "length"`：文字、纯思考、空输出或工具调用 | 省略中断 assistant 和相关合成工具结果，在 `turn_end` 请求下一轮。 |
| stream 失败，包括 `terminated` / `TypeError: terminated` | 等待后先让原生 retry 处理；耗尽后才安排有预算的 fallback。 |
| `Error: {"detail":"Bad Request"}`、空错误信息及未知错误 | 默认最多额外恢复 **2 次**，同时占用 stream 和总预算；先排除明确终态原因。 |
| 明确 cooldown / 重试时间 | 等待指定时长，再交给原生 retry 或 settlement fallback。 |
| 用量限额没有有效重置时间 | 每 10 分钟轮询，首个窗口最多 5 小时 / 30 次；某个窗口放弃后，后续窗口为 5 小时 20 分 / 32 次。 |
| 成功但为空，或只有思考、没有可见回答/工具调用 | 使用 stream 共享预算恢复。 |
| 工具结果已完成，但任务终止在工具调用 | 保留已完成的结果，在 settlement 请求下一轮，不重新执行工具。 |

**不注入 `Continue` user 文本、隐藏 checkpoint 或其他模型可见提示词。** 被中断响应中的文字、reasoning、工具参数和签名不会被复制到下一次请求；只追加 `context_edit` 投影省略、`continue: true` 决策和不进入模型上下文的 `custom` 计数元数据。已完成的历史回答和工具结果保留，原始 stop reason、失败、用量历史不改写。

Pi 核心保护截断工具参数，扩展不执行工具。普通工具轮次本来就会继续，不会额外安排恢复。正常文字结束、显式取消、认证/权限、安全拒绝及明确参数/证书等错误不盲目重试；输入上下文超限仍由 Pi compaction 处理。

所有扩展等待现在都在取消信号仍有效的 `turn_end` 进行，**settlement 不再等待**。Escape/SDK abort、关闭扩展和新输入会中断等待；直接排队的工作每秒检测。等待后原生 retry 仍优先，并可能再加它自己的 backoff，因此已知瞬时错误的延迟可能比单独运行 Pi 更长。

错误后已有排队输入时，扩展暂时保留 assistant 尾部供 Pi 选择输入，再在请求时省略其损坏协议，避免对旧任务多发一次请求；不会复制 partial 或注入隐藏指令。即使关闭恢复、总预算为零或参数校验失败，旧版本的 pi-continuity 提示词 artifacts 仍从模型上下文排除，原始历史不删除。

## Cooldown 与用量限额

支持错误中的 `cooldown`、`retry in/after`、`try again in/after`、`please wait`、`reset in` 等明确提示；支持 `:` / `：` / `=`、空格和大小写差异。

| 单位 | 支持写法 |
| --- | --- |
| 毫秒 | `ms`、`msec`、`msecs`、`millisecond(s)` |
| 秒 | `s`、`sec`、`secs`、`second(s)` |
| 分钟 | `m`、`min`、`mins`、`minute(s)`；常见误拼 `miutes`、`minuites`、`mintues` |
| 小时 | `h`、`hr`、`hrs`、`hour(s)` |
| 天 | `d`、`day(s)` |

例如：`cooldown: 12s`、`cooldown is 2miutes`、`cooldown: 0.25s`、`retry in 1h2min3s`、`retry after 1 hour, 2 minutes and 3 seconds`。小数时长向上取整到毫秒。

JSON 字段如 `retry_after`、`retryAfterMs`、`cooldown_seconds`、`retry_after_minutes`、`retryDelay: "3.5s"` 也支持：字段后缀决定纯数字的单位。`Retry-After: 120` / `retry_after: 120` 按秒解释；无单位的 `cooldown: 120` 不猜测。`Retry-After` 还支持 RFC 风格的 HTTP 日期。

若出现多个有效提示，取最长等待。`~`、`≈`、`about`、`approximately` 增加最小已声明单位的一半作为取整余量：`~2 min` 加 30 秒，`~2 s` 加 500 毫秒；保留原先 Codex `Try again in ~N min.` 的 30 秒余量。负数、NaN/Infinity、不安全数值、科学计数法、损坏的组合和月份等不支持的单位不解析，也不把 timeout、请求 ID 或普通输出中的数字当重试时间。

明确时间的恢复计入总预算，不占 stream 子预算，也不被 10 秒 stream 上限截短。只有已识别的用量限额缺少有效时间时，才走有界 10 分钟轮询；轮询有独立窗口，不占总恢复次数。`--continuity=false` 或 `--continuity-max-resumes=0` 关闭这两条路径。认证、安全和上下文错误不会因 cooldown 提示而恢复；无有效时间提示的 billing/quota 耗尽保持终态。

保持 Pi 运行；重启/reload 不恢复计时器。`/pi-continuity status` 显示剩余时间和轮询进度。

## 控制项

```text
/pi-continuity [status|on|off]
```

状态不打印 partial 内容。参数校验失败后，`on` 不能绕过保护；必须修正配置再 reload。关闭恢复不删除历史，也不修改 Pi 原生 retry 设置。

| 参数 | 默认值 | 含义 |
| --- | ---: | --- |
| `--continuity` | `true` | 显式 `--continuity=false` 关闭恢复。 |
| `--continuity-max-resumes` | `16` | 每条真实用户请求的总恢复上限；`0` 关闭，`unlimited` 移除总上限。 |
| `--continuity-stream-retries` | `12` | stream/空响应/未知错误共享子上限；默认前 3 次 5 秒，其后 9 次 10 秒。 |
| `--continuity-unknown-retries` | `2` | 未诊断错误的独立子上限，仍受 stream/总预算约束；`0` 禁用此兜底。 |
| `--continuity-stream-delay-ms` | `5000` | live boundary 的基础等待；后续阶段用 2 倍，最多 10 秒。 |
| `--continuity-checkpoint-max-chars` | `12000` | **弃用的 no-op**，不注入提示词；仍保留旧 `64000` 上限校验以兼容脚本。 |
| `--continuity-tool-tail` | `true` | 故意使用 terminal/handoff 工具结束时可设为 `false`。 |

```bash
pi --continuity-max-resumes 20 --continuity-stream-retries 12
pi --continuity-stream-delay-ms 5000
pi --continuity-tool-tail=false
```

预算按真实新用户请求重置，不按原生 retry 的每次 `agent_start` 重置。它们不限制原生/provider 内部 retry、正常工具循环或嵌套请求，不是全局费用预算；无人值守仍须设置 harness 总时间和调用/token 上限。

## 集成与限制

- CLI 的 TUI、RPC、JSON、print 模式正常安装即可。
- SDK 必须在接收任务的同一个 `AgentSession` 加载扩展并调用 `session.bindExtensions(...)`；等待 `session.prompt()` 完成或 `agent_settled`，不能把第一个 `agent_end` 当最终结束。
- 裸 `pi-agent-core` 的 `Agent` / `agentLoop()` 不自动加载本扩展，需要额外 adapter。
- 恢复是新的模型请求，不恢复 provider decoder 状态，不保证正确性或不重复操作。
- 被杀进程、永不结束的 stream/工具、provider 未暴露的内容及耗尽的 credits 无法由本扩展修复。
- 原始历史仍可能敏感；其他扩展可覆盖 boundary/context 决策，加载顺序是组合边界。

## 开发与更新

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:load
npm pack --dry-run
pi -e .
```

测试使用真实 Pi **1.5.2** `AgentSession` 和内存 faux provider，不调用真实模型、不需要 API key、不产生付费请求。图片/动画是机制 storyboard，不是 TUI 录屏或模型 benchmark；见 [assets.md](assets.md)。

```bash
pi update npm:pi-continuity
pi remove npm:pi-continuity
# GitHub 安装：
pi update git:github.com/zhexusun10/pi-continuity
pi remove git:github.com/zhexusun10/pi-continuity
```

之后重新启动或 `/reload`。移除扩展不会删除已有 session entries。协作和发布流程见 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [releasing.md](releasing.md)。

## License

MIT；独立社区 package，并非 Pi 官方产品。
