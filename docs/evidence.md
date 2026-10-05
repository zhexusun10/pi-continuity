# Research basis: loop engineering

This document records two connected evidence sources: the paper's Terminal-Bench 4.0 benchmark analysis, which supplies the empirical reason for recovery, and this repository's deterministic AgentSession validation, which checks the implementation's control flow and package loading.

## Paper observations

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks](https://arxiv.org/html/2610.00917), arXiv:2610.00917, [§5.1 Feedback and Recovery](https://arxiv.org/html/2610.00917#S5.SS1), accessed 2026-10-04:

> PI also ends a run when a turn is cut short by the output cap, whereas OpenHands continues and openJiuwen re-prompts the model to continue with its partial reasoning kept (100 runs resumed, 48 of which went on to score above zero).

The same paragraph says this resumption was decisive in **2 of 6** inspected matched pairs. It also reports provider-stream errors in **25 of Kimi's 62 PI runs on TB4**, attributing them to harness resilience rather than model behavior.

The paper's Terminal-Bench 4.0 results establish that recovery and termination policy matter in these agent runs. Its limitations discuss the small matched-pair sample and the fact that the comparison does not isolate one component's causal effect. The figures are reported here as the paper's benchmark evidence for the problem this package addresses.

The paper's conclusion also distinguishes a genuinely unfinished step from a human-required blocker (for example, a CAPTCHA). The extension's recovery policy asks the next model turn to report a human-required blocker in text and stop; it does not add an unconditional final-answer re-check.

## Pi source inspected

Local `packages/coding-agent/package.json` reports **1.0.3**. Source checkout:

```text
04b97ef0007ad2d55615d0a545163387a701fc67
```

All source links below are pinned to that revision, not moving `main`.

### 1. Truncated tools are already protected

[`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/agent/src/agent-loop.ts#L258-L282) rejects tool calls from a `length` response with synthetic errors instead of executing potentially incomplete arguments. The tool batch then naturally continues. This is the fix identified as commit `351efc828` / PR [#6285](https://github.com/earendil-works/pi/pull/6285).

pi-continuity relies on this core safety behavior, never executes tools itself, and keeps the unexecuted-call explanation in an optional sanitized checkpoint before requesting the next boundary turn.

### 2. Pure text/reasoning length stops still have an exit path

The same loop sets `hasMoreToolCalls = false` when there are no tool calls. With no steering/follow-up message and no explicit finish-turn continuation decision, it exits and emits `agent_end` ([loop decision](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/agent/src/agent-loop.ts#L285-L320)).

**Important correction:** that is not the whole `AgentSession` behavior. The session's [`_checkCompaction()`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/coding-agent/src/core/agent-session.ts#L2917-L2999) can compact and retry a length stop once. [`isRecoverableLength()`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/ai/src/utils/overflow.ts#L174-L184) checks:

```typescript
message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput
```

Thus, length stops **below** the desired output limit can recover under the relevant compaction settings. Stops **at** that limit are not covered by this condition; disabled compaction and exhausted recovery also leave exit paths. Describing all pure-text truncation as unconditionally terminal in 1.0.1 would be inaccurate.

Our integration tests reproduce the at-cap baseline with compaction enabled, then show a next request when the extension is loaded. A `turn_end` boundary decision runs before post-run settlement and can request the next model turn without injecting a synthetic user message.

### 3. Native retries exist, but discard failed assistant context

[`_handlePostAgentRun()`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/coding-agent/src/core/agent-session.ts#L1807-L1843) performs native transient retries, compaction, and queued-message handling before the final boundary. [`_prepareRetry()`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/coding-agent/src/core/agent-session.ts#L3713-L3752) durably omits the failed assistant from model projection and waits with backoff. Provider [`transformMessages()`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/ai/src/api/transform-messages.ts#L195-L203) also skips errored/aborted assistants because incomplete reasoning/tool structures can be invalid to replay.

The public [`isRetryableAssistantError()` classifier](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/ai/src/utils/retry.ts) explicitly recognizes `terminated`. A finalized `stopReason: "error"` with that message follows native-first recovery; `stopReason: "aborted"` and explicit cancellation remain terminal.

This extension saves readable fragments as safe quoted text before native retry omission, reuses the native classifier with additional premature-stream patterns, and schedules fallback only at `agent_before_settle`. It does not replace native retry settings or pretend there was no failed response.

### 4. A tool may intentionally stop the loop

A tool batch can terminate the loop's normal follow-up. If the final substantive assistant block is a tool call and the session still reaches final settlement, the extension requests one next model turn after the completed tool result. Normal tool turns are left alone. The opt-out `--continuity-tool-tail=false` is important for tools intentionally designed to return structured data and end without text.

### 5. Evals reject a final length stop

[`packages/evals/src/harness.ts`, `promptAgent()`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/evals/src/harness.ts#L238-L254) awaits `session.prompt()`, then rejects a final stop reason other than `stop` or `toolUse`. A final `length` throws. It also rejects an empty final `stop` response.

An extension loaded into that session can change which assistant is final by actually making another request. It does not change this check or determine the reward. The outcome of a thrown exception depends on the surrounding evaluator; the guard itself does not assign a score.

## Illustration provenance

The README's PNG and animated GIF/MP4 are **mechanism storyboards**, illustrating the documented loop policy. They are not captured executions, new tests, live TUI recordings, or model-quality measurements. They do not plot the paper's 48/100 observation as this extension's success rate. [Rendering source and reproduction](assets.md).

## Existing implementation validation

- Deterministic unit tests for detection, budgets, quoted partial preservation, and cancellation/backoff.
- Integration tests use the **published Pi 1.0.3 SDK**, a real `AgentSession`, and Pi's in-memory faux provider. No real model APIs or credentials are used.
- Explicit `terminated` / `TypeError: terminated` fixtures in `tests/terminated.test.ts` cover empty/partial responses, native-first retry, exhausted-native fallback, protocol safety, budgets, cancellation, and queued steering input.
- Isolated offline RPC installation/command-load verification.

These validate the extension's control flow and package loading. The paper's Terminal-Bench 4.0 results provide the benchmark evidence for the underlying recovery problem; a separate real-model comparison would measure this package's task outcomes.
