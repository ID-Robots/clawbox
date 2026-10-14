# Prime Radiant — `src/lib/prime-radiant/`

The server-side layer of Prime Radiant, the "living wiki": a git-backed vault
of Markdown pages with structured claims, read by OpenClaw's bundled
`memory-wiki` plugin in isolated mode and kept healthy by its own lint. Every
module here is SERVER ONLY unless it says "pure".

## Layout on disk

```
<box data dir>/prime-radiant/        (or $PRIME_RADIANT_DIR)
  vault/                              git repo, branch main, memory-wiki layout
    index.md  AGENTS.md  .gitignore
    entities/  concepts/  syntheses/  sources/
  prime-radiant.sqlite                state: claim_registry, review_items, runs, costs, ingest_jobs, ingest_files
  uploads/<batch>/                    dropped documents waiting for their ingest (removed when it ends, 24 h TTL)
  tmp/<job>/                          a job's private extraction scratch (removed when it ends)
```

## Modules

| Module | What it is for |
| --- | --- |
| `paths.ts` | `primeRadiantRoot()`, `vaultDir()`, `stateDbPath()` (read at call time); `safePagePath(input)` rebuilds a caller's page path or answers null; `isKnowledgePage(rel)` tells pages from bookkeeping (`index.md`, `reports/`, `.openclaw-wiki/`, …). |
| `schema.ts` (pure) | The page contract: `PageFrontmatter`, `Claim`, the enums, `validateFrontmatter(raw)`, `hasVerification(fm)`, `folderForType(type)`. Unknown keys are kept. |
| `frontmatter.ts` (pure) | `parsePage(text)` → `{ ok, frontmatter, body }` or `{ ok: false, errors }`; `serializePage(fm, body)` is deterministic (an unchanged page re-serialises to the same bytes); `pageSummary(body)`. YAML via js-yaml's CORE schema (no implicit dates). |
| `claims.ts` (pure) | The global claim-id namespace `<domain>/<entity>/<fact>`: `isClaimId`, `makeClaimId`, `slugify`, `buildClaimIndex(pages, ledgerRetired)`, `claimCollisions`, `retiredReuse`, `assertClaimIdAvailable` (throws `ClaimIdError` `invalid`/`taken`/`retired`), `allocateClaimId`, `retireClaimsOnPage`. A retired id is never reused. |
| `redact.ts` (pure) | `redactText(text, { maskEmails, maskPhones })`, `redactPath(path, { homeDir })`, `scanSecrets(text)`. Deterministic `[REDACTED:<KIND>]` placeholders; IBAN mod-97 and card Luhn validation; Unix timestamps are never cards. Apply to text AND paths before any network call. |
| `links.ts` (pure) | `extractLinks(body)` (wikilinks and relative Markdown links, code ignored), `createLinkResolver(pages)`, `buildLinkGraph(pages, indexBody)` → inbound/outbound/indexed. |
| `lint.ts` (pure over a snapshot) | `lintVault(snapshot, { scope, ledgerRetired, now })` → `LintReport`. Rules: `page-too-long` (6,000 soft / 12,000 hard), `summary-missing`, `summary-too-long` (300), `too-many-claims` (20), `claim-too-long` (240), `atomic-too-long` (entity/decision 3,000), `orphan`, `no-sources`, `stale-after-passed`, `secret-pattern`, `frontmatter-invalid`, `claim-id-collision`, `claim-id-retired-reuse`. Over-cap findings carry a `split` (`suggestSplit`: by headings, else by paragraphs; the page stays the hub). Four rules have `blocksCommit`. |
| `git.ts` | `git(vault, args)` through `runChild` (no shell, own environment, user's global git config ignored), `withVaultLock(vault, fn)` (per-vault mutex in `processStore`), `commitPaths`, `restorePaths`, `headCommit`, `currentBranch`, `commitCount`, `logForPath`, `showFileAt`, `changedPaths(base, head)`, `trackedAtHead`. Author/committer `Prime Radiant <prime-radiant@localhost>`. |
| `vault.ts` | `vaultInitialised()` (read-only: a repository with a commit?), `ensureVault()` (idempotent first-run init — `POST init` and `vaultOperation` only), `readVaultSnapshot()`, `readPage(rel)`, `listEntry(page)`, and **`vaultOperation(message, fn)`** — the one way to change the vault: lock held, writes through `tx.write/writePage/remove`, scoped lint, exactly one commit (or none if nothing changed); a blocking finding (`VaultLintBlockedError`) or a throw puts every touched file back. |
| `state-db.ts` | `openStateDb(vault)` / `withStateDb(vault, fn)` (node:sqlite, migrated by `user_version`); the claim ledger: `readRetiredLedger`, `recordRetired`, `syncActiveClaims`. The other tables are created for later work. |
| `plugin-wiring.ts` | `planMemoryWikiWiring(config, vault)` (pure), `memoryWikiWiringStatus()`, `ensureMemoryWikiWiring({ force })`: writes only `plugins.entries.memory-wiki.{enabled, config.vaultMode, config.vault.path}`, only when they differ, in one batch. Owner choices (plugin off, another mode or vault, agent scope, deny/allow lists) are `conflict`s, never overwritten unless forced (and deny/allow/agent scope never). |
| `service.ts` | What the routes answer: `getStatus()`, `listPages(filter)`, `getPage(rel)`, `getLint(paths)` — none of them creates anything; on a missing vault they answer `initialised: false` / empty / null — and `initialise()` (`ensureVault` + `ensureMemoryWikiWiring`, idempotent; a failed config write is a `WiringWriteError`). |
| `route-helpers.ts` | `json`, `fail(code, error, status)`, `vaultFailure(where, err)`, `ownerWriteGuard(req, what)` (session → owner cookie → same origin). |
| `writer.ts` (pure) | The Flash writer's contract: `buildWriterPrompt(items)` / `readWriterItems`, `parseWriterResponse(text, items)` (strict: one verdict per item, a dropped or garbled item fails that file alone, no JSON array throws `WriterParseError`), `buildPage(draft, sourceLabel, ctx)` (path by type, global claim ids via `allocateClaimId`, a re-ingested document updates its page in place, a VERIFIED page is never touched), `addToIndex`. Everything the model answers is redacted again before it is written. Caps: 50 files and 240,000 characters a call, 6,000 characters a document, 12 facts a page. |
| `flash-client.ts` | `FlashClient` (`complete({ system, user, maxTokens, signal })` → `{ text, usage, model }`), `createClawboxAiFlashClient` (the ClawBox AI proxy, `resolveClawaiToken` per call, a credential the proxy itself refuses noted in the shared memo), `FlashCallError` kinds (`rate_limited`, `server`, `network`, `bad_response` retryable; `no_credential`, `auth`, `refused`, `aborted` not), `completeWithRetry` (4 attempts, Retry-After or jittered backoff), `estimateUsd`. `flashClient()` answers `setFlashClientOverride(client)` first (kept in `processStore`), then `createStubFlashClient()` when `CLAWBOX_TEST_MODE=1` AND `PRIME_RADIANT_FLASH_STUB=1`, else the proxy. |
| `flash-stub.ts` | The deterministic model for the browser smoke test: a card per item from the document itself. |
| `ingest-sources.ts` | `scanFolders` (Memory Shard's `walkFiles` plus `SKIPPED_DIR_NAMES` and ClawBox's own output folders — never the vault), `readFileOnce` (one no-follow handle: size, SHA-256, bytes), `extractText` (txt/md decoded; pdf/docx through the box's own `extractOne` over a private copy of the hashed bytes), `prepareText` (control characters out, redacted, capped), `sourceLabel` (home folded, redacted — the only name a document has outside the box). |
| `ingest-store.ts` | Job rows, file rows (SHA-256 per file: dedupe and retry), `recordCost`/`readCosts`, `settleOrphanJobs`. |
| `ingest.ts` | `startIngest(input, deps)` → the job at once; the work runs on. One job a box (`IngestBusyError`). Scan → per file read/hash/dedupe/extract/redact → batches of 50 (or the character budget) → up to 8 Flash calls in flight → ONE `vaultOperation` commit per answered batch. `subscribeIngest`, `getIngestJob`, `listIngestJobs` (never create the database), `stopIngest`, `ingestFinished`, `safeJobId`. A refused credential or plan stops the job; a re-run of the same folders retries exactly what did not finish. Every dependency (client, vault, parallel, batch size, extractor, sleep, clock) is injectable. |
| `ingest-upload.ts` | Dropped files: `stageUpload` (batch id and file name rebuilt from their alphabets, written `wx`, metered, 9 MiB a file because the middleware keeps only the first 10 MiB of a body, a body shorter than its declared length refused), `stagedBatch`, `pruneStaleBatches`. |

## Routes (`src/app/setup-api/prime-radiant/`)

All owner-only through `requireSession`, `force-dynamic`, `Cache-Control: no-store`, failures as `{ error, code }`. The GETs NEVER create the vault (no folder, no repository, no state database, no config write); the app calls `POST init` when status says `initialised: false`. There is no boot hook.

- `POST init` — `ensureVault()` + `ensureMemoryWikiWiring()`, idempotent: `{ created, plugin: { state, …, wrote } }`. Owner cookie AND same origin (the MCP bearer gets 403 `owner_only`, a cross-site page 403 `cross_origin`), because it writes openclaw.json. 500 `vault_unavailable` when the vault cannot be made, `wiring_failed` when the vault is made and the config write failed.
- `GET status` — `initialised`, the vault's counts, git head, memory-wiki wiring state (reported, never written), lint summary. Not initialised → zero counts, `git: { branch: null, head: null, commits: 0 }`, a clean lint.
- `GET pages?type&domain&status&verified&q&offset&limit` — page list, no bodies (`{ total: 0, pages: [] }` with no vault).
- `GET pages/<path>` — one page: frontmatter or its errors, body, summary, backlinks, links, scoped lint. Not a page, or no vault → 404.
- `GET lint?path=…&paths=a,b` — lint report for those pages, or the whole vault (an empty report with no vault).
- `POST ingest` `{ folders: string[] }` (1–20, the folder picker's rule — `resolveFolderInsideBrowseRoot`, shared with Memory Shard) or `{ upload: <batch> }` → 202 `{ job }`. Owner cookie AND same origin. 409 `busy` (`runningId`), 412 `no_credential`, 404 `folder_not_found` / `unknown_batch` (with `index`), 400 `folder_refused` (ClawBox's own output) / `invalid`.
- `GET ingest` → `{ running, jobs }` (recent, newest first; nothing created on a fresh box).
- `GET ingest/<id>/events` — SSE: `job` (tallies), `file` (`{ seq, label, status, pages?, reason? }`), `end` (final job, then the stream closes). A finished job answers `job` + `end` at once; a 15 s comment keeps proxies open; 404 for an unknown id.
- `POST ingest/upload?name=<file>[&batch=<id>]` — one dropped document as the raw body → `{ batch, name, bytes }`. Owner cookie AND same origin. 400 `invalid_name` / `empty`, 404 `unknown_batch`, 409 `batch_full`, 413 `too_large`, 507 `disk_full`.

## Building on it

- The ingest writer adds pages with `vaultOperation("ingest: <what>", async (tx) => { … tx.writePage(path, fm, body) … })`, allocating ids with `allocateClaimId` against `buildClaimIndex` of a snapshot read under the lock, after `redactText`/`redactPath` on everything sent to a model. Later passes calling the model go through `flashClient()` + `completeWithRetry` and record every call with `recordCost`.
- A verification replaces a claim with `retireClaimsOnPage` (+ `verified` on the claim, `checked_by: "human"`) inside one `vaultOperation("verify: <claimId>", …)`; the ledger records the retired ids after the commit.
- A gate compares branches with `changedPaths` and `showFileAt` + `parsePage` + `hasVerification` on the base side.
