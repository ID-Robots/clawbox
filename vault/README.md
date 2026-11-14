# ClawBox Vault

The password manager built into ClawBox. The owner's website logins live on the
box, encrypted; an extension in the box's own browser fills them into the real
login forms and offers to save new ones; and the assistant can list, match,
save and fill logins **without ever seeing a password**.

The owner logs in once in the box's browser, the extension saves the login, and
from then on the assistant can be told "log in to the billing portal": the
extension types the password into the real inputs and the assistant gets back a
status word.

It is the same on OpenClaw and on Hermes: the vault is ClawBox's own service,
not part of either runtime.

## Architecture

```
            ClawBox desktop: "ClawBox Vault" window (owner only)
                 │  /apps/clawbox-vault/  (web server, owner's cookie)
                 ▼  vault PIN → session
 box's browser ───────────► vault service ◄────────────── assistant
  extension (MV3)            127.0.0.1:4796               ClawBox's MCP server
   background worker ─long-poll─► fill queue              mcp/tools/vault.ts
   content script                 pairing / auth / audit   token file, mode 600
   popup                          catalog (metadata)       vault_list, vault_match,
                                  │                        vault_fill, vault_save,
                                  ▼                        vault_generate,
                     pass insert / show / rm / mv          vault_delete, vault_audit
                     ~/.clawbox-vault/store (gpg + git)
```

| Part | Where | What it does |
|---|---|---|
| Vault service | `src/server/` | Bun HTTP server on `127.0.0.1:4796`. API for the extension, the assistant's tools and the desktop app; serves the desktop app. Started by `config/clawbox-vault.service` through `scripts/start-vault.sh`. |
| First run | `src/server/storeinit.ts` | Makes the vault's own GnuPG keyring and `pass` store the first time the service starts. Nothing to set up by hand. |
| pass adapter | `src/server/pass.ts`, `catalog.ts` | Writes with `pass insert -m -f` (stdin), reads with `pass show`, deletes with `pass rm`, renames with `pass mv`. Every write is a git commit in the store. |
| Extension | `extension/` (static files), `src/extension/` (sources) | Manifest V3. Detects login forms, fills them, shows the save bar, popup with the logins for the page. Built by the service into `~/.clawbox-vault/extension` on every start (`src/server/extensiondir.ts`); `scripts/launch-browser.sh` loads it from there. |
| Assistant tools | `src/mcp/tools.ts`, registered by `mcp/tools/vault.ts` | The seven `vault_*` tools, in ClawBox's own MCP server, on both runtimes. |
| Desktop app | `src/ui/` | Entries: list, search, add, edit, delete, reveal on click; password generator; the browser's pairing; activity log. Proxied to the owner by `src/app/apps/clawbox-vault` (see `src/lib/vault-proxy.ts`). |
| Shared | `src/shared/` | URL and domain matching (eTLD+1 through the public suffix list), the entry format, the password generator. |

### Entry format

Entries are `<site>/<account>`, in the format `pass` users know:

```
<password>
login: ops@example.com
url: https://billing.example.com/login
2fa: otpauth://totp/...
note: monthly invoices
```

Line 1 is the password; the known fields follow; any other lines are kept as
they are when an entry is updated.

## First run

1. The service starts with the box. On its first start it creates
   `~/.clawbox-vault/` (mode 700) with a keyring (`gnupg/`), a store (`store/`,
   a git repository) and its state files.
2. The owner opens **ClawBox Vault** on the desktop and chooses a vault PIN.
   **Until then nothing is saved or filled:** the assistant's tools answer
   "not set up", and the box's browser is not paired.
