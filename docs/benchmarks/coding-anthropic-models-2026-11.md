# Coding Agent on Anthropic models — price against quality, November 2026

Measured on one x64 box on 2026-11-09 and 2026-11-10, through the box's own routes (`/setup-api/coding-agent/run` and `/team`), on throwaway clones of two of the owner's installed apps and then on all seven of the real projects. It is the evidence behind the Anthropic defaults in `src/lib/coding-role-models.ts` and `src/lib/coding-provider.ts`. Every figure is ONE run: read the table for its large gaps, not its small ones.

## Method

- **Two tasks, each a full release of a real app** (Next.js 16 + bun, an HTTP API, an MCP server, a phone-width UI gate): **T1**, Calculator 1.3.0 "scientific engine" (an expression grammar with functions, constants, postfix operators and exact error rules); **T2**, Todo 1.3.0 "notes, tags and undo" (a data-model change through the store, the API, the MCP server and the UI). Each goal is a written specification of about 3,000 characters with a handful of examples.
- **A hidden acceptance test per task**, never shown to a run: 111 expression cases for T1 and 48 API checks for T2, plus the app's own gates run on the result (`bun test`, typecheck, build, the MCP smoke test, the mobile gate). T1 also has 58 robustness cases written afterwards from the specification's rules and from defects the runs' own review passes found.
- **Cost is the list price of the tokens each run reported** (input, output, cache write at the one-hour rate Claude Code uses, cache read), in dollars per million: Fable 5.2 8 / 40 / 16 / 0.2, Opus 5.5 4 / 20 / 8 / 0.2, Sonnet 5.5 2 / 10 / 4 / 0.1, Haiku 5.5 0.1 / 0.5 / 0.2 / 0.01. The box ran on a subscription sign-in, so these are comparison figures, not a bill.
- **Wall time** is from the start request to the last run settling, with at most two runs side by side (the owner's setting).

## Results

### T1 — Calculator 1.3.0 (111 hidden cases, 58 robustness cases)

| Shape | Models and effort | Cost | Wall | Hidden | Robustness |
|---|---|---|---|---|---|
| Team, the defaults before this work | Fable 5.2 planner at xhigh, four Opus 5.5 workers at ultracode, one Opus 5.5 final review at xhigh | $12.34 | 35 min | 111 | 58 |
| One run + review pass | Opus 5.5 at xhigh (pass at ultracode) | $7.01 | 30 min | 111 | 58 (56 before the pass) |
| One run + review pass | Sonnet 5.5 at xhigh (pass at ultracode) | $3.41 | 39 min | 111 | 58 (57 before the pass) |
| One run + review pass | Haiku 5.5 at xhigh | about $0.40 | 33 min | 111 | 57 |
| One run, no pass | Opus 5.5 at low | $1.27 | 19 min | 111 | 56 |

The planner alone, same goal: Fable 5.2 at xhigh $4.39 in 9 minutes, Fable 5.2 at high $2.47 in 4 minutes with the same four-task plan, Opus 5.5 at high $0.76 in 3 minutes with a comparable three-task plan.

### T2 — Todo 1.3.0 (48 hidden checks)

| Shape | Models and effort | Cost | Wall | Hidden | Gates |
|---|---|---|---|---|---|
| One run + review pass | Sonnet 5.5 at medium | $1.68 | 13 min | 48 | all green |
| One run + review pass | Opus 5.5 at medium | $6.56 | 25 min | 48 | all green |
| Team, the new defaults | Fable 5.2 planner at high ($6.29), five Sonnet 5.5 workers at ultracode ($9.07), five Opus 5.5 reviewers at high ($1.98) | $17.33 | 74 min | 48 | all green |
| Team, the new defaults and the planner told that dependent steps are one task | Fable 5.2 planner at high ($6.17), four Sonnet 5.5 workers at ultracode ($6.57), one Opus 5.5 final review at high ($0.51) | $13.25 | 44 min | 48 | all green |
| Team, the planner also given a yardstick, asked for at `medium` | Fable 5.2 planner at medium ($1.09, one minute) plans ONE task; it runs as one Sonnet 5.5 run at medium ($1.20) with its review pass ($0.35) | $2.64 | 13 min | 48 | all green |

Both single-run interfaces were looked at as screenshots at 390 and 320 pixels: no overflow, no page errors, the three new features usable in each.

### Seven real releases, through the box's own flow

After the defaults changed, the owner's apps were given a 1.3.0 release each as ONE ordinary run on the real project — the two benchmark tasks among them, run again where they belong — the run's own worktree, the automatic review pass, the pull request the box opens and merges itself. No model was named, so each ran on the new default (Sonnet 5.5). Each result was then checked out in a throwaway clone: the app's own gates, and a probe of the goal's stated rules against the built app.

| Release | Effort | Cost | Wall | App's gates | Rules probed | Outcome |
|---|---|---|---|---|---|---|
| Habit Tracker 1.3.0 — weekly targets, CSV export | medium | $1.18 | 10 min | all green | 17 of 17 | merged by the box |
| Notes 1.3.0 — pin, archive, export and import | medium | $1.75 | 16 min | all green | 15 of 15 | merged by the box; the review pass fixed one real interface defect |
| Pomodoro 1.3.0 — daily goal, statistics | medium | $1.72 | 13 min | all green | 12 of 12 | merged by the box |
| Timer 1.3.0 — labels, preset editing, export | ultracode (the owner's setting) | $7.82 | 47 min | all green | 11 of 11 | merged by the box; the review pass fixed one real defect |
| Audiobook Player 1.3.0 — bookmarks, a speed per book | medium | $3.19 | 18 min | all green (109 tests) | not probed | merged by the box, and brought into the project folder by it |
| Todo 1.3.0 — notes, tags, undo (T2) | medium | $1.69 | 14 min | all green | 48 of 48 hidden | merged by the box, and brought into the project folder by it |
| Calculator 1.3.0 — scientific engine (T1) | medium | $0.80 | 11 min | all green | 111 of 111 hidden, 58 of 58 robustness | merged into the project folder (its goal refused a pull request) |

The five `medium` runs on the small apps cost $0.80 to $1.75 and took 10 to 16 minutes; the larger Audiobook Player cost $3.19 and 18. The Todo run repeated its benchmark figure to the cent ($1.68 on the clone), and Calculator at `medium` reached the score its $12.34 team did. The one run left on the owner's `ultracode` setting cost $7.82 and took 47 — four to ten times the cost and three to four times the wait for a release the size of the other small ones, with more tests written (71, where Habit Tracker, Notes and Pomodoro wrote 22 to 30) and no difference the gates or the probes could see.

## What the figures say

1. **Sonnet 5.5 writes these tasks as well as Opus 5.5 for a quarter to a half of the cost.** Same hidden score on both tasks, same robustness score after the review pass on T1, and on T2 half the wall time. It is now what a team's worker and an unnamed single run get. Opus 5.5 stays the reviewer.
2. **The shape costs more than the model.** T2 as a five-task team cost ten times what one run of the same goal did and took almost six times as long, for the same 48 of 48. Every task is a fresh session that learns the project again (about 130,000 tokens of cache written per worker) and, under review "each", a reviewer run. The planner's brief used to ask for exactly that plan — "any chain where each step builds on the last, runs serially" — and now says such steps are one task; a one-task plan already runs as one ordinary run. Told that, the planner dropped one task and chose a single final review: a quarter cheaper and 40% faster, and still eight times the single run. So the brief now also carries a yardstick — a whole feature release of a small app is one session's work — and with it the planner planned this release as one task, at `high` ($3.75 for the plan, against $6.17 and $6.29 for the four- and five-task plans) and at `medium` ($1.09). The last row is that plan run end to end: a goal sent to a team now costs about what it costs sent to a single run. It differs from the rows above it in effort as well as in the brief, so read it against the single Sonnet run at medium ($1.68), not against the two teams at the owner's `ultracode`.
3. **The planner was the dearest run of every team it planned** ($4.39 of $12.34, $6.29 of $17.33). At `high` Fable 5.2 wrote the same plan as at `xhigh` for 56% of the cost in under half the time, so `high` is where a planner and a reviewer with no effort stored now start on Anthropic. Opus 5.5 planned comparably for a third of that again; it is the choice to store for the planner when cost matters more than the plan's detail.
4. **Effort is the other large lever, and the review pass earns its cost.** On real releases of one size, `ultracode` cost four to ten times what `medium` did (above). One Opus 5.5 run at `low` cost $1.27 against $4.72 at `xhigh` for the same hidden score — but it left two robustness defects, and the review pass found six real defects in the `xhigh` run's work. `medium` with the review pass on was the best value measured ($1.68 on T2). `ultracode` adds a sub-agent fan-out to a pass over a diff the run has just verified: $2.29 of the $7.01 run.
5. **Haiku 5.5 is a usable economy tier**: every hidden case, one robustness miss, for a small fraction of Sonnet's cost — at more turns and no saving in time. It replaces Sonnet 5 as the provider's economy model.

## What changed in the product

- `ROLE_DEFAULT_MODELS.anthropic`: planner `claude-fable-5-2`, worker `claude-sonnet-5-5`, reviewer `claude-opus-5-5`. `DEFAULT_ANTHROPIC_MODEL` (an unnamed single run): `claude-sonnet-5-5`. `ECONOMY_MODELS.anthropic`: `claude-haiku-5-5`.
- `ROLE_AUTO_EFFORT.anthropic`: a planner and a reviewer with no effort stored start at `high`; an effort the owner stores for the role is still honoured up to the `xhigh` cap.
- The planner's brief: steps that each build on the last are one task; only a chain too long for one session is split into serial tasks; and a yardstick for what one session does.
- Found by the seven real releases and fixed: a pull request the box merged never reached the project folder (the next run would have forked from the old base); a run's worktree mounted an app under the run's id instead of the app's (`CLAWBOX_APP_ID`); a Next.js build could not follow the linked `node_modules` in a run's worktree, so the review pass's preview failed (the worktree now gets a tree of hard links); a plan naming a path outside the project failed its single-run team; a folder named like an installed app could take over that app's registration while its server was down (`docs/agents/apps-and-webapps.md`); and a package install made in a run's evidence folder climbed to the box's own `package.json`.
- Found and fixed on the way (each has its paragraph in `docs/agents/coding-agent.md`): the review pass inheriting the owner's effort instead of its run's, a run that wrote through its shell recorded as changing nothing (so no review pass), the final reviewer shown only the first 1,200 characters of the goal, a rejected final review ending the team with all its work done, worktree paths left inside committed files, `bun test` projects treated as having no suite, the preview dying on an installed app's port, and screenshots a Claude run could not see.

## Limits of this benchmark

- One run per configuration, two tasks, one kind of project (a small Next.js app). A 10% difference here is noise.
- Both tasks fit in one session. Nothing here measures a goal too large for one — the case teams are for.
- The planner's cost was measured on its default model only as part of a team. Alone, on T1, Opus 5.5 planned for a third of Fable 5.2's cost; no team was run from an Opus plan.
- Haiku 5.5's cost assumes the short-context list price throughout; its runs were long, so its real figure may be higher.
- Prices are those in force on 2026-11-10.
