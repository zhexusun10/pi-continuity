# Evidence and validation

This document separates paper observations, version-pinned Pi source inspection, and deterministic implementation tests. None of the repository's tests are real-model task-quality benchmarks.

## Paper observations

[Finding the Right Fit: Model–Harness Interactions across Agent Tasks](https://arxiv.org/html/2610.00917), arXiv:2610.00917, [§5.1 Feedback and Recovery](https://arxiv.org/html/2610.00917#S5.SS1), accessed 2026-10-04:

> PI also ends a run when a turn is cut short by the output cap, whereas OpenHands continues and openJiuwen re-prompts the model to continue with its partial reasoning kept (100 runs resumed, 48 of which went on to score above zero).

The same paragraph says resumption was decisive in **2 of 6** inspected matched pairs. It reports provider-stream errors in **25 of Kimi's 62 PI runs on TB4**, attributing them to harness resilience rather than model behavior.

These Terminal-Bench 4.0 observations motivate explicit recovery policy, but the small matched-pair sample does not isolate one component's causal effect. They are not this extension's success rate. In particular, the paper's partial-reasoning retention describes openJiuwen: **pi-continuity since 0.4.0 intentionally injects no partial text/reasoning, checkpoint, or hidden prompt**.

The paper also distinguishes unfinished work from human-required blockers such as CAPTCHA. A normal textual blocker/final answer does not trigger an unconditional extra requirements-check loop here.

## Historical source inspection

The original inspection used Pi **1.0.3**, source revision `04b97ef0007ad2d55615d0a545163387a701fc67`. The following links are revision-pinned:

- [Core truncated-tool protection and loop decisions](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/agent/src/agent-loop.ts#L258-L320): `length` tool calls receive synthetic errors instead of execution. Text/reasoning length stops without another continuation can exit the low-level loop.
- [Session compaction/retry](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/coding-agent/src/core/agent-session.ts#L2917-L2999) and [`isRecoverableLength`](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/ai/src/utils/overflow.ts#L174-L184): below-cap length stops can recover under relevant settings. It is inaccurate to describe every pure-text length stop as unconditionally terminal; the integration baseline specifically uses an at-cap output with compaction enabled.
- [Native retry/compaction/queue ordering](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/coding-agent/src/core/agent-session.ts#L1807-L1843) and [retry omission](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/coding-agent/src/core/agent-session.ts#L3713-L3752): native recovery precedes final settlement and omits failed assistant context.
- [Retry classifier](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/ai/src/utils/retry.ts): `terminated` is a native retry signal; explicit aborted responses remain terminal.
- [Provider message transformation](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/ai/src/api/transform-messages.ts#L195-L203): errored/aborted assistant protocol is not safe to replay.
- [Eval final-response guards](https://github.com/earendil-works/pi/blob/04b97ef0007ad2d55615d0a545163387a701fc67/packages/evals/src/harness.ts#L238-L254): the harness awaits `session.prompt()` and rejects invalid final stop reasons or empty final stops. An extension must make an actual next request, not rewrite failure as success. The surrounding evaluator, not this guard alone, determines reward.

Codex rounded-minute guidance was additionally checked against Pi **1.1.0**, revision `cdaf6c227d4718a72b59ccd02152c9614df44cfc`: [`parseErrorResponse`](https://github.com/earendil-works/pi/blob/cdaf6c227d4718a72b59ccd02152c9614df44cfc/packages/ai/src/api/openai-codex-responses.ts#L1596-L1623) can emit `Try again in ~N min.` from an HTTP reset timestamp. Other in-band stream errors can expose only `Codex error: The usage limit has been reached`, with no reset timestamp. The extension retains a 30-second approximate-minute margin and does not invent reset timestamps for guidance-less errors.

## Current compatibility: Pi 1.5.2

Development dependencies pin `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-coding-agent` to **1.5.2**. Pi modules remain host-provided peers, not bundled runtime dependencies. Test tool schemas use the separately pinned `typebox` development dependency, matching the Pi 1.5.x SDK API.

Inspected published artifacts are version-pinned, not moving `main`:

- [Extension API and boundary/context contracts](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/extensions/types.d.ts).
- [Session projection contracts](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/session-manager.d.ts).
- [Agent session recovery and settlement](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/agent-session.js).
- [Agent lifecycle and queue selection](https://unpkg.com/@earendil-works/pi-agent-core@1.5.2/dist/agent.js).
- [Core error hard-exits and truncated-tool execution protection](https://unpkg.com/@earendil-works/pi-agent-core@1.5.2/dist/agent-loop.js).
- [Native transient error classifier](https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/utils/retry.js).

### Error recovery and cancellation

Generic `Bad Request` / `{"detail":"Bad Request"}` does not establish a transient or permanent cause. After terminal checks, undiagnosed errors receive a separate default 2-attempt cap, also consuming stream and total budgets. `--continuity-unknown-retries=0` disables that path. The reported error shape is reproduced with scripted responses and thrown errors, not a claimed live-provider reproduction.

The native retry classifier recognizes transport failures such as `ERR_HTTP2_STREAM_CANCEL` / `The pending stream has been canceled`. A broad cancellation-word exclusion would incorrectly suppress that recovery. Explicit user/request cancellation, including bare `aborted`, remains terminal. HTTP status is read from status-bearing prefixes/fields, not arbitrary byte counts, request IDs, or reset minutes.

Core error turns invoke the finish hook but hard-exit afterwards. Therefore a `turn_end` continuation flag is not proof a next request occurred. Fallback decisions remain at `agent_before_settle`, after native recovery and queues.

`ExtensionContext.signal` is active while streaming. Agent clears its active run before session-level settlement, so sleeping at settlement cannot reliably observe SDK abort through that signal. All extension waits now use live `turn_end`; settlement only checks policy and returns drafts. Native retry stays first after the wait and may add its own backoff. This is a latency trade-off, not a native-retry settings override.

### Projection safety and no prompt injection

A context edit replaces content or omits a projected contribution without changing raw metadata/history. The extension adds no `custom_message`, user text, quoted partial, interrupted-tool note, or other model-visible prompt. `custom` recovery counters are metadata only. Legacy pi-continuity prompt artifacts are excluded even when recovery is disabled, zero-budgeted, or fails closed. Already-omitted targets are not edited twice; active content-edited/restored targets remain eligible for omission.

`Agent.continue()` immediately drains follow-up input when its transcript ends in an assistant. Omitting that tail prematurely can cause an old-task request first. With queued input after an error, the extension retains the tail until queue selection, then excludes broken protocol in request-time context. Input interruption is recorded before the host asynchronously enqueues transformed input. No cached text can be re-injected because no partial text is copied at all.

### Cooldown formats

The parser in `lib/retry-delay.ts` is extension policy, not a claim that every provider emits these formats. Synthetic fixtures cover the user-reported `cooldown: ...s`, `h`/`s`/`min`/`miutes`, related aliases, fractions, compounds, explicit fields, and numeric/date Retry-After. Several valid hints use the longest delay. Invalid/unrelated values are not inferred from arbitrary numbers.

A recognized usage limit without valid guidance polls every 10 minutes, initially for at most 5 hours / 30 attempts; after an exhausted window, later windows use 5 h 20 min / 32 attempts. These are bounded policy windows, not measured provider reset guarantees.

## Deterministic validation

The current suite uses a real **Pi 1.5.2 AgentSession** and in-memory faux provider, never real model APIs or credentials:

- `tests/extension.test.ts`: at-cap baseline, output shapes, native-first retry, no prompt injection, tool-tail behavior, history/projection safety, legacy cleanup, extension composition, and budgets.
- `tests/terminated.test.ts`: `terminated`/thrown errors, native-first ordering, bounded fallback, cancellation, raw usage/history, and safe queued input.
- `tests/error-recovery.test.ts`: generic/missing/unknown errors, independent/shared caps, terminal exclusions, reasoning-only responses, cancellation, and earlier boundary decisions.
- `tests/usage-limit.test.ts` and `tests/retry-delay.test.ts`: virtual long waits, format parsing, rounding, malformed values, no early native 429 retry, zero-duration bounds, polling windows, and cancellation.
- `tests/live-backoff.test.ts`: SDK abort without advancing the backoff clock, exhausted-native cancellation, steering/follow-up races, no partial/signature/tool-argument injection, and off behavior.
- `tests/review-regressions.test.ts`: status/cancellation classification, deprecated helper bounds, fail-closed configuration, projection redactions, legacy cleanup, and native truncated-tool continuation after zero/exhausted extension budgets.
- Isolated offline source/tarball RPC installation and `/pi-continuity` command loading; package manifest review excludes development dependencies, credentials, workspaces, and transcripts.

The earlier 138-test pre-release suite used Pi 1.0.3; 0.4.0 recorded 172 tests on Pi 1.5.0. Historical counts are not substitutes for validating the current build. Real-model comparisons would require separate authorization and reporting of models, prompts, budgets, repetitions, and failure accounting.

## Illustration provenance

README PNG/GIF/MP4 assets are **mechanism storyboards**, not captured executions, live TUI recordings, or model-quality measurements. They do not present the paper's 48/100 observation as this extension's success rate. See [assets.md](assets.md) for provenance and reproduction.
