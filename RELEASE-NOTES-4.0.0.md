# ClawBox 4.0.0

Previous release: v3.9.0, 21 August 2026. About 2,390 commits.

4.0 is the release where the box does work for you while you are not watching.
You can hand it a whole coding task and get a pull request back. It answers on
the same address every time instead of a new one each restart. It indexes what
you have told it so it can find it later. And it fits on a phone.

## Highlights

- **Coding Agent.** Delegate a whole task to a headless Claude Code run. It
  works in a copy of your project, opens a pull request, and reviews its own
  diff before it calls itself done.
- **Several Anthropic accounts.** When a coding run hits one account's usage
  limit it moves to the next and carries on in the same session.
- **A hostname that stays.** A provisioned box answers on
  `<boxHandle>.clawbox.tech` through a named Cloudflare tunnel, instead of a
  fresh random URL after every restart.
- **Memory Shard.** Your notes, conversations and document folders become an
  index the assistant can search, on both editions, built in the cloud your
  plan already covers.
- **Chat that fits a phone.** A phone opens straight into the chat, with a
  thumb-sized microphone and the pickers folded behind one control.
- **Change model without restarting anything.** Provider, model and reasoning
  effort are pills under the message box and apply to the running agent.
- **Switch a box between OpenClaw and Hermes.** Settings, Harness re-makes a
  box as the other edition without a reflash.
- **Nothing heavy is installed behind your back.** Installs and updates now
  fetch only the local runtime and the small on-device model. Everything else
  is installed when you ask for it, which made updates much shorter.

## What's new by area

### Coding agent

- Delegate a coding task to a headless Claude Code run (`claude-ds -p`). Runs
  live in the web server and persist in `data/coding-agent-runs.json`, so a run
  outlives the browser tab that started it. Statuses are `running`,
  `completed`, `failed`, `stopped`, `paused`, `draft` and `gave_up`.
- **A run works in a copy of your project.** Each run gets a git worktree at
  `<project>/.clawbox/worktrees/<runId>` on branch `clawbox/<runId>`, so a run
  never edits the checkout under you and several runs cannot commit each
  other's half-written files. `maxParallelRuns` defaults to 2 and accepts 1 to 4.
- **Pull requests.** A run opens one with `gh pr create --base <base> --head
  <branch>`, and the base branch is resolved from the repository rather than
  assumed.
- **Review pass.** When a run settles, an automatic pass adversarially reviews
  the work and hunts for defects. A review that changed nothing has to say so.
  Further rounds are bounded by `MAX_REVIEW_ROUNDS`.
- **Steer a run in flight.** `POST /setup-api/coding-agent/message` and the MCP
  tool `coding_run_message` put a message in front of a run that is still
  going, instead of the previous choice between Stop and Pause, both of which
  throw the turn away. The message is queued on the record first, so it
  survives a web server restart, and the answer says whether it was queued or
  delivered.
- **Evidence.** Each run has a folder at `data/coding-agent-artifacts/<runId>/`
  for screenshots and test output, and its closing message is filed there as
  `report.md`. The app renders that as Markdown. Agent-written HTML is served
  as plain text and never executes in the app's origin.
- **Deliverables and retries.** A run can be given something it must leave
  behind before the box calls it finished. `completionAttempts` defaults to 3
  and accepts 1 to 6. A failed check with attempts left resumes the same
  session; with none left the run is `gave_up` and offers Resume, and the
  owner's own Resume is not counted against the cap.
- **Permissions.** The owner keeps an allow-list of Claude Code permission
  rules, at most 32. A headless run cannot be asked mid-run, so a refusal
  reaches the owner on the run's page with "Allow next time", which saves the
  narrowest rule that covers it. The credential stores and the box's own state
  can never be unlocked by a rule.
- **Secrets.** Project-scoped and box-scoped secrets are stored AES-256-GCM at
  rest under a key derived from the device session secret. No route ever
  answers with a value. A run is handed only ticked entries, and only while the
  owner's master switch is on. Everything the run says is scrubbed of those
  values before it reaches the record.
- **Isolation.** A run's parent process is spawned through `setpriv` with the
  ambient and inheritable capability sets emptied and no-new-privs set.
- The feature needs a paid ClawBox AI plan, Pro or Max. A box already enabled
  when a subscription lapses is never auto-disabled.
- MCP tools: `coding_agent_run`, `coding_agent_status`, `coding_agent_resume`,
  `coding_agent_stop`, `coding_run_list`, `coding_run_message`,
  `coding_secret_list`.

### Multiple Anthropic accounts

- **Settings, Providers, Anthropic accounts** holds several Claude Pro/Max
  sign-ins and API keys in the order you choose. Accounts are stored encrypted
  in the secret store under the `@anthropic-accounts` scope.
