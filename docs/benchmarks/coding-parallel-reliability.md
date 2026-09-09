# Coding Agent parallel reliability — September 2026

Changes follow a four-Jetson real-world application benchmark (not a model leaderboard).

- The Team planner/reviewer reads `resultText`, the complete CLI result. `summary` remains a 6,000-character display preview. Legacy records fall back to their summary. Invalid plans still fail closed and get at most one replanning attempt, with precise task/field/limit feedback.
- The planner knows the 2,000-character task-description limit and can partition independent work. An incomplete outer JSON array cannot be mistaken for its nested empty dependency array.
- Transcript paths encode **all non-ASCII-alphanumeric characters**, including the dot in `.clawbox` worktree paths.
- `workflowTelemetry` records actual child lifecycles from the current session's Workflow journals, excluding earlier resumed phases. Existing `subagents*` fields remain the legacy direct-helper/container counters; do not add containers to child counts. Per-workflow peaks describe overlapping lifetimes, not continuous simultaneous inference. Missing/truncated evidence is explicitly incomplete. Journal telemetry is derived from disk and does not add or rebill tokens.
- Vision responses and MCP transcripts include per-attempt requested model, response model (null if not returned), usage (null if absent), HTTP status, and elapsed time. These are auxiliary image-description calls, separate from coding-agent token totals. Model-resolution probes are not included; this is not complete invoice accounting.
- Browser calls name their coding run, so concurrent Team workers get their own file scope, session and download ownership. A live run may navigate to an HTTP loopback port >=1024 only when every identified listener belongs to its process group and project cwd. No arbitrary internal-service grant; navigation/redirect and subresource requests on run pages are checked. Use a normal background child, not a daemon detached into a new process group. WebSocket local-preview support is not added here.
- Completed Team roles clean up their process groups. Successful standalone runs retain the existing owner-managed app-preview lifecycle; stopped/failed runs still clean up. Browsers close only owned pages.

## Validation and next experiment

Regression tests cover full-plan transport >6K, partial JSON, exact schema limits, dotted worktrees, journal deduplication/resume boundaries/incomplete stops, vision retries/model usage, run-scoped browser sessions and an actual loopback listener with wrong-group/wrong-cwd/stopped-run denials. Team cleanup is checked with a real leftover child process; standalone preview retention is retained and tested.

After CI/review and beta deployment to all four Nanos, use new isolated project directories and identical frozen task/seed. Record complete handoffs, independent API/UI grades, real helper overlap, retries, model-specific usage and vision attempts. Keep token limits disabled. Preserve both earlier benchmark phases. Exercise controlled same-file conflicts, reviewer rejection and cancellation separately from throughput runs; do not quietly repair a measured agent output.
