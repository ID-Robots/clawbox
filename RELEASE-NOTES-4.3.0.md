# ClawBox 4.3.0

Previous release: v4.2.0, 5 October 2026. 941 commits.

4.3 adds a Screenshot app and gives you and your assistant one shared browser.
An app the Coding Agent built can now be shared through a public link. xAI Grok
joins the AI providers, most model changes no longer restart the assistant, you
can hold to talk, and the Coding Agent shows its agents at work on a live
chart. Prime Radiant, a new app, writes a wiki from your own documents and
checks it every night. Coding runs report back in the chat that asked for them,
an update asks before it stops your agents, Local AI installs wait in line, and
the box tells you when a scheduled job fails. Wi-Fi, updates, backups, first
setup and switching between Anthropic accounts get a long list of fixes.

## Highlights

- **Screenshots, built in.** The new Screenshot app captures the whole screen,
  an area or one window, and lets you mark the picture up before it is saved to
  the Screenshots folder in Files. Print Screen, Ctrl+Shift+S or the Screenshot
  button beside the clock takes one in a single step.
- **One browser for you and your assistant.** The browser your assistant uses
  is now the one on the box's own desktop, shown in Agent Browser. Sign in to a
  site there once and the assistant can use it, and you can watch it work. It
  opens and closes only its own tabs.
- **Share an app with a public link.** Right-click an app the Coding Agent
  built and choose Create public link. Visitors reach only that app, for a set
  time or until you disable the link, and you can ask them for a password.
- **xAI Grok, and model changes without a restart.** On OpenClaw, xAI Grok can
  be set up with an API key or a SuperGrok or X Premium sign-in. Changing the
  model, or switching Local AI on or off, no longer restarts the assistant in
  most cases, so the chat carries on.
- **Hold to talk.** Hold the chat's microphone button, or F8, while you speak,
  and let go to send. Spoken replies download several times smaller, and
  Settings → Voice can play every reply aloud, including replies to questions
  you typed.
- **The Coding Agent, on a live chart.** The Coding Agent opens on a chart of
  its agents at work. You can message a run while it works, extra runs and
  teams wait in line instead of being refused, and Fix CI sends a pull request
  whose checks failed back to be fixed.
- **Prime Radiant, a living wiki.** A new app that keeps a wiki for you. Point
  it at your documents and it writes a page for each one, listing the facts it
  found with where each came from and how sure it is. Every night it tidies the
  wiki, looks for facts that contradict each other, and asks you about anything
  it cannot settle alone.
- **Coding runs report back in the chat.** When the assistant starts a coding
  run for you, the chat hears how it ended and the assistant tells you without
  being asked, including a deliverable that is missing or work still running.
  While it works, a run can send the assistant a question, a blocker or a
  milestone.
- **Updates that ask before they stop your agents.** While coding runs or
  assistant tasks are working, Update asks first: Cancel waits for them,
  Update anyway goes ahead. The box reboots only when the update needs a
  boot, and the update screen shows what is new while you wait.
- **Local AI installs wait in line.** Start a Local AI install while another
  one runs and it waits its turn instead of being refused. Its card says what
  it is waiting for, it starts by itself, and you can cancel it.
- **Alerts for scheduled jobs.** When one of the assistant's scheduled jobs
  fails, keeps being skipped or does not run when it is due, the desktop tells
  you, and Telegram too when a bot is connected. Settings → Harness lists the
  jobs in trouble.

## New features

### Prime Radiant

- **Prime Radiant** is a wiki the box keeps for you, on both editions. Open it
  from its icon on the desktop, next to Memory Shard; the first time, the box
  creates the wiki and there is nothing to set up. Adding documents needs the
  box signed in to ClawBox AI, which writes the pages; reading, reviewing and
  undoing work without it.
- **Add** reads folders on the box, or your whole home folder in one click, and
  files you drop on it. Text, Markdown, PDF, Word, OpenDocument and RTF files
  are converted on the box, and a document already in the wiki is not written
  twice. A folder import leaves out code projects, caches, boilerplate,
  temporary files and machine-generated text; a file you drop is always read.
  What looks like a secret is removed before any text leaves the box.
- Each document gets a page that lists its facts, each with how sure it is,
  where it came from and whether you verified it. **Map** draws the pages and
  their links as a 3D picture, and **Pages** lists them and, with Memory Shard
  switched on, searches inside them.
