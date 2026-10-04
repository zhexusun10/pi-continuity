# Loop engineering design

## Research basis

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks, §5.1](https://arxiv.org/html/2610.00917#S5.SS1) motivates making recovery and termination explicit harness policies: openJiuwen resumes interrupted output with partial reasoning retained, and the inspected matched pairs identify resumption as consequential. [Evidence and scope](evidence.md) separates these paper observations from implementation validation.

Here, **loop engineering** means controlling the transition from a completed response to the next request or task settlement. The loop policy decides when another model turn is warranted, what state survives, how native recovery and queues compose, and which limits end the run.

## Problem → trace → solution

A reasoning-only response reaches its output cap. There are no parsed tool calls and no queued user message. Pi's low-level loop finishes; conditional post-run compaction does not recover an at-cap output. The extension removes the interrupted assistant from the next model projection, keeps a bounded quoted partial when useful, and requests one next model turn through the session boundary.

```text
user task
  → assistant(length, thinking fragment, no tool call)
  → turn_end
  → [without extension] agent_end → settlement
  → [with extension] context omission + optional quoted partial checkpoint
  → public boundary `continue: true` → next provider request
```

A boundary continuation requires runnable projected context. The extension removes the interrupted assistant and any synthetic results that belong to it; a preceding user message or completed tool result then makes the context runnable. A custom checkpoint is added only when readable partial progress or an interrupted-tool note is useful. Returning boundary drafts and a continuation decision makes the change synchronous and persistent; it avoids fire-and-forget `sendUserMessage()` races at `agent_end` and works in TUI, RPC, JSON, and print modes.

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
| `turn_end` / `length` | Preserve earlier boundary drafts; omit interrupted assistant/synthetic results, append an optional bounded checkpoint, and return `continue: true`. If other work already ensures a next request, append only the safe checkpoint. |
| `turn_end` / recoverable `error` | Capture readable partial content as a hidden checkpoint, **without** requesting fallback. Pi's native retry policy gets first refusal. |
| `agent_before_settle` | After native retries/compaction/queues, inspect the last finalized turn. Recover a transient error, empty successful response, explicit error-reported output cap, or final tool tail by repairing the projected context and returning `continue: true` when no other continuation/input is pending. |
| `context` | Before each provider request, omit stale recovery artifacts and incomplete failed assistant protocol messages from the request-time projection; the raw append-only session remains unchanged. |
| `agent_settled` | Drop the captured last turn and timer; retain counts for status. |
| `session_tree`, `session_shutdown` | Clear branch-sensitive state and cancel any extension-owned wait. |

Do not reset on `agent_start`: native retry can emit it several times inside one user request. Otherwise a retry limit becomes an unlimited loop.

## Protocol-safe partial context

We intentionally do not replay the original incomplete assistant as if it completed successfully. We also do not change `stopReason` to hide failure from a harness.

1. Read the boundary's **projected** content so earlier boundary redactions/omissions are respected.
2. Extract readable text and non-redacted reasoning. Exclude tool arguments and all opaque signatures/response IDs.
3. JSON-quote the unfinished fragments and label them as context, not verified results or new user instructions. Quotation is a boundary marker, not a complete defense against model prompt injection.
4. Append `context_edit` omissions and an optional hidden `custom_message` checkpoint. Repeated checkpoints from the same request are merged into one bounded active checkpoint; older recovery messages and markers are removed from the next request. Raw history and usage remain unchanged; prior completed actions are not omitted.
5. Explain that interrupted tool calls were not executed in the optional checkpoint. Tool-tail recovery is different: completed tool results remain in place and the boundary requests the next model turn after them.

For native stream retries, the checkpoint is committed at `turn_end` before Pi omits the errored assistant. The fallback does not duplicate that partial content. Only finalized content exposed by the provider is saved; deltas discarded by a provider before finalization are not reconstructed.

Pi persists these hidden messages. They are model context, not telemetry, but can include sensitive reasoning. A later redaction extension must handle both the original message and the copied custom checkpoint. Removing the extension does not remove prior entries. At a new user-request boundary, stale pi-continuity recovery artifacts are omitted from the active model projection (except the first resumed request after a session reload); this does not erase their raw entries. Another extension can replace the returned drafts or override continuation later; extension load order is an explicit composition boundary.

## Retry and cost limits

The total cap defaults to 8 extension-scheduled continuations per actual user request. The stream/empty-response sub-cap defaults to 6, with three 5-second waits followed by three 10-second waits. Readable partial checkpoints are merged and capped at 12,000 characters by default (configurable up to 64,000); `--continuity-checkpoint-max-chars=0` disables copied partial context. All limits are checked before scheduling; only successful scheduling consumes the extension budget. `unlimited` explicitly removes the total cap, but not the stream sub-cap or checkpoint character cap.

Stream recovery adds at most 6 extension fallbacks by default, after native recovery has finished: attempts 1–3 wait 5 seconds and attempts 4–6 wait 10 seconds. The base is configurable with `--continuity-stream-delay-ms`; later attempts use 2x the base and are capped at 10000 ms. Length and tool-tail continuations are immediate. A local AbortController cancels waits on off/reset/shutdown; a live `ctx.signal` is combined when available. The boundary also rechecks queued messages and the current extension state after waiting. Pi itself rejects another boundary request if the user aborts during settlement. When no active signal exists in the post-run boundary, the finite wait may finish before cancellation settles; drafts/counts can represent a scheduled continuation that Pi did not ultimately execute.

These limits are **not** global provider-call budgets. Pi's native retries may start a fresh batch after each fallback. For a persistent transient error with `N` native retries and `S` fallbacks, up to `(N + 1) × (S + 1)` outer calls may occur, before considering provider-internal retries. Normal tool loops and native truncated-tool continuation are not bounded by this extension. Reload/restart resets in-memory state. Set a harness deadline and provider/tool timeouts separately.

Authentication, permission, account limits, billing, safety errors, explicit aborts, unknown deterministic errors, pending responses, and deferred handles are not resumed. Input-context overflow is left to Pi's compaction path. A normal final text answer, including a human-required blocker report, is respected without an extra requirements-check loop.

## Boundaries this extension cannot cross

- A provider/tool that hangs forever and emits no finalized turn. Configure idle and tool timeouts.
- Process death, harness deadlines, external error-triggered termination, or lost credentials/credits.
- Provider-hidden encrypted reasoning, exact decoding continuation, or content absent from the finalized response.
- Arbitrary nested model calls, cache warming, or summarization streams. This hooks the main agent's turns.
- Guarantees that a model will follow the next-turn request, preserve correctness, avoid repeats, or improve reward.
- Missing integration contracts: a direct core loop without an extension adapter, an AgentSession whose extensions are not loaded/bound, or a harness treating the first `agent_end` as final. See [integration layers](#integration-layers).

## Reproducible tests

`tests/harness.ts` creates a real SDK `AgentSession`, in-memory model/auth stores, an isolated resource loader, and a faux provider. Scripted responses expose normalized provider contexts without any real API requests. The baseline test uses a desired output cap of 16 and a 64-character faux output (16 estimated output tokens) with compaction enabled; Pi alone settles after one request. The extension test gets a second request and one final settlement.

Tool tests record execution counts, assert that truncated arguments never reach execution, and verify completed tool results precede the next tool-tail model turn. Stream tests distinguish native success from exhausted-native fallback and ensure `agent_start` does not reset limits. Cancellation, disabled recovery, existing continuations, queued user input, earlier redaction, and human-blocked text are covered separately.
