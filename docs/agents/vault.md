# ClawBox Vault

The password manager built into every box (TASK-2524): a loopback-only service in `vault/`, its extension in the box's own browser, seven `vault_*` tools in ClawBox's MCP server, and an owner-only desktop app. Read it when you touch `vault/`, `mcp/tools/vault.ts`, `src/lib/vault-proxy.ts`, `src/app/apps/clawbox-vault/`, `config/clawbox-vault.service` or `scripts/lib/vault-extension.sh`. `vault/README.md` is the full description of the service; this page is how it is joined to the rest of the tree and the rules those joins keep.

## The one rule

**No password ever reaches the assistant**: not in a tool result, not in an error, not in a log or a transcript. Every layer keeps it by itself:

- The service's agent API (`/api/agent/*` in `vault/src/server/app.ts`) has no route that reads an entry into its answer. A fill is carried out by the extension, which fetches the password for that one command and types it into the page; the agent gets a status.
- A fill report from the browser whose `detail` contains the entry's password is dropped by the service (`withoutSecret`) before it is answered to the agent.
- `vault/src/mcp/tools.ts` rebuilds every listing field by field (`entryView`, `auditView`), so a field a service added cannot ride along, and scrubs a password the model itself passed in (`vault_save`) from every reply.
- `mcp/tools/vault.ts` passes on the text and the error flag only (no `structuredContent`), and the registrar's credential pass runs after it.
- The vault's folder is refused by name to every file and shell surface (below).

Tests that prove it: `vault/tests/api.test.ts` (the grep test over logs, audit log, state files and replies; the leaking fill report), `vault/tests/mcp.test.ts` (in-process, and through the real MCP server over stdio on both editions), `src/tests/unit/mcp-vault-tools.test.ts` (the tool family against a service that leaks on purpose). A change that adds a way for a secret to come back must fail one of them; add the case when you add a route or a tool.

## Where things are

- **Service**: `vault/src/server/`, started by `config/clawbox-vault.service` (system unit, `User=clawbox`, `WantedBy=multi-user.target`) through `scripts/start-vault.sh`, under Bun. `127.0.0.1:4796` and nothing else: the service refuses to start on a non-loopback host and the start script pins `CLAWBOX_VAULT_HOST=127.0.0.1`. The unit reads no `.env` (that file is writable by everything running as clawbox).
- **Data**: `~/.clawbox-vault/` (mode 700): `store/` (the `pass` store, a git repository), `gnupg/` (the vault's own keyring), `state.json` (PIN hash, paired extension's origin and token hash, the auto-pair switch), `agent-token`, `audit.jsonl`, `extension/` (built on every start). Never `~/.gnupg` or `~/.password-store`.
- **First run**: `vault/src/server/storeinit.ts` makes the key (ed25519, no passphrase: the service decrypts unattended) and the store. Not fatal: without `pass` or `gpg` the service still runs, `/api/ui/status` says what is missing, store routes answer 503 and the next request tries again.
- **Packages**: `pass` and `gnupg` from `step_apt_update` (install.sh and install-x64.sh; a separate non-fatal line, run on every update too). `tldts` is a root `dependencies` entry, so the app's own `bun install` brings it; `vault/` has no `node_modules`. `happy-dom` and `@types/chrome` are root dev dependencies for the vault's tests.
- **Install and update**: the unit is in `EXPECTED_ACTIVE_SERVICES` (every edition). A fresh install starts it in `step_start_services`. An update needs no line of its own: `step_rebuild_reboot` runs `step_systemd_services` (copy + enable) and then `restart_services_after_update`, which starts or restarts every enabled `clawbox-*` unit. On a PC, `install_vault_service` in install-x64.sh writes the unit from `step_systemd_services` and from `step_apt_update` (the root step every PC update runs).

## The PIN comes first

Until the owner has chosen a vault PIN in the desktop app, the vault does nothing: `/api/agent/*` answers 409 `not_set_up` (the tools turn that into a `CONFLICT` envelope telling the agent to stop and tell the user) and `/api/pair/auto` answers 409, so the box's browser is not paired and no save bar appears. Setting the PIN is the owner's opt-in. Do not add a route that works before it.

## The browser

- `scripts/launch-browser.sh` loads the extension with `--load-extension` when `~/.clawbox-vault/extension` is complete (`scripts/lib/vault-extension.sh`; the second flag re-enables that switch on branded Chrome). The launcher has no other `--disable-features` flag: Chromium keeps only the last one, so merge into this one if another is ever needed.
- The folder is BUILT by the service on every start (`vault/src/server/extensiondir.ts`): static files from `vault/extension/`, scripts bundled from `vault/src/extension/`, the service's own address and the cards switch compiled in. Nothing built is committed (`vault/.gitignore`, pinned by `vault-builtin-wiring.test.ts`).
- **Automatic pairing**: the service writes this run's secret into `extension/pairing.json` (mode 600). The extension's worker reads its own packaged file and posts it to `/api/pair/auto`; the service checks the secret, the `chrome-extension://` origin and that a PIN is set, and answers a token. The manifest lists no `web_accessible_resources`, so no web page can read the file: keep it that way. The path is fixed, so the extension id (and its stored token) survives restarts.
- **Unpair holds**: `DELETE /api/ui/pairing` also turns auto-pairing off (`state.json` `autoPair: false`) until the owner turns it on again in the app (`POST /api/ui/pairing/auto`). The manual 6-digit code still works for any browser on the box.

