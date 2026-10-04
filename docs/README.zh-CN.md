# pi-continuity

**为 Pi 提供更健壮的 loop engineering。**

一轮输出结束，不等于任务完成。这个 extension 在截断和流错误后保留进展，并区分“工具调用完成”和“整个任务完成”，把恢复与停止变成明确的运行时策略。

[English](../README.md) · [研究依据](evidence.md) · [循环设计](design.md) · [源码](../extensions/index.ts)

## 为什么是 loop engineering？

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks，§5.1](https://arxiv.org/html/2610.00917#S5.SS1) 指出，**harness 如何返回失败、恢复中断和决定停止**，会影响 model–harness 的配合：

- openJiuwen 在输出上限后保留 partial reasoning 并重新提示继续，恢复了 **100 个 run，其中 48 个后来获得非零 reward**。
- 在人工检查的 **6 个 matched pair 中，2 个的恢复机制是决定性因素**。
- 论文还将 provider stream 失败归于 harness resilience，而不是简单归为模型能力不足。

这是论文中的观测，**不是本扩展的实测成绩，也不是普适成功率保证**。它给出的设计依据是：不要把可恢复的轮次结束，过早当作任务结束。

pi-continuity 将这个依据落实为：**保留可用状态 → 原生恢复优先 → 按策略继续未完成任务 → 在合适的边界停止**。Continue 只是发给模型的指令；loop engineering 在于决定**什么时候继续、保留什么上下文、什么时候必须停止**。取消、审批、人工阻塞和恢复预算仍然有效。

Pi 已有截断工具保护，以及对部分 length stop 的 compact-and-retry；本扩展补齐仍然存在的退出路径，包括达到期望输出上限的纯文字/思考截断。详见[论文与版本固定的源码分析](evidence.md)。

![循环机制示意：区分轮次中断与任务完成，保留可读进展，并在策略约束内继续](https://raw.githubusercontent.com/zhexusun10/pi-continuity/main/assets/loop-engineering.png)

*机制示意图，不是任务成功率测试。*

## 安装

```bash
pi install git:github.com/zhexusun10/pi-continuity
```

重新启动 Pi，或 `/reload`。需要具有可操作边界事件的 **Pi 1.0.1+**，以及 Node.js 22.19+。这是 **coding-agent 层的扩展**：Pi CLI 和使用 `AgentSession`、正确加载并绑定扩展的 SDK 程序都可以使用。不修改 Pi 内核，无需构建。

## 看恢复策略

![机制动画：截断后续跑、原生重试优先的流恢复，以及工具结果之后再追加 Continue](https://raw.githubusercontent.com/zhexusun10/pi-continuity/main/assets/demo.gif)

*这是绘制的机制 storyboard，不是 Pi TUI 录屏，也不是真实模型实验。流恢复先让原生重试完成；工具尾部续跑发生在结果之后，不重复执行已完成的工具。* [MP4](https://raw.githubusercontent.com/zhexusun10/pi-continuity/main/assets/demo.mp4) · [渲染源码与来源说明](assets.md)。

## 三项功能

1. **Output Truncation 后继续任务。** 对文字、纯思考、空输出、混合内容和工具调用的 `stopReason: "length"`，在 `turn_end` 追加 Continue，并请求下一轮。明确标注输出上限的 provider error 也可以恢复。
2. **加强 stream recovery。** 在错误发生后，把可读 partial 内容保存为 checkpoint，供 Pi 原生重试使用；原生重试/恢复耗尽后，再补有限次数的退避重试。支持 EOF、未完整结束的 stream、socket reset，以及 Pi 已有的瞬时错误分类。空的成功输出也进入这个有限恢复机制。
3. **停在 tool call 时追加 Continue。** 在 `agent_before_settle` 确认任务确实要停止、最后一个有效 assistant 内容块仍然是 tool call，才补 Continue。普通工具轮次本来就会自然续跑，不会每调用一次工具就插入 Continue。

正常文字结束、用户取消、认证/权限/余额/配额错误、安全拒绝和未知确定性错误不会被自动续跑。输入上下文超限仍由 Pi compaction 处理。

### 如何保存 partial reasoning？

直接重放残缺工具参数、未完成的 signed reasoning 可能让下一次 provider 请求也失败。本扩展用追加式 `context_edit` 从**模型上下文**中省略被截断的 assistant 与其合成错误工具结果，再将可读文字/思考作为明确标注的引用文本存入隐藏 custom message。

- 原始历史、usage 和此前已经完成的工具结果仍然保留。
- 残缺 tool call 不执行，模型必须重新给出完整参数。
- 不复制 tool arguments、签名或被 redacted/encrypted 的思考。
- 保留的是可读进展，不是 provider 的不透明 reasoning 状态，也不是从某个 token 位置精确接续解码。

已有排队用户输入或其他扩展的 continuation 优先，不额外插入重复 Continue；仍会清理截断的协议内容，避免污染下一次请求。隐藏 checkpoint 会由 Pi 持久化，并作为 user-role context 传给模型；因此 session 文件也可能含可读思考内容。

## 配置

```text
/pi-continuity status
/pi-continuity off
/pi-continuity on
```

`status` 显示当前/上一条用户请求的恢复次数，不显示私密 partial 内容。开关仅作用于当前已加载 session，重载后恢复 CLI 默认值。关闭不会删除旧 checkpoint，也不会关闭 Pi 原生重试。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--continuity` | `true` | `--continuity=false` 关闭扩展恢复。 |
| `--continuity-max-resumes` | `20` | 每条真实用户请求最多由扩展安排 20 次续跑。`0` 不注入；`unlimited` 无此上限。 |
| `--continuity-stream-retries` | `3` | 原生恢复结束后最多补 3 次 stream/空响应恢复，也计入总上限。`0` 关闭流 checkpoint 和额外恢复。 |
| `--continuity-stream-delay-ms` | `1000` | stream 退避基础毫秒数，逐次翻倍，每次最多等待 8 秒。 |
| `--continuity-tool-tail` | `true` | 用 `--continuity-tool-tail=false` 兼容刻意无文字终止的 structured-output / handoff 工具。 |

true/false 开关需要显式值，例如 `--continuity true` 或 `--continuity=false`，不是只写参数名的 presence-only flag。

```bash
pi --continuity-max-resumes 50 --continuity-stream-retries 5
pi --continuity-max-resumes unlimited
pi --continuity-tool-tail=false
```

上限随真实新用户请求重置，不随每次原生重试的 `agent_start` 重置；状态只存在于内存，重载/重启后会重置。它限制的是扩展安排的续跑，不限制 Pi 原生工具循环或 provider 内部重试。每次 fallback 后原生重试可能再次发生，因此总模型调用次数不能简单把两项 retry 上限相加。

**续跑会增加 token 和时间成本；unlimited 可能无限循环。** Continue 不能证明任务完成，自动化运行仍需要独立校验和 harness 层时间/token 预算。遇到必须由人处理的阻塞，提示会要求模型用文字说明并停止，不绕过审批。

## Harness 与边界

### CLI、SDK 与 agent-core 到底有什么区别？

| 使用方式 | 集成方式 |
| --- | --- |
| **Pi CLI：TUI / RPC / JSON / print** | 正常安装，coding-agent 运行时负责加载扩展。 |
| **coding-agent SDK：`AgentSession`** | 通过 resource loader 加载扩展，并调用 `session.bindExtensions(...)`；这与 CLI 使用的是同一层 session 机制。 |
| **直接使用 `pi-agent-core` 的 `Agent` / `agentLoop()`** | 这些是底层构件，不是 extension host；不会自动加载本包，也没有本扩展使用的完整 session 边界契约，需要额外适配。 |

原先“bare pi-agent-core loops are not supported”的意思是**不能把这个 extension 直接插入未经过 coding-agent session 封装的底层循环**，不是说 agent-core 无法恢复，更不是 SDK 不支持。`AgentSession` 本身就建立在 agent-core 之上。

本包依赖的是 `ExtensionAPI`、session 上下文投影、可持久化的 boundary drafts，以及 `agent_before_settle`。底层循环也可以用自己的 hooks 实现恢复策略，但本仓库没有提供那层适配器。[分层说明](design.md#integration-layers)。

必须把扩展加载进实际评测使用的同一个 `AgentSession`；等待 `session.prompt()` 完整结束，或等待 `agent_settled`，不能把第一个 `agent_end` 当作任务彻底结束。

扩展不改变评分规则；成功恢复后最终 assistant 可以不再是 `length`，但不保证任务获得 reward。它也救不了提前在中间错误/第一个 `agent_end` 退出的外部 harness。

无法处理进程被杀、没有结束信号的永久 stream 挂起、工具无限阻塞、provider 从未暴露的内容或余额耗尽。作用范围是主 agent 的 finalized turn，不是所有嵌套模型/总结调用。请另设 provider idle timeout 和 shell timeout。取消会阻止边界之后的下一次模型请求；若 post-run 边界没有活跃 abort signal，当前有限退避可能需要等完，Pi 才完成取消。

本扩展不直接访问网络/文件，不做 telemetry；实际模型请求与 session 持久化由 Pi 完成。后加载扩展可以覆盖边界决策，特别是脱敏扩展需注意加载顺序。移除扩展不会删除历史 checkpoint。

## 更新与移除

```bash
pi update git:github.com/zhexusun10/pi-continuity
pi remove git:github.com/zhexusun10/pi-continuity
```

随后重启或 `/reload`。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:load
npm pack --dry-run
pi -e .
```

现有测试使用真实 Pi `AgentSession` 和内存 faux provider，不需要 API key，不消耗付费模型 token。包含未加载本扩展的 Pi 对照、不同截断形态、原生重试顺序、上限、取消、排队输入和早先脱敏保护。安装验证使用隔离配置与 offline RPC。

图片与动画独立于运行时测试；[渲染说明](assets.md)提供 PNG/GIF/MP4 的生成方法，不启动 Pi、不调用模型。

MIT；独立社区扩展，并非 Pi 官方产品。
