# ClawBox 4.2.0

Previous release: v4.1.0, 25 September 2026. 78 commits.

4.2 lets several people share one ClawBox, each with a user of their own. On an
x64 ClawBox it spreads the desktop over several monitors, adds a drop-down
terminal and a proper kiosk mode. Project folders can be backed up to GitHub in
one click, ClawKeep backups are fixed, and testing on real ClawBox hardware
fixed the problems it found.

## Highlights

- **Several people, one ClawBox.** The owner adds users in Settings → Users.
  Each person signs in with their own name and password, and gets a desktop and
  a Terminal of their own. Settings and installed apps stay with the owner.
- **Monitor mode, with a drop-down terminal.** On an x64 ClawBox running the
  ClawBox desktop session, one desktop spans a row of monitors, arranged in
  Settings → Monitors. Win+Down drops a terminal down from the top of the
  screen.
- **Back up project folders to GitHub.** In Files → Projects, Back up copies a
  folder to a private GitHub repository, with a daily backup if you want one.
  Files that look like passwords or keys are left out, and you are told which.
- **Kiosk mode.** On an x64 ClawBox that shows its desktop full screen, every
  page the desktop opens gets a ClawBox bar with tabs, back, forward, reload
  and an address field, so the desktop is always one click away.
- **ClawKeep backups fixed.** Snapshots no longer carry old backup archives
  along, a link that cannot be archived is skipped and named instead of failing
  the backup, and a full account no longer turns auto-backup off for good.
- **Fixes from hardware testing.** Testing 4.2 on real ClawBox hardware found
  and fixed problems with voice input, spoken replies, the ClawBox AI plugin's
  Retry, and updating a box left on an older build.

## What's new by area

### Users and sign-in

- **Settings → Users** (owner only) adds and removes users. Each one is a real
  account on the box with its own password. Removing a user signs them out
  everywhere.
- The sign-in page offers a choice of user only on a box that has more than
  one. A box with one user signs in exactly as before, and existing sign-ins
  keep working.
- Another user gets the desktop and a Terminal that runs as their own account.
  Settings, installed apps and the assistant stay with the owner; a page that
  is the owner's sends them back to the desktop with a short note.
- Signing in, switching user or locking the screen in one browser tab moves
  every other open tab of that browser along with it.

### Desktop

- **Monitor mode** (x64 desktop session): arrange monitors by dragging, choose
  the main one, and set resolution, refresh rate, scale, rotation, mirroring
  and variable refresh rate, plus brightness where the monitor allows it. A new
  layout is undone after 20 seconds unless you keep it. Windows maximise and
  snap on the monitor they are on; the shelf, chat and notices stay on the
  main one.
- **Drop-down terminal** (x64 desktop session): Win+Down shows and hides it, in
  the ClawBox Terminal's colours.
- **Kiosk mode** (x64): pages the desktop opens get a ClawBox bar with tabs,
  back, forward, reload and an address field, and a new tab opens a ClawBox
  start page with search. The desktop's shelf gathers those pages under one
  **Web** icon.
- **Windows and Terminals survive a page refresh.** Open windows come back
  where they were, and a running Terminal keeps running on the box and
  reattaches with its output.
- A maximised window now fills the desktop edge to edge.
- The desktop does less work in the background: fewer repaints and fewer
  polls, which shows most on a large screen.

### Files and projects

- Pin folders as **Projects**: in the Files sidebar and behind a Projects icon
  on the desktop. A folder downloads as one ZIP, without the local AI models.
- **GitHub backup** uses the Coding Agent's GitHub sign-in. It offers Back up
  now, History, Open on GitHub, a daily backup (off until you turn it on, and
  only when something changed) and Disconnect, which leaves the GitHub copy
  alone. A folder that already has its own GitHub remote is pushed to its
  current branch, never force-pushed. Likely secrets, files over 50 MB and
  nested repositories are left out and listed.
- Select several files at once (Ctrl/Cmd-click, Shift-click, Select all), then
  download them as one ZIP, move them or delete them. Move by dragging onto a
  folder or with **Move to…**, and choose the folder an upload goes to.
- The box's own data folder can no longer be pinned as a project.

### Chat and voice

- Your chat tabs are the same on every device: a conversation started on the
  phone is listed on the desktop too.
- Files the assistant sends in the web chat now download instead of failing.
- Files and folders dragged onto the chat's message box are attached.
- On a phone, opening the chat no longer raises the keyboard by itself.
- Voice input works with ClawBox AI's transcription again, and when the cloud
  cannot answer, the box transcribes on its own with Whisper.
- **Install speech** in Settings → Local AI works on a freshly set-up box, and
  spoken replies no longer fail when the voice engine has to start from cold.

### Coding Agent

- **Several Anthropic accounts move together.** The chat and every coding run
  use the same account, and when it reaches a limit they all switch to the
  next one and carry on.
- **Run history** can keep more: Standard (the last 30 runs), Extended, Keep
  everything, or Archive.
- Pull requests the box opens by itself keep private addresses, home folders,
  e-mail addresses, tokens and the box's own name out of their title,
  description and comments.
- A coding team is not done while the project's own tests fail, and harmless
  events no longer count as team alerts.
- A model error partway through a run no longer blocks new runs for 15
  minutes.

### Backups

- ClawKeep snapshots leave out backup archives kept inside the assistant's own
  folder. On one box they had grown snapshots from 2.5 GB to 13 GB and filled
  the account.
- A link that cannot be archived is skipped, and the ClawKeep status and
  restore card name it.
- While the account is full, auto-backup shows **Paused while the account is
  full** and comes back on by itself once there is room. A schedule change from
  the assistant or a script no longer switches auto-backup off by accident.

### Updates

- The update screen shows what is new in the version being installed.
- A box with no recorded update branch follows main and is offered its
  releases. System Update → Advanced options says which branch it follows.
- A box left on an older build by a failed update repairs itself at the next
  boot.
- Changes made by hand to ClawBox's own files are saved aside before an update
  resets them, and the update card says so.
- The ClawBox AI plugin no longer loops through a repair on every start when
  its exact version is missing from ClawHub, and **Retry** installs it and
  switches it back on.

## Upgrade notes

- Upgrade from 4.1.x or 4.0.x in **Settings → System Update**. On the Hermes
  edition that is the only route.
- Updates are release-tag based: a box offers 4.2.0 once the `v4.2.0` tag is
  published.
- Your data is preserved, as in 4.1, and the edition lock is untouched.
- Monitor mode, the drop-down terminal and kiosk mode come with the ClawBox
  desktop session on an x64 install, set up with the scripts in
  `scripts/x64-migration/kiosk/`. The update does not switch them on, and a
  ClawBox on Jetson looks and works as before.
- The owner is the user ClawBox was installed as. A box stays single-user until
  the owner adds someone.

## Breaking changes

- None. A dismissal of the 4.1 card is kept but no longer hides anything, and a
  tab still showing the 4.1 card cannot dismiss the 4.2 one.
