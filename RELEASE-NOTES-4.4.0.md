# ClawBox 4.4.0

Previous release: v4.3.0, 6 November 2026. 301 commits.

4.4 adds ClawBox Vault, a password manager built into every box, and an
organisation mode for a ClawBox that serves a company's staff. Local AI can run
on an AI engine of your own on your network, and the box checks for updates
every week and can tell you on Telegram. ClawBox AI is one model now, DeepSeek
V4 Flash. On the OpenClaw edition the assistant moves to OpenClaw 2026.11.5, a
one-way move, and its periodic check-in becomes an automation job. Updates are
faster and steadier, and Wi-Fi, the hotspot, Memory Shard and installs on PCs
get a long list of fixes.

## Highlights

- **ClawBox Vault, passwords built in.** A password manager on every box,
  opened by the owner from its desktop icon. Once you choose a vault PIN, the
  box's browser offers to save your logins and fills them in, and the
  assistant can log in to a site for you without ever seeing the password.
- **Organisation mode, for a company's staff.** A switch in Settings → System →
  Users gives other users only Chat, Files and their own settings, each with a
  limited assistant and a memory of their own. The owner picks the tools staff
  may use, sets upload, storage and chat limits, and reads an audit log.
- **Your own AI engine as Local AI.** Settings → Local AI → External engine runs
  the chat on an OpenAI-compatible server you run on your network, such as
  vLLM, SGLang or llama.cpp, instead of the model on the box. Without a ClawBox
  AI sign-in, Prime Radiant, picture descriptions and the Memory Shard index
  use it too.
- **A weekly update check, on Telegram too.** Every Monday morning the box
  looks for a newer ClawBox and tells you once per version: on Telegram, with
  an Update button, when a bot is connected, otherwise on the desktop. You can
  send /update to the bot at any time, and the update still waits for you to
  confirm it on the desktop.
- **One ClawBox AI model.** ClawBox AI is DeepSeek V4 Flash on every plan, for
  chat and for pictures. The update moves every setting that named a retired
  ClawBox AI model, such as the Max plan's own model, to deepseek-v4-flash. A
  model you chose from another provider stays.
- **OpenClaw 2026.11.5, a one-way move.** On the OpenClaw edition the update
  takes OpenClaw from 2026.10.9 to 2026.11.5 and moves the assistant's data to
  its newer format. The move is one-way: after the update an older OpenClaw
  core cannot open the data any more.
- **Check-ins become an automation job.** On OpenClaw 2026.11.5 the
  assistant's periodic check-in is an ordinary automation job. The update
  converts the check-in you had, on or off as it was, and Unprompted check-ins
  in Settings → Harness switches that job without restarting the assistant.

## New features

### ClawBox Vault

- **ClawBox Vault** is installed and running on every box, on both editions.
  Only the owner opens it, from its desktop icon, and nothing is saved or
  filled until the owner has chosen a vault PIN of at least six characters.
- The box's own browser then offers **Save to ClawBox Vault?** when you sign in
  to a site, and fills the logins you saved on https pages.
- The assistant can sign in to a site for you through the vault without ever
  being handed the password. Every fill, save and delete is listed under
  **Activity** in the app.
- ClawKeep does not back the vault up, and a factory reset removes it. Payment
  cards are off. Branded Google Chrome does not load the vault's extension.

### Organisation mode and other users

- **Organisation mode**, a new owner-only switch in **Settings → System →
  Users**, is for a ClawBox that serves a company's staff. While it is on,
  other users get only Chat, Files and their own settings; the Terminal, the
  Coding Agent, the app stores, backups, AI providers, system, network, updates
  and users stay the owner's. ClawBox AI offers are hidden for everyone, and
  the sign-in page asks for a username instead of listing the users. The change
  applies at once, and a user's open Terminal or remote desktop closes.
- In organisation mode, each member of staff chats with a limited assistant of
  their own, with a memory nobody else can read: a separate agent on OpenClaw,
  a separate profile on Hermes. The assistant runtime itself enforces the
  limits: no web search, browser, outbound messages, automations, coding agent,
  shell or system tools, and files are written only inside the member's own
  folder. A blocked tool call answers **Blocked by ClawBox: …**.
- A member's **Files** shows only their own home and a **Shared** folder that
  every member and the owner can read and write.
- **Tools for members of staff**, a card in Settings → System → Users, lets the
  owner give staff chosen MCP servers: to every member or only some, each with
  their own credential or none. Tools that send, publish, pay or delete stay
  blocked, and tools that create or edit only when the owner allows them. A
  file such a tool writes appears as a download card in that member's chat.
