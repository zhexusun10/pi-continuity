# Loop engineering design

## Motivation and scope

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks, §5.1](https://arxiv.org/html/2610.00917#S5.SS1) motivates explicit recovery and termination policies. Its observations about openJiuwen retaining partial reasoning are not this extension's implementation or measured success rate. Since 0.4.0, pi-continuity deliberately **does not inject partial text/reasoning, checkpoints, or hidden instructions**. [Evidence](evidence.md) distinguishes paper observations, version-pinned source inspection, and deterministic control-flow tests.

Loop engineering here controls the transition from a response boundary to the next model turn or final settlement:

```text
user task → assistant(length/error/empty/tool tail)
          → public session boundary
          → append-only projection omissions + bounded continuation metadata
          → native recovery / queued work / extension fallback / settlement
```

Pi owns provider requests, tool execution, and session persistence. The extension uses only public `ExtensionAPI`/`ExtensionContext` hooks, `context_edit` drafts, `continue: true`, and non-context `custom` metadata. No core patches, private runtime APIs, direct provider requests, filesystem access, or telemetry.

## Integration layers

```text
Pi CLI / coding-agent SDK
  → AgentSession: extensions, projections, recovery, settlement
    → pi-agent-core Agent / agentLoop: model turns and tools
```

CLI TUI/RPC/JSON/print modes load the package normally. SDK applications must load the factory and call `session.bindExtensions(...)` on the same `AgentSession` that receives the prompt. Await `session.prompt()` or final `agent_settled`: `agent_end` precedes native retry, compaction, queues, and settlement recovery.

A direct core `Agent`/`agentLoop()` has no coding-agent extension host. Core hooks can implement equivalent policies in a separate adapter, but core notification events do not supply persisted entry IDs, projected contexts, or session boundary drafts. This package does not supply that adapter.

The pinned Pi **1.5.2** [extension contract](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/extensions/types.d.ts) and [core loop](https://unpkg.com/@earendil-works/pi-agent-core@1.5.2/dist/agent-loop.js) document the boundaries used here.

## Event policy

| Event | Action |
| --- | --- |
| `session_start` | Reset state and validate flags. Invalid limits fail closed; `on` cannot bypass failed validation. |
| `before_agent_start`, actual user `message_start` | Reset the request budget. Preserve captured turn identity as needed while queued user input is delivered. |
| `turn_end` / `length` | Omit interrupted assistant and synthetic tool results. Request continuation only when no other work supplies it and budget remains. If the native truncated-tool loop will continue after our cap, sanitize without recording another attempt. |
| `turn_end` / short recovery | Wait with the live public abort signal for stream/empty/unknown errors. Unknown errors have a smaller sub-cap. No model-visible checkpoint is appended. |
| `turn_end` / timed limit | Parse explicit cooldown/reset guidance and wait before native retry. Recognized usage limits without guidance use bounded polling. |
| `input` | Remember interruption before aborting the local wait: the host enqueues transformed input asynchronously after input hooks. |
| `agent_before_settle` | After native recovery and queues, synchronously check eligibility, completed waits, budgets, cancellation, and other continuations; return drafts/continuation, never sleep. |
| `context` | Always exclude legacy pi-continuity prompt artifacts. When enabled with a positive cap, exclude incomplete failed assistant protocol. Never add model-visible text. |
| `agent_settled`, `session_tree`, `session_shutdown` | Clear branch/run state and abort extension-owned waits. Retain settled budget counts for status until reset. |

Never reset budgets on `agent_start`: a native retry emits multiple starts inside one user request.

## Protocol and privacy policy

Recovery omits the broken assistant and its synthetic tool results together. Omission changes only model projection: raw stop reasons, errors, usage, and earlier completed actions remain in append-only history. Truncated tool arguments are never executed by this extension; Pi's core rejects those calls. Completed tool results remain available for tool-tail recovery.

No readable partial, signature, redacted thinking, tool arguments, or interrupted-tool note is copied into the next request. Earlier completed assistant reasoning is not globally stripped. Recovery accounting is a plain `custom` entry, not `custom_message`, and never becomes model context.

Legacy `pi-continuity-checkpoint` / `pi-continuity` custom messages are excluded even when recovery is disabled, zero-budgeted, or fails closed. Boundary cleanup omits their active projected contributions without deleting raw entries. The current projection determines whether a target is already omitted; an earlier content replacement or omission followed by restoration must not prevent cleanup. Earlier boundary drafts are preserved.

`--continuity-checkpoint-max-chars`, `checkpointMaxChars`, and the deprecated partial extraction/limiting helpers remain for compatibility. The flag validates its former upper bound but has no runtime effect. Small helper caps still obey a hard bound, including a zero-length retained tail. `checkpointContent` remains removed.

## Native retry and queued input

Core hard-exits finalized error turns even if `turn_end` requested continuation. Fallback therefore belongs to `agent_before_settle`, after native retry/compaction/queue handling. Native retry still gets first refusal; its settings are never replaced.

All extension waits run at live `turn_end`, not signal-less settlement. A local controller combines with `ctx.signal`; abort/off/input/reset/shutdown interrupt it. Direct queued work is polled once per second. Known transient errors can pass through this wait and then native backoff, increasing latency relative to Pi alone. Native calls do not themselves increment extension budgets.

Pi 1.5.2 `Agent.continue()` drains queued follow-up input immediately when the transcript ends in an assistant. Omitting that tail too early can cause another old-task request first. On queued/interrupted input after an error, the boundary retains the assistant tail until Pi selects the input; the request-time context hook then drops its broken protocol. No partial is replayed or checkpoint appended. The input hook records interruption before the host's asynchronous enqueue to close that race.

Normal tools continue natively without an extra extension turn. A terminating tool tail is rechecked against the settlement projection before continuation. Tools intentionally designed to end with structured output can opt out with `--continuity-tool-tail=false`.

## Retry guidance and limits

Defaults per actual user request:

- Total extension continuations: **16**.
- Shared stream/empty/unknown continuations: **12**.
- Unknown errors: an additional **2**-attempt sub-cap, inside both other caps.
- Short delay: first 3 extension phases use **5 seconds**, later phases **10 seconds**; configurable base, capped at 10000 ms.
- `0` disables the corresponding recovery path. `max-resumes=unlimited` removes only the total cap, not sub-caps.

Missing/unknown errors, including generic `Bad Request`, are not labeled proven transient; they receive only the small unknown budget. Diagnosed authentication, permission, safety, request validation, certificate, explicit cancellation, and local programming failures are excluded first. Input-context overflow stays with Pi's compaction path. Successful final text, pending/deferred responses, and ordinary tool errors are not recovery signals. A reasoning-only successful response without visible text or tools uses bounded empty-response recovery.

`lib/retry-delay.ts` recognizes explicit `cooldown`, `retry in/after`, `try again in/after`, `please wait`, and `reset in` guidance. Supported durations include `ms`/`s`/`min`/`h`/`d`, word aliases, minute misspellings (`miutes`, `minuites`, `mintues`), compounds (`1h2min3s`), and fractions. Explicit retry/cooldown fields accept snake/kebab/camel names and unit suffixes. Numeric `Retry-After` means seconds; bare unitless cooldown is rejected. Only RFC-style Retry-After HTTP dates are parsed. See the [format table](../README.md#usage-limits).

Reject negative, non-finite, unsafe, malformed, scientific-notation, and unsupported-unit guidance. Round up to milliseconds. Several valid hints use the longest delay. Approximation markers add half the smallest stated unit, retaining 30 seconds for Pi/Codex rounded-minute guidance. Exact zero is immediate but still consumes the bounded total continuation budget. Timed recovery does not consume the stream sub-cap or use its 10-second delay cap. Long timers are segmented without overflowing Node's timer limit.

Recognized usage limits without valid guidance poll every **10 minutes** for at most **5 hours / 30 attempts**. After a window is exhausted, later windows use **5 h 20 min / 32 attempts**. Polling has its own finite bound and does not consume the total resume cap, but `continuity=false` and `max-resumes=0` disable it. Account exhaustion without valid retry guidance remains terminal. Timers/state do not survive process restart/reload.

These are not global provider-call budgets. Native retry can start a fresh batch after fallback, yielding up to `(native retries + 1) × (extension fallbacks + 1)` outer calls for a persistent transient error, excluding provider-internal retries. Normal tool loops and nested calls have their own policies. Use harness deadlines and token/call budgets separately.

## Boundaries and validation

The extension cannot recover a killed process, a never-finalized provider stream, a hung tool, unavailable credentials/credits, hidden decoder state, or content absent from finalized responses. It cannot guarantee task correctness, non-repetition, or benchmark improvement. Other extensions may override boundary decisions; load order is a composition boundary.

Tests use the real Pi 1.5.2 `AgentSession` with in-memory faux responses and no real model APIs. They cover output caps, native-first ordering, bounded unknown/cooldown recovery, immediate cancellation, steering/follow-up races, no prompt injection, raw history/usage, legacy artifact cleanup, prior redactions, and truncated-tool safety. Virtual clocks cover long waits without sleeping for hours. Offline source and tarball loading verify packaging independently of task-quality benchmarks.