- When the account a run is using hits its usage limit, the run moves to the
  next usable account and continues in the same session. Selection is in your
  priority order, not round-robin, so the first account takes over again as
  soon as its limit resets.
- If every account is limited the run pauses rather than failing, records which
  meter ran out and when it resets, and resumes by itself at the first reset.
- The MCP tool `anthropic_accounts` reports the same state.

### Remote access

- A provisioned box runs a **named** Cloudflare tunnel and answers on
  `<boxHandle>.clawbox.tech`, the same address every time. No Cloudflare
  account is required.
- The credential arrives over the portal heartbeat as `boxTunnel` and is
  written to `data/cloudflared/named-tunnel` with mode `0600`. The tunnel runs
  with the token in `TUNNEL_TOKEN` only, never on a command line.
- **Fallback.** With no credential, a refused token, or a named run that dies
  inside 60 seconds, the box falls back to a Cloudflare quick tunnel and a
  random `*.trycloudflare.com` URL. `data/cloudflared/tunnel.mode` records
  which one is running.
- A refused token's fingerprint is remembered so a dead credential is not tried
  again in a loop.
- Hostnames are validated as exactly one label under `clawbox.tech`, and tokens
  against a base64url pattern, so neither can carry shell metacharacters.
- Remote Control is opt-in and is not gated on a plan.
- The inbound firewall defaults to deny. Only 22, 80, 443, 18789 and 8090 are
  reachable, and on IPv4 only from private ranges. Ports 3006, 18800, 5900,
  6080, 11434, 8081 and 631 keep working over loopback and are unreachable from
  the network. `rpcbind` is disabled and masked unless an NFS or NIS package is
  installed.

### Editions

- **Switch a box between OpenClaw and Hermes.** Settings, Harness runs the
  `harness_swap` root step: it installs the other agent, proves it runs before
  the edition lock flips, re-provisions the units, and carries the ClawBox AI
  sign-in, the Telegram bot token and Memory Shard's folder list across. It
  needs the Max plan, an internet connection and about 3 GB free. The same
  button swaps back. This is separate from `/setup-api/harness/select`, which
  is the `dual` SKU's runtime switch between two installed harnesses and needs
  a licence signed by ID Robots.
- **A Hermes plugin you install now reaches the chat.** Hermes scans for
  plugins once, when its process starts, so a plugin installed afterwards
  reached no chat at all. A watcher now restarts the agent when the declared
  plugin set changes, `POST /setup-api/hermes/plugins/reload` asks for the same
  thing, and `hermes_plugins_reload` is what the assistant calls after
  installing one. No sudoers grant is added. The open chat window drops with
  the restart, and a desktop notice names the plugin and says to open a new one.
- Memory Shard works on the Hermes edition, where ClawBox owns the index itself.
- ClawKeep archives the Hermes agent through the backup daemon's own backend
  rather than the `openclaw` CLI.
- Hermes is pinned to a chosen upstream commit through `HERMES_PIN_COMMIT`.
- The CLI update path is refused on Hermes in favour of Settings, System
  Update, because re-running the OpenClaw installer would break the edition
  lock.
- MCP tool counts differ by edition: 77 tools on OpenClaw, 66 on Hermes.

### AI models

- ClawBox AI answers with **DeepSeek V4 Flash** (`deepseek-v4-flash`) by
  default, on the Free and Pro plans. The Max plan adds **DeepSeek V4 Pro**
  (`deepseek-v4-pro`). Both declare a 1,000,000 token context window and
  393,216 max output tokens.
- **Change model without restarting anything.** Provider, model and reasoning
  effort are three pills under the chat composer. Picking a different one
  applies to the running agent, with no gateway restart and no reconnect.
- **Sign in with a subscription you already pay for.** Besides API keys the
  provider step takes Claude Pro/Max, ChatGPT Plus/Pro and Google One AI
  Premium sign-ins. On Hermes, Anthropic and GitHub Copilot sign in from the
  panel.
- Provider defaults: Anthropic `claude-opus-5`, OpenAI `gpt-5.4`, Google
  `gemini-2.5-flash`, OpenRouter `anthropic/claude-haiku-4-5`.
- Vision resolves to `deepseek-v4-flash-vision-exp`, with `gpt-5.6-luna` kept
  as the legacy fallback.
- **Settings, Providers** shows the weekly chat allowance, the 5-hour burst
  window, the image, speech and memory-indexing meters and the credit balance,
  read from the account rather than guessed on the device.
- Plans as stated in code: Free at 0 euro, Pro at 9 euro a month, Max at 49
  euro a month with a 30-day trial.
- A failed turn now prints the provider's own reason instead of a generic
  failure, and a reply written by a fallback model says which model wrote it.
- Third-party credentials are kept in OpenClaw 2's sqlite auth store.
- OpenClaw is pinned to 2026.9.3.

### Local AI

