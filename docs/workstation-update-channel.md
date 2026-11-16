# The Workstation update channel

A ClawBox Workstation (DGX Spark and its partner builds) runs the same code as
every Jetson ClawBox, from the same repository and the same branches. What
differs is **when** a version reaches it. A Jetson follows `beta` or `main` as
it always has. A Workstation follows the **`workstation`** branch, and that
branch moves only when someone promotes a commit that was tested on a
Workstation. Nothing moves it automatically: no CI job, no merge, no release.

There is no Workstation fork. `workstation` always points at a commit that is
already on `beta` or `main`, and the promotion script refuses any other.

## How a box picks its channel

`src/lib/update-channel.ts` decides once per check and once per update:

| Box | Channel | Branch it updates from |
|---|---|---|
| Jetson ClawBox (`/etc/nv_tegra_release`) | branch rules | `.update-branch`, else its checkout's branch, else `main`. Unchanged. |
| ClawBox Workstation: arm64, not a Jetson, installed with `install-x64.sh` (the root-owned `/etc/clawbox/x64.env` names its checkout) | workstation | `workstation`. The pin is ignored. |
| x86_64 PC installed with `install-x64.sh` | branch rules | as a Jetson |
| PC with the x64 desktop integration package | branch rules | as a Jetson (its root step fetches the recorded branch itself) |

This is the same test `install-x64.sh` applies when it agrees to install on
an arm64 host (`host_arch_or_refuse`). On a Workstation, `.update-branch`
holds the branch the installer cloned (`main` or `beta`). That is a record of
the install, not a choice to follow beta, so the channel ignores it. The
Beta toggle and the branch override in **System Update → Advanced options**
write that same file, so they do not apply on a Workstation. The screen says
so: *"Updates follow `workstation`, the ClawBox Workstation channel…"*.

Nothing is written for the channel. It is not stored in `.update-branch`, and
the updater's auto-repin skips it.

### When there is nothing on the channel

If GitHub has no `workstation` branch (nothing promoted yet, or the branch was
deleted), the Workstation stays on the version it has, and says so. A local
copy of a deleted branch is dropped, as `git fetch --prune` would drop it:

- **The update check** reports *"Couldn't check for updates"* with the reason
  *"No version has been released on the ClawBox Workstation update channel
  yet: GitHub has no "workstation" branch. This Workstation stays on the
  version it has and does not follow beta or main instead."* It offers no
  update. In particular it does not offer `main`'s release tag, because a
  Workstation installs the `workstation` branch or nothing.
- **An update** fails at step 1, before the checkout is touched: *"There is
  nothing to update to: no version has been released on the ClawBox
  Workstation update channel yet… Nothing was changed."*

It never falls back to the pin, to `beta` or to `main`.

## Override (testing)

`CLAWBOX_UPDATE_CHANNEL` in the checkout's `.env`. The web server
(`clawbox-setup`) loads that file, so restart the server after you change it:

| Value | Effect |
|---|---|
| unset, empty or `auto` | the hardware decides (the table above) |
| `branch` | the branch rules, also on a Workstation. Use this to test a `beta` build (or a PR branch, through the branch override) on a Workstation before you promote it. |
| `workstation` | the Workstation channel on a PC installed with `install-x64.sh` that is not a Workstation, such as a test PC |

Any other value is refused. The update stops before step 1 with the box as
it was, and the check reports the reason; neither one guesses a branch. `workstation` is also refused on a
Jetson and on a desktop-integration PC. There, `install.sh` or the
integration's root step fetches the recorded branch before the web server's
updater runs, so the setting could only be half honoured.

Remove the line (and restart) when the test is done. Forgetting a
`CLAWBOX_UPDATE_CHANNEL=branch` line leaves the Workstation following beta.

## Promoting a tested commit

1. Choose the commit. It must already be on `beta` or `main`, for example the
   `beta` head a release candidate was cut from. Use its full 40-character sha:
   `git rev-parse origin/beta`.
2. Test that exact commit on a Workstation. Put the box on the branch rules
   (`CLAWBOX_UPDATE_CHANNEL=branch`, pin `beta` or the branch that holds the
   commit) and update it. Check that `git -C <checkout> rev-parse HEAD` is the
   commit, then run the checks the release needs.
3. Dry run, from any up-to-date checkout of this repository:

   ```bash
   scripts/promote-workstation.sh <sha>
   ```

   It prints the commit, the current `workstation` tip and every commit that
   would reach Workstations, and pushes nothing.
4. Promote:

   ```bash
   scripts/promote-workstation.sh <sha> --push
   ```

   Pass `--remote <name|url>` when your push remote is not `origin`.
5. Take the test Workstation off the override (remove the `.env` line, restart
   the web server). **System Update → Advanced options** should now say
   *"Updates follow `workstation`, the ClawBox Workstation channel…"*. The box
   is already at the promoted commit, so its check offers nothing. A
   Workstation behind it is offered `workstation@<sha>` at its next check. The
   check result is cached for up to 30 minutes, and **Check for updates**
   refreshes it.

The script refuses, and pushes nothing, when:

- the argument is a branch name or a short sha. Only the exact tested commit
  is accepted, since a branch can move between the test and the promotion;
- the commit is on neither `beta` nor `main` of the remote;
- the move is not a fast-forward of the current `workstation` tip;
- `workstation` moved on the remote while the script ran. The push carries a
  lease on the tip it read, so two promotions cannot overwrite each other.

### Rolling back

To send Workstations back to an older tested commit, pass `--rollback`. That
allows a move that is not a fast-forward:

```bash
scripts/promote-workstation.sh <older sha> --rollback --push
```

Rolling back over a harness pin change is limited by the updater's
harness-downgrade guard (docs-site *Going back to an older release*). A
Workstation whose data a newer OpenClaw or Hermes already migrated refuses
the older version until its owner chooses "Back up and switch anyway". The
usual fix for a bad promotion is to promote a fixed commit forward instead.

## Where it lives

- `src/lib/update-channel.ts`: the decision, the override and the sentences.
- `src/lib/updater.ts`: `resolveUpdateBranch` (rule 0), `getPinnedBranchTarget`
  (the check), `fetchUpdateBranchAsOwner` (step 1 on an `install-x64.sh` PC),
  `repinUpdateBranch` (never pins the channel), and the run's pre-flight. The
  pre-flight refuses a channel it cannot decide before step 0, so it applies
  on a Jetson too, where step 0 is `install.sh`.
- `src/lib/build-identity.ts`: the drift report compares a Workstation with
  its channel's tip, not with the branch `install-x64.sh` recorded.
- `scripts/promote-workstation.sh`: the promotion.
- Tests: `src/tests/unit/update-channel.test.ts`,
  `src/tests/unit/updater-workstation-channel.test.ts` (real git repositories,
  both platforms) and `src/tests/unit/promote-workstation-script.test.ts`.
