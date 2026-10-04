# Contributing

Use English for issues, pull requests, and primary documentation; Chinese translations are welcome.

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run verify:load
npm pack --dry-run
```

Keep the runtime extension free of direct network/filesystem access, telemetry, and core patches. Pi owns model requests, tool execution, and session persistence. Use public actionable boundaries; do not hide failures by changing stopReason to a successful value.

Every recovery change needs regression coverage for normal final text, cancellation, pending user input, native retries, bounded spending, and protocol safety. Use the in-memory faux provider and real AgentSession fixture, not real credentials or paid providers. Keep direct development dependencies pinned; host-provided Pi packages stay peer dependencies with `*` ranges.

Report real model measurements separately from deterministic control-flow tests. Include versions, provider/model, tools, prompts, all retry/compaction/time/token budgets, baseline, repetitions, and failure accounting. Do not infer reward improvements from the paper's matched pairs or synthetic recovery tests.

When reporting a bug, remove private prompts, sensitive reasoning, tool arguments, paths, and credentials from session excerpts. Include final stopReason/errorMessage and whether the harness waits for agent_settled.