- **Settings, Local AI is one inventory.** Every model that can run on the box
  is listed with Install, Uninstall, Enable and Disable on each row, and what
  each one is doing right now.
- **Local-only mode** routes every request to the box and switches every cloud
  provider off, fallbacks included. It appears once the box's own model is
  primary or fallback. OpenClaw and dual editions only; Hermes has no
  equivalent.
- The bundled model is **Gemma 4 E2B** (`gemma4-e2b-it-q4_0`), a 3.1 GB Q4_0
  build from Google's QAT release, served by llama.cpp.
- **Nothing heavy is installed behind your back.** A fresh install and every
  update now install only the local AI runtime and the small on-device model.
  The voice engine, the transcription engine and the 639 MB embedding model are
  installed when you ask for them. Updates got much shorter as a result.
- Speech to text is faster-whisper, speech out is Kokoro, both kept loaded in
  GPU memory with a CPU fallback when no GPU is usable. Memory search embeds
  with Qwen3-Embedding-0.6B.
- Ollama can install larger models up to 4B parameters.

### Chat and mobile

- **A phone opens straight into the chat**, with a thumb-sized microphone
  beside the text box. The microphone swaps for Send while you are typing.
- In portrait, the provider, model and reasoning pickers fold behind one
  control, and attach, text box, microphone and Send sit on one input row, so
  the composer stops spending two rows on its pickers.
- **Progress card.** A long task reports its steps in the chat as it goes: what
  is done, what is running, the done and total count, and the agent's own note
  on the current step.
- **Slash commands with autocomplete.** Typing `/` lists the commands the agent
  actually publishes, including those added by skills and plugins.
- **The assistant can ask you a question.** It shows a card with the options it
  is choosing between, each with its consequence, plus a box for an answer of
  your own. Nothing happens until you send one.
- **Spoken replies** can read a reply out loud, with a player and a scrubber on
  the bubble. Off by default; turn it on in Settings, Voice.
- Images can be attached from the file picker, the camera or the clipboard, and
  attached and generated images render inline.
- **Discord: paste the token and that is all.** The box reads the application
  id and your servers from Discord itself and builds the invite link. There is
  no Application ID field any more.
- **Pick your desktop companion.** Settings, Appearance, Mascot Pet offers the
  bundled ClawBox crab, which works offline, plus a gallery of community pets.
- Chat uses `aria-live` status regions and labelled icon buttons, and a screen
  reader hears the answer rather than its markdown.
- The UI ships in 10 locales: English, Bulgarian, German, Spanish, French,
  Italian, Japanese, Dutch, Swedish and Chinese. A parity test fails if a
  locale is missing a key.

### Memory Shard

- Your notes, past conversations and folders of your own documents become an
  index the assistant can search. PDF, Word, OpenDocument, RTF and TXT are
  converted to Markdown before indexing.
- It is its own desktop app now, having been a card inside ClawKeep, and it
  works on both editions.
- **The cloud index is the default** on every edition wherever your plan covers
  it, so there is no 639 MB model to download before your first index. "On this
  box" is the opt-in and is never overridden once you pick it.
- The index is SQLite at `data/memory-index/index.sqlite`.
- Memory Shard needs a Pro or Max plan.

### Backups

- No ClawKeep changes ship in this release. ClawKeep is not new in 4.0; it
  first shipped long before v3.9.0.
- Current behaviour, unchanged: a daily systemd timer mints short-lived R2
  credentials from the portal, archives agent state and uploads it to your
  Cloudflare R2 prefix. On OpenClaw it shells out to `openclaw backup create`
  and captures state, config, credentials, sessions and workspaces. On Hermes
  it archives `~/.hermes`, including `config.yaml`, `state.db`, memories,
  skills, plugins, hooks, cron and pairing.
- Encryption is mandatory. The runner refuses to back up at all without a
  device passphrase, and the tarball is AES encrypted before a byte leaves the
  device.
- Snapshots can be labelled and locked, retention keeps the newest unlocked
  ones, and restore is available from the ClawKeep app or the CLI.
- Note that Memory Shard's index is **not** included in a backup. It is rebuilt
  rather than restored.

### Security

- Session cookies carry a generation counter, so changing the device password
  revokes every existing session.
- The MCP server authenticates to the web API with a per-install bearer token
  compared in constant time.
- Coding runs are spawned through `setpriv` with capabilities dropped and
  no-new-privs set, secrets are encrypted at rest and scrubbed out of anything
  the run says, and the credential stores are deny-listed for a run's own file
  tools.
- Routes that could widen a delegated shell or remove the owner's code require
  the owner cookie and same origin, and refuse the MCP bearer. Steering a live
  run is same-origin only, because it puts words in front of a shell that edits
  files.
- The inbound firewall defaults to deny, as described under Remote access.
- Telegram pairing codes and request IDs are validated against strict patterns.
- The provisioning marker is tied to the run that wrote it, so an earlier run
  cannot report a false success.

