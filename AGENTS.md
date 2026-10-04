# Repository rules

- Scope edits to this repository. Do not patch the host Pi source or installation.
- Runtime extension: no direct provider requests, filesystem access, telemetry, or private internal APIs.
- Preserve raw failure/usage history. Never fabricate success by rewriting stopReason.
- Use public boundary drafts, preserve earlier entries, and guard continuation against cancellation, queued input, and unbounded spending.
- Treat readable partial reasoning as sensitive context; never copy opaque signatures, redacted thinking, or interrupted tool arguments.
- Keep Pi modules host-provided peers; pin direct development dependencies and use `--ignore-scripts` for dependency installation.
- Use strict TypeScript, no `any`, and top-level imports.
- Run `npm run check`, `npm test`, `npm run verify:load`, and `npm pack --dry-run` after code changes. Tests must never call real model APIs.
- Cite version-pinned source and distinguish paper observations, control-flow tests, and real-model benchmarks.
- Do not publish to npm, create releases, or run paid benchmarks without explicit authorization.
