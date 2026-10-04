# pi-continuity

**一轮输出被截断，不应该意味着整个任务就此结束。**

这是一个 Pi extension：补齐 Output Truncation 续跑、加强 provider stream recovery，并在任务真正停止于 tool call、没有最终文字回复时追加 Continue。

[English](../README.md) · [设计](design.md) · [论文与源码依据](evidence.md)

## 安装

```bash
pi install git:github.com/zhexusun10/pi-continuity
```

重新启动 Pi，或 `/reload`。需要具有可操作边界事件的 **Pi 1.0.1+**，以及 Node.js 22.19+。已经使用 Pi 1.0.1 SDK 测试；不支持旧版本或没有 extension 系统的裸 `pi-agent-core` 循环。不修改 Pi 内核，无需构建。

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

## 依据

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks，§5.1](https://arxiv.org/html/2610.00917#S5.SS1) 记录：openJiuwen 在输出上限后恢复了 **100 个 run，其中 48 个后来获得非零 reward**；人工检查的 **6 个 matched pair 中，2 个的恢复机制是决定性因素**。论文还将 provider stream 失败归于 harness resilience。

这些是论文的观测，**不是本扩展的 benchmark 成绩，也不是 Continue 的普适因果收益**。

当前 Pi 已补了截断工具调用的合成错误反馈，而且在输出量低于模型期望上限时，有一次 compact-and-retry。不能笼统说所有纯文字截断都必然直接退出；达到期望输出上限的纯文字/思考截断仍存在退出路径。本扩展覆盖这个缺口。详见[版本固定的源码分析](evidence.md)。

## Harness 与边界

必须把扩展加载进实际评测使用的同一个 `AgentSession`。SDK 应先调用 `session.bindExtensions(...)` 初始化扩展生命周期；等待 `session.prompt()` 完整结束，或等待 `agent_settled`，不能把第一个 `agent_end` 当作任务彻底结束。

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

测试使用真实 Pi `AgentSession` 和内存 faux provider，不需要 API key，不消耗付费模型 token。包含裸 Pi 截断失败对照、不同截断形态、原生重试顺序、上限、取消、排队输入和早先脱敏保护。安装验证使用隔离配置与 offline RPC。

MIT；独立社区扩展，并非 Pi 官方产品。