- **Every night**, 03:00 by default, Prime Radiant reads new and changed
  documents from the folders you chose, looks for facts that contradict each
  other and runs its checks. A night that would change a page you verified, or
  whose checks find an error, is held: its questions go to **Review**, where
  you keep an answer, write the right one, or set the question aside, and
  **Merge** then puts the night's work into the wiki.
- **History** records every change to a page, and **Undo** reverses one. The
  assistant can work the wiki for you too, and each change it makes shows in
  History under its own name.

### Screenshot app

- A new **Screenshot** app, on both editions, captures the whole screen, an
  area or a single window, right away or after a delay. Its editor lets you
  mark the picture up, and it is saved as PNG or JPG to the Screenshots folder,
  which the Files app shows.
- Print Screen or Ctrl+Shift+S takes the whole screen, and Shift+Print Screen
  or Alt+Shift+S an area, anywhere on the desktop and with the app closed. The
  keys are left alone while you type in a text field or a Terminal.
- A **Screenshot** button in the tray, beside the clock, takes the whole screen
  in one click.
- It works when the box is opened over its plain local address too. What no
  page may read, such as a sandboxed web app or the PDF viewer, is drawn as a
  labelled tile instead of being left blank. Where the browser's own screen
  capture is available, it is offered as an exact alternative.

### One browser for you and your assistant

- The browser on the box's desktop and the browser your assistant drives are
  now the same browser, with one profile. Sign in to a site there once and the
  assistant can use it, and you can watch what it does in **Agent Browser**.
- The assistant opens tabs of its own and closes only those. The browser is
  kept running, after a reboot and when its window is closed, so closing it in
  Agent Browser no longer stops it.
- On a box that had two browser profiles, a one-time step keeps one. The
  assistant's old profile is never deleted, and Agent Browser's settings say
  where it is kept. The documentation explains how to give the assistant a
  separate browser again.
- The Browser app is now called **Agent Browser**, with an icon of its own. Its
  setup shows its last step, and the banner saying the browser is only for
  automated testing is gone.

### Public links for your apps

- Right-click an app the Coding Agent built, on the desktop, and choose
  **Create public link**: **Temporary**, which stops working after the time you
  choose, or **Permanent**, which stays on until you disable it.
- Visitors reach only that app, never your desktop, files or other apps. For an
  app with its own server, by default they can load its data from its own
  `/api` but not change it: **The app's own data** in the dialog is **Read
  only** unless you choose **Read and write**, or **Off** to serve only the
  app's pages. You can list more of the app's paths visitors may use as well.
- Choose **Require a password** or **No password**. A password belongs to that
  link alone, can be typed or generated, and can be changed or removed later
  without changing the link.
- Each link has an address of its own, which changes when the box restarts. A
  disabled or expired link tells visitors it is gone for ten minutes, then
  stops answering.
- On a link with a password, the plain address a visitor copies from the
  browser asks for the password instead of answering "not found", and the
  right password opens the app on that device.
- Only the owner can create a link; the assistant cannot publish an app.

### xAI Grok

- On the OpenClaw edition, Settings and the setup wizard list **xAI Grok**.
  Paste an API key, or use **Sign in with Grok** with a SuperGrok or X Premium
  subscription and approve the sign-in on any device.
- Grok models then appear in the chat's model switcher and on the Providers
  strip, like any other provider's.

### Voice

- Hold to talk: hold the chat's microphone button while you speak and let go to
  send; a quick click still starts and stops a recording. Holding F8 while the
  chat is open does the same, and Esc cancels.
- **Auto-play every spoken reply**, a new switch in Settings → Voice that is
  off by default, plays the reply to a question you typed aloud as well, while
  you are at the chat.
- **Short spoken answers**, another new switch in Settings → Voice that is off
  by default, has a spoken reply say only the main answer, in at most three
  sentences, so it starts sooner. The full reply still appears in the chat.

### Terminal

- Paste a picture into Claude Code in the Terminal with Ctrl+V. The picture is
  uploaded to the box and Claude Code receives it as an attachment. Editors and
  other programs keep their own Ctrl+V.

### Desktop

- On a laptop, the tray shows the battery level beside the clock.
- On the ClawBox desktop session, a **Google Chrome** icon opens your own
  Chrome, with your own profile, as a window on the box's screen. A second
  click opens another window.
- **Remote desktop resolution**, in Settings → Appearance, sets the size of the
  remote desktop: 1280 × 720, which stays the default, 1600 × 900 or
  1920 × 1080. Changing it restarts the remote desktop briefly and closes the
  apps open on it, so you are asked first. The choice is kept across restarts
  and updates, and it does not apply while the remote desktop mirrors a
  physical screen.

