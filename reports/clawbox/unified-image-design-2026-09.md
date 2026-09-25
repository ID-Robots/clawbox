# Unified ClawBox image: design and step plan (TASK-1149)

**Goal (Yanko, 2026-09-24).** Every box ships from ONE image. During first setup, the wizard asks the owner to pick OpenClaw or Hermes. We stop flashing and shipping separate Hermes and OpenClaw boxes.

**Status.** This is a design only. v4.1 ships from `beta` first, and nothing behavioural lands before it. Every `file:line` below is against `beta` at `7db3c387`. Sizes marked *measured* come from x86_64 probes run for this document: the pinned OpenClaw `2026.9.4` and Hermes `2237be35`, installed the way `install.sh` installs them. A Nano's aarch64 numbers will differ somewhat, and PR 2 re-measures on a box.

**Recommendation in one paragraph.**
- Bake both harnesses into the image (Option A).
- Add a fourth lock value, `CLAWBOX_EDITION=unselected`. Nothing harness-specific runs while it is set.
- Add a wizard step between WiFi and Update. It hands the choice to a new root step, `edition_select`. That step reuses the harness swap's own lock and provision sub-steps, then removes the harness that was not chosen. The result on disk is exactly today's single-edition box.
- New code acts only when the recorded lock is literally `unselected`. No deployed box has that value, so upgrades are untouched (§6).

---

## 1. Where the edition is decided today

### Writers

| Writer | What it writes | When | Where |
|---|---|---|---|
| Flash rig or operator (nano-lab, not in this repo) | env `CLAWBOX_EDITION=<ed>` for the first `install.sh` run | factory provisioning run | read at `install.sh:716`. Documented as "the flash-time / QA override" at `install.sh:653` |
| `config/edition.txt` (optional first-flash seed) | nothing. It is read only when neither env nor lock names an edition | fresh install | `install.sh:720-721`. "Never authoritative" (`install.sh:672-675`) |
| `install.sh` `step_edition_lock` | `/etc/clawbox/edition.env` (root 0644) plus the legacy drop-in `clawbox-setup.service.d/edition.conf`. Then runs `step_edition_gateway_state` and `step_edition_foreign_teardown` | full install (`install.sh:11179-11180`) and **every in-app update**, through `step_post_update` (`install.sh:8370`) | `install.sh:4735-4816` |
| `scripts/setup-hermes-edition.sh` | the same two files | hermes/dual only, via `install.sh --step hermes_edition` (`install.sh:4822-4833`) | `setup-hermes-edition.sh:262-268`. Carries its own refusal at `:93-110` |
| Harness swap (Settings → Harness, Max plan) | the web writes `data/harness-swap.env` (`src/lib/harness-swap.ts:240`). The root step then re-execs `install.sh --step` as the target edition: install, prove it runs, `edition_lock`, provision | single editions only. Refuses `dual` and "no lock" (`install.sh:5152-5174`). Helpers: `install.sh:4870`, `4925-4931`, `5030`, `5091` | Max gate: `harness-swap.ts:71` |
| Dual licence | `data/dual-license.txt` or `CLAWBOX_DUAL_LICENSE`. This is not an edition; it unlocks `dual` | by hand at provisioning | `src/lib/edition-license.ts:9-11` |

- **Resolution order inside `install.sh`** (`install.sh:716-745`): env, then lock, then legacy drop-in, then `config/edition.txt`, then `"openclaw"`. An unrecognised value becomes openclaw with a warning (`:740`).
- **A provisioned box refuses any change** (`install.sh:782-833`). The escape hatch is `CLAWBOX_ALLOW_EDITION_CHANGE=1`, which the swap sets for its sub-steps.

### Readers

Every reader goes through one of three chokepoints, or through a shell twin of the same parse:

- `src/lib/edition-source.ts:81-96` `readEditionSource()`.
  - Reads the file first, then the env, then falls back to `"openclaw"` with `defaulted: true` (`:94-95`).
  - Cached by mtime (`:30`, `:84-88`).
  - `hasHermesHarness()` is at `:114-117`.
- `src/lib/openclaw-config.ts:72-73` `openclawIsAbsent()`, which is `readEdition() === "hermes"`.
- `src/lib/harness.ts:180` `getActiveHarnessSource()`.
  - A locked edition ignores the stored `active_harness`. Only a licensed `dual` reads it (`isDualUnlocked` `:85`, `lockedHarness` `:99`).