- **Limits for other users** sets the largest upload, a home folder quota and
  how many chat messages a user may send per minute and per hour. The owner is
  never limited, and the card shows each user's home folder usage.
- An owner-only **Audit log** lists sign-ins, failed sign-ins, sign-outs and
  administrator actions, newest first.
- The owner can **Reset password** for another user, who is then signed out
  everywhere. Every user other than the owner gets **Settings → Account** to
  change their own password.
- Updating is the owner's on every box: other users no longer see **Update
  available**, What's new or System Update.

### Local AI on an engine of your own

- **Settings → Local AI → External engine** uses an OpenAI-compatible server you
  run, such as an inference cluster, or vLLM, SGLang or llama.cpp on your
  network, as the box's Local AI instead of the model on the box. Enter its
  address, key, model and window, then **Test** or **Save and use**; **Remove**
  goes back to the Local AI you had. Speech and memory search keep running on
  the box.
- On OpenClaw, **The model reasons (thinking levels)** gives the chat Off, Low,
  Medium and High for a reasoning model on that engine. On Hermes the chat's
  reasoning level is sent to the engine on every turn.
- While an External engine or Local-only mode is the AI, **Settings →
  Providers** puts the local choice first and folds the cloud providers away.
  **Hide cloud AI providers** removes them from Settings, the setup wizard and
  the chat's model picker.
- On a box without a ClawBox AI sign-in, Prime Radiant, picture descriptions
  and the Memory Shard index run on the box's own engine, Local AI or the
  External engine, instead of ClawBox AI's cloud.
- **Link my subscription**, on the card in front of a paid feature, unlocks your
  plan's features without switching the box to ClawBox AI; the box keeps the
  model it uses.
- **Your speech server**, in **Settings → Local AI → Speech to text**, sends
  dictation and voice notes to an OpenAI-compatible speech-to-text server on
  the box or your local network first.

### Weekly update check

- **Check for updates every week**, in **Settings → System Update**, is on by
  default. Every Monday around 10:00, box time, the box looks for a newer
  ClawBox on the branch it follows and tells you once per version: on Telegram
  with a few highlights and an **Update** button when a bot is connected,
  otherwise with a notice on the desktop.
- The owner can send **/update** to the bot in a private chat at any time. A
  tap on **Update** only asks: the update starts once you confirm it on the
  ClawBox desktop, and not while agents are working.

### ClawBox AI

- ClawBox AI is one model on every plan, **DeepSeek V4 Flash**
  (`deepseek-v4-flash`), for chat and for pictures. The Pro and Max plans keep
  their names, but the plan no longer picks a model.
- At every start the box checks that the model can still see pictures. If it
  cannot, pictures go to a vision fallback, and if nothing can see them the
  chat says so in a plain sentence instead of an error.

### Coding Agent

- **Projects with several folders.** A folder project can list several git
  repositories from your project folder. **Add folder** on the project's page
  adds one; a run works on its own copy of each, and with automatic pull
  requests on it opens one pull request per repository it changed.
- The Coding Agent can use Claude Fable 5.2, Sonnet 5.5 and Haiku 5.5. On
  Anthropic, Fable 5.2 plans, Sonnet 5.5 writes and Opus 5.5 reviews unless you
  chose otherwise, and the effort picker offers medium and high again.

### Chat

- **Email draft for you to approve.** When the assistant prepares an email as a
  draft through a mail tool you granted, the chat can show the draft as a card
  with **Send**, **Keep as draft** and **Tell me what to change**. Only a person's
  press on **Send** sends it, through the send service set in **Settings →
  Email → Send approved drafts**; the assistant never gets permission to send.
  Off until the owner turns it on.
- The chat takes Word, Excel, PowerPoint and OpenDocument attachments (.docx,
  .xlsx, .pptx, .odt, .ods): the box reads their text for the assistant.

### Memory Shard

- Memory search can use the larger **Qwen3-Embedding-4B** on a PC with an
  NVIDIA GPU and enough free GPU memory, chosen in **Settings → Local AI** or in
  Memory Shard. Qwen3-Embedding-0.6B stays the default.

### ClawBox Workstation

- ClawBox installs with the PC installer on arm64 NVIDIA workstations such as
  NVIDIA DGX Spark. A fresh install on a machine with enough memory comes with
  Qwen3.6-35B-A3B as its local model.
- A ClawBox Workstation gets its updates from a `workstation` channel of its
  own, which receives a version only after it was tested on a Workstation.
- On a Workstation built from several DGX Sparks, the owner can see each Spark
  and the shared engine in a **Cluster** tab under **Settings → System**, once
  the other Sparks are listed in the box's settings file.

### Linked ClawBoxes (experimental)