### Coding Agent

- **A live chart of the agents.** The Coding Agent opens on its agents, drawn
  as a chart: the planner, each worker, each reviewer and the lead, with their
  state shown in colour and by icon, and the ones at work pulsing. Choose one to
  see what it is doing, its last steps, its time, tokens and files, and to open
  its run page, message it or stop it.
- **Messages reach a run while it works.** A message to a working run is handed
  to it right after the step under way, instead of when its turn ends.
- **Runs and teams wait in line.** A run asked for while the box is at its
  limit, and a team asked for while another team works, wait their turn instead
  of being refused. They keep their place across a restart and start on their
  own, their place in line is shown, and you can cancel them.
- **Fix CI.** When a pull request's checks fail, the run's page shows what
  failed: the checks, the tests and the files they name. **Fix CI** starts a
  run that fixes it, up to two attempts.
- **Teams open their own pull request.** A team that was asked for a pull
  request opens it once every task is accepted and its tests pass, sends
  failing checks back to the tasks they concern, and merges only when you asked
  for the merge.
- **Run notes.** Each project keeps notes of what earlier runs learned, such as
  the commands that work. Every run reads them, and you can view, edit and
  clear them on the project page.
- **Cheaper team roles.** A team's planner, lead and reviewers use the
  provider's cheaper model by default, while workers use yours; **Models per
  team role** in the Coding Agent's settings changes that. The team card shows
  the tokens each role used.
- **A fair share of the processor.** Coding runs work at a lower priority than
  the rest of the box and share a processor budget, smaller on battery, so the
  desktop stays responsive while they run.
- **Token use.** The Coding Agent's settings have a new **Token use** group
  under **Advanced**: **Run instructions** (**Short instructions** or **Full
  instructions**), **Helper agents** (**Only when it pays off** or **Always
  delegate**) and **Browser and media tools** (**Only for visual work** or
  **Always**). The leaner choice is the default for each, so every run sends
  fewer tokens, and a run keeps the choices it started with.
- **Leaner defaults for new runs.** Unless you changed them, a run now takes at
  most 200 steps instead of 400 and gets one attempt at what it had to deliver
  instead of three; **Attempts at a run's deliverable** raises the attempts
  again. A box with no effort saved starts runs at **Very high** instead of
  **Ultracode**. Coding Agent setup saves the effort it shows, so a box set up
  before this release keeps the Ultracode it saved there until you change it.
- **ClawBox apps in the Store.** The Store app has a **ClawBox Apps**
  category: **Install** downloads a published app, checks it, puts it in the
  Coding Agent's project folder and on the desktop, and **Uninstall** removes
  it again. A Coding Agent project with a `clawbox.json` gets **Publish to
  ClawBox Store**; until publishing is open to your account, the dialog says it
  is coming soon.
- **Runs report back in the chat.** When the assistant starts a coding run from
  a chat, on OpenClaw or Hermes, that chat hears when the run ends, and the
  assistant tells you how it went in a few lines without being asked. A run
  you stopped, and one that waited in line but could not start, are told too,
  each ending once. When a run's deliverable is missing, or something it
  started is still running, the assistant says so instead of calling the run
  done.
- **A run can reach you while it works.** A coding run can send the assistant
  that started it a question only you can answer, a blocker, or a milestone of
  a long job, and carry on working.

### Updates

- **Updates ask before they stop your agents.** An update stops the assistant
  and restarts the box's web server, which used to cut off agent work in
  progress. Now, while coding runs or assistant tasks are working, **Update**
  first says **Agents are working right now**, how many are active and that
  the update stops them mid-task, with **Cancel** to wait and **Update anyway**
  to go ahead.
- **What's new, while you wait.** The update screen shows the release it
  installs one highlight at a time: the title types in beside a screenshot of
  the feature, with a live demo over it. Pick one with its chip, the arrow
  keys or, on a phone, a swipe; it goes on drawing while the box restarts.
- **Update** goes straight to the full-screen update screen, after a short
  ClawBox loader, instead of drawing the steps inside the Settings window
  first. In a window too small for the steps and the showcase side by side,
  it shows the steps alone.

### Local AI

- **Installs wait in line.** An install in **Settings → Local AI** that cannot
  run beside another one waits its turn instead of being refused. Its card
  says **Queued — starts after** the install it waits for, with **Cancel**, and
  it starts by itself when that one ends, after a restart too.

### Scheduled job alerts

