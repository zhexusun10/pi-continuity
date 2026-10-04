# pi-continuity

**A cut-off turn should not be the end of the task.**

Continue Pi after output truncation, recover broken provider streams, and request a final text response when a run ends on tool calls.

[![CI](https://github.com/zhexusun10/pi-continuity/actions/workflows/ci.yml/badge.svg)](https://github.com/zhexusun10/pi-continuity/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Pi 1.0.1](https://img.shields.io/badge/tested-Pi%201.0.1-blue.svg)](https://pi.dev)

[简体中文](docs/README.zh-CN.md) · [Design](docs/design.md) · [Evidence](docs/evidence.md) · [Source](extensions/index.ts)

## Install

```bash
pi install git:github.com/zhexusun10/pi-continuity
```

Start a new Pi process or run `/reload`. No core patches, build step, or runtime dependency installation. This repository is npm-package-ready, but the documented installation uses GitHub; it does not assume an npm release exists.

Requires **Pi 1.0.1+ with actionable boundary hooks**, and Node.js 22.19+. Tested against the Pi 1.0.1 SDK. Older Pi versions and bare `pi-agent-core` loops are not supported.

## What changes?

| When Pi would stop | pi-continuity |
| --- | --- |
| `stopReason: "length"`: text, reasoning-only, empty, mixed, or tool-call output | Adds **Continue** at `turn_end` and ensures a next request. Saves readable partial text/reasoning as quoted context. |
| A failed provider stream | Preserves readable partial context for Pi's **native retries first**. After native recovery is exhausted, adds bounded extra retries with backoff. Covers EOF, incomplete streams, socket resets, and Pi's transient-error classifier. |
| Successful but empty output | Treats it as an incomplete response, using the same bounded stream-recovery budget. |
| The run actually ends with a tool call as its last substantive assistant block | Adds **Continue** at `agent_before_settle`, after tool results, to request completion or a final text answer. |

An ordinary tool call already causes Pi to continue. The extension does **not** add Continue to every tool turn. Normal final text, explicit aborts, authentication/billing/quota errors, safety rejections, and unknown deterministic errors are not retried. Input-context errors remain Pi's compaction responsibility. Clearly reported output-cap errors are also supported when a provider represents them as `error` instead of `length`.

### Partial reasoning, without broken protocol replay

Interrupted tool arguments and incomplete provider reasoning signatures are unsafe to replay. The extension uses append-only `context_edit` entries to omit the interrupted assistant and its synthetic tool results from **model context**, then saves readable text/reasoning in a hidden custom message. The model is told those fragments are unfinished and that interrupted calls were **not executed**; it must re-issue complete arguments if needed.

Raw history, usage records, completed earlier tools, and their results remain intact. Redacted/encrypted reasoning and tool arguments are **not** copied into the continuation. This preserves readable progress, not opaque provider reasoning state or exact decoding position.

Queued user input or another extension's continuation takes precedence: no duplicate Continue is injected, but length-truncated protocol content is still sanitized. Hidden checkpoints and recovery messages are persisted by Pi and converted to user-role context for the next request.

## Controls

```text
/pi-continuity
/pi-continuity status
/pi-continuity off
/pi-continuity on
```

Status reports the last/current user request's recovery counts, without printing private partial content. Toggles apply to the current loaded session; `/reload` restores CLI defaults. Turning it off stops future injections, not previously stored checkpoints or Pi's native retry policy.

| CLI flag | Default | Meaning |
| --- | --- | --- |
| `--continuity` | `true` | Enable recovery. Use `--continuity=false` to disable. |
| `--continuity-max-resumes` | `20` | Maximum extension-scheduled continuations per actual user request. `0` disables injections; `unlimited` removes this cap. |
| `--continuity-stream-retries` | `3` | Additional stream/empty-response recoveries **after** native retries; included in the total cap. `0` disables stream checkpoints and fallback. |
| `--continuity-stream-delay-ms` | `1000` | Extra stream backoff base: 1s, 2s, 4s…; each wait is capped at 8s. |
| `--continuity-tool-tail` | `true` | Use `--continuity-tool-tail=false` for tools that intentionally terminate without text, such as structured-output or handoff tools. |

The true/false controls take explicit values (`--continuity true` or `--continuity=false`); they are not presence-only flags.

```bash
pi --continuity-max-resumes 50 --continuity-stream-retries 5
pi --continuity-max-resumes unlimited
pi --continuity-tool-tail=false
```

Budgets reset on an actual new user request, not on every `agent_start` emitted by native retry. They are in-memory limits and reset after reload/process restart. Pi's native tool loops and provider-internal retries are **not** counted or disabled. Native retries may run again after each fallback, so the total provider-call count is not simply the sum of the two limits.

**Recovery costs additional tokens and time.** Unlimited continuation can loop indefinitely. A Continue is a chance to finish, not proof of task completion. Use independent verification and harness-level time/token budgets for unattended work. The prompt asks the model to explain human-required blockers in text and stop; it does not bypass approval gates.

## Why?

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks, §5.1](https://arxiv.org/html/2610.00917#S5.SS1) reports **100 openJiuwen runs resumed after output caps; 48 later scored above zero**, with resumption decisive in **2 of 6** inspected matched pairs. It also attributes provider-stream failures to harness resilience.

Those are the paper's observations, **not pi-continuity benchmark results** or a causal estimate of a generic Continue prompt's benefit. Pi has since added truncated-tool handling and conditional compact-and-retry. The remaining gap includes text/reasoning truncation at the desired output cap. See [the paper and version-pinned source analysis](docs/evidence.md).

## Harness integration and limits

Load this package into the **same `AgentSession` used by the harness**. Await `session.prompt()` through final settlement, or use `agent_settled`; `agent_end` can precede native/fallback recovery. SDK applications must initialize extension bindings (`session.bindExtensions(...)`) so lifecycle configuration runs.

A successful resumed response can replace the final `length` stop seen by a harness. The extension does not change reward logic, deadlines, or exception handling, and cannot rescue a harness that exits on the first `agent_end` or intermediate error.

It cannot recover a killed process, a provider stream that never terminates, an unbounded hanging tool, content the provider never exposed, or exhausted credits. It handles the **main agent's finalized turns**, not arbitrary nested model calls or summarization streams. Configure provider idle timeouts and shell timeouts separately. Other extensions can override later boundary decisions; load order matters, particularly for context redaction. See [design and limitations](docs/design.md).

The extension makes **no direct network requests, telemetry calls, or filesystem operations**. Pi performs model calls and persists the hidden context entries, including readable reasoning. Treat session files as sensitive.

## Update / remove

```bash
pi update git:github.com/zhexusun10/pi-continuity
pi remove git:github.com/zhexusun10/pi-continuity
```

Restart Pi or `/reload` afterward. Removal stops future recovery but does not erase already persisted session entries.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:load
npm pack --dry-run
pi -e .
```

Tests use Pi's real `AgentSession` and in-memory faux provider: **no API keys, paid model calls, or real tool side effects**. They cover baseline truncation, reasoning/text/tool recovery, native retry ordering, budget exhaustion, cancellation, queued inputs, earlier redactions, and terminal tool opt-out. `verify:load` installs the local package into an isolated config and checks offline RPC command discovery; it can also verify a GitHub install:

```bash
node scripts/verify-install.mjs git:github.com/zhexusun10/pi-continuity
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [release checklist](docs/releasing.md).

## License

MIT. An independent community extension, not an official Pi product.