- **Linked ClawBoxes (experimental)**, a switch in **Settings → System Update →
  Advanced options**, is off by default. Switched on, **Settings → Linked
  ClawBoxes** lists up to eight of your other ClawBoxes, and Ctrl+Shift+2 to
  Ctrl+Shift+9 open them from the desktop like workspaces; Ctrl+Shift+1 is
  always this box.

## Improvements

### Updates

- On OpenClaw, in-app updates keep the chat down for much less time: an
  assistant that is already running is no longer restarted while its service
  is configured, it is started once instead of three times, and after the
  update it starts through its own pre-start instead of a full repair pass
  when nothing needs repair.
- An update skips rebuilding the app when the build on disk already matches,
  and a box tracking beta or main at the published tip skips the on-box type
  check that the project's own CI already ran.
- Updates that move OpenClaw reinstall only the plugins that are behind or
  broken, instead of every external plugin. A plugin that fails to refresh is
  named on a warning card.
- A download that stalls is retried instead of hanging until the step times
  out, and a box with room for two builds keeps the previous one as a fallback.
- A failed update offers **Try again** next to **Dismiss**.
- **Full update log** opens a read-only terminal with everything the update
  printed, live while it runs and readable afterwards, with Copy and **Download
  log**. Credentials are redacted.
- On a PC, an update that finds the pinned OpenClaw already installed no
  longer stops the assistant to reinstall it.

### The assistant

- OpenClaw is updated to 2026.11.5 and Hermes Agent to v0.23.3.
- On OpenClaw on a Jetson, a watchdog restarts an assistant that stopped
  answering without exiting, at most twice an hour. Before, a stuck assistant
  stayed down until a reboot.
- On OpenClaw, when the assistant saves something to its memory, it says so in
  the same reply, names the file, and tells you that you can ask it to remove
  it.
- On a box where every chat shares one AI engine, such as a Workstation,
  OpenClaw's background memory review and skill learning start switched off;
  **Settings → Harness** can still turn them on.

### Settings

- Each connected provider in **Settings → Providers** has a short **Sign out**
  button beside its switch.
- **Settings → System → Device** folds temperature and storage into the
  Resources card.
- **Settings → Harness → Scheduled job alerts** has **Who gets them on
  Telegram**: only the people you tick get the alerts.

### Desktop

- Pages load faster: the icon font is a smaller file the browser keeps.
- On a Jetson, the desktop session no longer starts four of Ubuntu's background
  apps, which saves memory.
- Agent Browser's header is more compact.

### Security

- The installers write the service account's files as that account and no
  longer run its programs as root, and credentials stay off logged command
  lines and the process list.
- Secrets written in quoted form, such as `{"token": "…"}`, are masked in tool
  output, error messages and pull requests too.
- On a Jetson, the web server's long-running helpers start without its
  network capabilities.

## Fixes

### Updates

- On a Jetson, an update no longer fails at the rebuild step with "node-pty is
  still not loadable after rebuild", which rolled the update back and left the
  web Terminal dead.
- An update that moves OpenClaw no longer fails at the OpenClaw step with
  "Plugin migration obligations changed".
- When an update step fails, the update screen shows that step's own error,
  also after a rebuild was rolled back, and a step killed from outside the
  updater, for example by the out-of-memory killer, says so.
- A second update can no longer start while the first is still finishing.
- With several monitors, the update screen is drawn on the main monitor.

### Chat

- On OpenClaw, answers of reasoning models such as ClawBox AI stream into the
  chat word by word again, instead of arriving in one piece.
- While a reply streams in, you can scroll up to read without the chat pulling
  you back to the bottom.
- Coming back to a chat tab no longer shows the last answer twice.
- A message sent while the assistant is still starting waits under **Starting
  up, one moment…** and goes out once it is up.
- On OpenClaw, a user other than the owner can type /new or /reset to start
  their own session again. On Hermes, /new and /reset start a fresh session
  instead of timing out.
- File names in Cyrillic and other non-Latin scripts are no longer garbled
  when uploaded.
- A Telegram access request shows on the desktop within seconds.

### Wi-Fi and the hotspot

- A box whose Wi-Fi radio was switched off turns it back on by itself, so it
  can raise the setup hotspot and join a network again; a hardware switch stays
  off. Joining a network shows each step.
- The hotspot switch in Settings matches what the box does, and joining Wi-Fi
  from Settings after setup switches the hotspot off for good.
- In the setup wizard, a slow read of the device no longer overwrites choices
  you already made.

### Memory Shard

- An index pass no longer stops after two hours, so a full pass on the box's
  own model can finish. A pass that makes no progress for 30 minutes is
  stopped and says so.
- On OpenClaw, **Index now** no longer stops the assistant for nothing while it
  keeps the index up to date itself, and a healthy index is no longer reported
  as degraded.