- The box tells you when one of the assistant's scheduled jobs fails, keeps
  being skipped, does not run when it is due, or was switched off after it
  failed: on the desktop, and on Telegram when a bot is connected. You hear
  once per problem and once more when the job runs normally again, and several
  jobs at once come as one message. The message never quotes the job's error.
- **Settings → Harness → Scheduled job alerts** lists the jobs in trouble,
  since when, and the scheduler's last error. **Alert me about scheduled jobs**
  is on by default. The desktop notice's **Open Settings → Harness** goes
  straight to that card.

## Improvements

### AI models and the assistant

- On OpenClaw, changing the model in Settings, installing or switching Local
  AI, and the local-only switch take effect without restarting the assistant
  wherever the change can be applied live. Each of those used to cost about a
  minute of chat. Saving a model is quicker too, because the box makes one
  settings change instead of several.
- OpenClaw is updated to 2026.10.9 and Hermes Agent to v0.22.5.
- Once setup is finished, the assistant answers your first chat message like
  any other, instead of starting a get-to-know-you conversation.
- On OpenClaw, the assistant comes with a ClawBox handbook and a set of
  everyday skills, such as email, documents, reminders and research. Each is
  added once, and a skill you remove is not added back. A scheduled task that
  keeps failing now says so in the chat.
- The Coding Agent's **Let the assistant delegate coding work** switch is on
  unless you switched it off, so once the Coding Agent is set up, the
  assistant can hand it coding work from the chat.
- **Protect ClawBox files from the agent**, a new switch in Settings →
  Harness, is on by default and stops the assistant's own file and shell tools
  deleting or overwriting ClawBox's own files and local AI models. On
  OpenClaw, changing it restarts the assistant.
- On OpenClaw, memory search reads the assistant's memory and no longer
  indexes every past chat, which kept its databases growing. A box that set
  this itself keeps its setting; on the others the index is rebuilt once after
  the update.
- On OpenClaw with ClawBox AI, a long chat is compacted at about 128K tokens,
  so each message no longer sends more of the conversation as the chat grows.
- What the assistant's tools hand back is scrubbed of tokens, keys and other
  credentials before the assistant sees it.
- Spoken replies are sent compressed: a 15-second reply is about 90 KB instead
  of more than 700 KB.
- The assistant can search and read ClawBox's own user guide and support pages,
  as they are for the installed version, with no internet needed. When
  something on the box fails, it looks the symptom up there first.

### Chat

- Pressing Stop leaves a grey "Stopped." line under whatever part of the answer
  had arrived, so a stopped reply is no longer mistaken for a lost one. On
  Hermes the stopped reply is also kept after a reload.
- On Hermes, documents attached in the chat reach the assistant, and small text
  files are quoted into the message so that the box's own small model reads
  them too. A Hermes box that cannot look at pictures still takes documents.
- The Hermes chat shows the Hermes icon instead of the crab.
- A coding run card you hide with × stays hidden, in every window and after a
  reload. **Show finished coding runs again** brings back only the cards that
  left on their own.
- A long conversation on Local AI no longer takes minutes to be shortened by
  the box's small model, on OpenClaw or Hermes. The chat offers **Start a new
  chat with Local AI**, which answers in seconds, or **Shorten this
  conversation first**, and a shortening that leaves the chat no smaller is
  not reported as done.
- On OpenClaw, the chat's **Task progress** card has three buttons: × hides it
  in that chat until the assistant updates it, the bin clears it, and refresh
  asks the assistant to bring it up to date. On a narrow phone its time stays
  whole and the summary is cut first.

### Coding Agent

- The app is simpler: a project page shows its team first, the whole task opens
  in a readable dialog, a finished run leads with its summary, and the settings
  page shows the basics with everything else under one Advanced section.
- A finished run's working copy is removed, because its branch keeps the work
  and a resume brings it back. A copy that still holds unsaved changes is kept.
- A team task starts only once the tasks it depends on have been reviewed and
  accepted. Work that started on a task that is then reopened is held, without
  counting against its tries.
- An app a run builds reaches the desktop even though the run stopped its own
  test server: the box starts the app from its project folder, and says what
  went wrong when it cannot.
- A working run no longer shows "0 turns".
- A run no longer ends while something it started, such as a background job,
  is still running: it keeps working until that is done. If it has to stop
  anyway, its page says **Something this run started is still running.**, and
  that line counts only what the run itself started.
- Work a run wrote only through its shell, such as a generated file, is
  committed on the run's branch when the run made no commit of its own.