- Shell and Python twins:
  - `install.sh:838-844` (`is_hermes_edition`, `has_hermes_harness`, `has_openclaw_harness`)
  - `scripts/register-mcp.sh:45,120-128`
  - `scripts/setup-hermes-edition.sh:86-93`
  - `clawkeep/clawkeep/agent.py:39,80`

About 200 call sites in ~100 files outside tests consume these; `rg "getActiveHarness\(|openclawIsAbsent\(|hasHermesHarness\(|readEdition\("` lists them all. By decision:

| Area | Readers | What the edition decides | Lifetime |
|---|---|---|---|
| MCP gating | `mcp/lib/edition.ts:76` `resolveEdition`, called once at `mcp/clawbox-mcp.ts:594-595`. `mcp/lib/register.ts:375` drops tools whose `editions` exclude it. An unreadable lock gives the smaller set (`mcp/lib/edition.ts:47-58`) | tool set | per stdio child |
| MCP registration | `scripts/register-mcp.sh:120-128`, run at every boot by `production-server.js:313`. `src/lib/clawbox-mcp-registration.ts:88-91` | which harness config gets the ClawBox entry | per run |
| Middleware and gateway proxy | `src/middleware.ts:560`, `src/app/[...gateway]/route.ts:60` | 404 for gateway paths on hermes | per request |
| Harness API | `setup-api/harness/active/route.ts:28`, `status/route.ts:21`, `select/route.ts:24-25`, `swap/route.ts:66-77` | what the UI and MCP are told; switcher and swap gates | per request |
| Updater | `src/lib/updater.ts:3394,3401` (`openclaw_install`/`_patch` apply), `:3468` (`hermes_edition` applies), `:3827-3834` (versions). The root unit loads the lock as env (`config/clawbox-root-update@.service:13`) | which steps an update runs | per update |
| Voice | `setup-api/tts/route.ts:129,168,402`, `stt/route.ts:73,157`, `whisper/route.ts:449`, `src/lib/voice-reply.ts:103` | channel voice only where OpenClaw exists | per request |
| Channels | `src/lib/telegram-bot-identity.ts:175`, plus the telegram, discord and whatsapp routes via `getActiveHarness()` | which harness stores the bot | per request |
| Memory and backup | `src/lib/clawkeep-memory.ts:968,1669`, `src/lib/memory-shard.ts:93`, `clawkeep/clawkeep/agent.py:80` | local index vs OpenClaw's; backup backend | per call |
| Providers | `setup-api/ai-models/configure/route.ts:476,578,2711`, `ai-models/catalog/route.ts:1356`, `setup-api/hermes/*` | which harness config the sign-in lands in | per request |
| Branding and pets | `src/lib/setup-skin.ts` (`resolveAgentSkin`), `src/app/setup/layout.tsx` (force-dynamic, `:5-19`), `src/lib/hermes-pets.ts:79,121,328`, `setup-api/pets/route.ts:32` | skin, mascot | per request |
| Boot-time, once per process | `src/instrumentation.ts:285-303` (wallpaper migrations; asked once per boot, and they defer when the answer is defaulted), `:474-481` (Hermes plugin watcher starts only if `hasHermesHarness()` at boot) | | **process lifetime** |
| Factory reset | `setup-api/setup/reset/route.ts:313-315`. The lock is preserved (`RELEASE-NOTES-4.0.0.md:341`) | gateway mask dance | per call |
| UI | `src/lib/client-harness.ts:49,96-104` (the edition is pinned for the document only when `activeKnown`), `SetupWizard.tsx:420-431,788`, `AIModelsStep.tsx:366,1700,2047`, `SettingsApp.tsx:1337`, `TelegramConfiguringOverlay.tsx:40,210`, `PetPicker.tsx:60` | copy, provider UI, Hermes palette | per document |
| Sweeps | `scripts/feature-sweep.mjs:365,408-409`, `e2e-install/35-mcp.spec.ts:37-47`, `mcp/check-tools.ts` (matrix per edition) | assertions | per run |

**Consequence for this design.** Almost every reader re-reads the lock per request. Three things do not:
- the MCP child;
- `instrumentation.ts` boot work;
- the systemd units enabled at install.

So a choice made after first boot has to end with the units provisioned for the chosen edition and a `clawbox-setup` restart. The swap does the first of these already.

---

## 2. Option A vs Option B

