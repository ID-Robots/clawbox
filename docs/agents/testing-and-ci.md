# Testing and CI

CI behaviour that the short Testing section in CLAUDE.md leaves out. Read it when you change a workflow under `.github/workflows/`, `e2e-install`, or the triage and review bots' scripts; the on-device suite is `docs/nano-hardware-tests.md`.

## Testing

- **CI**: `.github/workflows/e2e-install.yml` writes repository secrets into `e2e-install/.env.test` only when the event is NOT a `pull_request` (a same-repo PR head supplies the Playwright code that reads that file — and the workflow file itself, so the `if:` is hygiene and the real fence is the owner keeping those secrets in a GitHub Environment restricted to beta/main); same-repo PRs therefore behave like fork PRs and the credentialed specs skip. `scripts/issue-triage.mjs` and `scripts/pr-review.mjs` validate the model's JSON against their SCHEMA on BOTH transports (`assertMatchesSchema` in `scripts/lib/triage-output.mjs`: enum/type violations throw loudly, unknown keys are dropped, free text is truncated), derive every label from fixed tables, and pass free text through `plain()` before it reaches a bot comment — the `issues` workflow runs main's copy, so the fix is inert until it reaches main.

## The bench (score a live box)

`scripts/bench/clawbox-bench.mjs` (`bun run bench`) is not a test but a scorecard: it drives the LIVE box through the kiosk Chrome's DevTools port (the signed-in desktop page runs every request and the gateway socket, so the bench never handles a credential), scores each area 0–100 against coarse Jetson-minded anchors, and `compare` reads two reports as better/same/worse past a noise threshold. Areas, anchors, what it touches and how to read a result: `docs/clawbox-bench.md`; the arithmetic is pinned by `src/tests/unit/bench-score.test.ts`. Run it before and after an update, `--runs 3` when the box is busy.
