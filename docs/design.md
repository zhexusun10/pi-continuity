# Loop engineering design

## Research basis

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks, §5.1](https://arxiv.org/html/2610.00917#S5.SS1) motivates making recovery and termination explicit harness policies: openJiuwen resumes interrupted output with partial reasoning retained, and the inspected matched pairs identify resumption as consequential. [Evidence and scope](evidence.md) separates these paper observations from implementation validation.

Here, **loop engineering** means controlling the transition from a completed response to the next request or task settlement. The loop policy decides when another model turn is warranted, what state survives, how native recovery and queues compose, and which limits end the run.

## Problem → trace → solution

A reasoning-only response reaches its output cap. There are no parsed tool calls and no queued user message. Pi's low-level loop finishes; conditional post-run compaction does not recover an at-cap output. The extension removes the interrupted assistant from the next model projection and requests one next model turn through the session boundary. It injects no partial text, reasoning, checkpoint, or hidden prompt.

```text
user task
  → assistant(length, thinking fragment, no tool call)
  → turn_end
  → [without extension] agent_end → settlement
  → [with extension] context omission
  → public boundary `continue: true` → next provider request
```

A boundary continuation requires runnable projected context. The extension removes the interrupted assistant and any synthetic results that belong to it; a preceding user message or completed tool result then makes the context runnable. It adds no model-visible checkpoint or instruction. Returning boundary drafts and a continuation decision makes the change synchronous and persistent; it avoids fire-and-forget `sendUserMessage()` races at `agent_end` and works in TUI, RPC, JSON, and print modes.

## Integration layers

```text
Pi CLI / coding-agent SDK application
  -> AgentSession: extension loading, session projection, recovery, settlement
     -> pi-agent-core Agent / agentLoop: model turns and tool execution
```

pi-continuity is installed at the **AgentSession extension layer**, not by replacing the core loop. Both the CLI and SDK can use it. SDK users must load its factory through the resource loader and initialize bindings with `session.bindExtensions(...)`.

A program that imports only `Agent` or `agentLoop()` from `pi-agent-core` has not created this extension host. In particular:

- Core `turn_end` is a notification carrying a message and tool results; the coding-agent extension boundary also provides projected context, persisted entry IDs, draft entries, and a continuation decision.
- `agent_before_settle` runs after session-level native retries, compaction, and queues; it is not a core Agent event.
- Append-only `context_edit` / `custom_message` drafts belong to the session layer, not the standalone core loop.

Core hooks such as `finishTurn` and `prepareNextTurn` can support custom loop policies, but are not a drop-in replacement for those contracts. Error/aborted core turns also remain hard exits and need outer recovery orchestration. This package does not expose a standalone core adapter. That is the precise integration requirement previously described too broadly as "bare pi-agent-core loops are not supported"—not an inability of agent-core to support recovery.

See the version-pinned [core hooks](https://github.com/earendil-works/pi/blob/76dfb88f63ce51ff2e3fe2ead4fcf1f65f71f121/packages/agent/src/types.ts#L256-L281) and [extension boundaries](https://github.com/earendil-works/pi/blob/76dfb88f63ce51ff2e3fe2ead4fcf1f65f71f121/packages/coding-agent/src/core/extensions/types.ts#L958-L1035).

## Event policy

| Event | Action |
| --- | --- |
| `session_start` | Read and validate flags; clear state. Invalid spending limits disable recovery and surface an extension error. |
| `before_agent_start`, actual user `message_start` | Reset the request budget and captured last turn. Our hidden custom messages do not reset it. |
| `turn_end` / `length` | Preserve earlier boundary drafts; omit interrupted assistant/synthetic results and return `continue: true`. If other work already ensures a next request, only sanitize the projection. |
| `turn_end` / recoverable `error` | Omit the failed assistant from the projection, **without** requesting fallback and without a checkpoint. Pi's native retry policy gets first refusal. |
| `turn_end` / usage limit | With provider-independent minute guidance, wait the advertised time; without guidance, poll at a fixed 10-minute interval. Both wait with the live public abort signal before any native 429 retry. Interrupt on abort/off/new input; poll directly queued input once per second. |
| `agent_before_settle` | After native retries/compaction/queues, inspect the last finalized turn. Recover a transient error, completed usage-limit wait or poll, empty successful response, explicit error-reported output cap, or final tool tail by repairing the projected context and returning `continue: true` when no other continuation/input is pending. |
| `context` | Before each provider request, omit all recovery artifacts and incomplete failed assistant protocol messages from the request-time projection; the raw append-only session remains unchanged. |
| `agent_settled` | Drop the captured last turn and timer; retain counts for status. |
| `session_tree`, `session_shutdown` | Clear branch-sensitive state and cancel any extension-owned wait. |

Do not reset on `agent_start`: native retry can emit it several times inside one user request. Otherwise a retry limit becomes an unlimited loop.

## No injected model context

The extension deliberately refuses to inject any prompt, checkpoint, quoted partial, reasoning fragment, or hidden instruction into model context. Recovery is limited to:

1. Append-only `context_edit` entries that omit an interrupted assistant and synthetic results that cannot be replayed safely.
2. A `continue: true` boundary decision that asks Pi to start the next model turn.
3. A plain `custom` session entry that records the recovery attempt; this entry does not participate in model context.

The next request therefore sees the original task and any completed tool results, without partial output from the interrupted response. This trades away partial-progress reuse for a strict no-prompt-injection policy.

Raw history and usage remain unchanged. Prior completed actions are not omitted. Another extension can replace the returned drafts or override continuation later; extension load order is an explicit composition boundary.

## Retry and cost limits

The total cap defaults to 16 extension-scheduled continuations per actual user request. The stream/empty-response sub-cap defaults to 12, with three 5-second waits followed by nine 10-second waits. All limits are checked before scheduling; only successful scheduling consumes the extension budget. `unlimited` explicitly removes the total cap, but not the stream sub-cap.

Timed limits are recognized only in finalized error messages with `Try again in [~]N min/mins/minute(s)` or `Retry in ...`; provider IDs and login methods are irrelevant. A `~` value gets 30 seconds of margin because Pi rounds Codex reset minutes. Exact values wait N minutes; approximate zero waits 30 seconds. Timed continuations consume the total cap, not the stream sub-cap, and are never reduced to the 10-second stream delay. Long timers are segmented to avoid Node's 2,147,483,647 ms timer overflow.

Usage limits without valid reset guidance (for example a Codex mid-stream `Codex error: The usage limit has been reached`) are polled instead: wait 10 minutes, continue the task, and repeat until the provider answers or the 5-hour window closes (at most 30 attempts). Because a provider's usage window is commonly 5 h, the first window matches it exactly; once a window has been given up, later windows add a 20-minute buffer and use 5 h 20 min (at most 32 attempts), so the poll does not stop at the same instant the provider resets. Missing, negative, non-finite, or unsafe minute counts take this path. The poll has its own bound and does not consume the total resume cap, but `--continuity-max-resumes=0` and `--continuity=false` disable it. `insufficient_quota`, `quota exceeded`, `out of budget`, `billing`, and `available balance` remain terminal.

Unlike short stream fallback, the limit wait belongs to `turn_end`: Pi 1.0.x–1.5.0 exposes an active cancellation signal there but not in post-run settlement. Waiting for hours at `agent_before_settle` would leave SDK abort/Escape blocked until the timer expires. Waiting earlier also prevents native 429 retry from running before the advertised reset. The extension does not request an error-turn continuation at `turn_end`; after waiting it leaves native recovery in charge and falls back at settlement if needed. A cancelled wait never schedules timed continuation. State/timers are in memory and are not restored on reload or process restart.

Stream recovery adds at most 12 extension fallbacks by default, after native recovery has finished: attempts 1–3 wait 5 seconds and attempts 4–12 wait 10 seconds. The base is configurable with `--continuity-stream-delay-ms`; later attempts use 2x the base and are capped at 10000 ms. Length and tool-tail continuations are immediate. A local AbortController cancels waits on off/reset/shutdown; a live `ctx.signal` is combined when available. The boundary also rechecks queued messages and the current extension state after waiting. Pi itself rejects another boundary request if the user aborts during settlement. When no active signal exists in the post-run boundary, the finite wait may finish before cancellation settles; drafts/counts can represent a scheduled continuation that Pi did not ultimately execute.

These limits are **not** global provider-call budgets. Pi's native retries may start a fresh batch after each fallback. For a persistent transient error with `N` native retries and `S` fallbacks, up to `(N + 1) × (S + 1)` outer calls may occur, before considering provider-internal retries. Normal tool loops and native truncated-tool continuation are not bounded by this extension. Reload/restart resets in-memory state. Set a harness deadline and provider/tool timeouts separately.

Authentication, permission, safety errors, explicit aborts, unknown deterministic errors, pending responses, and deferred handles are not resumed. Billing/quota limits remain terminal; subscription usage limits without explicit, valid minute guidance use the bounded 10-minute poll instead. Input-context overflow is left to Pi's compaction path. A normal final text answer, including a human-required blocker report, is respected without an extra requirements-check loop.

## Boundaries this extension cannot cross

- A provider/tool that hangs forever and emits no finalized turn. Configure idle and tool timeouts.
- Process death, harness deadlines, external error-triggered termination, or lost credentials/credits.
- Provider-hidden encrypted reasoning, exact decoding continuation, or content absent from the finalized response.
- Arbitrary nested model calls, cache warming, or summarization streams. This hooks the main agent's turns.
- Guarantees that a model will follow the next-turn request, preserve correctness, avoid repeats, or improve reward.
- Missing integration contracts: a direct core loop without an extension adapter, an AgentSession whose extensions are not loaded/bound, or a harness treating the first `agent_end` as final. See [integration layers](#integration-layers).

## Reproducible tests

`tests/harness.ts` creates a real SDK `AgentSession`, in-memory model/auth stores, an isolated resource loader, and a faux provider. Scripted responses expose normalized provider contexts without any real API requests. The baseline test uses a desired output cap of 16 and a 64-character faux output (16 estimated output tokens) with compaction enabled; Pi alone settles after one request. The extension test gets a second request and one final settlement.

Tool tests record execution counts, assert that truncated arguments never reach execution, and verify completed tool results precede the next tool-tail model turn. Stream tests distinguish native success from exhausted-native fallback and ensure `agent_start` does not reset limits. Cancellation, disabled recovery, existing continuations, queued user input, earlier redaction, and human-blocked text are covered separately. Timed-limit tests use a virtual clock to prove no call occurs before a five-hour reset, including its rounding margin, and cover exact/zero-minute guidance, native 429 ordering, abort/off/input interruption, raw failure/usage preservation, and total-budget exhaustion. Guidance-less tests cover the 10-minute poll cadence, the 30-attempt/5-hour give-up, the 32-attempt/5 h 20 min extended give-up after a previous window was exhausted, independence from the resume cap, terminal billing/quota exclusion, and cancellation.
