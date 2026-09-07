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
* `install.sh` restages it from `write_root_exec_manifest`, and
  `root_exec_may_anchor` allows that function to RE-RECORD at exactly two
  moments: when `install.sh` is itself running out of the tree (an operator's
  `sudo bash install.sh`, the flash host's provisioning run, the one-time
  transition below — root is already executing that tree, so recording it grants
  nothing new), and immediately after this run's own `git reset --hard` to the
  update branch.

  Outside those two moments nothing is written. The record is only brought
  FORWARD — it must still describe the tree, or the run refuses. It used to be
  re-written there too, on the argument that rewriting a record which already
  matches is a no-op; it is not, because `--verify` is asked about
  `$PROJECT_DIR` and the answer is stale the instant it returns, and `--write`
  then walks the tree again and records whatever is there by then. A foothold
  that restores the tree, starts `post_update` (→ `step_systemd_services` →
  `install_root_libexec`, where `SRC_DIR` is the mirror) and swaps `install.sh`
  between the two walks got its bytes into the record — and from the record into
  the mirror, whose staged-copy check compares against that same record. Not
  writing is the same no-op with no second walk to win.

So a tree that changed because an update replaced it is re-recorded at that
moment and mirrors on the next dispatch; a tree that changed because something
rewrote `install.sh` matches nothing, is never copied, and root runs the previous
root-established build. Both answers are "run the mirror".

The copy itself is then **checked before it is installed**. `--verify` answers a
question about `$PROJECT_DIR` and the answer is stale the instant it returns, so
`mirror_tree` builds a staging directory and runs `sha256sum -c` over it against
the record before the swap — the property `--verify-file` gave for one file,
applied to all of them. Without it the mirror held the tree as it was during the
*copy*: the walk is byte-sorted, so `config/*` lands before `install.sh`, and the
staging directory appearing under a world-readable `/var/lib/clawbox` is itself
the starting gun for a poller. A mismatch throws the staging away and leaves the
previous mirror standing. One restage runs at a time (`flock`), because
concurrent dispatches are ordinary and two of them sharing fixed staging names
could between them leave `$MIRROR_DIR` absent.

`install.sh`'s own self-update bootstrap still runs on a dispatched step: it
finds the checkout at `/home/clawbox/clawbox` rather than beside itself, and
re-execs the **mirror** copy it restages from the tree it just reset — never the
tree. Its repair for a manifest helper that will not answer follows the same
rule: it may install `$_b/config/clawbox-root-manifest.sh` into
`/usr/local/libexec/clawbox` and run it as root only where `$_self` IS `$_b`,
i.e. where root already executes that checkout. On a dispatched step it refuses
and carries the failure forward instead; `install_root_libexec` installs the
helper later in the same run out of `$SRC_DIR`. Root installing a
clawbox-writable file and then executing it is this whole document's subject
whatever the verb — `install` counts as much as `exec` does, and the copy is
worse than a single exec because it BECOMES the file that decides which bytes
root runs afterwards. Keying that block on "is there a `.git` next to me" would have switched the
whole thing off for every dispatched step, and with it the fleet's ability to
deliver a fix to the updater *in* the update that carries it.

Every `git` that writes the checkout, or that can execute a program the checkout
configures, stopped running as root at the same time, because it is the same
class of hole by another route: `fetch` honours `remote.<name>.uploadpack`
and `url.*.insteadOf`, `checkout` runs `.git/hooks/post-checkout`, and any
checkout runs `filter.*.smudge` — all named by `.git/config` or by files under
`.git/hooks`, inside the clawbox-writable tree and deliberately outside the
record. `install.sh` now runs those as whoever owns the checkout
(`use_tree_owner_for_git`), which is what `scripts/force-update.sh` has always
done. The read-only ref plumbing that resolves which branch a detached checkout
belongs to (`for-each-ref`, `name-rev`, `rev-parse`, `symbolic-ref`) still runs
as root: it touches neither the index nor the working tree, so it reaches none of
`.git/hooks`, `filter.*.smudge`, `core.fsmonitor` or `remote.*.uploadpack`.

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
* An **interrupted swap** is recovered, in both places that can meet one. The
  swap is two renames, and a kill between them — a power cut, an OOM kill, the
  reboot `rebuild_reboot` performs on purpose — leaves `$MIRROR_DIR` absent with
  the only root-established build sitting in `$MIRROR_DIR.old`. Without a
  recovery the next restage DELETED that copy and the box refused every root
  step, including `post_update` and `bootstrap_updater`, the two that would let
  it finish the update and heal itself.

  `mirror_tree` puts the aside copy back before it clears its staging area, so a
  restage that then refuses leaves the box on the previous build. That covers
  every caller of `--mirror`. The **dispatcher** does the same check itself
  before it decides there is nothing to run, because the dispatch that actually
  meets this state is the one whose tree does not verify — an update in flight —
  and that is the branch which never calls `--mirror` at all. Both names are
  root-owned directories under a root-owned `/var/lib/clawbox`, so neither
  recovery is a trust decision: it moves bytes root staged and vouched for. A
  recovered copy from a previous build is still checked against the record for
  the pinned family, exactly as any other mirror is.
