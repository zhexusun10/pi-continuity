# Changelog

## [Unreleased]

## [0.1.1] - 2026-10-11

### Added

- PNG and GIF/MP4 mechanism illustrations with reproducible rendering source and explicit provenance; no new model experiments.
- Gallery image/video metadata.
- Explicit `terminated` / `TypeError: terminated` regression coverage for native retry, bounded fallback, safe partial context, cancellation, and queued steering input.
- Provider-independent timed recovery for `Try again in ~N min.` / `Retry in N mins/minutes` errors, including ChatGPT/Codex API/login paths. Wait the advertised minutes, add 30 seconds for approximate rounding, and continue the same task within the total recovery budget.
- Virtual-clock regression coverage for five-hour waits, native 429 ordering, exact/approximate zero-minute guidance, cancellation/off/queued input, protocol safety, and timer overflow.

### Changed

- Validate compatibility against Pi 1.0.3 and 1.1.0, and pin the AgentSession, pi-ai, and agent-core development peers to 1.1.0. Pi's native below-limit length recovery remains distinct from the extension's bounded continuation for hard output-cap stops; raw stop reasons and usage are not rewritten.
- Lead English/Chinese documentation with the paper-based case for robust loop engineering.
- Clarify CLI and AgentSession SDK support, and the adapter requirement for direct core-loop integrations.
- Merge same-request readable partial checkpoints into one bounded active context and omit stale recovery artifacts from later requests without rewriting raw history.
- Expand common transient transport/provider error patterns while keeping deterministic and unknown errors fail-closed.
- Reduce the default extension continuation cap to 8 and add a bounded `--continuity-checkpoint-max-chars` control (default 12,000; maximum 64,000).
- Use session-like public boundary retry for extension fallbacks, retaining hidden context only for bounded readable partial checkpoints and interrupted-tool notes.
- Extend default stream fallback to six attempts: three 5-second waits followed by three 10-second waits.
- Report pending recovery time and timed-limit counts through `/pi-continuity status`.

## [0.1.0] - 2026-10-04

### Added

- Output-cap continuation for text, thinking-only, empty, mixed, and tool-call responses using Pi's actionable boundary hooks.
- Safe quoted partial checkpoints, preserving raw history while omitting invalid interrupted protocol content from model context.
- Native-first stream recovery with a broader transport-error classifier, bounded extra fallback, and fixed-delay waits.
- Continuation for genuinely stopped tool-call tails, with opt-out for deliberately terminal tools.
- Per-user-request budgets, CLI flags, session status/toggles, and cancellation/queued-input guards.
- Unit and real AgentSession/faux-provider integration tests, offline RPC installation verification, and Linux/Windows CI.
- English/Chinese documentation and version-pinned paper/source evidence with explicit limitations.
