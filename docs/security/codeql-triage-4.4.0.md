# CodeQL triage for 4.4.0

The open CodeQL alerts on the 4.4.0 release PR (#1578, beta → main): 22
alerts, each given a verdict by reading the code. **4 are REAL, 10 are BY
DESIGN and 8 are TEST/DEV-ONLY.** The four REAL alerts share one cause and are
fixed for 4.4.1 (section 4). No alert was dismissed on GitHub.

## 1. What was read

- **Alert list**: the 22 open alerts CodeQL listed for the release PR
  (`refs/pull/1578/merge`) on 2026-11-26. The code-scanning API could not be
  queried again when this document was put together, so an alert opened,
  moved or closed after that date is not reflected here.
- **Code**: beta at `f6a426f6e321bd82d6a013e796b71b5d93334b96`, the head of
  the release PR. Every File:line below is at that commit, and each of those
  lines is the sink its rule names.
- **Fix**: the 4.4.1 fix is cut from the same commit (section 4).

## 2. Verdict key

- **REAL**: input an attacker controls reaches the sink with no owner auth
  and no guard that is enough.
- **BY DESIGN**: an owner-set value behind owner auth, a value a guard makes
  safe, or a fixed destination. The reason names the guard.
- **TEST/DEV-ONLY**: a lab, test or benchmark script. The product never runs
  it and the web server never serves it. The proof is in section 5.

## 3. Verdicts

The table is ordered by area: request handling, then outbound tokens, then
lab, test and bench scripts.

| Alert | Rule | File:line | Verdict | Reason |
|---|---|---|---|---|
| 743 | js/request-forgery (critical) | src/lib/external-engine.ts:396 | REAL | The probe URL is `{baseUrl}/models`. Save (`POST /setup-api/local-ai/external`, through `saveExternalEngine` in external-engine-ops.ts) and Test (`POST /setup-api/local-ai/external/test`) take `baseUrl` from the request body. `GET ?probe=1` and the Cluster view (src/lib/cluster-view.ts, LAN addresses only) use the saved record's URL. Each route calls `requireSession({ ownerOnly: true })` (src/lib/route-auth.ts), so only the owner's session gets in. But neither POST checked where the request came from, and the owner's cookie also rides on a POST from another box's tunnel name (section 4). So a page there could Save its own server as the box's chat engine, which sends later conversations to it, or make the box probe a LAN or loopback address. `normalizeExternalBaseUrl`, `refusedEngineHost` and `hostRefusal` refuse link-local, metadata and unspecified addresses, and redirects are not followed. That is right for the owner's own engine, but it does not stop a forged request. **Fixed in 4.4.1.** |
| 744 | js/file-access-to-http | src/lib/external-engine.ts:398 | BY DESIGN | Data: the stored key (`readExternalEngineKey`), sent as a bearer. It goes only to the origin it was saved for. `resolveKey` (external-engine-ops.ts) and the Test route's origin comparison reuse it only when the new base URL has the saved origin, and otherwise send no key. `GET ?probe=1` and the Cluster view use the saved record's own URL (the Cluster view also needs a key no newer than its record). `redirect: "manual"` stops a 3xx from carrying the key on. A Save to another origin stores `none`, not the old key. All callers are owner-only. |
| 742 | js/http-to-file-access | src/lib/external-engine.ts:100 | REAL | Data: the `apiKey` of a Save body. `parseExternalApiKey` allows one printable token of at most 4096 characters, with no whitespace or control characters. It is written to the fixed path `data/.external-engine-key` with mode 0600, through a temp file and a rename, so the content cannot harm the file. But the write is part of the same forged Save as 743: the page's key, stored for the page's server. The cause and the fix are the same as 743's. **Fixed in 4.4.1.** |
| 740 | js/http-to-file-access | src/lib/hotspot-env.ts:146 | REAL | Data: `ssid` and `password` from `POST /setup-api/system/hotspot`, a route with no auth check of its own. Before an owner password exists, the route is on the first-boot allow-list (src/lib/setup-api-gate.ts; the window closes on `password_configured`). That is by design, because there is no owner yet. After that, the proxy's session gate applies (src/proxy.ts). The content is safe: the SSID is at most 32 characters and the password 8 to 63. Control characters are refused by the route and by `quoteForScripts`. The AP scripts parse the file as root (`read_env_value`, never `source`) and pass the values to nmcli only as arguments. What was missing is the origin check (section 4). A page on another box's tunnel name could set a hotspot password it knows and raise the access point, or switch the hotspot off. **Fixed in 4.4.1.** |
| 671 | js/http-to-file-access | src/app/setup-api/system/update-branch/route.ts:131 | REAL | Data: `branch`, written to the fixed path `.update-branch`. `isSafeBranch` (src/lib/update-branch.ts) limits it to a safe character set, the same rule the updater and install.sh use. The proxy's session gate plus `UPDATE_API_PATHS` (src/lib/non-owner-scope.ts) make the route owner-only for people. But it checked no origin (section 4). So a page on another box's tunnel name could pin the box to any branch of the project's repository, with `allowHarnessDowngrade: true`, and the next update would install that branch as root. **Fixed in 4.4.1.** |
| 675 | js/log-injection | src/lib/provider-model-fallback.ts:269 | BY DESIGN | Only the model-fallback route calls this code, and it checks `hasPersonSession` and `isSameOriginRequest`. non-owner-scope.ts refuses a non-owner's write under `/setup-api/ai-models`. The browser modules only send the report, and the server checks every field. `provider` must be a key of `POLICIES` (src/lib/provider-newest-model.ts), which holds only `xai`. `candidate` comes from the box's own catalog of that provider's models (`readChoosableModels`) and must match `XAI_FLAGSHIP_RE` (`grok-N[.N[.N]]`) after a trim. So at most whitespace can surround it, and no text that would read as a forged log entry can reach the line. |
| 676 | js/log-injection | src/lib/provider-model-fallback.ts:358 | BY DESIGN | `failedRef` is `xai/` plus a model id that passed `MODEL_ID_RE` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`). Without the `m` flag, `$` matches only at the end of the string, so the id cannot hold a CR or LF. `fallback` is the catalog candidate described in 675. The rest of the line is literal text. Same route guards as 675. |
| 716 | js/file-access-to-http | src/lib/subscription-link.ts:135 | BY DESIGN | Data: the subscription link token, read from the config store key `subscription_link_token`. Only `linkSubscription` writes that key, and only after `isClawboxAiToken`. It goes to `deviceInfoUrl()`, which is the fixed portal URL (`https://clawbox.com/api/clawbox-ai/device-info`) unless the service environment sets `CLAWBOX_AI_DEVICE_INFO_URL` (section 6). No request field, config-store setting or tool argument reaches the URL or adds to the request, which carries the bearer header and nothing else. The token goes back to the portal that issued it. |
| 687 | js/file-access-to-http | src/lib/vision-describe.ts:177 | BY DESIGN | Data: an image file read by `POST /setup-api/vision/describe` (or the browser route's own screenshot), and the box's ClawBox AI token. It goes to `clawboxAiProxyUrl()` (src/lib/clawbox-ai-models.ts): the fixed proxy URL unless the service environment sets `CLAWBOX_AI_PROXY_URL` (section 6). `ask()` calls `isCloudAiLocked()` again right before the request, so with local-only AI on, nothing leaves. The route guards which file is read: `requireSession`, then `allowedRoots`. A person's session may read the Files app's tree. An agent bearer may read the live run's working and evidence folders, or the Files tree when no run is live. Both checks run on the typed path and again after realpath. `isProtectedFilePath` refuses credential stores and the server state under `data/`. Only PNG, JPEG and WebP files under 8 MB are read, opened with O_NOFOLLOW after realpath. Staff on an organisation box cannot reach the route. The caller picks which allowed image is described, which is the feature, but cannot pick where it is sent. |
| 685 | js/file-access-to-http | src/lib/telegram-owner-send.ts:156 | BY DESIGN | Data: the bot token from the harness's own config. URL: `telegramApiRoot()` returns `https://api.telegram.org`. It returns a loopback root (`http://127.0.0.1`, `localhost` or `[::1]` plus a port) only when `CLAWBOX_TELEGRAM_API_ROOT` matches that pattern, and then the root is rebuilt from the match. Any other value falls back to Telegram. `sendTelegramBotMessage` rebuilds the token from `BOT_TOKEN_RE` (digits, a colon, `[A-Za-z0-9_-]`), so it cannot add a path, query, host or userinfo. The token only goes to the service that issued it. |
| 686 | js/file-access-to-http | src/lib/telegram-owner-send.ts:161 | BY DESIGN | The same request as 685. The body's chat id comes from the harness allowlist and is rebuilt from `TELEGRAM_CHAT_ID_RE` (digits and an optional minus). The text is the caller's notice to the owner, and button labels are capped at 64 characters. Destination as in 685. |
| 682 | js/file-access-to-http | src/lib/coding-agent-notify.ts:625 | BY DESIGN | Data: the box's MCP bearer (`getMcpToken()`). `hermesChatTurn` sends it to `http://127.0.0.1:<PORT>/setup-api/hermes/chat`. The host is a literal loopback address, `PORT` must match `^\d{1,5}$` (otherwise 80) and the path is literal. Nothing leaves the box: the web server is calling itself. |
| 683 | js/file-access-to-http | src/lib/coding-agent-notify.ts:626 | BY DESIGN | The same loopback request as 682. The body holds the run's notice (`buildChatNotice`), the chat's session key and a session id read from the box's own transcript store. |
| 725 | js/file-access-to-http | mcp/tools/vault.ts:111 | BY DESIGN | Data: the vault's agent token. `readToken` refuses the token file if group or others can read it. The token goes to `vaultServiceUrl()`, which throws unless the whole base matches `^http://(127.0.0.1\|localhost)(:port)?$`. Every path the vault module passes is a literal `/api/agent/...`, with query values run through `encodeURIComponent` (vault/src/mcp/tools.ts), so a tool argument cannot change the host. The token never leaves the box. |
| 735 | js/log-injection | scripts/nano-stress/board-stress.mjs:109 | TEST/DEV-ONLY | Lab stress run. Only scripts/nano-stress/run.sh starts it: run.sh runs on the lab runner host and copies the script to a fresh temporary folder on a lab board. Its `log` helper already folds CR/LF to a space, so a reply cannot forge a log line. |
| 730 | js/file-access-to-http | scripts/nano-stress/board-stress.mjs:139 | TEST/DEV-ONLY | Same script. It signs an owner cookie with that board's session secret and sends it only to the same board's dashboard (`CLAWBOX_DASHBOARD`, default `http://127.0.0.1`). |
| 734 | js/http-to-file-access | scripts/nano-stress/board-stress.mjs:1000 | TEST/DEV-ONLY | Same script. On a failure it writes the error message to `<--out>.error`, next to the record file the operator named. |
| 726 | js/log-injection | scripts/nano-tests/board/org-mode-staff-mcp-files.mjs:56 | TEST/DEV-ONLY | On-board test. It runs only from scripts/nano-tests/tests/56-org-mode-staff.sh, inside the lab suite (scripts/nano-tests/run.sh, started by an operator or by the hardware-test workflow's self-hosted lab runner). `say` folds CR/LF/U+2028/U+2029 to a space, so a reply cannot fake a RESULT line. |
| 718 | js/file-access-to-http | scripts/nano-tests/board/org-mode-staff-mcp-files.mjs:422 | TEST/DEV-ONLY | Same test. `relayTokenOf` reads the test member's relay token from the board's own harness config and sends it to the same board's loopback `/setup-api/staff-mcp/<server>`. |
| 669 | js/file-access-to-http | scripts/bench/lib/client.mjs:90 | TEST/DEV-ONLY | The `npm run bench` client (scripts/bench/clawbox-bench.mjs), run by an operator. With `--auth token` it sends the box's MCP bearer to the `--base-url` the operator passes (default `http://localhost:3005`). |
| 667 | js/bad-code-sanitization | scripts/bench/scenarios/chat-turn.mjs:35 | TEST/DEV-ONLY | Bench scenario, run by an operator. The evaluated string embeds `JSON.stringify(sessionKey)`. `sessionKey` is `agent:<id>:clawbox-bench-<time stamp>`, and `<id>` comes from the box gateway's own hello (its main session key). The string runs through CDP `Runtime.evaluate` in the signed-in desktop page. No HTML parser sees it, so the `</script>` break-out this rule warns about cannot happen, and a JSON string is a complete JS string literal. |
| 668 | js/bad-code-sanitization | scripts/bench/scenarios/chat-turn.mjs:38 | TEST/DEV-ONLY | Same as 667, for the scenario's cleanup call (`sessions.delete`). |

### Counts

| Area | Alerts | REAL | BY DESIGN | TEST/DEV-ONLY |
|---|---|---|---|---|
| Request handling: external engine, hotspot, update branch, model fallback | 743, 744, 742, 740, 671, 675, 676 | 4 | 3 | 0 |
| Outbound tokens: subscription link, vision, Telegram, coding-agent notices, vault | 716, 687, 685, 686, 682, 683, 725 | 0 | 7 | 0 |
| Lab, test and bench scripts | 735, 730, 734, 726, 718, 669, 667, 668 | 0 | 0 | 8 |
| **Total** | **22** | **4** | **10** | **8** |

## 4. The four REAL alerts and what 4.4.1 changes

### The cause

The owner gate is there. What was missing is a check of where the request
came from.

- The session cookie (`clawbox_session`) is host-only and `SameSite=Lax`.
  `Lax` keeps the cookie off a POST from another **site**. It does not keep
  it off a POST from another **origin of the same site**.
- A box reached through its named tunnel has the hostname
  `<handle>.clawbox.tech` (`BOX_TUNNEL_DOMAIN`, src/lib/named-tunnel.ts).
  `clawbox.tech` is not on the Public Suffix List, only `tech` is. So every
  box's tunnel name is same-site with every other box's.
- Every box owner controls what their own tunnel name serves. A page there
  can send another box's tunnel name a POST that needs no CORS preflight. The
  visiting owner's browser attaches that box's cookie, and the route reads the
  body with `request.json()`, whatever its content type.
- `src/proxy.ts` checks the session, not the origin. The project's guard for
  the origin is `isSameOriginRequest` (src/lib/same-origin.ts), which
  state-changing routes call after their owner gate. The four routes behind
  743, 742, 740 and 671 did not call it.
- The other ways to reach a box are already cross-site, so `Lax` covers them:
  a LAN address or `.local` name, a quick tunnel (`trycloudflare.com` is a
  public suffix) and Tailscale (`ts.net` is a public suffix).

### The fix

One commit per area, each adding the existing `isSameOriginRequest` check to
a POST handler. It comes after the owner gate where the route has one, and
first in the handler otherwise. A request that fails the check gets
`403 { code: "cross_origin" }`, and the handler does nothing else. No new
helper and no other change.

| Commit | Alerts | Route file | Test |
|---|---|---|---|
| `fix(external-engine): refuse a Save or Test sent from another origin` | 743, 742 | src/app/setup-api/local-ai/external/route.ts, src/app/setup-api/local-ai/external/test/route.ts | src/tests/routes/local-ai-external-access.test.ts: a Save and a Test with the owner's signed cookie and a foreign Origin get 403 `cross_origin`, and no request leaves the box. The owner's own page can still Test. |
| `fix(hotspot): refuse a hotspot save sent from another origin` | 740 | src/app/setup-api/system/hotspot/route.ts | src/tests/routes/system/hotspot.test.ts: a save with a foreign Origin gets 403 `cross_origin`, nothing is written to the config store or `hotspot.env`, and the access point is not restarted. A save from the box's own origin still works. |
| `fix(update-branch): refuse an update-branch change sent from another origin` | 671 | src/app/setup-api/system/update-branch/route.ts | src/tests/routes/system/update-branch.test.ts: a set or a clear with a foreign Origin (and the downgrade override) gets 403 `cross_origin`, and nothing is written or removed. A set from the box's own origin still works. |

Who is unaffected: the box's own pages (Settings, the setup wizard, System
Update, the Local AI card) send their own origin. curl, the on-device tests
and other non-browser callers send no Origin, or the box's own. All of them
pass as before, including the first-boot window.

Each new refusal test fails against the beta route files (`expected 422 to be
403` for the external engine Save, `expected 200 to be 403` for the hotspot
and the update branch) and passes with the fix.

4.4.0 is a bug-fix-only release, so it ships without this change. The fix
lands in 4.4.1.

### CodeQL after the fix

CodeQL may keep listing 743, 742, 740 and 671 after 4.4.1. The guard is in
the route handler, not on the flagged line, and CodeQL's data-flow model does
not know `isSameOriginRequest`. With the fix in place they are BY DESIGN, and
the guard to name is `isSameOriginRequest`. They are not dismissed on GitHub.

## 5. Proof for the TEST/DEV-ONLY rows

A box runs from a git checkout, so these files are on every device's disk,
but nothing in the product starts them. At `f6a426f6e`, a `git grep` for
`nano-stress`, `nano-tests`, `board-stress`, `org-mode-staff-mcp-files`,
`scripts/bench`, `clawbox-bench` and `npm run bench` / `bun run bench`
covered everything except `docs/`, `*.md`, the script folders themselves and
`src/tests/`. It found only:

- `package.json`'s `bench` script (`node scripts/bench/clawbox-bench.mjs run`).
  An operator runs it by hand. No unit, install step, update step or `src/`
  module calls it.
- `.github/workflows/pr-tests-coverage.yml`, which only shellchecks and
  self-tests the shell part of scripts/nano-tests.
- `.github/workflows/nano-hardware-tests.yml`, which runs the on-device suite
  from a self-hosted lab runner against a lab board.
- `.gitignore` (the suite's local results folder) and
  `scripts/harness-contract/scan.mjs` (an exclusion list).

Nothing runs, imports or serves these files: no systemd unit in `config/`, no
line of `install.sh` or the update scripts, no `src/` module and no route.
`install.sh` touches `scripts/` only to set the exec bit on its `*.sh` files.
The web server serves `public/` and its app routes, and `public/` holds no
link into `scripts/`. scripts/nano-stress/run.sh and scripts/nano-tests/run.sh
both state that they run on the lab runner host and reach the board through
the lab's ssh helper.

## 6. Service environment

Every URL override named above (`CLAWBOX_AI_DEVICE_INFO_URL`,
`CLAWBOX_AI_PROXY_URL`, `CLAWBOX_TELEGRAM_API_ROOT`, `PORT`,
`CLAWBOX_VAULT_URL` / `CLAWBOX_VAULT_PORT`) comes from the web server's
process environment. No request, config-store setting or tool argument sets
it. The unit reads the checkout's `.env`, which the box's own account can
write, the agent's shell included. That same account can already read the
token files these requests carry, so changing a URL gives it nothing new. The
Telegram and vault overrides are also pinned to loopback.
