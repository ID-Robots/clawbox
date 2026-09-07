# The root-exec mirror, and how it reaches a box already in the field

Engineering note for the updater. Written for TASK-733 (deep-scan finding #12),
which PR #740 deferred because the code change is easy and the ROLLOUT is not.

## What root runs, and where it reads it from

`clawbox-root-update@<step>.service` is how the unprivileged `clawbox` account
gets a root step. It runs `/usr/local/libexec/clawbox/clawbox-root-step.sh`, the
root-owned dispatcher, which decides what root executes.

Until this change the dispatcher exec'd `/home/clawbox/clawbox/install.sh`. That
file is `clawbox:clawbox 0755` inside a `clawbox:clawbox` directory, and
`install.sh` hands the whole tree back with `chown -R clawbox:clawbox` on every
root run. Two things kept that from being a one-move local root:

* a root-owned sha256 **record** of everything root runs on the account's behalf
  — `install.sh`, `scripts/`, `config/` — written to `/etc/clawbox/root-exec.manifest`
  and verified before the exec (`config/clawbox-root-manifest.sh`), and
* the dispatcher copying `install.sh` into `/run/clawbox` and hashing the copy,
  so the file could not be swapped between the check and the exec.

Neither covered the **self-updating family** — `bootstrap_updater`, `git_pull`,
`build`, `rebuild`, `rebuild_reboot`, `post_update`, `update_smoke` — because an
update legitimately rewrites the very files the record describes, so verifying
would fail every update at its second step. Three of those seven are on
`WEB_ROOT_STEPS`: `bootstrap_updater`, `post_update` and `rebuild_reboot` are
startable by the web server, the in-UI terminal and the agent's shell through
`config/clawbox-run-root-step.sh`, which `config/clawbox-sudoers` grants
NOPASSWD. Write `install.sh`, start the step, own the box.

The fix is the **mirror**: `/var/lib/clawbox/root-exec-mirror`, root-owned,
holding exactly the paths the record covers. The dispatcher execs
`$MIRROR/install.sh` and never the tree — for the pinned steps too — and
`install.sh` resolves `scripts/` and `config/` relative to the directory it was
started from (`SRC_DIR`), so the scripts it goes on to `bash` as root and the
unit files it installs into `/etc` come out of the mirror as well. Moving only
`install.sh` would have moved the hole one file along.

What makes the exemption safe is **when the mirror is restaged**, not that it
exists:

* `config/clawbox-root-step.sh` restages it on every dispatch, and only while
  `--verify` says the tree still matches the root-owned record.
* `install.sh` restages it from `write_root_exec_manifest`, which re-records the
  tree — and `root_exec_may_anchor` allows that at exactly two moments: when
  `install.sh` is itself running out of the tree (an operator's
  `sudo bash install.sh`, the flash host's provisioning run, the one-time
  transition below — root is already executing that tree, so recording it grants
  nothing new), and immediately after this run's own `git reset --hard` to the
  update branch. Everywhere else the record is only re-written over a tree that
  still matches it, which is a no-op on a healthy box and a refusal on a
  tampered one.

So a tree that changed because an update replaced it is re-recorded at that
moment and mirrors on the next dispatch; a tree that changed because something
rewrote `install.sh` matches nothing, is never copied, and root runs the previous
root-established build. Both answers are "run the mirror".

`git` over the checkout stopped running as root at the same time, because it is
the same class of hole by another route: `fetch` honours `remote.<name>.uploadpack`
and `url.*.insteadOf`, `checkout` runs `.git/hooks/post-checkout`, and any
checkout runs `filter.*.smudge` — all named by `.git/config` or by files under
`.git/hooks`, inside the clawbox-writable tree and deliberately outside the
record. `install.sh` now runs git as whoever owns the checkout
(`set_git_runner_for_tree`), which is what `scripts/force-update.sh` has always
done.

## Rollout ordering — read this before shipping

The dispatcher that needs the mirror must never be installed on a box that has
no mirror, and the new dispatcher does **not** fall back to the tree. Get that
order wrong and a fleet box refuses every root step, on an appliance with no
console. The ordering is enforced in one place: `write_root_exec_manifest`
records the manifest, verifies it, and stages the mirror — and
`install_root_libexec` installs the new dispatcher only when that whole function
returned 0. Mirror first, dispatcher second, always.

### What an old-build box does on its first update to this beta

1. **`bootstrap_updater`** — the box still has the OLD dispatcher, so it execs
   `/home/clawbox/clawbox/install.sh` out of the tree, unverified. **This last
   run is the accepted risk of the change**: it is exactly the exposure that
   exists today, taken once more, on the update that removes it. There is no way
   to avoid it — the new dispatcher can only be installed by code that is
   already running as root, and on an old box that code is the old one.
2. The old `install.sh`'s bootstrap block fetches, hard-resets the tree to the
   update branch and re-execs into the NEW `install.sh`, still out of the tree
   (`SRC_DIR` = `PROJECT_DIR` on this one run).
3. `step_bootstrap_updater` → `sync_repo_to_update_target` →
   `refresh_root_exec_manifest`. That restages the manifest helper from the tree
   the reset just produced — the installed one is the previous release's and does
   not know `--mirror` — then records the manifest and **creates the mirror**.
   From here the mirror exists and is current, while the OLD dispatcher is still
   the installed one, so nothing has changed about how steps are dispatched.
4. The pinned steps (`apt_update`, `openclaw_install`, `gateway_setup`, …) run
   through the old dispatcher exactly as before.
5. `rebuild_reboot` rebuilds and reboots. The mirror is on `/var/lib`, not
   `/run`, precisely so it survives this.
6. The continuation runs **`post_update`** → `step_systemd_services` →
   `install_root_libexec`, which installs the new helper, re-records the manifest,
   restages the mirror, and only then installs the **new dispatcher**.
7. Every root step after that point — and every step of every later update —
   runs out of the mirror.

### If the box dies mid-way

Nothing strands.

* Before step 6 the installed dispatcher is still the old one, which runs the
  tree; the update resumes through the existing `update_needs_continuation` path
  and converges.
* After step 6 the mirror is present by construction (same function).
* A mirror that is somehow missing or stale on a healthy box is rebuilt by the
  dispatcher itself on the next dispatch, from a tree that verifies. The refresh
  is idempotent — the same walk over the same bytes — so it is safe to repeat and
  is repeated on **every** dispatch rather than once at install time.
* A box with no mirror AND a tree that does not verify refuses the step (exit 65)
  and prints the repair, which is the one an operator already knows:
  `sudo bash /home/clawbox/clawbox/install.sh --step systemd_services`.
* If `install_root_libexec` cannot write the manifest or the mirror, it leaves
  whatever dispatcher is already installed, records `root_exec_manifest` against
  the run's verdict, and the update finishes. A box that could not take the new
  dispatcher keeps the old one and keeps working.

### Verifying it on a box

```
sudo ls -ld /var/lib/clawbox/root-exec-mirror          # root:root, 0755
sudo ls    /var/lib/clawbox/root-exec-mirror           # install.sh scripts config
sudo /usr/local/libexec/clawbox/clawbox-root-manifest.sh --mirror-path
sudo /usr/local/libexec/clawbox/clawbox-root-manifest.sh --verify && echo recorded
journalctl -u 'clawbox-root-update@*' | grep -F /var/lib/clawbox/root-exec-mirror
```

The journal line for an exempt step names the mirror path as the script root
executed. Nothing under `/home/clawbox` should appear as a root `ExecStart` or a
root `bash` target.

## What this does not close

* **The mirror is a copy, not a signature.** It stops a clawbox-level foothold
  from choosing the program root runs at a moment of its choosing; it does not
  authenticate the code. The trust anchor is still "what `git reset --hard
  origin/<branch>` put in the tree", and `.git` is clawbox-writable, so an
  attacker who can rewrite `.git/config`'s remote can still influence what an
  update fetches. That is a different finding with a different fix (a signed
  release), and it is not made worse here: running git unprivileged removes the
  hook/filter code-execution half of it.
* **A one-instant window inside the swap.** `mirror_tree` builds a staging
  directory and swaps it in with two renames; a dispatch landing between them
  refuses (exit 65) rather than running anything. A retry, not a root exec.
* **Paths deliberately left on the tree.** `install.sh` still names
  `$PROJECT_DIR/scripts/...` where it `chmod`s or `chown`s the tree copy, where a
  `User=clawbox` unit's `ExecStart` points at it (`start-vnc.sh`), where a script
  is run unprivileged (`ensure-local-embeddings.sh`, `apply-desktop-theme.sh` —
  which is chowned to `clawbox`, so mirroring it would make the mirror writable),
  and in `step_vnc_install`'s migration of the old first-boot unit, which has to
  recognise the tree path in order to rewrite it. None of those is root executing
  a file the account can rewrite.
* **`install-x64.sh`** is untouched: the x86 installer ships no
  `clawbox-root-update@` template, no root-step dispatcher and no launcher grant,
  so the escalation chain this is about does not exist there.