- The assistant can start a run from a branch you name, and hand it your own
  files, such as a PDF in Documents, which were refused before.

### Backups

- ClawKeep checks whether a backup fits in the account's free space before it
  uploads anything, and leaves the cloud copy untouched when it does not.
- When a backup is refused, the ClawKeep window, **Back up now** and the shield
  on the shelf say why, with sizes: what the backup needs and what is free, or
  that it is larger than the whole plan. A backup started while another runs is
  reported as already running, not as a failure.
- A storage service that stops answering can no longer hold a backup, and
  **Back up now**, for over an hour: the run gives up within minutes and says
  so.

### First setup

- The password step says under each field, as you type, when a password is too
  short or the two entries do not match.
- After the notice that the hotspot was not restarted, the button reads
  **Continue**, so a box whose Wi-Fi cannot host a hotspot is no longer stuck
  on that step.
- A box that already has a password skips the password step, instead of asking
  for a current password the step has no field for.
- On Hermes, choosing to use only local AI sets local AI up, and the provider
  step says "Starting the Hermes agent" rather than "Restarting gateway".

### Desktop

- The fullscreen button leaves the shelf while the page is already full screen.
- Wallpaper **Upload** takes pictures only: another file is refused with a
  message, and a stored file that is not a picture shows the default wallpaper.
- A desktop whose sign-in expired or was revoked goes to the sign-in page
  instead of sitting frozen.
- The crab's eyes stay closed while it sleeps.
- On Hermes, the Skills app no longer lists bundled skills that cannot run on
  this device.
- The notices in the top-right corner stay there, under the kiosk bar, and
  take turns with the chat instead of jumping when you open, dock or move it.
  Small pop-up messages join them, instead of sitting in the bottom-right
  corner over the chat's message box.
- A notice with a button says under its message where the button leads, such
  as **Open Settings → Harness**.

### Settings

- **Users** has moved into **Settings → System**, as a tab beside the
  device's figures, and only the owner sees it. A sign-in page that needs the
  owner's one-time repair now points to **Settings → System → Users**.
- Signing out of a provider shows what is happening: the button reads
  **Signing out…** and the row dims until the box has its new list, so a
  sign-out that restarts the assistant no longer looks like a lost click.
- Connecting or signing out of an AI provider, and setting up Telegram,
  Discord, Email or WhatsApp, run as jobs of the box with a card in the corner.
  Close or reopen Settings half-way and the change is still shown running, and
  a failure says what went wrong instead of showing a bare code.

## Fixes

### Wi-Fi, network and remote access

- A saved Wi-Fi network is kept and tried while the hotspot starts, recovery
  is bounded so a box is not left with neither Wi-Fi nor a hotspot, and a
  hotspot you switched off stays off when Ethernet is unplugged before setup.
- A connectivity check that fails for a moment no longer restarts the
  assistant; a real outage still does. Some boxes had restarted it every half
  hour.
- Remote access no longer answers every request with "not found" when the
  box's user has tunnel settings of their own.
- **Install Cloudflare Tunnel** in Settings → Remote Control works on every
  kind of ClawBox install; some refused it.
- On ClawBox installed on your own x64 machine, a Cloudflare Tunnel download
  that stalls no longer holds up the install or **Install Cloudflare Tunnel**:
  it gives up within minutes with a warning, and the button can try again.
- Restoring a ClawKeep backup always turns remote access back on, so the box
  can be reached afterwards, and it stays on after a reboot. This happens also
  when remote access was off on the box before the restore.

### Updates

- When an update fails, the box's code is put back to match the build it is
  still running, so it is not left with new code under an old build. This also
  covers an update started from an older build.
- The first start after an update no longer drops the remote desktop once.
- A Jetson box no longer comes back from an update unable to boot because the
  firmware moved its SSD down the boot order: the SSD is kept first at every
  start and shutdown, and the network boot entries stay switched on but last.
  A device the firmware adds again, the SSD included, now goes to the top of
  the order, so a start that missed the SSD once no longer leaves the box at
  the UEFI Shell prompt on every start after it.
- An update reboots the box only when something needs a boot, such as a new
  kernel, and otherwise restarts the ClawBox services. Any ClawBox service
  that should run and is not running afterwards is started, and the update's
  warning names each one that did not come back, telling one that came up late
  from one that crashed.
- On ClawBox installed on your own x64 machine too, an update that leaves
  OpenClaw as it is no longer stops the assistant.
