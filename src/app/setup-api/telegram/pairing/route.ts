import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import {
  readTelegramAllowFrom,
  listTelegramPairingRequests,
  readTelegramPairingRequests,
  approveTelegramPairing,
} from "@/lib/openclaw-config";
import {
  approveHermesPairing,
  listHermesPairing,
  readHermesApprovedUsers,
  readHermesPairingRequests,
  notifyHermesTelegramUser,
  type HermesPairingRequest,
} from "@/lib/hermes-telegram";
import { hermesSecretsPresent } from "@/lib/hermes-skill-secrets";
import { PAIRING_TOKEN_RE, normalizePairingToken, samePairingToken } from "@/lib/telegram-pairing-token";

/** Where Hermes keeps its own bot token — `hermes config set` writes this key. */
const HERMES_TELEGRAM_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";

export const dynamic = "force-dynamic";

// Neither harness's allowlist stores a display name. We remember the name
// captured at approval time (ClawBox-side, in config-store) so the UI can show
// who each approved sender is.
const APPROVED_NAMES_KEY = "telegram_approved_names";

// What the bot tells a requester once the owner lets them in. OpenClaw sends
// this itself (`pairing approve --notify`); Hermes has no such flag, so we send
// it with `hermes send`.
const APPROVED_NOTICE = "You're approved — send me a message and I'll answer.";

/**
 * Does this box have a Telegram bot at all?
 *
 * Asked per edition, because the two keep the credential in different places.
 * On OpenClaw ClawBox holds it and `telegram_bot_token` IS the answer. On
 * Hermes the harness holds its own in ~/.hermes/.env — `hermes config set
 * TELEGRAM_BOT_TOKEN` writes there and `hermes send` reads from there — and
 * ClawBox's copy is written only as a side effect of
 * /setup-api/telegram/configure. Asking for it on a box paired with `hermes
 * config set`, or restored without config.json, answered `configured: false`
 * for a working bot, and this route's GET returns an empty pairing state on
 * that answer: page.tsx polls it every 20 s for the "someone wants to talk to
 * your bot" popup, so a new household member's request was never shown to
 * anyone.
 *
 * Presence only, and never the value — `hermesSecretsPresent` is the same
 * write-only reader the skills store uses. A plain file read, no CLI: this
 * route is on a 20 s desktop poll, which is why its Hermes paths are
 * deliberately CLI-free.
 */
async function isConfigured(harness: Harness): Promise<boolean> {
  if (harness === "hermes") {
    return (await hermesSecretsPresent([HERMES_TELEGRAM_TOKEN_KEY]))[HERMES_TELEGRAM_TOKEN_KEY] === true;
  }
  const token = await get("telegram_bot_token");
  return typeof token === "string" && token.length > 0;
}

async function readApprovedNames(): Promise<Record<string, string>> {
  const raw = await get(APPROVED_NAMES_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name === "string") out[id] = name;
  }
  return out;
}

/**
 * Approved senders. Hermes' own store carries the display name, so it wins over
 * ClawBox's remembered map; OpenClaw's allowlist is bare ids and needs the map.
 */
async function buildApproved(
  harness: Harness,
  names?: Record<string, string>,
): Promise<Array<{ id: string; name?: string }>> {
  const nameMap = names ?? (await readApprovedNames());
  if (harness === "hermes") {
    const approved = await readHermesApprovedUsers();
    return approved.map(({ id, name }) => ({ id, name: name ?? nameMap[id] }));
  }
  const ids = await readTelegramAllowFrom();
  return ids.map((id) => ({ id, name: nameMap[id] }));
}

// GET — list approved senders (fast: one read of OpenClaw's state store, or
// of the legacy allowFrom file on a v1 box). With `?pending=1` it also runs
// the harness's `pairing list` CLI, which on OpenClaw is a ~10-12 s cold start
// on a Jetson, so pending stays opt-in rather than being fetched on every
// status refresh.
export async function GET(request: Request) {
  try {
    const harness = await getActiveHarness();
    if (!(await isConfigured(harness))) {
      return NextResponse.json(
        { configured: false, approved: [], pending: [] },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const params = new URL(request.url).searchParams;
    const approved = await buildApproved(harness);
    // `?poll=1` reads the pairing store directly — the state database, or the
    // legacy file on a v1 box (fast — safe for the desktop poller);
    // `?pending=1` uses the authoritative CLI (the Settings "Check" button).
    const wantsPoll = params.get("poll") === "1";
    const wantsPending = params.get("pending") === "1";
    let pending: HermesPairingRequest[] = [];
    if (harness === "hermes") {
      if (wantsPoll) {
        pending = await readHermesPairingRequests();
      } else if (wantsPending) {
        pending = (await listHermesPairing(request.signal)).pending;
      }
    } else if (wantsPoll) {
      pending = await readTelegramPairingRequests();
    } else if (wantsPending) {
      pending = await listTelegramPairingRequests();
    }
    return NextResponse.json(
      { configured: true, approved, pending },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read pairing state" },
      { status: 500 },
    );
  }
}

// POST { code } — approve a pending request and notify the requester. `code` is
// the 8-char code the bot DM'd, or (Hermes only) the request id from the pending
// list, which is the only approvable token there because Hermes stores codes
// hashed. See src/lib/telegram-pairing-token.ts.
export async function POST(request: Request) {
  try {
    let body: { code?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const harness = await getActiveHarness();
    const code = normalizePairingToken(body.code);
    if (!PAIRING_TOKEN_RE.test(code)) {
      return NextResponse.json(
        { error: "Enter the 8-character pairing code from the bot's message." },
        { status: 400 },
      );
    }

    // Capture the requester's id + name from the pending store BEFORE approving
    // (approval removes the request, and the allowlist keeps only the id).
    let approvedId: string | undefined;
    let approvedName: string | undefined;
    try {
      const requests =
        harness === "hermes"
          ? await readHermesPairingRequests()
          : await readTelegramPairingRequests();
      const match = requests.find((r) => samePairingToken(r.code, code));
      if (match) {
        approvedId = match.id;
        if (match.name) approvedName = match.name;
      }
    } catch {
      // name capture is best-effort — approval still proceeds
    }

    try {
      if (harness === "hermes") {
        const result = await approveHermesPairing(code, request.signal);
        // Hermes echoes the granted user back; trust it over the store read.
        approvedId = result.userId ?? approvedId;
        approvedName = result.userName ?? approvedName;
        if (approvedId) {
          // Never let a failed courtesy DM undo a completed approval.
          await notifyHermesTelegramUser(approvedId, APPROVED_NOTICE);
        }
      } else {
        await approveTelegramPairing(code);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A spawn/timeout failure is an infrastructure problem (500); anything
      // else is almost always a user-recoverable expired/unknown code (400).
      if (/timed out|ENOENT|spawn|not installed|cancelled/i.test(message)) {
        return NextResponse.json(
          { error: "Couldn't reach the agent to approve the code. Try again in a moment." },
          { status: 500 },
        );
      }
      return NextResponse.json(
        {
          error:
            "Couldn't approve that code — it may have expired (codes last 1 hour) or already been used. Ask them to message the bot again.",
        },
        { status: 400 },
      );
    }

    let names: Record<string, string> | undefined;
    if (approvedId && approvedName) {
      names = await readApprovedNames();
      names[approvedId] = approvedName;
      await set(APPROVED_NAMES_KEY, names);
    }
    const approved = await buildApproved(harness, names);
    return NextResponse.json({ success: true, approved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Approval failed" },
      { status: 500 },
    );
  }
}
