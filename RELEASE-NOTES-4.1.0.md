# ClawBox 4.1.0

Previous release: v4.0.0, 21 September 2026. About 50 commits.

4.1 is the release that follows 4.0 into the field. It gives the chat more of
a phone, stops a conversation restore from waiting forever, gives web apps
built before 4.0 their saved data back, lets the Coding Agent's green pull
requests merge by themselves, and makes updates and backups hold up on the
boxes where 4.0 had trouble with them.

## Highlights

- **More of the phone for the chat.** On a phone the chat opens full screen,
  its header and the message box's options fold away, and the text can be set
  from 85% to 150%. Both choices are remembered on that phone.
- **A conversation that cannot reopen says why.** Reopening a conversation no
  longer waits without end. When the box cannot bring it back, the chat says
  why and offers Try again.
- **Web apps from before 4.0 find their data.** An app you built on an earlier
  release opens with what it had saved. The box copies that data into the
  app's own storage and deletes nothing.
- **Coding Agent pull requests merge when green.** With merging switched on, a
  run hands its pull request to GitHub's auto-merge, so it lands as soon as its
  required checks pass. A pull request labelled hold, or one into main, is
  never merged.

## What's new by area

### Chat and mobile

- **Full-screen chat on a phone.** It is on by default on a phone and the
  desktop is unchanged. The chat's header and the composer's options each fold
  away, and the transcript text steps through 85%, 100%, 115%, 130% and 150%.
  Both choices are kept in that browser. The text size is announced to screen
  readers, and a tap that follows a swipe on the header strip is no longer
  swallowed.
- **Restoring a conversation always ends.** Each socket handshake gets 30
  seconds, each history read 30 seconds and the whole restore 90 seconds, and
  the five-minute reconnect deadline now covers every reconnect rather than
  only the first connection. A history read is retried, after 2, 4, 8 and 15
  seconds, only when the gateway says "not yet" or does not answer. When a
  restore fails, a panel names the reason (busy, no answer, could not be
  restored) and offers **Try again**; the chat popup also offers **Start a new
  chat**, which opens a fresh tab and deletes nothing. A message the gateway
  never acknowledges now says the box has not taken it yet, instead of asking
  you to send it again.
- A coding-run card leaves the chat five seconds after its run finishes
  cleanly, and a run that opened a pull request waits for it to merge first.
  The card folds without moving the transcript, focus inside it moves to the
  🤖 chip that brings it back, and nothing is deleted.
- On a phone, **View** on a coding-run card closes the chat so the run's page
  is on screen, instead of opening it behind the chat.
- When nothing named an Anthropic model, the chat uses **Claude Opus 5.5**
  (`claude-opus-5-5`). `claude-opus-5` stays in the list as the previous
  generation, and a model you picked yourself is never rewritten.

### Coding agent

- **GitHub's auto-merge.** Under the owner's merge switch, the box turns on
  auto-merge for a pull request it would merge itself, while GitHub is holding
  the merge for a requirement, so it merges the moment its required checks
  pass. It turns auto-merge off again for a hold label (`hold`, `hold-*`,
  `on hold`, `do-not-merge*`, `DNM`), for a base of `main`, when the owner
  switches merging off, and while anything is outstanding: a failing check, a
  conflict, an unanswered comment, a change request, or CodeRabbit not yet
  done. The box's own merges are merge commits now, with a squash only where a
  repository allows nothing else.
- **One CodeRabbit review per pull request.** Automatic pull requests open as
  drafts and are marked ready once every other check has passed on the head, so
  CodeRabbit reviews green code once and the loop does not wait for re-reviews.
- **A run on your own Anthropic account uses Claude Opus 5.5.**
  `claude-opus-5-5` is the default there, and `claude-opus-5` and
  `claude-sonnet-5` are still accepted when a run asks for one by name. A run on
  the box's own ClawBox AI plan is unchanged; the plan chooses the model.
- A run on an Anthropic account finds its transcript under `~/.claude`.
- A settled run's evidence folder is cleared of `venv/`, `.venv/`,
  `node_modules/` and `__pycache__/` trees and of links that point outside it,
  which had broken the box's own build.
