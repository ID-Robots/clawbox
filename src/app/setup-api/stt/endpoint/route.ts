export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { clearOwnerChoice, noteOwnerChoice } from "@/lib/clawai-cloud-choice";
import { cloudAiLockOn } from "@/lib/feature-engine";
import { GatewayNotReadyError, openclawIsAbsent, restartGateway } from "@/lib/openclaw-config";
import { hasPersonSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { syncChannelAudio } from "@/lib/stt-channel";
import {
  deleteSttEndpoint,
  deleteSttEndpointKey,
  probeSttEndpoint,
  readSttEndpoint,
  readSttEndpointKey,
  validateSttEndpointInput,
  writeSttEndpoint,
  writeSttEndpointKey,
} from "@/lib/stt-endpoint";
import { localSttInstalled } from "@/lib/stt-local";
import { getSttRoute, readStoredSttPrimary, setSttPrimary } from "@/lib/stt-preference";
import { createSerialLock } from "@/lib/serial-lock";

/**
 * The owner's own OpenAI-compatible speech server as the transcription engine
 * (TASK-2501 PR-D: speech local-only).
 *
 * GET                                   → the saved server (never its key)
 * POST {baseUrl, model?, apiKey?,       → test it, save it and make it the
 *       clearApiKey?, test?}              engine that hears the box first —
 *                                         the chat microphone and channel voice
 *                                         notes alike; `test: true` only tests
 * DELETE                                → forget it; the box goes back to its
 *                                         own engine (or, without the lock, to
 *                                         the default)
 *
 * The server must be on this box or on the private LAN (stt-endpoint.ts): an
 * address on the internet is refused here and again on every recording.
 *
 * OWNER ONLY AND SAME-ORIGIN, the rule /setup-api/stt keeps for the same
 * reason: where a recording is sent is the person's decision, never the
 * agent's, and the MCP bearer is admitted to /setup-api/* by middleware.
 */

const withEndpoint = createSerialLock();

function noStore<T>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

async function view() {
  const record = await readSttEndpoint();
  return record
    ? { configured: true, baseUrl: record.baseUrl, model: record.model, apiKeySet: readSttEndpointKey(record.baseUrl) !== null }
    : { configured: false };
}

async function ownerOnly(req: Request): Promise<NextResponse | null> {
  if (!(await hasPersonSession(req)) || !isSameOriginRequest(req)) {
    return NextResponse.json(
      { error: "Changing the transcription engine needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  return null;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Put channel voice notes on what the store now says, and restart the gateway
 * when the list changed (media understanding is read at gateway start). Never
 * turns a saved change into a failure: what could not be done is a warning.
 */
async function alignChannels(): Promise<string | null> {
  if (openclawIsAbsent()) return null;
  try {
    const [route, local] = await Promise.all([getSttRoute(), localSttInstalled()]);
    const wrote = await syncChannelAudio(route.order, local.installed);
    if (!wrote) return null;
    try {
      await restartGateway();
      return null;
    } catch (err) {
      console.warn("[setup-api/stt/endpoint] gateway restart failed after the audio write:", err instanceof Error ? err.name : typeof err);
      return err instanceof GatewayNotReadyError
        ? "Saved, but the gateway has not finished restarting — channel voice notes switch over once it is serving again."
        : "Saved, but the gateway restart failed — channel voice notes switch over at the next restart.";
    }
  } catch (err) {
    console.warn("[setup-api/stt/endpoint] could not update channel voice notes:", err instanceof Error ? err.name : typeof err);
    return "Saved, but channel voice notes could not be updated — they switch over the next time the transcription engine is changed.";
  }
}

export async function GET() {
  try {
    return noStore(await view());
  } catch {
    return NextResponse.json({ error: "Could not read the speech server settings." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const refused = await ownerOnly(req);
  if (refused) return refused;
  let body: Record<string, unknown> | null;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const input = validateSttEndpointInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error, code: input.code }, { status: 400 });

  return await withEndpoint(async () => {
    try {
      const saved = await readSttEndpoint();
      // A key on file belongs to the origin it was saved for: it is reused for
      // that origin only, so re-aiming the endpoint never mails the old
      // server's key to a new host.
      const keptKey = !input.clearApiKey && saved && originOf(saved.baseUrl) === originOf(input.value.baseUrl)
        ? readSttEndpointKey(saved.baseUrl)
        : null;
      const apiKey = input.apiKey ?? keptKey;
      const probe = await probeSttEndpoint(input.value, apiKey);
      if (!probe.ok) {
        return NextResponse.json({ error: probe.error, code: probe.code }, { status: probe.code === "address_refused" ? 400 : 502 });
      }
      if (body?.test === true) return noStore({ ok: true, latencyMs: probe.latencyMs });

      // The pin first, as /setup-api/stt does: a later failure then leaves a
      // pin over an unchanged engine, which the cloud default reads as "leave
      // this box alone" — the safe direction.
      await noteOwnerChoice("stt");
      // The key off first, then the record, then the new key: every state a
      // failure can leave sends no key, or the right key, to the address on
      // file — never one server's key to another.
      deleteSttEndpointKey();
      await writeSttEndpoint(input.value);
      if (apiKey) writeSttEndpointKey(apiKey, input.value.baseUrl);
      await setSttPrimary("endpoint");
      const warning = await alignChannels();
      return noStore({ ...(await view()), ok: true, latencyMs: probe.latencyMs, ...(warning ? { warning } : {}) });
    } catch (err) {
      console.warn("[setup-api/stt/endpoint] could not save the speech server:", err instanceof Error ? err.name : typeof err);
      return NextResponse.json({ error: "Could not save the speech server on this box." }, { status: 500 });
    }
  });
}

export async function DELETE(req: Request) {
  const refused = await ownerOnly(req);
  if (refused) return refused;
  return await withEndpoint(async () => {
    try {
      const wasPrimary = (await readStoredSttPrimary()) === "endpoint";
      await deleteSttEndpoint();
      if (wasPrimary) {
        // Back to the box's own engine under the lock; otherwise the
        // capability goes back to the automatic default, the way removing
        // Whisper hands it back (`releaseLocalTranscription`).
        if (await cloudAiLockOn()) {
          await setSttPrimary("local");
        } else {
          await setSttPrimary("cloud");
          await clearOwnerChoice("stt");
        }
      }
      const warning = await alignChannels();
      return noStore({ ...(await view()), ok: true, ...(warning ? { warning } : {}) });
    } catch (err) {
      console.warn("[setup-api/stt/endpoint] could not remove the speech server:", err instanceof Error ? err.name : typeof err);
      return NextResponse.json({ error: "Could not remove the speech server on this box." }, { status: 500 });
    }
  });
}
