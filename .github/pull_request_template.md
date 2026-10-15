## Summary

<!-- What does this PR change and why? Link related issues: Fixes #123 -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation / tooling
- [ ] Other: ___

## Harness native mechanism

<!--
Before building or fixing anything the harness under ClawBox already does
(credentials, models, sessions, config, the gateway service, plugins, skills,
pairing, backups, updates), find how the PINNED version does it natively — its
CLI help, its config schema, its gateway RPC, its docs — and use that. One line
per harness this PR touches; delete the ones it does not.
-->

- OpenClaw `<version>`: <!-- a docs page, CLI command, config key or RPC method, e.g. `openclaw config set` (docs/cli/config.md) -->
- Hermes `<tag>`: <!-- e.g. `hermes gateway restart`, the dashboard's `reload.env` RPC -->
- none exists: <!-- why. That is a finding to raise upstream, not a licence to rebuild it -->

## Pinned harness versions changed?

- [ ] No
- [ ] Yes: OpenClaw `config/openclaw-target.txt` and/or Hermes `HERMES_PIN_COMMIT` in `install.sh` (`harness-pins.test.ts` and the `harness-contract` check say what has to move with them)

## How was this tested?

<!-- Commands, steps, or hardware used (e.g. Jetson Orin Nano, x64 dev install). -->

- [ ] `bun run lint` passes
- [ ] `bun run test` passes
- [ ] `bun run build` succeeds
- [ ] Manually verified on device / dev install

## Checklist

- [ ] Branch is up to date with the target branch
- [ ] Follows the conventions in [CLAUDE.md](../CLAUDE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] No secrets, tokens, or credentials committed
- [ ] Added/updated tests where it makes sense
- [ ] Updated docs where user-facing behavior changed

## Screenshots / logs (if UI or runtime change)

<!-- Drop images or terminal output here. -->