| | **A: both baked, the choice activates one** | **B: common base, the choice fetches one** |
|---|---|---|
| Image vs today's OpenClaw golden | **+ Hermes ≈ 2.0–2.7 GB.** Checkout plus venv is "~1.9 GB" on a device (`install.sh:4346`; *measured* 1.6 GB here: 71 MB git, 253 MB venv, 1.1 GB node_modules). Up to 0.65 GB of Playwright Chromium when upstream's installer finds no system browser (*measured* 184 + 115 + 2 MiB downloaded, 656 MB unpacked). uv's Python 3.11 is ≈ 0.1 GB | **− OpenClaw ≈ 0.55 GB** (*measured* 546 MB, 330 packages) |
| Image vs today's Hermes golden | + OpenClaw ≈ 0.55 GB, plus the `@openclaw/*` channel plugins | − Hermes ≈ 2.0–2.7 GB |
| Download at setup | **none** | OpenClaw ≈ 0.24 GB from npm (*measured* fresh-cache fetch), plus plugins. Hermes ≈ 0.7–0.9 GB from GitHub, PyPI, npm and the Playwright CDN (*measured* sum of the parts above) |
| Setup time of the choice | Lock, provision and remove; no network. *Estimate* 1–3 min, dominated by the first harness start and MCP registration ("a couple of minutes on a loaded Orin", `src/lib/clawbox-mcp-registration.ts:80-82`). PR 2 measures it | OpenClaw: the npm core alone is "33 s on an Orin over WiFi" (`install.sh:5562`), then patch, config, plugins and gateway. Hermes: "a few minutes" (`docs-site/editions/switching.mdx:52`), with 3 GiB free and 1.5 GB RAM required (`harness-swap.ts:78-80`). *Measured* 74 s wall for Hermes on a fast wired x86 link |
| Offline setup | **Works for both choices**, as today. Update can be skipped and "setup is never blocked" (`UpdateStep.tsx:376-384`). Gemma is fetched at flash (`install.sh:4459`) | **Fails for both.** No agent until a download succeeds. Hermes also pipes upstream's installer from raw.githubusercontent.com into bash (`install.sh:4112,4298-4301`) on every customer's first boot |
| Where it fails | At the rig, where `[provision-status]` already catches it (`install.sh:11156-11159,11325-11344`) | At the customer's desk: GitHub's anonymous rate limit (`UpdateStep.tsx:382`, TASK-655), PyPI or npm outages, region blocks. Nobody from us is there |
| Flash rig | One image, larger by the rows above, so flashing each box takes longer | Smaller image, but the rig can no longer prove the agent runs |

**Recommend A.**
- Offline setup, a verdict at the rig and no first-boot supply-chain fetch are worth ~0.5 GB (vs the Hermes golden) to ~2.7 GB (vs the OpenClaw golden) of image.
- The customer's disk pays none of it long term, because activation **removes the harness that was not chosen**.
- Removal makes each box end in exactly today's single-edition state. That state is what the V4 sweeps and the docs assert, e.g. "the `openclaw` command is absent" on Hermes (`docs-site/editions/overview.mdx:48`).
- Keeping the dormant harness for a faster later swap is a possible follow-up, not part of v1. The swap re-pins it anyway (`install.sh:4084` onward).

---

## 3. Setup wizard: the edition step

**Placement.** The step goes after WiFi and before Update. It is rendered only while the lock reads `unselected`, as a gate in front of today's step 2. Steps 1–5 are **not renumbered**, because `setup_progress_step` persists numbers (`SetupWizard.tsx:433-439`). Deployed boxes and resumed setups therefore behave exactly as today.

It must come before these steps:
- **Update.** The updater picks its steps by edition (`updater.ts:3394,3401,3468`), and `post_update` re-bakes the lock (`install.sh:8370`). Choosing first means the update refreshes exactly one harness to its pin, as it does today.
- **Credentials, AI models, Telegram.** Credentials takes `hermes` (`SetupWizard.tsx:788`). The provider sign-in lands in each harness's own file (`install.sh:752`, `AIModelsStep.tsx:2047`). The Telegram bot is per harness (`telegram-bot-identity.ts:175`).

It must come after WiFi:
- The box is then on the owner's network (`WifiStep.tsx:242`, "resumes at Step 2"), so the portal hint in §5 can be read.
- The `clawbox-setup` restart at the end of activation must not land in the middle of the AP hand-off.

**What it writes.** The step writes one request, and root does the rest.

