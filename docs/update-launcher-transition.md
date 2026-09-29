# Never strand a box between two root-step contracts

Engineering note for the updater. Written for TASK-1316.

## The failure

A web build starts root steps one of two ways:

* **Before TASK-539** (every 3.x build up to 5d7d1559): `systemctl start
  clawbox-root-update@<step>.service` with no sudo. That is authorised by the
  polkit `.pkla` grant for `org.freedesktop.systemd1.manage-units`, and only by
  that grant. JetPack ships polkit 0.105, which ignores `rules.d`, so
  `config/49-clawbox-updates.rules` does not help there.
* **From TASK-539 on:** `sudo -n /usr/local/libexec/clawbox/clawbox-run-root-step.sh
  <step>`, authorised by one sudoers line (`src/lib/root-step-runner.ts`).

`step_polkit_rules` removes the old grant, because that grant is arbitrary root
for the clawbox account. Until TASK-1316, `step_rebuild_reboot` ran it **before**
`do_rebuild`. When the rebuild then failed (bun install, the 4 GiB swap gate, an
OOM kill), `do_rebuild` put the previous build back and returned non-zero. The
box was left like this:

* the old web server was still running (it had never been replaced);
* the grant it needed was gone;
* every update died at step 1 with polkit's `Interactive authentication
  required`.

No later release can fix that from inside. The update is exactly what that
server can no longer start, and the running code cannot be changed by a PR. A
customer's box was found in this state: running build 6b2adde, tree 35cee34,
grant stripped.

## The rules now

1. **A privilege path the web build on disk still uses is not removed.**
   `step_polkit_rules` asks `config/clawbox-build-heal.sh --build-uses-launcher`
   first. That script greps the compiled server of the build a server would run
   (`.next/standalone`, or a parked `.next-old/standalone`, which
   production-server.js reclaims at boot) for the launcher path. If the build
   does not contain it, and the box still has the grant, the grant is **kept**.
   A box that does not have the grant never gets it back.
2. **It is removed once a new build is verified on disk.** The callers are:
   * `step_rebuild_reboot`, right after `do_rebuild` returns 0 and before the
     reboot or restart;
   * the legacy handover (TASK-789), which already rebuilt first;
   * `post_update`, as a backstop;
   * `heal_build` (below).

   The other halves of the contract are additive for an old build: the launcher,
   the dispatcher, the mirror and the unit files are new files it does not call.
   The dispatcher is still installed only after the mirror is staged
   (`docs/root-exec-mirror.md`).
3. **The sudoers narrowing is the one subtractive change that stays early.**
   TASK-539 replaced the four exact `systemctl start clawbox-root-update@…`
   grants (chpasswd, set_hostname, restart_ap, llamacpp_install) with the
   launcher grant. A pre-539 build therefore loses those four hand-offs from the
   moment `step_systemd_services` runs until its replacement is built. The
   updater itself is unaffected, because it keeps the polkit grant (rule 1).
   That failure rolls forward on its own: the owner re-runs the update, which
   still works, or the boot heal rebuilds.

## Self-heal at boot: `clawbox-build-heal.service`

This is a root oneshot, `WantedBy=multi-user.target`. It runs
`/usr/local/libexec/clawbox/clawbox-build-heal.sh`, which is installed root-owned
by `install_root_libexec` and granted to nobody. On a healthy box it compares
the build's commit with `HEAD` (read with git **as the tree's owner**), checks
that the launcher and its sudoers line are present, and exits in well under a
second having changed nothing.

It heals two states:

| reason | condition | what `step_heal_build` does |
|---|---|---|
| `stale-build` | The build does not match `HEAD`, predates the launcher, and the tree uses the launcher. | `do_rebuild` from the tree **on disk** (no fetch, no reset, local edits kept), then `step_systemd_services`, then restart `clawbox-setup`, then `step_polkit_rules`. |
| `root-contract-missing` | The build uses the launcher, but the launcher or its sudoers grant is missing. | `step_systemd_services`, then `step_polkit_rules`. |

It goes through the root dispatcher as step `heal_build`, like any other root
step. `heal_build` is **pinned** and not in the self-updating family. The
dispatcher therefore runs it out of the mirror, and only while the tree still
matches the root-exec record (TASK-445/733). Nothing about the heal lets root
run code it did not record. It is in `DISPATCH_STEPS` and the dispatcher's
`ALLOWED_STEPS`. It is on no launcher or UI list, so the web server cannot start
it.

It is **bounded**: at most 2 attempts per tree commit and reason. Each attempt
is recorded in `/var/lib/clawbox/build-heal.state` (root 0644, `key=value`):
when it ran, why, and how it ended. After two failures the unit says
`NOT retrying` on every boot, with the manual command
(`sudo bash /home/clawbox/clawbox/install.sh --step heal_build`). It counts
again only when the tree moves to another commit. Deleting the state file resets
the count.

While a `stale-build` heal rebuilds, the dashboard is down. That is the same
window as the rebuild of an ordinary update.

## When the web server cannot ask the launcher

`startRootStep` turns a launcher that could not even be asked into a
`RootStepUnavailableError`. The cases are:

* sudo refused: the grant is missing;
* `command not found`: the launcher is missing;
* `step not permitted from the web server`: the launcher is older than the
  build.

The message says what is wrong and names one Terminal command:

* on the appliance: `sudo bash /home/clawbox/clawbox/install.sh --step systemd_services`;
* on an x64 desktop install: `install-x64.sh --step root_step_contract`.

The updater does not dress that message up with an older journal line from the
same unit.

## Local edits survive an update

Every reset an update performs is preceded by `scripts/preserve-local-edits.sh`:

* the bootstrap block at the top of install.sh;
* `sync_repo_to_update_target`, used by step 1 and by `--step git_pull`;
* src/lib/updater.ts's own `reset --hard` and `clean -fd` (via `src/lib/local-edits.ts`).

The script runs as the checkout's owner. It saves to
`/home/clawbox/clawbox-local-edits/<UTC timestamp>/`:

* `tracked.patch`;
* `untracked/`;
* `STATUS`, `BASE` and `README.txt`.

It keeps the newest 5 saves. The owner is told where the edits went through a
`CLAWBOX-WARN[local-edits-saved]` card on the update result. If the copy cannot
be written, the edits go into the checkout's `git stash`, which is said just as
loudly. Only if neither can hold them does the update stop, with the tree
untouched. The update then runs on a clean tree: `sync_repo_to_update_target`
now also runs `git clean -fd`, as the in-app updater always has.

The first update **into** a release that carries this runs the previous
release's bootstrap block, which does not save. Only updates after that are
covered.

## A box that is already stranded

The fix cannot reach a box whose running build predates this change. Its owner,
or support, can recover it by hand. The owner needs the box's password, for
sudo.

The in-UI Terminal is served by the web server that step 3 stops, so step 3 runs
in its own transient unit.

```sh
# 1. Save the local edits (Terminal app or SSH, as the clawbox user)
sudo chown -R clawbox:clawbox /home/clawbox/clawbox/.git
cd /home/clawbox/clawbox
save="/home/clawbox/clawbox-local-edits/manual-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$save/untracked"
git rev-parse HEAD > "$save/BASE"
git status --short --untracked-files=all > "$save/STATUS"
git diff --binary HEAD > "$save/tracked.patch"
git ls-files -z --others --exclude-standard | xargs -0 -r cp -a --parents -t "$save/untracked" --
ls -la "$save" "$save/untracked"

# 2. Move the code to the current release of this box's channel
b=$(git branch --show-current); b=${b:-main}; echo "channel: $b"
git fetch origin
git checkout -f "$b"
git reset --hard "origin/$b"
git clean -fd

# 3. Rebuild from that code and put the root side of the launcher contract in
#    place, in that order, outside the web server's process tree
sudo systemd-run --unit=clawbox-recovery --collect \
  -p EnvironmentFile=-/etc/clawbox/network.env -p EnvironmentFile=-/etc/clawbox/edition.env \
  /bin/bash -c 'cd /home/clawbox/clawbox; bash install.sh --step systemd_services || echo "WARNING: systemd_services reported a problem, rebuilding anyway"; bash install.sh --step rebuild && bash install.sh --step polkit_rules'
journalctl -fu clawbox-recovery      # the Terminal disconnects when the web server restarts

# 4. Reload the dashboard. System Update → Update now finishes the rest
#    (OpenClaw core, system fixups) through the launcher.
```

Put the edits back with `git apply --3way "$save/tracked.patch"` and
`cp -a "$save/untracked/." /home/clawbox/clawbox/` once the box is on the new
release, if they still apply.