- On OpenClaw, an update checks that the chat can open its conversations, not
  only that the assistant runs. When it still cannot after one restart of the
  assistant, the update fails and says to restart the device, instead of
  finishing green over a silent chat; a chat that is only slow to answer is a
  warning.
- An update no longer stops the assistant while it is still starting, which
  made the stop wait out its five and a half minute limit; it lets the start
  finish first, for up to three minutes.
- An update no longer fails at **Applying system fixups** when another job
  restarts the assistant while the update stops it.
- On a box without a clock battery, an update no longer fails a healthy box
  when the clock jumps forward to the network time after a cold start.
- The update screen no longer lists the **Installing Chromium** and
  **Installing VNC (Remote Desktop)** steps, which still run, and its step
  count leaves them out.
- On a wide screen the update screen fills the window, with **Don't power
  off** at its foot, instead of stopping short above an empty band.
- Checking for updates no longer waits on a download of every branch and tag
  from GitHub, so the setup wizard's update step no longer stalls on
  "Checking for updates…" when GitHub is slow.
- On OpenClaw, an update that lacks the disk space to move the assistant's data
  to the new format stops before it changes OpenClaw, and says how much space
  it needs and how much is free. When an agent's data is left unfinished, the
  OpenClaw app says **OpenClaw's agent data needs attention** and what to do,
  instead of looking ready.
- On OpenClaw, a restart or update gives the assistant up to five and a half
  minutes to finish saving before it is stopped, instead of 30 seconds.

### Sign-ins and providers

- Signing in to a Claude subscription again really replaces the old sign-in.
  Before, the new one could be dropped without a word and every chat failed.
  When the sign-in is missing the chat now says so and names the two fixes, and
  the Providers strip shows a Claude sign-in that needs renewing.
- A box linked to ClawBox AI during first setup no longer finishes setup with
  no assistant: the cloud defaults wait until the assistant answers.
- The ClawBox AI sign-in no longer reports a time-out for a sign-in that
  worked.
- Saving ClawBox AI after its sign-in was revoked no longer leaves setup on
  **Warming up**: the revoked sign-in is cleared and you are asked to sign in
  again. A model save the box has not answered within 90 seconds stops and
  says so.
- When your ClawBox AI allowance is used up, a failed chat message says which
  allowance is spent and when it frees up, instead of a generic rate limit, and
  for the weekly allowance how to add an extra-usage pack. The usage card calls
  the five-hour allowance **Short-term limit (5 hours)**.
- The Telegram card no longer says the channel is active when the bot is not
  receiving messages, for example after its token was rejected.
- On Hermes, a chat or a Hermes dashboard tab whose ClawBox sign-in has
  expired goes to the sign-in page, as on OpenClaw, instead of staying on a
  chat that no longer answers.
- On Hermes, ClawBox AI cannot be signed out while it is the default
  provider: its button says to make another provider the default first. A
  sign-out that Hermes still lists as signed in now fails instead of
  reporting success, and the helpers that still pointed at ClawBox AI go back
  to Hermes' own.

### Switching between Anthropic accounts

- An account is no longer marked expired because the box could not reach
  Anthropic to renew its sign-in, for example after the box was switched off
  or before its network was up after a restart. The box tries again on the
  next request, and only Anthropic itself refusing the sign-in takes an account
  out. Before, such a box needed every account signed in again.
- When an account's organization has switched off Claude subscription access
  for Claude Code, the account is marked **Needs re-authentication** straight
  away, and the chat and coding runs move to the next account instead of going
  back to it. A sign-in Anthropic reports as revoked is checked with Anthropic
  and, when it really is dead, moves them on too.
- The account the box switches to is used right away, instead of sitting out
  the cool-down of the account before it.
- A failed chat reply or scheduled task counts against an account only when
  the assistant was really running on that account. Right after a switch, a
  failure that still came from the previous account no longer takes the new
  one out, and an account that reached its limit still moves on.
- A slow-starting assistant is no longer restarted over and over, and neither
  is one whose switch could not be saved: the box waits longer before each new
  try.
- A coding run that cannot be moved to another account now says so plainly:
  that the box may be offline when another account is still usable, and in
  every case that the run has to be started again. It no longer says every
  account refused it and asks you to sign in again over accounts the card shows
  as fine.
- On OpenClaw, a chat whose account reached its usage limit moves to another
  account on its next message, instead of answering with the limit message.
  The account joins in again once its limit resets.
- Claude's usage limits are read per model: a weekly limit on one model holds
  back only the runs on that model, while the chat and other models carry on.
  The **Anthropic accounts** card shows every model's week, and Anthropic's
  "continuing automatically" notes count as progress, not as a reason to
  switch accounts.