1. The browser sends `POST /setup-api/setup/edition {edition: "openclaw"|"hermes"}`.
   - It is added to the bootstrap allow-list beside `/setup-api/update/run` (`src/lib/setup-api-gate.ts:62`). Steps 1–3 run before a password exists (`src/middleware.ts:152`).
   - It refuses when `setup_complete` is set or the lock is not `unselected`.
2. The route writes `data/edition-select.env` (`TARGET_EDITION`, `REQUESTED_AT`), in the same shape as the swap request (`harness-swap.ts:240`). It then starts the root step and streams its phases. `GET` answers `{unselected, hint}`.
3. The root step `edition_select` (new) does the following.
   - It parses the request with the same value gate as `read_configured_harness_swap` (`install.sh:4870`).
   - It requires `CLAWBOX_RECORDED_EDITION = unselected`. This rule is what stops the step from being a free swap.
   - It proves the target runs, using the swap's probes (`install.sh:4986,5007`).
   - It runs `--step edition_lock` as the target (`install.sh:4925-4931`). That writes the lock and drop-in, sets the gateway mask state and tears down foreign units.
   - It provisions: `hermes_edition`, or `gateway_setup` for openclaw (exactly as `install.sh:5030,5091` do).
   - It removes the other harness. For Hermes that means the OpenClaw core, `bin/openclaw` and `~/.openclaw`. For OpenClaw it means `~/.hermes` and `~/.local/bin/hermes`. It leaves the shared `~/.cache/ms-playwright` alone. Removal is non-fatal and reported.
   - It runs `register-mcp.sh` and then restarts `clawbox-setup`, so the boot-time readers in §1 run for the chosen edition.
4. **End state.** `/etc/clawbox/edition.env` reads `openclaw` or `hermes`, byte-for-byte what a factory-flashed single-edition box has. Nothing new is stored in `config.json`. The wizard resumes at step 2 (Update).

**Copy.** New keys go in `src/lib/translations.ts` and every locale (the i18n scan fails otherwise):
- Title: **"Choose your agent"**
- Body: "ClawBox runs one AI agent. Pick the one you want. The rest of setup adapts to it."
- **OpenClaw**: "The standard ClawBox agent. Add abilities from the App Store and manage it in the OpenClaw Control UI."
- **Hermes**: "Hermes Agent by Nous Research. Add abilities from Hermes Skills and manage it in the Hermes dashboard."
- With a hint only: "Your order was for the Hermes Edition, so it is selected."
- Footer: "Same desktop, same apps, same updates. You can switch later in Settings → Harness with the Max plan."
- Confirm: "Continue with {agent}". The progress line reads "Setting up {agent}…" and shows the stream phases.

---

## 4. Factory prep: flash rig and golden capture

This supersedes TASK-1019's two-button golden. The rig code lives in nano-lab. This repo only sees its env and its verdict channel: `/etc/clawbox/provision-status` and the `[provision-status]` sentinel (`install.sh:460-467,11325-11344`).

1. **One golden build.** Run `CLAWBOX_EDITION=unselected sudo -E bash install.sh`.
   - It installs both harnesses, enables neither harness's units and bakes `unselected`.
   - The verdict is OK only if both harnesses pass the swap's runnable probes (`record_provision_failure`, `install.sh:481`).
2. **Golden capture requirements** (for nano-lab to verify):
   - `setup_complete` is unset and the lock reads `unselected`.
   - `/etc/machine-id` is emptied, so each box regenerates it. The portal device id is derived from it (`src/lib/portal-heartbeat.ts:21,47`). A captured machine-id would give every box in a batch the same `dev_` id and break §5.
3. **One button, one image.** The per-edition goldens are retired after the §7 acceptance passes. `install.sh` keeps working unchanged for `openclaw`, `hermes` and `dual`, for RMA reflashes and for the rare `dual` build (flash-time plus licence, as today).
4. **Fulfilment** stops picking an image per order. Every box is identical stock. Optionally, the rig prints the box's `dev_` id as a QR on the label, for §5.

---

## 5. Checkout and store

- **The edition on an order becomes informational.** Both listings stay the same hardware at the same price (`docs-site/index.mdx:40`). The order says "you'll pick your agent during setup; Hermes Edition orders arrive with Hermes preselected".
- **No existing channel can carry the order's edition to the box:**
  - The portal heartbeat is outbound only, and it only runs once a `claw_` token exists (`portal-heartbeat.ts:98,125`).
  - ClawBox AI sign-in happens after the choice, and a Hermes buyer needs no subscription (`docs-site/index.mdx:45`).
