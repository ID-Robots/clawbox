# CodeQL triage for 4.4.0

The open CodeQL alerts on the 4.4.0 release PR (#1578, beta → main), as of
2026-11-26: 22 alerts. Line numbers refer to the PR's merge commit, which has
the same tree as beta at `f6a426f6e`.

Each alert was read against the code and put in one of three classes:

- **REAL**: input an attacker controls reaches the sink with no owner-auth gate
  and no guard that is enough.
- **BY DESIGN**: the value is the owner's own, set or read behind owner auth (or
  the box's own config and service environment), and the guard named in the
  table holds.
- **TEST/DEV-ONLY**: a script for lab boards or benchmarks. The product never
  runs it and the web server never serves it.

No alert was dismissed on GitHub.

| Alert | Rule | File:line | Verdict | Reason |
|---|---|---|---|---|
| 743 | js/request-forgery (critical) | src/lib/external-engine.ts:396 | BY DESIGN | The owner types the URL of their own external engine. Every caller is behind `requireSession({ ownerOnly: true })` (local-ai/external, external/test, external/select, system/cluster). `hostRefusal` refuses metadata and link-local hosts, including DNS names that resolve to them; the cluster path also requires a LAN address; redirects are not followed. |
| 744 | js/file-access-to-http | src/lib/external-engine.ts:398 | BY DESIGN | The stored API key goes as a bearer only to the engine the owner saved it for. The Test route sends the stored key only when the origin is the same, and with `redirect: "manual"` the key cannot follow a 3xx to another host. |
| 742 | js/http-to-file-access | src/lib/external-engine.ts:100 | BY DESIGN | Only an owner-only route writes the key. The file path is fixed (`data/.external-engine-key`) and the file is 0600, written to a temp file and renamed. `parseExternalApiKey` refuses whitespace, control characters and over-long keys. |
| 740 | js/http-to-file-access | src/lib/hotspot-env.ts:146 | BY DESIGN | The hotspot name and password go to a fixed path (0600, temp file + rename). The route caps their length and refuses control characters, and so does `quoteForScripts`. The file is parsed as root and never sourced. The route is open only during the first-boot window, before any owner password exists (setup-api-gate allow-list). |
| 671 | js/http-to-file-access | src/app/setup-api/system/update-branch/route.ts:131 | BY DESIGN | Owner only: the proxy requires a session, and non-owner-scope answers 403 for `/setup-api/system/update-branch`. The branch must pass `isSafeBranch` (the same rule as the updater and install.sh) and is written to the fixed `.update-branch` path. |
| 716 | js/file-access-to-http | src/lib/subscription-link.ts:135 | BY DESIGN | The box's own ClawBox AI token is sent as a bearer to the portal's device-info URL. That URL is a constant, or a service-env override; no request can change it. |
| 687 | js/file-access-to-http | src/lib/vision-describe.ts:177 | BY DESIGN | The image the user asked to describe, with the box's ClawBox AI token, goes to the ClawBox AI proxy, whose URL is a constant or a service-env override. The cloud-AI lock is checked again just before the request. |
| 685 | js/file-access-to-http | src/lib/telegram-owner-send.ts:156 | BY DESIGN | The bot token and chat id come from the harness's own config. Both are rebuilt from their strict patterns (`BOT_TOKEN_RE`, `TELEGRAM_CHAT_ID_RE`) before use. The API root is Telegram's, or a loopback-only override. |
| 686 | js/file-access-to-http | src/lib/telegram-owner-send.ts:161 | BY DESIGN | The same request as 685: the body carries only the rebuilt chat id, the notice text and buttons whose labels are capped. |
| 682 | js/file-access-to-http | src/lib/coding-agent-notify.ts:625 | BY DESIGN | A loopback call to the box's own `/setup-api/hermes/chat`, authenticated with the box's MCP token. The port must be 1–5 digits and the host is fixed at 127.0.0.1. |
| 683 | js/file-access-to-http | src/lib/coding-agent-notify.ts:626 | BY DESIGN | The same loopback request as 682: the body is the notice and a session id read from the box's own transcript. |
| 725 | js/file-access-to-http | mcp/tools/vault.ts:111 | BY DESIGN | The vault's agent token goes to the vault service. `vaultServiceUrl` throws on any URL that is not `http://127.0.0.1` or `http://localhost`. |
| 675 | js/log-injection | src/lib/provider-model-fallback.ts:269 | BY DESIGN | The route needs a signed-in person session and a same-origin request. The provider must be a key of the `POLICIES` allow-list, the model id must match `MODEL_ID_RE` (`[A-Za-z0-9._:-]`), and candidates come from the provider's own catalog. No newline can reach the log line. |
| 676 | js/log-injection | src/lib/provider-model-fallback.ts:358 | BY DESIGN | The same values as 675 (`failedRef` = allow-listed provider + strict-alphabet model id, the fallback taken from the catalog). |
| 735 | js/log-injection | scripts/nano-stress/board-stress.mjs:109 | TEST/DEV-ONLY | A lab-board stress script, run by hand. The log line already folds CR/LF to spaces. |
| 730 | js/file-access-to-http | scripts/nano-stress/board-stress.mjs:139 | TEST/DEV-ONLY | A lab-board stress script: it sends the board's owner cookie to that same board's dashboard. |
| 734 | js/http-to-file-access | scripts/nano-stress/board-stress.mjs:1000 | TEST/DEV-ONLY | A lab-board stress script: it writes an error message to its own fixed output file. |
| 726 | js/log-injection | scripts/nano-tests/board/org-mode-staff-mcp-files.mjs:56 | TEST/DEV-ONLY | An on-board test: `say` already folds CR/LF/U+2028/U+2029 to spaces, so a reply cannot fake a RESULT line. |
| 718 | js/file-access-to-http | scripts/nano-tests/board/org-mode-staff-mcp-files.mjs:422 | TEST/DEV-ONLY | An on-board test: it sends the test user's relay token to the board's own staff-mcp route. |
| 669 | js/file-access-to-http | scripts/bench/lib/client.mjs:90 | TEST/DEV-ONLY | The `npm run bench` client: it sends the operator's token to the box being benchmarked. |
| 667 | js/bad-code-sanitization | scripts/bench/scenarios/chat-turn.mjs:35 | TEST/DEV-ONLY | A bench scenario. The page script embeds a session key the bench generated itself, through `JSON.stringify`, in its own headless page. |
| 668 | js/bad-code-sanitization | scripts/bench/scenarios/chat-turn.mjs:38 | TEST/DEV-ONLY | The same as 667 (the bench's cleanup call). |

**Result: no REAL alert.** 14 are BY DESIGN and 8 are TEST/DEV-ONLY, so 4.4.1
needs no code change for them.
