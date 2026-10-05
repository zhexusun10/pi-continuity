# pi-continuity

**Recover an interrupted Pi turn without replaying broken protocol state.**

[![CI](https://github.com/zhexusun10/pi-continuity/actions/workflows/ci.yml/badge.svg)](https://github.com/zhexusun10/pi-continuity/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-continuity)](https://www.npmjs.com/package/pi-continuity)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Pi 1.0.1](https://img.shields.io/badge/tested-Pi%201.0.1-blue.svg)](https://pi.dev)

[简体中文](docs/README.zh-CN.md) · [Design](docs/design.md) · [Evidence](docs/evidence.md) · [Source](extensions/index.ts)

## Why this exists

The empirical motivation is the paper's **Terminal-Bench 4.0** benchmark analysis in [Finding the Right Fit: Model–Harness Interactions across Agent Tasks](https://arxiv.org/html/2610.00917), §5.1. It reports that openJiuwen resumed **100** runs after output caps, **48** later scored above zero, and resumption was decisive in **2 of 6** inspected matched pairs. The same analysis reports provider-stream failures in **25 of Kimi's 62 PI runs on TB4**, tying part of the problem to harness resilience.

These benchmark observations motivate a concrete engineering question: when a response boundary is caused by an output cap, a broken stream, or a tool-call ending, should the harness settle the task immediately? pi-continuity answers by preserving safe progress, letting Pi's native recovery run first, and requesting another model turn through Pi's public session boundary when the turn is still recoverable. The paper, Pi source revision, and repository validation are documented in [Evidence](docs/evidence.md).

## Install

```bash
pi install npm:pi-continuity
```

For a GitHub source install:

```bash
pi install git:github.com/zhexusun10/pi-continuity
```

Then start a new Pi process or run `/reload` in an existing session. The package does not patch Pi, call providers directly, or install runtime dependencies.

Requires **Pi 1.0.1+ with actionable session boundaries** and Node.js 22.19+. It works in the Pi CLI and in SDK applications that load and bind the extension to the same `AgentSession` used for the model run.

## What changes?

| When Pi would stop | pi-continuity |
| --- | --- |
| `stopReason: "length"`: text, reasoning-only, empty, mixed, or tool-call output | Removes the interrupted assistant protocol from the next model projection, preserves bounded readable partial context when useful, and requests one next model turn at `turn_end`. |
| A failed provider stream, including `errorMessage: "terminated"` or `"TypeError: terminated"` | Lets Pi's native session retry run first. After native recovery is exhausted, omits the failed assistant, preserves a bounded checkpoint when useful, and requests another model turn with staged delays. |
| Successful but empty output | Omits the empty assistant response and requests another model turn using the bounded stream-recovery budget. |
| A run that ends with a tool call after the tool result | Keeps the completed tool result and requests one next model turn at `agent_before_settle`; it does not add a synthetic user instruction or rerun the tool. |

The extension uses Pi's public session boundary API: `context_edit` repairs the next model projection and `continue: true` asks the `AgentSession` to call its next model turn. It does not inject a synthetic `Continue` user message for every retry. A hidden checkpoint is added only when readable partial progress or an interrupted-tool note is useful.

An ordinary tool call already causes Pi to continue. The extension does not add an extra turn to every tool call. Normal final text, explicit aborts, authentication/billing/quota errors, safety rejections, and unknown deterministic errors are not retried. Input-context errors remain Pi's compaction responsibility. Clearly reported output-cap errors are supported when a provider represents them as `error` instead of `length`.

## How it works

For an interrupted assistant response, the extension reads the projected session context and preserves raw history while repairing only the next model projection:

1. It identifies the response boundary from the assistant stop reason and the projected content.
2. It appends `context_edit` entries for the interrupted assistant and synthetic results that cannot be replayed safely.
3. It optionally stores readable text/reasoning as a quoted, bounded checkpoint. Tool arguments, signatures, response IDs, and redacted reasoning are excluded.
4. It returns `continue: true`. Pi commits the boundary drafts and starts the next model turn.

Pi's native retry runs before `agent_before_settle`. The extension saves a checkpoint at `turn_end` so native retry can still use readable progress after Pi omits the failed assistant from model context. If native recovery is exhausted, the extension uses the same public boundary mechanism for its fallback.

A truncated tool call is never executed by this extension. Pi's core handles truncated tool calls safely; the next model turn receives a note that the interrupted call was not executed and must be re-issued with complete arguments. A completed tool result remains available for tool-tail recovery.

The session history is append-only. `context_edit` changes model projection, not raw history or usage records. Recovery markers are plain session metadata and do not become model messages. Checkpoints are model context and may contain readable reasoning from the finalized provider response.

## Controls

```text
/pi-continuity
/pi-continuity status
/pi-continuity off
/pi-continuity on
```

`status` reports recovery counts for the current or last user request without printing partial content. Toggling applies to the current loaded session; `/reload` restores CLI defaults. Turning the extension off stops future extension recovery but does not remove persisted history or disable Pi's native retry setting.

| CLI flag | Default | Meaning |
| --- | ---: | --- |
| `--continuity` | `true` | Enable extension recovery. Use `--continuity=false` to disable it. |
| `--continuity-max-resumes` | `8` | Maximum extension-scheduled model turns per actual user request. `0` disables extension recovery; `unlimited` removes this total cap. |
| `--continuity-stream-retries` | `6` | Extra stream/empty-response recoveries after native retry. The default schedule is three attempts at 5 seconds, then three attempts at 10 seconds. `0` disables this fallback. |
| `--continuity-stream-delay-ms` | `5000` | Base delay for extra stream/empty-response recoveries. Attempts 1–3 use this value; later attempts use 2x, capped at 10 seconds. |
| `--continuity-checkpoint-max-chars` | `12000` | Maximum readable partial context merged into the active checkpoint. Hard maximum: `64000`. `0` disables copied partial text/reasoning. |
| `--continuity-tool-tail` | `true` | Recover a settled tool-call ending. Set `false` for intentionally terminal structured-output or handoff tools. |

Boolean flags take explicit values such as `--continuity=false`; they are not presence-only flags.

```bash
pi --continuity-max-resumes 12 --continuity-stream-retries 6
pi --continuity-stream-delay-ms 5000
pi --continuity-checkpoint-max-chars 8000
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
- Provider-specific error wording differs. The classifier covers Pi's retry classifier and common HTTP/transport failures while remaining conservative for unknown deterministic errors.
- The extension cannot recover a killed process, a provider stream that never finalizes, an unbounded tool, content the provider never exposed, or exhausted credits.
- Readable checkpoints are persisted by Pi as model context. Treat session files as sensitive.
- Other extensions can replace boundary drafts or continuation decisions. Load order is a composition boundary, especially for redaction.

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

Tests use Pi's real `AgentSession` and in-memory faux provider. They make no real model requests and use no API keys or paid provider calls. The suite covers output-cap shapes, native retry ordering, fallback budgets, staged delays, cancellation, queued input, protocol omissions, tool execution safety, and package loading.

The repository also contains optional illustration tooling. See [docs/assets.md](docs/assets.md) to regenerate the PNG/GIF/MP4 storyboard. It does not run Pi or access a provider.

## Update and remove

```bash
pi update git:github.com/zhexusun10/pi-continuity
pi remove git:github.com/zhexusun10/pi-continuity
```

Restart Pi or run `/reload` afterwards. Removing the extension stops future recovery but does not erase existing session entries.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [the release checklist](docs/releasing.md) for repository workflows.

## License

MIT. An independent community package, not an official Pi product.