- A run held up by two spent weeks of the same model waits for the later of
  the two resets, instead of starting again while the other week still
  refuses it.
- When Anthropic refuses an account's sign-in in the middle of a coding run,
  the run moves to the next usable account instead of going round the
  refused one until its tries run out, and a resumed run never goes back to
  an account it gave up on.
- When the assistant checks your Claude accounts, its answer leads with the
  verdict and the advice, before the list of accounts.

### Chat and voice

- When the cloud voice does not answer, a spoken reply gives up after about 20
  seconds, instead of showing "Speaking the reply…" for a whole minute and then
  going quiet without a word. A short line under the reply says the voice is
  not answering, or that it could not speak that reply, and it goes away once
  the conversation moves on. A reply whose audio breaks off part way says so
  too.
- A coding run started somewhere other than this chat, such as another browser
  or device, now shows its card in the open chat within about half a minute,
  without a reload. One failed check no longer stops the chat from looking
  until the page is reloaded.
- On OpenClaw, typing / in the chat lists the commands on a setup with more
  than one agent too; the list used to stay empty.
- On OpenClaw, a user other than the owner can start a new chat again; it used
  to fail with "Could not start a new chat".
- On Hermes, the first message in a chat already under way no longer fails
  with a permission error, or asks about adding a picture, after the assistant
  restarted or the provider or model was switched. The chat reopens the
  conversation and sends the message; when it cannot, it asks you to send it
  again in a moment.
- On OpenClaw, **Turn off Local AI** while Local AI answers the chat moves the
  chat straight back to your cloud model, instead of loading the local model
  again on the next message.

### Prime Radiant

- **Undo** never undoes a verification, whole or one page of it, which used to
  bring the wrong answer back and leave the right one retired. **History**
  marks those changes **Can't be undone**, and says why.
- When a document behind a page you verified changes, the night is held and
  **Review** asks you about it, showing what the new version adds and drops,
  instead of the change being skipped without a word. An import you start
  yourself leaves that page as you verified it, lists it under **Left out** on
  the job's row, and asks in **Review** too.
- Stopping an import shows **Stopped**, and the files it did not reach wait
  for the next run instead of failing; **Try these again** imports them. Files
  dropped on **Add** show **Dropped files** as their source.
- A fact worded with its document as the subject is checked against the
  others like any fact, so a contradiction can no longer hide that way.
- **Review** shows a disputed fact in its own words, and its kinds of
  evidence, verdicts and notes read in your language instead of raw words.
- An import's total matches what its preview promised, and its count of pages
  written moves while it writes.
- The nightly card no longer says the nightly pass has started once it has
  ended, and a night whose question check gets no verdict keeps the last
  score.
- On a phone, nothing in Prime Radiant runs off the edge of the screen.
  Changing the language no longer stalls **Pages** for about ten seconds, and
  the usage totals in its settings show at once.

### Factory reset

- Factory reset now also empties Projects, Music, Pictures, Videos, Public and
  Templates, and removes loose files in the home folder, keeping the folders
  themselves.
- A Hermes box still starts its assistant after a factory reset.

### Other fixes

- The desktop environment's own first-run assistant no longer starts in the
  background, which saves memory.
- ClawKeep on a box set up before its portal moved switches to the new address
  by itself, for backups and for a pairing already under way. Any other portal
  address is left alone.
- An app with its own server can load and save its data through its own `/api`
  inside its desktop window; the browser used to block those calls.
- A project a Coding Agent team builds no longer carries a link to the box's
  own dependency folder, so it runs on other machines too.
- The box's web server and the libraries it uses are updated with their
  security fixes.
- Every "… ago" on the desktop is counted on the box's clock, not your
  browser's, so a computer whose clock runs a little behind no longer shows a
  finished backup as "in the future".
- Every box is moved onto the llama.cpp build ClawBox pins, at install and on
  every update, and says so when it cannot be rebuilt. A box on an old build
  had memory search fall back to the cloud without a word; **Settings → Local
  AI** now says why the **Memory search** model stopped.
- On Hermes, the assistant's first ClawBox tool call after more than ten quiet
  minutes no longer fails.
- The desktop no longer stays dimmed under **Drop files to upload** after files
  are dropped on an app's own drop zone.

### Fixes since the release candidate

- **Only the owner can finish first setup.** The step that completes setup, and
  hands out the owner's session, now refuses every other signed-in user and the
  assistant's own access. Switching an update on from the chat asks the owner
  to confirm first; the assistant can no longer start a system or OpenClaw
  update on its own.
