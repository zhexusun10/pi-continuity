# pi-continuity

**Recover an interrupted Pi turn without replaying broken protocol state.**

[![CI](https://github.com/zhexusun10/pi-continuity/actions/workflows/ci.yml/badge.svg)](https://github.com/zhexusun10/pi-continuity/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-continuity)](https://www.npmjs.com/package/pi-continuity)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Pi 1.5.2](https://img.shields.io/badge/tested-Pi%201.5.2-blue.svg)](https://pi.dev)

[简体中文](docs/README.zh-CN.md) · [Design](docs/design.md) · [Evidence](docs/evidence.md) · [Source](extensions/index.ts)

## Why this exists

The empirical motivation is the paper's **Terminal-Bench 4.0** benchmark analysis in [Finding the Right Fit: Model–Harness Interactions across Agent Tasks](https://arxiv.org/html/2610.00917), §5.1. It reports that openJiuwen resumed **100** runs after output caps, **48** later scored above zero, and resumption was decisive in **2 of 6** inspected matched pairs. The same analysis reports provider-stream failures in **25 of Kimi's 62 PI runs on TB4**, tying part of the problem to harness resilience.

These benchmark observations motivate a concrete engineering question: when a response boundary is caused by an output cap, a broken stream, or a tool-call ending, should the harness settle the task immediately? pi-continuity answers by preserving safe progress, letting Pi's native recovery run first, and requesting another model turn through Pi's public session boundary when the turn is still recoverable. The paper, Pi source revision, and repository validation are documented in [Evidence](docs/evidence.md).

## Install

```bash
pi install npm:pi-continuity
```

The npm package **pi-continuity** supports **Pi 1.5.2**. This source tree builds **pi-continuity@0.5.0**.

For a GitHub source install:

```bash
pi install git:github.com/zhexusun10/pi-continuity
```

Then start a new Pi process or run `/reload` in an existing session. The package does not patch Pi, call providers directly, or install runtime dependencies.

Requires **Pi 1.0.1+ with actionable session boundaries** and Node.js 22.19+. Validated against **Pi 1.5.2**; the development dependencies are pinned to 1.5.2. It works in the Pi CLI and in SDK applications that load and bind the extension to the same `AgentSession` used for the model run.

## What changes?

| When Pi would stop | pi-continuity |
| --- | --- |
| `stopReason: "length"`: text, reasoning-only, empty, mixed, or tool-call output | Omits the interrupted protocol and requests the next turn at `turn_end`. Partial text/reasoning is never injected. |
| A failed provider stream, including `terminated` / `TypeError: terminated` | Lets native retry run first, then schedules bounded fallback if needed. No checkpoint or hidden prompt is injected. |
| Explicit retry guidance: `cooldown: 12s`, `Try again in ~N min.`, `Retry-After`, etc. | Waits the advertised duration before native retry or fallback. Supports milliseconds through days, compounds, common minute misspellings, and explicit retry fields. |
| Provider usage limit **without** a reset time (for example `Codex error: The usage limit has been reached`) | Polls every 10 minutes for up to 5 hours (30 attempts), then stops and leaves the raw failure in history. Once a window has been given up, later windows use 5 h 20 min (32 attempts) so the poll does not stop at the same instant the provider resets. Polling has its own bound and does not consume `--continuity-max-resumes`; `--continuity=false` or `--continuity-max-resumes=0` disables it. |
| Generic `Error: {"detail":"Bad Request"}`, missing error details, or unrecognized provider errors | Tries at most **2** extra recoveries by default, also consuming the shared stream and total budgets. Known permanent causes are excluded first. This is a bounded fallback, not evidence that a 400 error is transient. |
| Successful but empty or reasoning-only output with no visible answer/tool call | Omits the incomplete assistant response and requests another model turn using the bounded stream-recovery budget. |
| A run that ends with a tool call after the tool result | Keeps the completed tool result and requests one next model turn at `agent_before_settle`; it does not add a synthetic user instruction or rerun the tool. |

The extension uses Pi's public session boundary API: `context_edit` repairs the next model projection and `continue: true` asks the `AgentSession` to call its next model turn. It does not inject a synthetic `Continue` user message, a hidden checkpoint, or any other model-visible prompt. Partial text/reasoning from the interrupted response is deliberately dropped; only append-only session metadata (which does not enter model context) is added for recovery accounting.

An ordinary tool call already causes Pi to continue. The extension does not add an extra turn to every tool call. Normal final text, explicit aborts, authentication errors, safety rejections, and diagnosed permanent errors (including invalid parameters, expired credentials, certificate failures, and local programming errors) are not retried. Undiagnosed errors use the small unknown-error cap; `--continuity-unknown-retries=0` restores fail-closed behavior for them. Billing/quota limits remain terminal; subscription usage limits without explicit retry guidance are polled every 10 minutes for at most 5 hours (5 h 20 min after a give-up). Input-context errors remain Pi's compaction responsibility. Clearly reported output-cap errors are supported when a provider represents them as `error` instead of `length`.

## How it works

For an interrupted assistant response, the extension reads the projected session context and preserves raw history while repairing only the next model projection:

1. It identifies the response boundary from the assistant stop reason and the projected content.
2. It appends `context_edit` entries for the interrupted assistant and synthetic results that cannot be replayed safely.
3. It returns `continue: true`. Pi commits the boundary drafts and starts the next model turn.

No checkpoint text, quoted partial, or hidden instruction from the interrupted response is added to model context. The next request sees the original task and any completed tool results, with broken protocol blocks omitted. Reasoning in earlier completed assistant turns is not stripped by this extension.

All extension-owned waits run at `turn_end`, where the public cancellation signal is live; settlement never sleeps. Short stream/empty/unknown recovery uses the staged delay and spending caps, with a separate default ceiling of 2 unknown-error attempts. Native retry still gets first refusal after waiting and may apply its own backoff, so native-recognized errors can wait longer than with Pi alone. Cancellation, queued input, or disabling recovery interrupts the wait; directly queued work is polled once per second. Error-turn `continue` alone cannot replace the wait because core hard-exits finalized errors. Settlement respects pending continuations.

When input is queued after an error, the assistant tail is retained until Pi selects that input, then omitted by the context hook. This avoids delaying follow-up input by an extra old-task request, without injecting partial text or hidden instructions.

A truncated tool call is never executed by this extension and is omitted from the next model projection. Pi's core handles truncated tool calls safely; the model must re-issue any still-needed work with complete arguments. A completed tool result remains available for tool-tail recovery.

The session history is append-only. `context_edit` changes model projection, not raw history or usage records. Recovery markers are plain session metadata and do not become model messages. The extension does not persist partial text/reasoning as model context, but raw session history may still contain sensitive content.

## Usage limits

**Advertised cooldown/reset.** Explicit finalized error guidance such as `cooldown: 12s`, `retry in ...`, `retry after ...`, `try again in ...`, `please wait ...`, and `reset in ...` is recognized independently of provider or login. Colons (`:`/`：`), `=`, spaces, case differences, and common key naming styles are supported.

| Unit | Accepted forms |
| --- | --- |
| Milliseconds | `ms`, `msec`, `msecs`, `millisecond(s)` |
| Seconds | `s`, `sec`, `secs`, `second(s)` |
| Minutes | `m`, `min`, `mins`, `minute(s)`; common typos `miutes`, `minuites`, `mintues` |
| Hours | `h`, `hr`, `hrs`, `hour(s)` |
| Days | `d`, `day(s)` |

Examples: `cooldown: 0.25s`, `cooldown is 2miutes`, `retry in 1h2min3s`, and `retry after 1 hour, 2 minutes and 3 seconds`. Decimal durations are rounded up to whole milliseconds. JSON fields such as `retry_after`, `retryAfterMs`, `cooldown_seconds`, `retry_after_minutes`, and `retryDelay: "3.5s"` are supported: a unit suffix specifies the numeric field's unit. Unitless `Retry-After: 120` / `retry_after: 120` means seconds; bare `cooldown: 120` is ambiguous and is not accepted. `Retry-After` also accepts an RFC-style HTTP date, but arbitrary date strings and unrelated timeout/request-ID numbers are not inferred.

Exact values wait their stated duration. Approximate `~`, `≈`, `about`, or `approximately` adds half the smallest advertised unit as rounding margin: `~2 min` adds 30 seconds; `~2 s` adds 500 ms. This retains Pi/Codex's 30-second margin for `Try again in ~N min.`. When several valid hints appear, the longest delay wins. Negative/non-finite/unsafe values, malformed compounds, scientific notation, and unsupported units such as months are rejected.

**No advertised reset.** Some transport paths expose the same limit without a reset time (for example a Codex mid-stream `Codex error: The usage limit has been reached`). The extension then polls: it waits 10 minutes, continues the same task, and repeats until the provider answers or the 5-hour window (30 attempts) is exhausted. A provider's usage window is commonly 5 h, so the first window matches it exactly; once a window has been given up, later windows add a buffer and use 5 h 20 min (32 attempts), so the poll does not stop at the same instant the provider resets. Polling has its own bound and does not consume `--continuity-max-resumes`, but `--continuity=false` and `--continuity-max-resumes=0` disable it. Missing or invalid duration guidance on a recognized usage-limit error falls back to this polling path.

The wait runs at `turn_end`, while Pi's public cancellation signal is still active, **before** native retries can ignore the reset time. After waiting, native recovery gets first refusal; otherwise `agent_before_settle` requests the next model turn. Escape/SDK abort, `/pi-continuity off`, new input, session reset, or shutdown interrupts the wait. Directly queued SDK input is checked at least once per second. `/pi-continuity status` shows the remaining wait and poll progress. Keep Pi running; restart/reload does not restore a pending timer.

Timed-limit continuations count toward `--continuity-max-resumes`, not the stream sub-cap. Usage-limit polling is bounded by its own 5-hour window instead (5 h 20 min after a give-up). `--continuity-stream-retries=0` and the 10-second stream delay cap do not disable or shorten either usage-limit path. Authentication, safety, and input-context errors remain excluded even if they contain usage-limit wording. `insufficient_quota`, `quota exceeded`, `out of budget`, `billing`, and `available balance` remain terminal.

## Controls

```text
/pi-continuity
/pi-continuity status
/pi-continuity off
/pi-continuity on
```

`status` reports counts without partial content. Toggling applies to the loaded session; `/reload` restores CLI defaults. Invalid flags keep recovery disabled even after `/pi-continuity on`; fix the configuration and reload. Turning recovery off does not erase history or disable native retry. Legacy pi-continuity prompt artifacts are still excluded from model context when recovery is off, zero-budgeted, or fails closed.

| CLI flag | Default | Meaning |
| --- | ---: | --- |
| `--continuity` | `true` | Enable extension recovery. Use `--continuity=false` to disable it. |
| `--continuity-max-resumes` | `16` | Maximum extension-scheduled model turns per actual user request. `0` disables extension recovery; `unlimited` removes this total cap. |
| `--continuity-stream-retries` | `12` | Shared cap for extra stream/empty/unknown recoveries after native retry. Default phases: 3 attempts at 5 seconds, then 9 at 10 seconds. `0` disables these fallbacks. |
| `--continuity-unknown-retries` | `2` | Additional cap for undiagnosed errors, also bounded by stream/total caps even with `max-resumes=unlimited`. `0` disables unknown-error recovery. |
| `--continuity-stream-delay-ms` | `5000` | Live-boundary delay before native recovery or fallback. Extension attempts 1–3 use the base; later phases use 2x, capped at 10 seconds. |
| `--continuity-checkpoint-max-chars` | `12000` | **Deprecated no-op.** No checkpoint/prompt is injected; the old `64000` upper bound is still validated for compatibility. |
| `--continuity-tool-tail` | `true` | Recover a settled tool-call ending. Set `false` for intentionally terminal structured-output or handoff tools. |

Boolean flags take explicit values such as `--continuity=false`; they are not presence-only flags. Usage-limit polling is bounded separately at 30 attempts within 5 hours (32 attempts within 5 h 20 min once a window has been given up); use `--continuity=false` or `--continuity-max-resumes=0` to disable it.

```bash
pi --continuity-max-resumes 20 --continuity-stream-retries 12
pi --continuity-stream-delay-ms 5000
pi --continuity-tool-tail=false
```

Budgets reset on an actual new user request, not on every `agent_start` emitted by native retry. The extension total cap and stream sub-cap limit extension-scheduled turns; Pi native retries, provider-internal retries, normal tool loops, and nested model calls have their own policies. These are not global cost budgets. Use a harness-level deadline and token/call budget for unattended runs.

## CLI, SDK, and core-loop boundaries

| Integration | Requirement |
| --- | --- |
| Pi CLI: TUI, RPC, JSON, or print | Install the package normally; Pi's coding-agent runtime loads and binds the extension. |
| `AgentSession` SDK | Load the factory through the resource loader and call `session.bindExtensions(...)` on the same session that receives the prompt. Await `session.prompt()` through settlement or observe `agent_settled`. |
| Direct `pi-agent-core` `Agent` or `agentLoop()` | This package does not attach to a bare core loop. A separate adapter must implement equivalent persistence and boundary behavior. |

`agent_end` can occur before native retry, compaction, queued input, or extension recovery has finished. Consumers that need the final result must wait for `agent_settled` or the completed `session.prompt()` promise.

## Limits

- A recovery turn is a fresh model request. It does not restore provider decoder state or guarantee exact continuation from a token boundary.
- A model can still repeat work, miss context, or stop incorrectly. Check task results independently.
- Provider-specific error wording differs. The classifier covers Pi's retry classifier and common HTTP/transport failures; new or ambiguous errors receive only the small unknown-error budget. Persistent bad requests may require configuration or provider fixes, not more retries.
- The extension cannot recover a killed process, a provider stream that never finalizes, an unbounded tool, content the provider never exposed, or exhausted credits.
- No partial text/reasoning, checkpoint, or other hidden prompt is injected. Raw history can still contain sensitive content.
- Other extensions can replace boundary drafts or continuation decisions. Load order remains a composition boundary.

The benchmark figures above are the paper's Terminal-Bench 4.0 results. This repository's deterministic suite and in-memory AgentSession tests validate extension control flow and package loading; the source attribution and methodology are collected in [evidence.md](docs/evidence.md).

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:load
npm pack --dry-run
pi -e .
```

Tests use Pi's real `AgentSession` and in-memory faux provider. They make no real model requests and use no API keys or paid provider calls. The suite covers generic Bad Request and unknown-error caps, reasoning-only completion, terminal-cause exclusions, output-cap shapes, native retry ordering, fallback budgets, staged delays, virtual five-hour usage-limit waits, 10-minute guidance-less polling and its give-up and extended windows, reset rounding, cancellation, queued input, protocol omissions, tool execution safety, and package loading.

The repository also contains optional illustration tooling. See [docs/assets.md](docs/assets.md) to regenerate the PNG/GIF/MP4 storyboard. It does not run Pi or access a provider.

## Update and remove

```bash
pi update npm:pi-continuity
pi remove npm:pi-continuity
# For GitHub installations:
pi update git:github.com/zhexusun10/pi-continuity
pi remove git:github.com/zhexusun10/pi-continuity
```

Restart Pi or run `/reload` afterwards. Removing the extension stops future recovery but does not erase existing session entries.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [the release checklist](docs/releasing.md) for repository workflows.

## License

MIT. An independent community package, not an official Pi product.