- Memory Shard reads the status of a box whose main agent is not called
  "main".

### Sign-ins and Anthropic accounts

- An Anthropic account whose usage reading shows its limit spent is marked
  **Limited until** its reset, and the box moves on before a run fails on it.
- On OpenClaw, scheduled automations follow the Anthropic account pool across
  swaps and renewals instead of failing or answering with a spent account's
  limit message.
- On OpenClaw, accounts whose tokens are due together are renewed together, so
  the assistant is stopped once instead of once per account.
- On OpenClaw, a ChatGPT or Claude sign-in that went through is no longer
  reported as rolled back.

### Coding Agent

- A pull request merged on GitHub is brought into the project folder, and the
  preview of an installed server app starts on a spare port.
- Coding runs on a ClawBox AI model with a 200k window no longer stop with
  "Autocompact is thrashing".
- Read-only Codex runs no longer fail on Ubuntu 23.10 and newer.
- On OpenClaw boxes with a ChatGPT sign-in, idle Codex helper processes are
  stopped instead of holding hundreds of megabytes each.

### PCs and installs

- On a PC or Workstation, setup gets past its first step on a computer already
  online over Wi-Fi, and the Cloudflare tunnel forwards to the port the web UI
  serves on instead of answering 502.
- Choosing **On this box** in Memory Shard on an x86 PC downloads the default
  model instead of failing.
- The local model row is named after the model the box runs, instead of always
  "Gemma 4".
- On a Jetson, Ubuntu's log rotation is installed when missing, and bluetoothd
  no longer fills the journal.

### Other fixes

- The ClawBox MCP server starts on every install; on some it kept failing for a
  missing dependency.
- A server app that cannot start says what failed instead of "not found".
- The desktop shelf's tray no longer covers the app icons on mid-size windows.
- The Screenshot app remembers **Capture with** and **Hide this window**.
- The owner's Terminal opens programs on the remote desktop.
- ClawKeep leaves no staging archives behind in the temporary folder.
- On Hermes, a voice that cannot start for lack of memory says so instead of
  blaming the cloud voice.
- On OpenClaw, the OpenClaw icon no longer leads to a dead address when the box
  is reached through a tunnel.

## Upgrade notes

- Upgrade from 4.3.x, 4.2.x, 4.1.x or 4.0.x in **Settings → System Update**, or
  over SSH by running `sudo bash install.sh` in the ClawBox checkout. On the
  Hermes edition System Update is the only route.
- A box offers 4.4.0 once 4.4.0 reaches the branch the box follows: the branch
  set for it, else the branch it is checked out on, else `main`, the release
  channel. On `main` the update is offered by its release name, `v4.4.0`. A
  ClawBox Workstation follows its own `workstation` channel.
- Your data is preserved, and the edition lock is untouched.
- On the OpenClaw edition, the update moves OpenClaw from 2026.10.9 to
  2026.11.5, and with it the assistant's data to the newer format 2026.11.5
  uses. The move is one-way: after the update an older OpenClaw core cannot
  open the data any more, so the box cannot go back to 4.3 or an earlier
  release afterwards.
- On the OpenClaw edition, OpenClaw 2026.11.5 runs the assistant's periodic
  check-in as an ordinary automation job. The update converts the check-in the
  box had, on or off as you had it, and **Unprompted check-ins** in **Settings →
  Harness** switches that job. ClawBox does not create the job itself, so a box
  set up fresh on this release has none until one is created, and the row says
  so instead of showing a switch.
- Settings that named a retired ClawBox AI model, the Max plan's
  `deepseek-v4-pro` or the picture model `deepseek-v4-flash-vision-exp`, are
  moved to `deepseek-v4-flash`; a picture setting goes to the vision fallback
  instead while Flash cannot see pictures. Only ClawBox AI's own entries move;
  a model you set for another provider stays.
- Hermes Agent is updated from v0.22.5 to v0.23.3.
- On a Jetson, the box's own chat model server moves to a newer llama.cpp
  build, loaded in a mode that fits an 8 GB board.
- ClawBox Vault is installed and started on every box. Nothing is stored in it
  until the owner chooses a vault PIN.

## Breaking changes

- ClawBox AI no longer has a separate model for the Max plan or for pictures;
  the Pro and Max plans use the same model.
- On OpenClaw, **Unprompted check-ins** switches the check-in job, and a box
  without one shows no switch.
- Updating is the owner's alone: other users no longer see update notices,
  What's new or System Update.
- A dismissal of the 4.3 card is kept but no longer hides anything, and a tab
  still showing the 4.3 card cannot dismiss the 4.4 one.