- **A box that cannot read its own settings no longer looks Free.** When the
  OpenClaw config is unreadable for a moment, the plan shows as unknown instead
  of Free, so a paying owner no longer sees "your plan is now Free" or a false
  upgrade celebration.
- **Turning Local AI off keeps your other backup models.** Only the local
  model leaves the fallback list; ClawBox AI stays as the backup.
- **Hermes keeps the conversation after a reload.** On the Hermes runtime the
  chat resumes the same session after F5, a restart or an update, so the next
  message still knows what was said before.
- **ClawKeep backs up the runtime you switched to.** A dual box switched to
  Hermes now backs up the Hermes chats, memory and skills, and the status says
  so. A refused cloud upload is reported in the dashboard instead of leaving a
  backup stuck on "Uploading".
- **First setup from a phone.** If the request that sets the owner's password
  drops on the setup hotspot, the wizard stays on the security step with Save
  usable instead of moving on with no password. The Update step says why a
  start did nothing.
- **The Coding Agent cleans up after itself.** Stale run copies and worktrees
  in the project folder are trashed after a retention period (14 days by
  default, in Settings → Coding Agent); your own projects and anything with
  unsaved work are never touched. Store server apps install on a fresh box
  without a project folder set, and the app window keeps your session.
- **ClawBox AI sign-in.** You can sign out of the box's ClawBox AI account from
  Settings, a failed ClawBox AI turn is shown in the chat with a way to sign in
  again, and cloud voices appear right after an upgrade to Max without a
  restart.
- **Updates.** The System Update screen was redesigned around the steps it
  runs, names the build a beta run installs and follows it until the box
  judges it; an OpenClaw update already at the pinned version skips the
  reinstall and keeps the assistant running. Long Settings tasks (installs,
  model downloads) run in the background with a corner card, survive closing
  Settings and can be cancelled.
- **Local AI on Hermes.** Gemma runs with a 64k window and a lean mode, and
  Local AI stays on when you swap back.
- **Coding teams.** A team the owner stopped stays stopped, a worker's commits
  on its own branch are brought home, and a run or team shows up the moment it
  is asked for.
- **OpenClaw for every user.** The owner can share the OpenClaw app with all
  users of the box from Settings (off by default).

## Upgrade notes

- Upgrade from 4.2.x, 4.1.x or 4.0.x in **Settings → System Update**, or over
  SSH by running `sudo bash install.sh` in the ClawBox checkout. On the Hermes
  edition System Update is the only route.
- A box offers 4.3.0 once 4.3.0 reaches the branch the box follows: the branch
  set for it, else the branch it is checked out on, else `main`, the release
  channel. **System Update → Advanced options** shows which. On `main` the
  update is offered by its release name, `v4.3.0`; on any other branch it is
  named by its commit.
- Your data is preserved, as in 4.2, and the edition lock is untouched.
- On the OpenClaw edition, the update moves OpenClaw's data to the newer format
  OpenClaw 2026.10.6 uses. The move is one-way, so the box cannot go back to an
  earlier release afterwards.
- The update moves the box to Node.js 24.22.1 or newer, the October 2026
  Node.js security release that OpenClaw 2026.10.6 requires, on every edition.
- Sites the assistant was signed in to in its old, separate browser need one
  sign-in in Agent Browser.

## Breaking changes

- The assistant now uses the browser on the box's desktop rather than a hidden
  one of its own. The documentation explains how to give it a separate browser
  again.
- The Coding Agent no longer merges a finished run's work into the project
  folder by hand; the work stays on the run's branch, as before.
- A coding run whose task and folder do not look like something people see no
  longer gets the browser, picture or speech tools, even with **Let runs draw
  pictures** or **Let runs record speech** on. Set **Browser and media tools**
  to **Always** to give them to every run again.
- A dismissal of the 4.2 card is kept but no longer hides anything, and a tab
  still showing the 4.2 card cannot dismiss the 4.3 one.
- The Projects app has been removed, together with its pinned folders and the
  GitHub backup in Files. Your folders stay where they are and still open in
  Files; copies already on GitHub stay there, and their daily backup stops.
- Prime Radiant no longer asks Claude Opus for a nightly second opinion, and
  its settings no longer have the **Second opinion** section that came with
  the 4.3 beta builds. The nightly pass does not use an Anthropic API key or
  Claude Code any more; questions it raised before stay in **Review**.