* A box with no mirror AND a tree that does not verify refuses the step (exit 65)
  and prints the repair, which is the one an operator already knows:
  `sudo bash /home/clawbox/clawbox/install.sh --step systemd_services`.
* A box **rolled back** to a build from before this change converges too: the
  older helper has no `--mirror` verb and says so (exit 64 is "I do not know that
  word"), `write_root_exec_manifest` treats that as "nothing to stage" rather
  than a failure — asking the helper with `--mirror-path` rather than reading an
  exit status — and `post_update` reinstalls a coherent helper, dispatcher and
  mirror. Reporting it as a provisioning failure would be a false failure over a
  rollback that is fine.
* A dispatch that lands while the tree does not verify runs the previous build's
  mirror and **says so** in the journal, with the time that copy was staged. It
  is the right answer — an update in flight is exactly this state — but a box can
  sit in it for a whole update while the updater reports success, so it is
  recorded rather than inferred from silence.
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

`--verify` is the load-bearing line of that recipe, not `ls`. `scripts/force-update.sh`
hard-syncs and rebuilds as `clawbox` and never re-records, so after one the tree
is newer than the record: every command above still prints a healthy-looking
mirror, `--verify` fails, and the box goes on running the PREVIOUS build's units,
sudoers and scripts on the root side until something re-records
(`sudo bash /home/clawbox/clawbox/install.sh --step systemd_services`, or the
next in-app update). The dispatcher says so on every dispatch — "does not match
the root-exec manifest — running the mirror staged &lt;time&gt;".

## What this does not close

* **The mirror is a copy, not a signature.** It stops a clawbox-level foothold
  from choosing the program root runs at a moment of its choosing; it does not
  authenticate the code. The trust anchor is still "what `git reset --hard
  origin/<branch>` put in the tree", and `.git` is clawbox-writable, so an
  attacker who can rewrite `.git/config`'s remote can still influence what an
  update fetches. That is a different finding with a different fix (a signed
  release), and it is not made worse here: running git unprivileged removes the
  hook/filter code-execution half of it.
* **A one-instant window inside the swap — now a wait, not a refusal.**
  `mirror_tree` builds a staging directory and swaps it in with two renames, and
  `$MIRROR_DIR` does not exist between them. A dispatch landing there takes the
  same `flock` the restage holds, waits for it, and finds the new mirror in
  place; it neither refuses nor runs anything out of the tree. What is left is
  the case where that wait times out (120 s), where the box refuses (exit 65) and
  the step is retried — a retry, not a root exec, which is the direction this
  whole file fails in.
* **Paths deliberately left on the tree.** `install.sh` still names
  `$PROJECT_DIR/scripts/...` where it `chmod`s or `chown`s the tree copy, where a
  `User=clawbox` unit's `ExecStart` points at it (`start-vnc.sh` and
  `launch-browser.sh` — `clawbox-browser.service` runs the tree copy, so the
  `chmod +x` on it is load-bearing), where a script is run unprivileged
  (`ensure-local-embeddings.sh`, `apply-desktop-theme.sh` — which is chowned to
  `clawbox`, so mirroring it would make the mirror writable), and in
  `step_vnc_install`'s migration of the old first-boot unit, which has to
  recognise the tree path in order to rewrite it. `clawbox-tts.sh` is named
  twice on purpose: the tree path is what gets REGISTERED with the harness (the
  mirror is torn down and rebuilt on every dispatch, so a provider pointing into
  it would find nothing mid-restage) while the timeout probe root executes reads
  the mirror. `scripts/recover.sh` keeps its loud tree fallback for
  `start-ap.sh`: it is an operator path run by hand as root, already root by
  choice. None of those is root executing a file the account can rewrite.
* **The helper and dispatcher copies in `install_root_libexec`.** They are taken
  from `$SRC_DIR`, so on a provisioned box they come out of the mirror — but on a
  full install and on the transition update `$SRC_DIR` IS the tree, and there is
  no record yet to check them against. Root already execs that tree on both of
  those paths, so this grants nothing it does not have; it is the same shape as
  the accepted last run above.
* **A root-owned tracked file in the working tree.** `use_tree_owner_for_git`
  hands `.git` back to the checkout's owner before dropping, but not the tree.
  Nothing in `install.sh` writes a tracked file as root today (only `.env`, which
  is gitignored), so this is latent; if one ever appears, the unprivileged reset
  fails where the root one succeeded.
* **`install-x64.sh`** is untouched: the x86 installer ships no
  `clawbox-root-update@` template, no root-step dispatcher and no launcher grant,
  so the escalation chain this is about does not exist there.
