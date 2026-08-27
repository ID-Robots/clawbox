// GET /setup-api/email/messages — the backend behind `email_list`/`email_read`.
//
//   ?limit=10          list the newest messages (headers only)
//   ?uid=1234          read one message body
//
// It exists so the MCP server stays a thin caller of the device's own API
// (mcp/README.md's rule) instead of carrying a second copy of the IMAP client
// and a second reader of the credential store. The credentials never enter the
// MCP process.
//
// READ-ON-DEMAND, LITERALLY. There is no poller, no listener and no cache
// behind this route. A request opens a connection, EXAMINEs the mailbox, reads,
// and logs out; between requests the ClawBox holds nothing open and knows
// nothing about the mailbox. If no tool call happens, the owner's mail is never
// touched — which is the promise the "read on demand" mode makes.
//
// AND IT DOES NOT MARK ANYTHING READ. Every fetch in imap-client.ts uses
// BODY.PEEK and the mailbox is opened with EXAMINE, so listing and reading
// leave \Seen exactly as it was. That is enforced in the client, not here.
//
// MODE GATE: this answers 409 unless the owner chose a mode that allows
// reading. The MCP server also refuses to REGISTER the read tools in that case
// (see mcp/tools/email.ts) — belt and braces, because the two live on opposite
// sides of a process boundary and the mode can change under a running server.

import { NextResponse } from "next/server";
import { getEmailCredentials, modeAllowsReading, toImapConfig } from "@/lib/email-config";
import { buildFullMessage, remoteImageUrls } from "@/lib/email-mime";
import { fetchRemoteImages } from "@/lib/email-image-fetch";
import {
  ImapError,
  isImapConfigUsable,
  listMessages,
  MAX_FULL_FETCH_BYTES,
  MAX_LIST_LIMIT,
  readMessage,
  readRawMessage,
} from "@/lib/imap-client";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A per-device budget, same shape and same reasoning as the send budget: the
 * caller is always the agent on loopback, so an IP key would be one bucket
 * wearing a misleading name. Reading is not destructive, so this is far looser
 * than the send budget — it exists to stop a stuck agent from hammering the
 * provider into a rate-limit ban, not to ration the owner.
 */
const READ_BUDGET = { windowMs: 60 * 1000, max: 20 } as const;
const READ_BUDGET_KEY = "agent";

export async function GET(request: Request) {
  try {
    const settings = await getEmailCredentials();
    if (!settings) {
      return NextResponse.json(
        {
          error: "Email is not set up on this device. The owner has to add an email account in Settings → Email first.",
          kind: "unconfigured",
        },
        { status: 409 },
      );
    }
    if (!modeAllowsReading(settings.mode)) {
      return NextResponse.json(
        {
          error:
            "This ClawBox is set to send only. The owner has to choose \"Read on demand\" in Settings → Email before the assistant can open the mailbox.",
          kind: "mode",
        },
        { status: 409 },
      );
    }

    const cfg = toImapConfig(settings);
    if (!isImapConfigUsable(cfg)) {
      return NextResponse.json(
        {
          error: "The incoming-mail server for this account is not usable. Set it in Settings → Email.",
          kind: "unconfigured",
        },
        { status: 409 },
      );
    }

    if (!checkRateLimit("email-read", READ_BUDGET_KEY, READ_BUDGET)) {
      return NextResponse.json(
        { error: "This ClawBox has read the mailbox as often as it will this minute.", kind: "rate_limited" },
        { status: 429 },
      );
    }

    const url = new URL(request.url);
    const rawUid = url.searchParams.get("uid");

    if (rawUid !== null) {
      const uid = Number(rawUid);
      if (!Number.isInteger(uid) || uid < 1) {
        return NextResponse.json({ error: "That is not a valid message id" }, { status: 400 });
      }

      // ?view=full — the OWNER's view, for the dashboard's full-message panel:
      // the header block, and the body with its structure intact. The agent's
      // `email_read` never asks for this and still gets flattened text.
      if (url.searchParams.get("view") === "full") {
        // Only ever ONE fetch of the message itself. The consent path re-uses
        // these same bytes to find the image URLs, so pressing "load images"
        // cannot be turned into a second trip to the mail server.
        const fetched = await readRawMessage(cfg, uid, {
          signal: request.signal,
          maxBytes: MAX_FULL_FETCH_BYTES,
        });

        // Remote images are loaded only when the request says the owner asked.
        // The URLs come from the MESSAGE, never from the query string, which is
        // what stops this from being a proxy the caller can aim (see
        // email-image-fetch.ts).
        let loaded: Map<string, string> | undefined;
        if (url.searchParams.get("images") === "1") {
          // The owner's request signal rides along: closing the panel must
          // stop the outbound fetches too, rather than leaving them running
          // against their own 12s deadline on a device with little to spare.
          loaded = await fetchRemoteImages(remoteImageUrls(fetched.raw), request.signal);
        }

        const message = buildFullMessage(
          fetched.raw,
          fetched,
          loaded ? (src) => loaded.get(src) : undefined,
        );
        return NextResponse.json(
          { message },
          // The owner's mail must not sit in any cache between here and the
          // browser, and must never be treated as a document in its own right.
          { headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } },
        );
      }

      const message = await readMessage(cfg, uid, { signal: request.signal });
      return NextResponse.json({ message });
    }

    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 10 : Number(rawLimit);
    if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      return NextResponse.json(
        { error: `limit must be between 1 and ${MAX_LIST_LIMIT}` },
        { status: 400 },
      );
    }

    const listing = await listMessages(cfg, { limit, signal: request.signal });
    return NextResponse.json(listing);
  } catch (err) {
    if (err instanceof ImapError) {
      // The CLASS of failure and the server, never the address or the password
      // — and never a subject line or a body, which is the owner's mail.
      console.error(`[email/messages] read failed: kind=${err.kind}`);
      const status = err.kind === "auth" ? 401 : err.kind === "mailbox" ? 404 : 502;
      return NextResponse.json({ error: err.message, kind: err.kind }, { status });
    }
    console.error("[email/messages] read failed: kind=unknown");
    return NextResponse.json({ error: "Could not read the mailbox.", kind: "network" }, { status: 502 });
  }
}