### Fixes

- The Local Models tab stops counting Ollama's memory twice. Ollama's own
  `llama-server` matched the llama.cpp pattern, so its memory was reported on
  both rows.
- Setup stops spending two and a half minutes starting Node.
- A failed chat turn stops printing the session's path and UUID.
- The device chat stops printing the agent's inter-session envelope.
- Duplicate user turns are gone, and there is a New chat button.
- Telegram voice notes reach speech to text rather than the wrong endpoint.
- The microphone reports that the connection is the problem rather than blaming
  your browser.
- A sign-in that restarts the agent re-points chats you already have open, so
  an open conversation cannot keep running on the old model while the pills
  name the new one.
- ClawBox AI chat has no model to choose, so it names the provider and shows no
  model pill, and its reasoning control starts at Medium.
- Installing on x86_64 checks the host first and lets you choose the web,
  gateway and terminal ports.

## Upgrade notes

- Upgrade from 3.9.x in **Settings, System Update**. Over SSH, run
  `sudo bash /home/clawbox/clawbox/install.sh`. There is no `clawbox` command
  on `PATH`; the CLI wrapper lives in the checkout and runs through Bun, and
  all it does is re-run the installer with `sudo`. On the Hermes edition the
  CLI path is refused and Settings, System Update is the only route.
- **How a box learns about the tag.** Updates are release-tag based: the box
  fetches tags from origin and considers `vX.Y.Z` tags, newest first. The
  desktop checks `/setup-api/update/versions` when it loads and every 30
  minutes after that, so an "Update available" card appears on every box within
  half an hour of the desktop being open once v4.0.0 is published. The card
  offers View update, Later and Dismiss. A dismissal is recorded against that
  exact pair of versions, so a later release raises a fresh notice.
- **What restarts.** The update stops `clawbox-setup.service`, rebuilds the web
  OS, re-provisions the systemd units, and ends with a reboot.
- **Expected downtime.** About 1 to 2 minutes of unreachability for the reboot.
  The UI reconnects and resumes progress reporting by itself. The update itself
  takes longer than that, but the box stays reachable for most of it. Updates
  are shorter in 4.0 because the voice, transcription and embedding models are
  no longer installed unless asked for.
- **Your data is preserved.** The updater runs `git clean -fd` without `-x`, so
  gitignored paths including `data/`, `.env`, `node_modules` and `.next`
  survive. The edition recorded in `/etc/clawbox/edition.env` is preserved, and
  updates do not change it.
- The in-app update does not touch the Jetson power profile. The box keeps the
  profile it booted with, and the closing reboot applies the persisted or
  default one again.
- After upgrading, the Coding Agent and Memory Shard both require a Pro or Max
  ClawBox AI plan. A box that had either enabled before a subscription lapsed
  is not auto-disabled.

## Breaking changes

There are no breaking changes to environment variables or configuration keys.
This was checked rather than assumed: across `v3.9.0..HEAD`, `.env.example`
gained 17 lines and lost none, and no environment variable or configuration key
was removed or renamed.

One API route was removed:

- `POST /setup-api/mascot-lines/regenerate` is gone. Mascot phrases are served
  by the remaining `/setup-api/mascot-lines` route. This is a session-gated
  internal route of the device UI rather than a published API, so no
  integration should depend on it.

Two ClawBox AI model aliases are retired upstream:

- `deepseek-chat` and `deepseek-reasoner` both resolved to V4 Flash on the
  proxy and are retired. Use `deepseek-v4-flash` and `deepseek-v4-pro`. A box
  that never had these written into its config is unaffected.
- Image generation moved from the `openai` provider to `litellm` for
  `gpt-image-1-mini`. The device migrates this itself on update.

## Known issues

- There are no open issues on the GitHub repository at the time of writing.
- The ClawKeep restic migration described in `docs/clawkeep-restic-migration.md`
  is a plan, not shipped code. ClawKeep still archives through the agent's own
  backup path and uploads to Cloudflare R2.
- Memory Shard's index is not backed up by ClawKeep and is wiped by a factory
  reset. It has to be rebuilt rather than restored.
- Local-only mode is not available on the Hermes edition.
- Restarting the Hermes agent to pick up a new plugin closes the chat window
  you have open. The desktop notice says so and tells you to open a new one.
- A quick tunnel's `*.trycloudflare.com` URL changes whenever the tunnel
  restarts. Only a provisioned box with a named tunnel credential keeps one
  address.
- The WiFi chip has a single radio. It can host the setup access point or join
  a network, never both at once.
- JetPack 7.x on Ubuntu 24.04 is not supported. Flash JetPack 6.2. On 24.04 the
  installer fails on Python's externally-managed-environment policy, PEP 668,
  among other differences.