- **Coding teams.** The planner sizes each team to its goal, every worker sees
  a digest of the board, and the team's metrics are recorded. A lead that adds
  or retires tasks while a team runs is opt-in and off by default. Team runs
  can send a short, bounded, logged `team_message` to a teammate, the lead or
  the assistant.

### Web apps

- **Storage from before 4.0 is carried over.** 4.0 correctly moved every web
  app into its own sandboxed origin, and in doing so cut apps built on 3.9 off
  from the data they had saved. A one-time step at boot now copies each app's
  old keys, the ones its own code names, into its own namespace. It copies only
  into an empty namespace, never copies ClawBox's own keys or another app's,
  never reads through a symlink, and deletes nothing, so a rollback still finds
  the originals.
- Such an app's old calls to `/setup-api/kv` are answered through the storage
  bridge, and its `localStorage` works again. A browser that still holds a
  pre-4.0 app's `localStorage` hands it over the first time the app opens
  there. A web app never gets the desktop's origin.

### Updates

- **OpenClaw is pinned to 2026.9.4** (state schema 17). An update now refuses up
  front, before it changes anything, when the device's state database is on a
  schema newer than the core it is about to install.
- The Codex and ClawBox AI (DeepSeek) plugins that a 4.0 update left **Needs
  repair** are retried once per OpenClaw release after the update, and the
  Providers row says **Repairing…** while that runs.
- An already-active swapfile, or a 4 GiB one that measures a page short, no
  longer fails the update.
- `scripts/force-update.sh` rolls a failed build back and exits non-zero, and
  the build no longer reads anything under `data/`, which a coding run's files
  could break.
- The gateway survives the kernel killing one of its child processes for
  memory; only that turn fails.

### Backups and memory

- **ClawKeep backups get past four failures seen after 4.0.** OpenClaw's own
  plugin links are set aside for the archive and put back afterwards, an
  archive that loses a file mid-backup is rebuilt up to four times, a duplicate
  archive path is refused before archiving with both sources named, and a
  database whose only damage is its indexes is re-indexed after a copy is kept.
  Any other damage stops the backup and leaves the file untouched.
- A Memory Shard index that the 4.0 update disowned is rebuilt by **Index now**
  and the schedule, and a box whose memory search fell back to another embedder
  says so.
- ClawKeep's cloud usage is recomputed from R2 on every heartbeat.

### Agent tools

- The ClawBox MCP server exits after an idle period, the coding family of tools
  sits behind `CLAWBOX_MCP_CODING_TOOLS`, and the longest tool descriptions
  moved into the field guide.
- The agent can reach its own workspace inside the `~/.openclaw` file guard.

### What's new card and version

- After the update the desktop shows **What's new in 4.1**, with a plan section
  that names only what the box's plan does not cover yet. It is keyed to 4.1,
  so a box that dismissed an earlier card is shown this one.
- Settings → About, System Update, `/setup-api/update/versions` and the card
  all name 4.1.0. The version the build carries, which About shows until the
  box answers, is now read from `package.json`. It used to be `git describe`,
  which on a box built from beta named an older tag.

## Upgrade notes

- Upgrade from 4.0.x, or from 3.9.x, in **Settings, System Update**. Over SSH,
  run `sudo bash /home/clawbox/clawbox/install.sh`. On the Hermes edition
  Settings, System Update is the only route.
- Updates are release-tag based: a box offers 4.1.0 once the `v4.1.0` tag is
  published, within half an hour of its desktop being open.
- Your data is preserved, as in 4.0: the updater's `git clean -fd` runs without
  `-x`, so `data/`, `.env`, `node_modules` and `.next` survive, and the edition
  lock is untouched.
- The one-time web-app storage step runs at the first boot of 4.1 and records
  itself in `data/webapp-legacy-storage.json`; it runs again at a later boot
  only if it could not finish.

## Breaking changes

- None. A dismissal of the 4.0 card is kept but no longer hides anything, and a
  tab still showing the 4.0 card cannot dismiss the 4.1 one.

## Known issues

- The full-page chat offers **Try again** after a failed restore but not
  **Start a new chat**; it is bound to the main session.
- The in-app updater still leaves the checkout on the new commit after a failed
  rebuild. It restores the previous build, marks the update failed and names
  the mismatch.
