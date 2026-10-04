# pi-continuity

**在不重放损坏协议状态的前提下恢复被打断的 Pi 轮次。**

[English](../README.md) · [设计](design.md) · [研究与源码依据](evidence.md) · [源码](../extensions/index.ts)

## 为什么需要它？

设计动机来自论文 [Finding the Right Fit: Model–Harness Interactions across Agent Tasks](https://arxiv.org/html/2610.00917) 的 **Terminal-Bench 4.0** benchmark 分析。论文 §5.1 记录：openJiuwen 在输出上限后恢复了 **100 个 run**，其中 **48 个后来获得非零 reward**；人工检查的 **6 个 matched pair 中，2 个的恢复机制是决定性因素**。同一分析还记录了 Kimi 在 PI 的 62 个 TB4 run 中有 **25 个 provider stream failure**，将部分问题归因于 harness resilience。

这些 benchmark 结果说明，输出边界不一定等于任务边界。pi-continuity 将这个问题落实为 session 策略：保留安全进展，让 Pi 原生 retry 先运行，并在仍可恢复时通过公开 boundary 请求下一次模型轮次。论文依据、固定版本源码和仓库验证见[研究与源码依据](evidence.md)。

## 安装

```bash
pi install npm:pi-continuity
```

也可以通过 GitHub 安装：

```bash
pi install git:github.com/zhexusun10/pi-continuity
```

安装后重新启动 Pi，或在当前会话执行 `/reload`。扩展不修改 Pi 文件、不直接访问 provider、不安装运行时依赖。

需要具有可操作 session boundary 的 **Pi 1.0.1+** 和 Node.js 22.19+。它适用于 Pi CLI，也适用于正确加载并绑定扩展的 `AgentSession` SDK 程序。

## 它解决什么问题？

| Pi 原本准备停止的情况 | pi-continuity 的处理 |
| --- | --- |
| `stopReason: "length"`：文字、纯思考、空输出、混合内容或工具调用 | 从下一次模型投影中移除不完整 assistant 协议；有可读进展时保存有界 partial，并在 `turn_end` 请求下一轮模型请求。 |
| provider stream 失败 | 先让 Pi 原生 session retry 处理；原生恢复耗尽后，移除失败 assistant，必要时保存有界 checkpoint，再按分段等待策略请求下一轮。 |
| 成功但为空的 assistant 输出 | 移除空 assistant，并使用 stream recovery 预算请求下一轮。 |
| 工具结果已经完成但任务停在 tool call | 保留已完成的 tool result，在 `agent_before_settle` 请求下一轮；不添加合成 user 指令，也不重复执行工具。 |

扩展使用 Pi 提供的公开 session boundary API：通过 `context_edit` 修复下一次模型请求的投影，通过 `continue: true` 让 `AgentSession` 发起下一轮。它不会为每次 retry 添加隐藏的 `Continue` user 文本。只有需要传递可读 partial 或说明中断工具未执行时，才添加隐藏 checkpoint。

普通工具调用本来就会让 Pi 继续。正常文字结束、显式取消、认证/权限/配额/billing 错误、安全拒绝和未知确定性错误不会被扩展自动重试；输入上下文超限仍由 Pi compaction 处理。

## 三种恢复路径

### Output truncation

扩展保留原始 session history，但用 `context_edit` 让不完整 assistant 和相关合成结果不再进入下一次模型请求。可读文字和未加密 reasoning 会被 JSON 引用为有界 checkpoint；工具参数、签名、response ID 和 redacted reasoning 不会复制。

Pi 核心负责保证截断 tool call 不会被执行。下一轮会知道中断工具没有执行，必要时必须重新生成完整参数。

### Stream recovery

Pi 原生 retry 在 `agent_before_settle` 之前运行。扩展在 `turn_end` 保存 partial checkpoint，使原生 retry 在省略失败 assistant 后仍能看到可读进展。原生 retry 耗尽后，扩展通过相同的公开 boundary 机制修复投影并请求下一轮。

默认额外 fallback 为 6 次：

```text
第 1～3 次：每次等待 5 秒
第 4～6 次：每次等待 10 秒
```

### Tool-call tail

如果最后一个有效 assistant 内容块是 tool call，且 Pi 已经准备结束，扩展保留完成的 tool result，直接请求下一轮模型。普通工具轮次不会额外触发这个逻辑。

对故意以结构化输出或 handoff 工具结束任务的场景，可以关闭：

```bash
pi --continuity-tool-tail=false
```

## 控制项

```text
/pi-continuity
/pi-continuity status
/pi-continuity off
/pi-continuity on
```

`status` 显示当前或上一条真实用户请求的恢复次数，不打印 partial 内容。开关作用于当前加载的 session；`/reload` 后恢复 CLI 默认值。

| 参数 | 默认 | 含义 |
| --- | ---: | --- |
| `--continuity` | `true` | `--continuity=false` 关闭扩展恢复。 |
| `--continuity-max-resumes` | `8` | 每条真实用户请求最多由扩展安排 8 次模型轮次。`0` 禁用；`unlimited` 移除总上限。 |
| `--continuity-stream-retries` | `6` | 原生 retry 之后最多补 6 次 stream/空响应恢复；默认 3 次 5 秒，再 3 次 10 秒。`0` 禁用 fallback。 |
| `--continuity-stream-delay-ms` | `5000` | stream/空响应额外恢复的基础等待毫秒数；第 1～3 次使用该值，之后使用 2 倍，最多 10 秒。 |
| `--continuity-checkpoint-max-chars` | `12000` | 活跃 checkpoint 中最多合并的可读 partial 字符数，硬上限 64000。`0` 不复制 partial 文本/思考。 |
| `--continuity-tool-tail` | `true` | 是否恢复停在 tool call 的任务。 |

布尔参数必须显式写值，例如 `--continuity=false`，不是 presence-only flag。

```bash
pi --continuity-max-resumes 12 --continuity-stream-retries 6
pi --continuity-stream-delay-ms 5000
pi --continuity-checkpoint-max-chars 8000
pi --continuity-tool-tail=false
```

这些预算按真实新用户请求重置，不按 Pi 原生 retry 的每次 `agent_start` 重置。它们只限制扩展安排的模型轮次，不限制 Pi 原生 retry、provider 内部 retry、正常工具循环或嵌套模型调用；无人值守运行仍需要 harness 层总时间、调用次数和 token 预算。

## CLI、SDK 与 agent-core 边界

| 使用方式 | 要求 |
| --- | --- |
| Pi CLI：TUI、RPC、JSON、print | 正常安装；Pi coding-agent runtime 会加载并绑定扩展。 |
| `AgentSession` SDK | 通过 resource loader 加载扩展，并在实际接收 prompt 的同一个 session 上调用 `session.bindExtensions(...)`。等待完整的 `session.prompt()` 或 `agent_settled`。 |
| 直接使用 `pi-agent-core` 的 `Agent` / `agentLoop()` | 本包不会自动挂接裸 core loop；需要额外 adapter 实现等价的 session 持久化与 boundary 行为。 |

`agent_end` 可能早于原生 retry、compaction、排队输入或扩展 fallback。需要最终结果的 harness 不能把第一个 `agent_end` 当作最终结束。

## 限制

- 每次恢复都是新的模型请求，不是 provider decoder 的 token 级恢复。
- 模型仍可能重复操作、遗漏上下文或错误停止；任务结果需要独立验证。
- 不同 provider 的错误文案不同。分类器覆盖 Pi 自带分类和常见 HTTP/传输错误，但对未知确定性错误保持保守。
- 进程被杀、永久挂起的 stream、无限阻塞的工具、provider 从未暴露的内容和耗尽的 credits 无法恢复。
- checkpoint 会由 Pi 持久化为模型上下文，session 文件可能包含可读 reasoning。
- 其他扩展可以替换 boundary drafts 或 continuation decision；扩展加载顺序是组合边界，尤其要注意脱敏扩展。

研究和源码依据见 [docs/evidence.md](evidence.md)。上面的 benchmark 数据来自论文的 Terminal-Bench 4.0 分析；仓库测试则验证本扩展的控制流和 package loading。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:load
npm pack --dry-run
pi -e .
```

测试使用真实 Pi `AgentSession` 和内存 faux provider，不调用真实模型、不需要 API key、不产生付费请求。测试覆盖截断形态、原生 retry 顺序、6 次 fallback、分段等待、取消、排队输入、上下文修复、工具安全和 package loading。

图片和动画是机制 storyboard，不是 TUI 录屏或模型 benchmark。生成方法见 [docs/assets.md](assets.md)。

## 更新与移除

```bash
pi update git:github.com/zhexusun10/pi-continuity
pi remove git:github.com/zhexusun10/pi-continuity
```

随后重启 Pi 或执行 `/reload`。移除扩展不会删除已经存在的 session entries。

仓库协作和发布流程见 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [docs/releasing.md](releasing.md)。

## License

MIT；独立社区 package，并非 Pi 官方产品。