3. Within a minute of the PIN being set (or of the browser's next start), the
   extension in the box's browser pairs by itself. No code to type.

## Security model

**Who can see a plaintext password, and when**

| Who | When |
|---|---|
| The store | Never in plaintext: files are GPG-encrypted, history is in the store's git repository. |
| The vault service | Only in memory, while decrypting an entry with `pass show` to build metadata, compare a captured login, or hand a secret to one of the two clients below. It writes a secret only through `pass insert` (stdin). |
| The paired extension | (1) For an **assistant fill**: once per fill command; the secret is released once and only for that command. (2) For a **popup fill** the user clicked: only if the entry matches the page. (3) For a **popup copy**: the password goes to the clipboard and is cleared after 30 s. In the page, only the chosen frame's content script receives it, and only to type it into the inputs. |
| The desktop app | Only after the vault PIN unlocked it, and only on an explicit **Reveal** or **Copy** click (hidden again after 30 s). |
| The assistant | **Never.** The agent API has no route that returns a password. Tools return names, logins, URLs, dates and statuses, each rebuilt field by field from the service's answer. `vault_save` without a password generates one on the service. A password the model itself passed in is scrubbed from every reply, and a fill report from the browser that contains the entry's password is dropped by the service before the assistant sees it. |
| Logs, audit log, error messages | Never. Request logs carry method, path, status and time; the audit log carries actor, action, entry name, host and status. JSON parse errors are not echoed. |

**What stops other clients**

- The service binds to `127.0.0.1` only (it refuses to start on anything else)
  and refuses Host headers from public domains (DNS-rebinding pages get `421`).
- **Desktop app**: reachable from the network only through ClawBox's web server,
  which serves it to the **owner's** session alone and forwards only the app's
  page and `/api/ui/*`. The vault PIN (scrypt-hashed in `state.json`) then opens
  a 15-minute in-memory session; wrong PINs are rate limited.
- **Extension**: holds a random 32-byte token; only its SHA-256 hash and the
  extension origin are stored. Every request must carry the token, and any
  `Origin` header must be that `chrome-extension://` origin. The box's own
  browser gets its token with a secret the service writes into the extension
  folder on each start (`pairing.json`, mode 600, not web-accessible), and only
  once a PIN is set. Any other browser on the box pairs with a 6-digit code
  from the unlocked desktop app (5 minutes, 5 attempts, one use).
- **Unpair** in the desktop app holds: the box's browser stays out until the
  owner pairs it again there.
- **Extension lock**: the popup or the desktop app can lock the extension; while
  locked the service releases no secrets and assistant fills return `locked`.
- **Assistant tools**: a random token in `~/.clawbox-vault/agent-token` (mode
  600, made by the service). The tools refuse the file if group or others can
  read it, send it to a loopback address only, and requests with a browser
  `Origin` are refused on the agent API.
- **Frames and schemes**: fills go only to `https://` pages (plain `http://`
  only on localhost), to the top frame or a same-origin iframe whose origin
  matches the entry. A form in a cross-origin frame is refused
  (`origin_mismatch`), checked in the background worker and again in the frame.
- **The folder**: `~/.clawbox-vault` is one of ClawBox's secret folders. The
  Files app, the assistant's file and shell tools and delegated coding runs are
  refused it by name (`src/lib/file-guard.ts`, `mcp/lib/guard.ts`).

**Limits.** The vault's key has no passphrase: the service has to decrypt an
entry for a fill while nobody is at the keyboard. So anything that runs as the
box's user and gets past the guards above can call `pass show` itself, and an
agent that drives the browser through DevTools could read a filled input from
the page. The vault keeps passwords out of the assistant's tools and context by
design; it is not a sandbox against a hostile process running as the same user.

**Backups.** ClawKeep does not back the vault up. The store and the key that
decrypts it would have to travel together, and a backup of both is only as
strong as the backup's own passphrase. See `docs/agents/vault.md`.

## The assistant's tools

Registered by ClawBox's MCP server for OpenClaw and for Hermes alike (full
profile; not in a delegated coding run).

| Tool | Returns |
|---|---|
| `vault_list(query?)` | names, login, url, updated date |
| `vault_match(url)` | matching entries, exact host first |
| `vault_fill(url, name?, submit?)` | a status only |
| `vault_save(name, login, url, password?, note?)` | the name; without `password` a strong one is generated and stored (new sign-ups). An existing entry keeps its password unless one is given or `regenerate: true` |
| `vault_generate(length?, symbols?, name?, login?, url?, overwrite?)` | with `name`: "generated and stored as <name>"; without: nothing is generated or stored |
| `vault_delete(name, confirm)` | requires `confirm: true` |
| `vault_audit(limit?)` | recent actions, no secrets |

### How a fill works

1. The assistant opens the login page in the box's browser.
2. It calls `vault_match(url)` to see which entry applies, or goes straight to
   `vault_fill(url)` (best match) or `vault_fill(url, name)`; `submit: true`
   presses the form's submit button.
3. The service resolves the entry, checks that the URL matches it, and queues a
   fill command. The extension's background worker receives it over its
   long-poll, picks the matching tab, fetches the login for that one command,
   probes the tab's frames, and fills through the native value setter plus
   `input`/`change`/`blur` events (so React, Vue and Angular forms see it).
4. Two-step logins: on a username-only page with `submit: true`, the extension
   submits, waits for the password page and fills it too.
5. The assistant gets one status:

| Status | Meaning |
|---|---|
| `filled` | typed into the real inputs (detail: submitted / two-step / password step) |
| `no_form` | the tab has no login form |
| `no_tab` | no open tab matches the entry: open the page first |
| `origin_mismatch` | the form is in a frame of another origin, the page is plain `http://`, or the named entry belongs to another site |
| `no_entry` | no entry matches the URL |
| `locked` | the owner locked the extension |
| `extension_offline` | no paired extension is connected (is the browser running?) |
| `timeout` | the extension took the command but did not answer in 20 s |

## Saving logins from the browser

When a password was typed and the form is submitted (or the page navigates),
the extension asks the service whether that login is new, changed or already
saved. The service compares server-side; the page never learns the stored
password. A bar appears in the page: **Save to ClawBox Vault?** (the name
defaults to `<domain>/<login>`) or **Update password?**.

## Matching rules

- Registrable domain (eTLD+1, private suffixes such as `github.io` included):
  `login.example.com` matches an entry for `example.com`; exact-host matches rank first.
