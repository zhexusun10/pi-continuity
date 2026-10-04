# Recovery design

## Problem → trace → solution

A reasoning-only response reaches its output cap. There are no parsed tool calls and no queued user message. Pi's low-level loop finishes; conditional post-run compaction does not recover an at-cap output. A harness reading the final assistant sees `length`.

```text
user task
  → assistant(length, thinking fragment, no tool call)
  → turn_end
  → [without extension] agent_end → settlement
  → [with extension] context omission + quoted fragment + Continue
  → next provider request → normal final answer → settlement
```

Adding only `continue: true` after a plain assistant is insufficient: Pi requires runnable user/tool-result context. The hidden custom message supplies user-role context. Returning boundary drafts and a continuation decision makes the change synchronous and persistent; it avoids fire-and-forget `sendUserMessage()` races at `agent_end` and works in TUI, RPC, JSON, and print modes.

## Event policy

| Event | Action |
| --- | --- |
| `session_start` | Read and validate flags; clear state. Invalid spending limits disable recovery and surface an extension error. |
| `before_agent_start`, actual user `message_start` | Reset the request budget and captured last turn. Our hidden custom messages do not reset it. |
| `turn_end` / `length` | Preserve earlier boundary drafts; omit interrupted assistant/synthetic results, append safe partial context and Continue, return `continue: true`. If other work already ensures a next request, append only the safe checkpoint. |
| `turn_end` / recoverable `error` | Capture readable partial content as a hidden checkpoint, **without** requesting fallback. Pi's native retry policy gets first refusal. |
| `agent_before_settle` | After native retries/compaction/queues, inspect the last finalized turn. Recover a transient error, empty successful response, explicit error-reported output cap, or final tool tail if no other continuation/input is pending. |
| `agent_settled` | Drop the captured last turn and timer; retain counts for status. |
| `session_tree`, `session_shutdown` | Clear branch-sensitive state and cancel any extension-owned wait. |

Do not reset on `agent_start`: native retry can emit it several times inside one user request. Otherwise a retry limit becomes an unlimited loop.

## Protocol-safe partial context

We intentionally do not replay the original incomplete assistant as if it completed successfully. We also do not change `stopReason` to hide failure from a harness.

1. Read the boundary's **projected** content so earlier boundary redactions/omissions are respected.
2. Extract readable text and non-redacted reasoning. Exclude tool arguments and all opaque signatures/response IDs.
3. JSON-quote the unfinished fragments and label them as context, not verified results or new user instructions. Quotation is a boundary marker, not a complete defense against model prompt injection.
4. Append `context_edit` omissions and a hidden `custom_message`. Raw history and usage remain unchanged; prior completed actions are not omitted.
5. Explain that interrupted tool calls were not executed. Tool-tail recovery is different: completed tool results remain in place and Continue is appended **after** them.

For native stream retries, the checkpoint is committed at `turn_end` before Pi omits the errored assistant. The fallback does not duplicate that partial content. Only finalized content exposed by the provider is saved; deltas discarded by a provider before finalization are not reconstructed.

Pi persists these hidden messages. They are model context, not telemetry, but can include sensitive reasoning. A later redaction extension must handle both the original message and the copied custom checkpoint. Removing the extension does not remove prior entries. Another extension can replace the returned drafts or override continuation later; extension load order is an explicit composition boundary.

## Retry and cost limits

The total cap defaults to 20 extension-scheduled continuations per actual user request. The stream/empty-response sub-cap defaults to 3. Both are checked before scheduling; only successful scheduling consumes the extension budget. `unlimited` explicitly removes the total cap, but not the stream sub-cap.

Stream backoff is `min(base × 2^(attempt - 1), 8000)` milliseconds, after native recovery has finished. Length and tool-tail continuations are immediate. A local AbortController cancels waits on off/reset/shutdown; a live `ctx.signal` is combined when available. Pi itself rejects another boundary request if the user aborts during settlement. When no active signal exists in the post-run boundary, the finite wait may finish before cancellation settles; drafts/counts can represent a scheduled continuation that Pi did not ultimately execute.

These limits are **not** global provider-call budgets. Pi's native retries may start a fresh batch after each fallback. For a persistent transient error with `N` native retries and `S` fallbacks, up to `(N + 1) × (S + 1)` outer calls may occur, before considering provider-internal retries. Normal tool loops and native truncated-tool continuation are not bounded by this extension. Reload/restart resets in-memory state. Set a harness deadline and provider/tool timeouts separately.

Authentication, permission, account limits, billing, safety errors, explicit aborts, unknown deterministic errors, pending responses, and deferred handles are not resumed. Input-context overflow is left to Pi's compaction path. A normal final text answer, including a human-required blocker report, is respected without an extra requirements-check loop.

## Boundaries this extension cannot cross

- A provider/tool that hangs forever and emits no finalized turn. Configure idle and tool timeouts.
- Process death, harness deadlines, external error-triggered termination, or lost credentials/credits.
- Provider-hidden encrypted reasoning, exact decoding continuation, or content absent from the finalized response.
- Arbitrary nested model calls, cache warming, or summarization streams. This hooks the main agent's turns.
- Guarantees that a model will obey Continue, preserve correctness, avoid repeats, or improve reward.
- A harness running only the low-level Agent, omitting extension bindings, or treating the first `agent_end` as final.

## Reproducible tests

`tests/harness.ts` creates a real SDK `AgentSession`, in-memory model/auth stores, an isolated resource loader, and a faux provider. Scripted responses expose normalized provider contexts without any real API requests. The baseline test uses a desired output cap of 16 and a 64-character faux output (16 estimated output tokens) with compaction enabled; Pi alone settles after one request. The extension test gets a second request and one final settlement.

Tool tests record execution counts, assert that truncated arguments never reach execution, and verify completed tool results precede tool-tail Continue. Stream tests distinguish native success from exhausted-native fallback and ensure `agent_start` does not reset limits. Cancellation, disabled recovery, existing continuations, queued user input, earlier redaction, and human-blocked text are covered separately.
