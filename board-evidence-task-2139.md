# Board evidence — TASK-2139 (PR #1401)

| | |
|---|---|
| Board | Nano lab board, serial `1791626057640` (leased for this check, released afterwards) |
| Code under test | `fix/task-2139-oauth-failover` @ `74d1d9fa0373e9954a707a74fed1209509015810` |
| Date | 2026-11-03 (times below are the board's, UTC) |
| **OpenClaw** | **PASS** — 10/10 checks |
| **Hermes** | **PASS** — 10/10 checks |
| PR unit tests on the board | 80/80 passed |

The commit that adds this file changes nothing else; the board ran the code commit above.

## 1. Board setup

```
$ git fetch && git checkout fix/task-2139-oauth-failover
  head: 74d1d9fa0373e9954a707a74fed1209509015810

$ nano-lease list                      # 1791626057640 listed FREE
$ nano-lease reserve 1791626057640 "TASK-2139: board evidence PR #1401"
  leased 1791626057640 to coding-agent

$ nano-board rebuild 1791626057640 fix/task-2139-oauth-failover 74d1d9fa0373e9954a707a74fed1209509015810
  === BEFORE e76868a346daa61f3e8b6aa59efdcbb8305220ec
  force-update rc=0
  === AFTER force-update 74d1d9fa0373e9954a707a74fed1209509015810
  post_update rc=0
  === DONE 2026-11-03T16:14:57+00:00
  sha=74d1d9fa0373e9954a707a74fed1209509015810
  branch=fix/task-2139-oauth-failover
  gateway=active  setup=active  gw_http=200
  [nano-ci] board runs the commit under test 74d1d9fa0373      (exit 0)

$ nano-board sha 1791626057640
  74d1d9fa0373e9954a707a74fed1209509015810                     # = branch head

$ nano-board health 1791626057640
  gw=active setup=active sha=74d1d9fa0                         (exit 0)
```

## 2. What was exercised

All of it through `nano-board ssh 1791626057640`, against the board's running
server and its own routes, as the owner (session minted on the board the way
`scripts/nano-tests/lib.sh` does):

1. **Pool of three Claude (OAuth) accounts** `T2139 A`, `T2139 B`, `T2139 C`, in
   that order (pick mode `order`), each connected through
   `POST /setup-api/anthropic/accounts {"action":"connect_oauth"}` from a sign-in
   handoff holding **placeholder tokens** (fake access/refresh tokens, `example.invalid`
   e-mails). Anthropic refuses every one of them for real (`401 OAuth access token is invalid`).
2. **One coding run** on provider `anthropic`
   (`POST /setup-api/coding-agent/run`, task "Reply with the single word OK"),
   which starts on A with A's first token.
3. **Right after the run was handed A's token**, A's token is renewed in the
   store through `{"action":"reauth_oauth","id":A}` — the "another consumer
   renewed it meanwhile" case of the 2026-11-03 incident.
4. The run is followed to its end (`GET /setup-api/coding-agent/runs?id=…&wait=60`);
   its progress, its error, the pool before/after and the server's own log
   lines for the run (`journalctl -u clawbox-setup`) are read back and checked.
5. The test accounts, the handoff and the project folder are removed.

Expected with the PR: A refused → the probe sees a fresher token in the store
and answers `ok` without renewing → **one** restart on A with the fresh token →
refused again → **not asked again**, the run moves on in the owner's order →
B refused → asked, `dead` → C refused → `dead` → nothing left: the run ends
`failed` with one clear error after 4 spawns, never back on A, A left
connected (not marked).

Runtime switch between the two passes: Settings' own route
`POST /setup-api/harness/swap {"harness":"hermes"}` (the board is a locked
OpenClaw edition).

## 3. OpenClaw — PASS

```
RUNTIME openclaw
BOARD_HEAD 74d1d9fa0373e9954a707a74fed1209509015810
POOL A=9e8dd94d B=2d13b1c5 C=fe520c81
POOL_BEFORE  active=9e8dd94d pickMode=order
  9e8dd94d T2139 A  kind=oauth status=ok
  2d13b1c5 T2139 B  kind=oauth status=ok
  fe520c81 T2139 C  kind=oauth status=ok
RUN run-i95trl3b: HTTP 202 provider=anthropic account=9e8dd94d at 16:18:07.641
ROTATE A (renewed in the store): HTTP 200 at 16:18:07.754
RUN_STATUS failed at 16:18:22.325
RUN_ERROR Anthropic refused the credential of every account this run could use. Sign one in again in Settings → Providers → Anthropic accounts, then start the run again.
```

Run progress (what the Coding Agent app shows):

```
On Anthropic account "T2139 A"
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Anthropic refused the credential of account "T2139 A"; carrying on with "T2139 A" in the same session
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Anthropic refused the credential of account "T2139 A"; carrying on with "T2139 B" in the same session
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Anthropic refused the credential of account "T2139 B"; carrying on with "T2139 C" in the same session
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Finished: failed
```

Server log for the run:

```
[anthropic-accounts] the owner re-authenticated a Claude account (9e8dd94d)
[coding-agent] run-i95trl3b: Anthropic refused account 9e8dd94d's credential; asked again, it is ok: the run goes back on it once if the store holds a fresher credential
[coding-agent] run-i95trl3b: continuing on Anthropic account 9e8dd94d after 9e8dd94d was refused, restarted with its credential read again from the store (credential retry 1/6)
[coding-agent] run-i95trl3b: Anthropic refused account 9e8dd94d's credential again after its restart on a fresh one; not asking again, the run moves to the next account
[coding-agent] run-i95trl3b: continuing on Anthropic account 2d13b1c5 after 9e8dd94d was refused, failed over in the owner's order (credential retry 2/6)
[coding-agent] run-i95trl3b: Anthropic refused account 2d13b1c5's credential; asked again, it is dead: the run moves to the next account
[coding-agent] run-i95trl3b: continuing on Anthropic account fe520c81 after 2d13b1c5 was refused, failed over in the owner's order (credential retry 3/6)
[coding-agent] run-i95trl3b: Anthropic refused account fe520c81's credential; asked again, it is dead: the run moves to the next account
[coding-agent] run-i95trl3b: no Anthropic account left to carry the run on after fe520c81 (left behind: 9e8dd94d, 2d13b1c5, fe520c81); it ends failed
```

Pool after the run:

```
active=9e8dd94d pickMode=order
  9e8dd94d T2139 A  kind=oauth status=ok
  2d13b1c5 T2139 B  kind=oauth status=revoked
  fe520c81 T2139 C  kind=oauth status=revoked
```

Checks:

```
ok - A refused, probe answers ok from the fresher token in the store (no renewal)
ok - one restart on A with its credential read again from the store (retry 1/6)
ok - A refused again after that restart: not asked again, the run moves on
ok - failed over to B, next in the owner's order (retry 2/6)
ok - B refused and probed, the run moves on
ok - failed over to C, next in the owner's order (retry 3/6)
ok - no account left after C: the run ends failed instead of looping
ok - the run went back on A exactly once (never after the second refusal)
ok - the run ended failed (status=failed)
ok - A is not marked (status=ok): the probe vouched for its fresher token
```

## 4. Hermes — PASS

Switch, as Settings does it:

```
POST /setup-api/harness/swap {"harness":"hermes"}            HTTP 200, 16:19:42 → 16:25:18
{"phase":"install","status":"Installing Hermes…"}
{"phase":"lock","status":"Re-baking the edition lock for Hermes…"}
{"phase":"provision","status":"Provisioning Hermes — units, identity, dashboard…"}
{"phase":"done","status":"The Hermes edition is in place."}
{"success":true,"active":"hermes","reload":true,"notes":["ClawBox AI sign-in carried over"]}
GET /setup-api/harness/status → {"active":"hermes","edition":"hermes","locked":true,…,"harnesses":[{"id":"hermes","label":"Hermes",…,"healthy":true}]}

$ nano-board sha 1791626057640       → 74d1d9fa0373e9954a707a74fed1209509015810
$ nano-board health 1791626057640    → gw=inactive setup=active sha=74d1d9fa0
  (gw is OpenClaw's gateway unit, which the Hermes edition does not run;
   clawbox-hermes-dashboard and clawbox-hermes-dashboard-proxy were active)
```

Same scenario:

```
RUNTIME hermes
BOARD_HEAD 74d1d9fa0373e9954a707a74fed1209509015810
POOL A=53927b4b B=8784f1d6 C=1e8f63c6
POOL_BEFORE  active=53927b4b pickMode=order
  53927b4b T2139 A  kind=oauth status=ok
  8784f1d6 T2139 B  kind=oauth status=ok
  1e8f63c6 T2139 C  kind=oauth status=ok
RUN run-vhhrk75n: HTTP 202 provider=anthropic account=53927b4b at 16:31:33.957
ROTATE A (renewed in the store): HTTP 200 at 16:31:34.052
RUN_STATUS failed at 16:31:48.134
RUN_ERROR Anthropic refused the credential of every account this run could use. Sign one in again in Settings → Providers → Anthropic accounts, then start the run again.
```

Run progress:

```
On Anthropic account "T2139 A"
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Anthropic refused the credential of account "T2139 A"; carrying on with "T2139 A" in the same session
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Anthropic refused the credential of account "T2139 A"; carrying on with "T2139 B" in the same session
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Anthropic refused the credential of account "T2139 B"; carrying on with "T2139 C" in the same session
Started with claude-opus-5-5
Failed to authenticate. API Error: 401 OAuth access token is invalid.
Finished: failed
```

Server log for the run:

```
[anthropic-accounts] the owner re-authenticated a Claude account (53927b4b)
[coding-agent] run-vhhrk75n: Anthropic refused account 53927b4b's credential; asked again, it is ok: the run goes back on it once if the store holds a fresher credential
[coding-agent] run-vhhrk75n: continuing on Anthropic account 53927b4b after 53927b4b was refused, restarted with its credential read again from the store (credential retry 1/6)
[coding-agent] run-vhhrk75n: Anthropic refused account 53927b4b's credential again after its restart on a fresh one; not asking again, the run moves to the next account
[coding-agent] run-vhhrk75n: continuing on Anthropic account 8784f1d6 after 53927b4b was refused, failed over in the owner's order (credential retry 2/6)
[coding-agent] run-vhhrk75n: Anthropic refused account 8784f1d6's credential; asked again, it is dead: the run moves to the next account
[coding-agent] run-vhhrk75n: continuing on Anthropic account 1e8f63c6 after 8784f1d6 was refused, failed over in the owner's order (credential retry 3/6)
[coding-agent] run-vhhrk75n: Anthropic refused account 1e8f63c6's credential; asked again, it is dead: the run moves to the next account
[coding-agent] run-vhhrk75n: no Anthropic account left to carry the run on after 1e8f63c6 (left behind: 53927b4b, 8784f1d6, 1e8f63c6); it ends failed
```

Pool after the run:

```
active=53927b4b pickMode=order
  53927b4b T2139 A  kind=oauth status=ok
  8784f1d6 T2139 B  kind=oauth status=revoked
  1e8f63c6 T2139 C  kind=oauth status=revoked
```

Checks:

```
ok - A refused, probe answers ok from the fresher token in the store (no renewal)
ok - one restart on A with its credential read again from the store (retry 1/6)
ok - A refused again after that restart: not asked again, the run moves on
ok - failed over to B, next in the owner's order (retry 2/6)
ok - B refused and probed, the run moves on
ok - failed over to C, next in the owner's order (retry 3/6)
ok - no account left after C: the run ends failed instead of looping
ok - the run went back on A exactly once (never after the second refusal)
ok - the run ended failed (status=failed)
ok - A is not marked (status=ok): the probe vouched for its fresher token
```

## 5. The PR's unit tests, run on the board

```
$ nano-board ssh 1791626057640 'cd ~/clawbox && node_modules/.bin/vitest run --config vitest.config.ts \
    src/tests/unit/anthropic-accounts.test.ts src/tests/unit/coding-agent-account-switch.test.ts --maxWorkers=1'
  ✓ restarts the run on the SAME account with the credential read again from the store, and marks nothing
  ✓ moves the run to the next account when the fresh credential is refused too — and does not ask again
  ✓ fails with one clear error only once every account has been refused
  ✓ does not go back to an account it gave up on when the box resumes it after a reset
  ✓ caps the carried-on tries of one run however many accounts there are
  ✓ asks Anthropic ONCE when several runs on the account are refused together, and every one goes on on the fresh token
  …
  Test Files  2 passed (2)
       Tests  80 passed (80)
```

## 6. Not covered on the board

- **A run that completes on the next account.** Every account here holds
  placeholder tokens, so every leg is refused and the run ends `failed` by
  design; finishing on a working account needs a real Anthropic sign-in. That
  leg is covered by the unit tests above.
- **Several runs refused together sharing one probe** was not reproduced live;
  the unit test "asks Anthropic ONCE when several runs on the account are
  refused together" passed on the board.
- The OpenClaw gateway's chat path (core using the pool's profiles) was not
  exercised; the PR changes it only through the shared probe.

## 7. Afterwards

```
POST /setup-api/harness/swap {"harness":"openclaw"}
  {"phase":"done","status":"The OpenClaw edition is in place."}
  {"success":true,"active":"openclaw","reload":true,"notes":["ClawBox AI sign-in carried over"]}
$ nano-board sha 1791626057640       → 74d1d9fa0373e9954a707a74fed1209509015810
$ nano-board health 1791626057640    → gw=active setup=active sha=74d1d9fa0   (exit 0)
GET /setup-api/anthropic/accounts    → {"accounts":[],…}   (test accounts removed, no handoff or test folder left)
$ nano-lease release 1791626057640   → {"released": true}   (board listed FREE again)
```