- **Proposed mechanism (PR 5, needs a clawbox.com endpoint):**
  1. At packing, fulfilment scans the label's `dev_` QR into the order.
  2. The portal serves `GET /api/portal/devices/<dev_id>/setup-hint`, which returns `{"edition":"hermes"}` and nothing else (no name, no email).
  3. The edition step asks once, with a 3 s timeout.
  4. With no answer (offline or unscanned), there is no preselect. Both cards are shown with OpenClaw highlighted, as today's default (`docs-site/editions/overview.mdx:43-44`).
  5. A hint preselects a card; it never locks the choice.
- **If packing cannot scan,** drop PR 5 and everyone chooses. Nothing else depends on it.

---

## 6. Upgrade path: deployed boxes keep their edition

Every deployed box has a lock naming `openclaw`, `hermes` or `dual`, because the first update after 3.x baked one (`install.sh:8370`). This chain holds today, and the plan keeps it byte-identical for those three values:

1. The in-app update runs `install.sh --step …` under `clawbox-root-update@.service`, which loads the lock as its env (`config/clawbox-root-update@.service:13`). The web server gets the same file last, so it wins over the user-writable `.env` (`config/clawbox-setup.service:42`).
2. `install.sh` resolves env, then lock, then drop-in, then seed (`install.sh:716-745`). Any recorded-vs-requested difference exits 1 before any unit is touched (`install.sh:782-833`).
3. Every update re-bakes the same value: `step_post_update` → `optional_step edition_lock` (`install.sh:8370` → `4735`).
4. Step selection reads the same lock: `updater.ts:3394,3401,3468`.
5. The Hermes provisioning script refuses independently (`scripts/setup-hermes-edition.sh:93-110`). The swap refuses `dual` and a missing lock, and is gated on the Max plan (`install.sh:5165-5174`, `harness-swap.ts:71`).

**What the plan adds to that guarantee:**
- Every new branch keys on the recorded value being exactly `unselected`.
- `unselected` is refused as a request on a box with any other lock ("un-choosing" would be a free swap).
- `unselected → dual` is refused.
- Factory reset keeps the lock, as today.

Tests pin this in PR 1 and PR 2:
- `install-edition-switch-refusal.test.ts` gets the new rows.
- `updater.test.ts` asserts the step list is unchanged for the three existing values.
- A route test asserts `/setup-api/setup/edition` answers 409 on them.

---

## 7. Risks and the acceptance test

| Risk | Mitigation |
|---|---|
| `unselected` leaks into a default: an unknown value reads as `openclaw` with `defaulted: true` today (`edition-source.ts:94-95`, `install.sh:740`) | PR 1 makes it a first-class value in `install.sh` and adds `unselected: true` to `EditionSource`. Pre-choice, no harness unit runs, and `register-mcp.sh` is a no-op |
| The choice turns into a free Max-plan swap | Root-side rule: the recorded value must be `unselected`. `X → unselected` is refused everywhere, and reset keeps the lock |
| Pre-password exposure of the route | Same class as `/setup-api/update/run` (`setup-api-gate.ts:62`). One-shot, and only after the box has left the open AP |
| Boot-time caches (MCP child, `instrumentation.ts:285-303,474-481`, client edition cache) | Activation ends with a `clawbox-setup` restart. The client cache never pins a defaulted answer (`client-harness.ts:96-104`), and `setup/layout.tsx` is force-dynamic |
| Removing the unchosen harness fails, leaving both on disk | Behaviour follows the lock, so the box still works. The failure is reported, and `post_update` retries the removal |
| Golden machine-id is shared by every box | Capture requirement in §4.2. Verify in nano-lab |
| Image size and rig flash time | Measured in §2. Disk is reclaimed at activation |
| A buyer picks the wrong agent | A confirm dialog. After setup, the switch is the Max-plan swap. Whether support may grant one free re-choice is an open question below |

**Acceptance test.** Run on a Nano in nano-lab after PR 4. No board is touched by this PR.

1. Flash the unified golden. The rig verdict is `[provision-status] OK`, and `/etc/clawbox/edition.env` reads `unselected`.
2. **Run 1.** WiFi → pick **OpenClaw** → Update → Credentials → AI → Telegram → done. Check:
   - The lock is `openclaw`.
   - `clawbox-gateway` is enabled and active.
   - The Hermes units are disabled, and `~/.hermes` is absent.
   - `node scripts/feature-sweep.mjs --host <box>` passes, including `harness/status` edition=openclaw.
   - The **V4 OpenClaw edition sweep** passes.
