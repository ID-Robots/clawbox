# Telegram pairing approval in Settings — Design

**Date:** 2026-06-16
**Branch:** `feature/telegram-pairing-approval` → `beta`
**Status:** approved, implemented, on-box validation pending

## Problem

OpenClaw's Telegram channel ships with `dmPolicy: "pairing"` (the secure default
ClawBox keeps — see #204 and `gateway-pre-start.sh`). When a new person DMs the
bot, the bot stays inert and replies with the user's Telegram id + an 8‑character
pairing code, telling them to ask the owner to run
`openclaw pairing approve telegram <CODE>` in a terminal. ClawBox owners don't
have a terminal in hand — so there was no in-product way to let someone in.

## Goal

In **Settings → Telegram**, let the owner:
1. Paste a pairing code (or pick from a live list of pending requests) and approve it.
2. Have the bot confirm to the user automatically ("you're approved").
3. See the list of users currently allowed to chat with the bot.

No revoke (no native CLI for it; out of scope).

## Verified facts (OpenClaw 2026.6.6, from docs + the device — no guessing)

- CLI: `openclaw pairing list telegram --json` → `{ "channel": "telegram", "requests": [...] }`.
- CLI: `openclaw pairing approve telegram <CODE> --notify` — `--notify` *"Notify the
  requester on the same channel"*, i.e. OpenClaw sends the confirmation itself.
- Approved senders persist in `~/.openclaw/credentials/telegram-<account>-allowFrom.json`
  → `{ "version": 1, "allowFrom": ["<userId>", ...] }` (default account = `telegram-default-allowFrom.json`).
  This is a **separate file** from `openclaw.json`, so the boot-time
  `channels.telegram.allowFrom` strip never removes pairing approvals.
- There is **no** CLI to list already-approved senders → read the file directly.
- The web server runs as `clawbox`, which owns the `credentials/` dir (perms 600) — it can read the file.
- The `pairing list` CLI cold-starts in ~10–12 s on Jetson; the file read is instant.

## Architecture

**`src/lib/openclaw-config.ts`** — three helpers + a stdout-capturing CLI spawn
(`runOpenclawCli`, mirroring `spawnOpenclawConfigSet`'s timeout/error handling):
- `listTelegramPairingRequests()` → runs `pairing list telegram --json`, returns `.requests` (defensive).
- `approveTelegramPairing(code)` → validates `/^[A-Z0-9]{8}$/`, runs `pairing approve telegram <CODE> --notify`.
- `readTelegramAllowFrom(account = "default")` → reads the allowFrom file, returns `string[]` (empty on any failure).

**`src/app/setup-api/telegram/pairing/route.ts`** (new):
- `GET` → `{ configured, approved, pending: [] }`. `approved` is the fast file read;
  `pending` is only populated when `?pending=1` (opt-in to the slow CLI).
- `POST { code }` → validates format (400 on bad), approves with `--notify`, returns
  the refreshed `approved` list. Expired/unknown code → 400; spawn/timeout → 500.

**`src/components/SettingsApp.tsx`** — a "User access" card under the Telegram
section (only when a bot is configured): approved-users list (loads with status),
a paste-a-code field, and an opt-in "Check for requests" button that loads pending
requests with one-click approve. The card itself does not auto-poll — the pending
CLI is slow, so it only runs on the explicit "Check for requests" click.

**`src/app/page.tsx`** — a desktop notification popup so new pairing requests
surface even when Settings is closed. It polls `GET …?poll=1` (the fast
file-read path, not the slow CLI) every 20s, de-dups already-seen/dismissed
requests via localStorage, and offers inline Approve / Open-in-Settings / Dismiss.

**`src/lib/translations.ts`** — `settings.pairing*` keys across all 10 locales.

## Security

We only ever approve **specific** senders and never touch `dmPolicy`/`allowFrom`
in `openclaw.json`, so the bot is never opened to everyone. The code is validated
before it reaches `spawn` (args are not shell-interpreted regardless).

## Testing

- Unit (`src/tests/unit/telegram-pairing.test.ts`): `readTelegramAllowFrom` parsing
  (temp home dir) + `approveTelegramPairing` format guard.
- Route (`src/tests/routes/telegram/pairing.test.ts`): GET configured/not/pending,
  POST validation, uppercase + `--notify`, expired→400, timeout→500.
- On-device E2E: second account DMs the bot → approve in Settings → bot sends the
  `--notify` confirmation → user can chat → appears in Approved users.

## Out of scope

Revoke; setup-wizard surface (no users exist at setup time); custom confirmation
wording (uses OpenClaw's native `--notify` message).