- An entry without a `url:` line matches by its name when the first segment is a domain.
- IDN hosts compare in punycode; look-alike hosts do not match.
- Never over `http://` except `localhost`/`127.0.0.1`; localhost entries match host and port exactly.

## Payment cards: off

The code can also keep payment cards (`src/server/cards.ts`,
`src/extension/cardforms.ts`). **It is switched off**, and nothing ClawBox
installs switches it on. With the switch off:

- every card route of the service answers `404`;
- the two card tools are not registered with the MCP server;
- the extension is built with cards compiled out: it reads no card field,
  shows no chip and no card save bar, and its popup has no Cards tab;
- the desktop app shows no Cards screen.

The switch is `CLAWBOX_VAULT_CARDS=1` in the service's environment (and in the
MCP server's, for the tools). It is there for development and for the tests.

## API (for reference)

| Prefix | Auth | Endpoints |
|---|---|---|
| `/api/health`, `/api/ui/status`, `/api/ui/setup`, `/api/ui/unlock`, `/api/pair`, `/api/pair/auto` | none (rate limited or secret-guarded where it matters) | |
| `/api/ui/*` | PIN session | `entries`, `entry`, `reveal`, `pairing`, `pairing/auto`, `extension-lock`, `audit`, `info`, `pin`, `lock` |
| `/api/ext/*` | extension token; `Origin`, if sent, must be its origin | `status`, `lock`, `unlock`, `unpair`, `entries`, `match`, `secret`, `check`, `save`, `commands`, `result` |
| `/api/agent/*` | agent token, no `Origin`, PIN set | `entries`, `match`, `fill`, `save`, `generate`, `delete`, `audit` |

All paths also work under `/apps/clawbox-vault/`. Only `/api/health` and
`/api/ui/*` are reachable through ClawBox's web server.

## Development

From the repository root (`bun install` there brings the vault's packages):

```sh
bun run typecheck:vault                     # tsc --noEmit -p vault
bun run test:vault                          # the vault's own suite (bun test)
cd vault && bun run build                   # extension → extension-build/ (git-ignored)
cd vault && bun run validate:extension      # manifest, files, permissions, CSP, no eval
```

The tests need `pass`, `gpg` and `git`. They never touch a real store: each one
makes a temporary `GNUPGHOME` with a throwaway key and a temporary store. They
cover domain matching, form detection and filling against HTML fixtures (plain
form, React 19 controlled inputs, two-step login, same-origin iframe fill and
cross-origin refusal) in a happy-dom browser, the pass round trip, first-run
setup, API auth (unpaired, wrong origin, wrong token, DNS rebinding, CORS),
automatic pairing, the cards switch, a grep test that secrets never reach logs,
the audit log or state files, and that no tool response contains the test
password, in-process and through ClawBox's real MCP server over stdio on both
editions. The repository's own suite adds the tool family, the owner-only route
and the installer wiring (`src/tests/unit/mcp-vault-tools.test.ts`,
`src/tests/routes/vault-proxy.test.ts`,
`src/tests/unit/vault-builtin-wiring.test.ts`), and
`scripts/nano-tests/tests/64-vault.sh` checks a real box.

### Configuration

| Variable | Default |
|---|---|
| `CLAWBOX_VAULT_PORT` (or `PORT`) | `4796` |
| `CLAWBOX_VAULT_HOST` | `127.0.0.1` (loopback only; anything else is refused) |
| `CLAWBOX_VAULT_BASE` | `/apps/clawbox-vault/` |
| `CLAWBOX_VAULT_HOME` | `~/.clawbox-vault` |
| `CLAWBOX_VAULT_STORE_DIR` | `<home>/store` |
| `CLAWBOX_VAULT_GNUPGHOME` | `<home>/gnupg` |
| `CLAWBOX_VAULT_CONFIG_DIR` | `<home>` (`state.json`, `agent-token`, `audit.jsonl`) |
| `CLAWBOX_VAULT_EXTENSION_DIR` | `<home>/extension` |
| `CLAWBOX_VAULT_PASS_BIN` | `pass` |
| `CLAWBOX_VAULT_CARDS` | unset (cards off) |
| `CLAWBOX_VAULT_ALLOWED_HOSTS` | extra Host names to accept (comma-separated) |
| `CLAWBOX_VAULT_FILL_TIMEOUT_MS` | `20000` |

### Troubleshooting

- **Logs**: `journalctl -u clawbox-vault`.
- **"The password store is not ready"** in the app: `pass` or `gpg` is missing
  (`sudo apt-get install pass gnupg`); the service picks it up by itself.
- **Forgot the vault PIN**: stop the service, remove the `"pin"` object from
  `~/.clawbox-vault/state.json`, start it again and choose a new PIN. The
  entries are untouched.
- **Fills return `extension_offline`**: the box's browser is closed, or the
  extension was unpaired (pair it again in the app's Browser page).
- **New agent token**: delete `~/.clawbox-vault/agent-token` and restart the service.