3. **Reflash. Run 2.** The same walk, picking **Hermes**. Check:
   - The lock is `hermes`.
   - `clawbox-gateway` is masked, and `openclaw` is not on PATH.
   - The Hermes dashboard and proxy are active.
   - The feature sweep and the **V4 Hermes edition sweep** pass.
4. **Offline variant of run 2.** Use WiFi with no internet: skip Update and use the local Gemma model. Setup completes, and the edition step takes under 3 min.
5. **Upgrade regression.** An existing `openclaw` box and an existing `hermes` box update to the build carrying PRs 1–4. The lock is unchanged, the edition step never renders, and the V4 sweep for each edition passes.

The V4 edition sweeps are not in this repo. The in-repo counterparts are `scripts/feature-sweep.mjs` and `e2e-install/35-mcp.spec.ts`.

---

## 8. Step plan: independently revertable PRs, in order

All PRs target `beta` after v4.1 ships. Revert in reverse order. Once a unified golden is in the field, PR 1 must not be reverted alone.

| # | Scope | Files | Tests | Revert leaves |
|---|---|---|---|---|
| 1 | **`unselected` lock value, inert.** Recognised in resolution and normalisation. Split the predicates into *installs* vs *runs* a harness: `unselected` installs both and runs neither (`EXPECTED_ACTIVE_SERVICES` and `FOREIGN_EDITION_UNITS`, `install.sh:1098-1199`). Refusal matrix: `unselected → openclaw|hermes` only with `edition_select`'s reason; `→ unselected` and `unselected → dual` refused. `register-mcp.sh` no-op. `EditionSource.unselected` | `install.sh`, `scripts/setup-hermes-edition.sh`, `scripts/register-mcp.sh`, `src/lib/edition-source.ts`, `clawkeep/clawkeep/agent.py` | `install-edition-switch-refusal`, `install-edition-lock`, `edition-source`, `register-mcp-*`, new `install-unselected-edition.test.ts`, `clawkeep/tests/test_agent.py` | a value no box has |
| 2 | **Root step `edition_select`.** Value-gated request, then probe → `edition_lock` → provision → remove the unchosen harness → register → restart. Measure activation time on a Nano | `install.sh` (step and `DISPATCH_STEPS`), `config/clawbox-root-step.sh:92-104`, `config/clawbox-run-root-step.sh:40-47`, `src/lib/root-steps.ts:31` | new `install-edition-select.test.ts` (refuses unless `unselected`, refuses dual or stale requests, removal), `root-steps.test.ts` | a step nothing calls |
| 3 | **Route `/setup-api/setup/edition`.** GET `{unselected, hint:null}`. POST writes the request and streams the phases, reusing `harness-swap.ts`'s request and journal-follow helpers, with no plan gate. Bootstrap allow-list entry | `src/app/setup-api/setup/edition/route.ts`, `src/lib/edition-select.ts`, `src/lib/setup-api-gate.ts` | route test (409 on `openclaw`/`hermes`/`dual` and on `setup_complete`), middleware allow-list test | a route the UI does not call |
| 4 | **Wizard step.** `EditionStep.tsx` as a gate before step 2 when `unselected`, the copy from §3, reload after the restart | `src/components/EditionStep.tsx`, `SetupWizard.tsx`, `src/lib/translations.ts` (+ locales) | `SetupWizard` unit tests (never renders on the three locked values), Playwright wizard spec with the route mocked, i18n scan | today's wizard |
| 5 | **Order hint (optional).** GET adds `hint` from the portal endpoint (3 s, fail-quiet); preselect only | `src/lib/edition-select.ts`, `EditionStep.tsx` | fetch-mocked unit tests: offline and unknown give no preselect | no preselect |
| 6 | **Docs.** "Chosen when the device is produced" becomes "chosen during setup". The first choice is free; later switches need Max | `docs-site/editions/overview.mdx:9,44,58`, `docs-site/index.mdx:40,47`, `README.md:233`, `docs-site/editions/switching.mdx` | `scripts/check-doc-images.sh` | old wording |
| — | **Factory (nano-lab, not this repo).** One golden with `CLAWBOX_EDITION=unselected`, machine-id reset, both-harness verdict, retire the two-button flow; then the §7 acceptance | nano-lab | §7 | per-edition goldens |

**Open questions for Yanko:**
- May support grant one free re-choice after setup?
- Should `dual` ever be offered in the wizard when a licence is present? This plan says no; `dual` stays a flash-time build.
