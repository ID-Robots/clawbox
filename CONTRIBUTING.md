# Contributing to ClawBox

Thanks for your interest in ClawBox! 🦞

We welcome pull requests from the community. External contributors can open PRs from a fork; the [ID Robots core team](https://github.com/orgs/ID-Robots/teams/id-robots-core-team) reviews, approves, and merges.

## Ways to contribute

### Pull requests

1. **Fork** [ID-Robots/clawbox](https://github.com/ID-Robots/clawbox) to your account.
2. **Clone** your fork and create a feature branch:
   ```bash
   git clone git@github.com:<you>/clawbox.git
   cd clawbox
   git checkout -b my-change
   ```
3. **Set up** the dev environment (see [README.md](README.md) and [CLAUDE.md](CLAUDE.md)):
   ```bash
   bun install
   bun run dev
   ```
4. **Make your change.** Keep PRs focused — one logical change per PR.
5. **Run checks locally** before pushing:
   ```bash
   bun run lint
   bun run test
   bun run build
   ```
6. **Open a PR** against `main`. The PR template will guide you through the checklist.
7. A core team member will review. Address feedback by pushing new commits to the same branch.

### Bug reports

[Open an issue](https://github.com/ID-Robots/clawbox/issues/new/choose) with:
- Steps to reproduce
- Expected vs actual behavior
- Device info (Jetson model, JetPack version, ClawBox version)
- Screenshots or terminal output

### Feature requests

[Start a discussion](https://github.com/ID-Robots/clawbox/discussions) and we'll consider it for the roadmap.

### Security

Found a vulnerability? **Do not open a public issue.** Email **yanko@idrobots.com** directly.

## Guidelines

- **Code style:** ESLint + TypeScript. Run `bun run lint` before committing.
- **Tests:** Add or update tests in `src/tests/*.test.ts`. Coverage target is 80%.
- **Commits:** Keep commit messages clear and descriptive. Squash noisy WIP commits before review.
- **Shell commands:** Use `execFile`, never `exec`, to avoid injection (see existing code in `src/lib/network.ts`).
- **API routes:** Always export `export const dynamic = "force-dynamic"`.
- **No direct pushes to `main`** — protected branch. All changes go through PR.
- **Signed-off commits are welcome but not required.**

## Review process

- 1 approving review from a code owner (`@ID-Robots/id-robots-core-team`) is required
- All CI checks (Test, Build, Lint) must pass
- All review conversations must be resolved
- PRs are merged by the core team once approved

## Community

- [Discord](https://discord.gg/FbKmnxYnpq) — get help, share your setup
- [Discussions](https://github.com/ID-Robots/clawbox/discussions) — ideas and Q&A

## Code of Conduct

Be respectful. We're building something cool together. 🤝
