# Changelog

## [0.1.0] - 2026-10-04

### Added

- Output-cap continuation for text, thinking-only, empty, mixed, and tool-call responses using Pi's actionable boundary hooks.
- Safe quoted partial checkpoints, preserving raw history while omitting invalid interrupted protocol content from model context.
- Native-first stream recovery with a broader transport-error classifier, bounded extra fallback, and exponential backoff.
- Continuation for genuinely stopped tool-call tails, with opt-out for deliberately terminal tools.
- Per-user-request budgets, CLI flags, session status/toggles, and cancellation/queued-input guards.
- Unit and real AgentSession/faux-provider integration tests, offline RPC installation verification, and Linux/Windows CI.
- English/Chinese documentation and version-pinned paper/source evidence with explicit limitations.