## The desktop app is the owner's alone

- The window (`src/components/VaultApp.tsx`, app id `vault`) frames the service's own page from `/apps/clawbox-vault/`, same-origin and unsandboxed, so every request the page makes carries the session cookie.
- `src/app/apps/clawbox-vault/[[...path]]/route.ts` requires the OWNER's cookie on every request (no test-mode or first-boot opening, never the MCP bearer), same-origin for writes, and forwards only the app's page, its three files, `/api/health` and `/api/ui/*` (`src/lib/vault-proxy.ts`). The extension's API, the agent's API and the pairing routes are not reachable from the network at all.
- It is deliberately NOT the generic `/apps/<id>` proxy (`src/lib/app-proxy.ts`): that one serves a sandboxed, opaque-origin frame whose requests carry no cookie and lets them through.
- `OWNER_ONLY_APP_IDS` hides the app from other users and `nonOwnerVerdict` refuses `/apps/clawbox-vault/**` before `/apps` is opened to every user (`src/lib/non-owner-scope.ts`).
- What unlocks the passwords themselves is the vault PIN, asked by the page and checked by the service. The route never sees it in the clear as anything but the body it forwards.

## The tools, on both runtimes

- One family, `mcp/tools/vault.ts`, registered by `buildServer` for OpenClaw and Hermes alike: `vault_list`, `vault_match`, `vault_fill`, `vault_save`, `vault_generate`, `vault_delete`, `vault_audit`. No second MCP server and no entry of its own in either runtime's config: the tools arrive with the `clawbox` server both already register.
- **Full profile only.** No tool declares `readOnly`, on purpose: a delegated run's `run-read` server takes in every tool that does (`src/lib/clawbox-run-read-tools.ts`). They are not on the `core` surface either.
- **Who can call them**: the owner's assistant. On an organisation box a member of staff's agent is denied `clawbox__*` on both runtimes (`config/org-staff-policy.json`). On a home box another user's chat runs on the owner's assistant with the device's tools, as it does for every other tool (multi-user.md): the vault tools are among them, and they still return no password. Not yet scopable per user.
- The agent's notes: `TOOL_NOTES` (`vault_fill`, `vault_save`), the Passwords section of `Clawbox.md`, and `docs-site/guides/vault.mdx` through `docs_search`.

## The folder is a secret folder

`.clawbox-vault` is in `PROTECTED_HOME_DIRS` (`src/lib/file-guard.ts`: the Files app, the MCP file tools, a coding run's denied folders), in `HARD_SEGMENTS` (`src/lib/coding-permission-rules.ts`) and in `SECRET_NAME_RE` (`mcp/lib/guard.ts`: the agent's shell pre-flight). The key in it has no passphrase, so these lists are what stands between a file tool and the store.

## Cards are off

The card half of the source is kept behind `CLAWBOX_VAULT_CARDS=1`, which no installer, unit or runtime config sets (pinned by `vault-builtin-wiring.test.ts`). Off means: the service answers 404 on every card route, the extension is built with cards compiled out (`vault/src/extension/flags.ts`: no card field is read), the MCP server registers no card tool, the desktop app shows no Cards screen. Turning it on is a product decision, not a config tweak: it needs both processes' environments and its own review.

## Not in ClawKeep

The vault is not backed up, and that is deliberate for now. A useful backup has to carry the store AND the key that decrypts it, so what protects the copy in the cloud would be ClawKeep's passphrase alone. It also does not fit either edition's backup shape as it stands: on OpenClaw the core archives the agent's state directory and ClawKeep only subtracts from it (`backup_guard.py`), and on Hermes the allow-list (`clawkeep/clawkeep/hermes.py` `ASSETS`) would need a credential-bearing asset outside the agent's home with a restore that stops the service and keeps a keyring's modes. Until that is designed and tested on boards, an owner who wants a copy takes one of `~/.clawbox-vault/store` and `~/.clawbox-vault/gnupg` themselves; `docs-site/guides/vault.mdx` says so.

## Tests

- `cd vault && bun test` (`bun run test:vault`): the vault's own suite; needs `pass`, `gpg`, `git`. Run by the `checks` job of `pr-tests-coverage.yml`.
- `src/tests/unit/mcp-vault-tools.test.ts`, `src/tests/routes/vault-proxy.test.ts`, `src/tests/unit/vault-builtin-wiring.test.ts`, and the vault cases in `non-owner-scope.test.ts`.
- `scripts/nano-tests/tests/64-vault.sh` on a board: the unit, the loopback listener, the first-run store, the PIN gate, the tools through the real MCP server, the owner-only route and the extension folder.
