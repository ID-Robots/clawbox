import { NextResponse } from "next/server";
import crypto from "crypto";
import fsp from "fs/promises";
import path from "@/lib/runtime-path";
import { requireSession } from "@/lib/route-auth";
import { logSafe } from "@/lib/log-safe";
import { get as configGet } from "@/lib/config-store";
import { clawboxAiProxyUrl } from "@/lib/clawbox-ai-vision";
import { readClawaiEntitlementTier } from "@/lib/clawai-plan-tier";
import { clawaiMusicArmable, readClawaiMediaFlags } from "@/lib/clawai-media-flags";
import { clawaiCredentialRefusalOnRecord } from "@/lib/clawai-credential-refusal";
import { CLAWBOX_AI_MUSIC_WEEKLY_TRACKS } from "@/lib/clawbox-ai-models";
import { ClawaiMediaError, generateClawaiMusic, type ClawaiMediaFailure } from "@/lib/clawai-media";
import { chatGeneratedMusicDir, GENERATED_MUSIC_RETENTION, pruneMediaDir } from "@/lib/harness/media-root";

export const dynamic = "force-dynamic";

/**
 * ClawBox AI music, for the harness that has no music tool of its own.
 *
 * On OpenClaw the box's music comes through the harness: `music_generate`,
 * armed by the configure route and the boot migration on the bundled `fal`
 * provider. Hermes has no music tool at all, so the MCP `music_generate` tool
 * (mcp/tools/ai.ts) asks HERE, and this route makes the track through the same
 * shared media route on the proxy (src/lib/clawai-media.ts) and writes it into
 * the chat's own media tree, where the chat's player can reach it.
 *
 * GET  → { available, reason? } — the MCP server's startup probe, so the tool
 *        exists only on a box that can use it (a tool that could only refuse is
 *        a refusal a small model argues with).
 * POST { prompt, lyrics?, instrumental? } → { path, mime, bytes, weeklyTracks }
 *
 * The gate is the configure route's: the `music` media flag, a linked box whose
 * credential the proxy has not refused, and the Max plan (plan, or the badge
 * while the plan is unknown). The weekly cap itself is the proxy's to enforce;
 * a spent one comes back as a 429 the caller can say in a sentence.
 */

/** Longest prompt accepted, in characters. */
const MAX_PROMPT_CHARS = 2_000;
/** Longest lyrics accepted, in characters. */
const MAX_LYRICS_CHARS = 3_000;

type MusicUnavailable = "flag_off" | "not_linked" | "refused" | "not_max";

/** Why music is off, in the customer's terms — the MCP tool says this as it stands. */
const UNAVAILABLE_TEXT: Record<MusicUnavailable, string> = {
  flag_off: "Music generation is not switched on for this ClawBox yet.",
  not_linked: "This ClawBox is not linked to ClawBox AI, so it cannot make music.",
  refused: "ClawBox AI has refused this box's credential; the owner re-links it in Settings → Providers.",
  not_max: "Music generation is part of the ClawBox AI Max plan.",
};

async function musicAvailability(): Promise<
  { available: true; token: string } | { available: false; reason: MusicUnavailable }
> {
  const flags = await readClawaiMediaFlags();
  if (!flags.has("music")) return { available: false, reason: "flag_off" };
  const token = await configGet("clawai_token").catch(() => undefined);
  if (typeof token !== "string" || !token.trim()) return { available: false, reason: "not_linked" };
  if (await clawaiCredentialRefusalOnRecord().catch(() => false)) return { available: false, reason: "refused" };
  const tier = await readClawaiEntitlementTier().catch(() => null);
  if (!clawaiMusicArmable(flags, tier)) return { available: false, reason: "not_max" };
  return { available: true, token: token.trim() };
}

/** Each failure's status, so the MCP tool can turn it into a next step. */
const FAILURE_STATUS: Record<ClawaiMediaFailure, number> = {
  limit: 429,
  refused: 403,
  not_served: 503,
  failed: 502,
  timeout: 504,
};

/**
 * One track at a time per box. A track is tens of seconds of the proxy's time
 * and a tenth of a week's allowance; two at once is never what anyone meant,
 * and the second caller is told the box is busy rather than queued behind it.
 */
let generating = false;

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const availability = await musicAvailability();
  return NextResponse.json(
    availability.available
      ? { available: true, weeklyTracks: CLAWBOX_AI_MUSIC_WEEKLY_TRACKS }
      : { available: false, reason: availability.reason, error: UNAVAILABLE_TEXT[availability.reason] },
  );
}

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { prompt?: unknown; lyrics?: unknown; instrumental?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "Say what the track should sound like." }, { status: 400 });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json({ error: `The description is too long: at most ${MAX_PROMPT_CHARS} characters.` }, { status: 400 });
  }
  if (body.lyrics !== undefined && typeof body.lyrics !== "string") {
    return NextResponse.json({ error: "Lyrics must be text." }, { status: 400 });
  }
  const lyrics = typeof body.lyrics === "string" ? body.lyrics.trim() : "";
  if (lyrics.length > MAX_LYRICS_CHARS) {
    return NextResponse.json({ error: `The lyrics are too long: at most ${MAX_LYRICS_CHARS} characters.` }, { status: 400 });
  }
  if (body.instrumental !== undefined && typeof body.instrumental !== "boolean") {
    return NextResponse.json({ error: "instrumental must be true or false." }, { status: 400 });
  }
  const instrumental = typeof body.instrumental === "boolean" ? body.instrumental : undefined;

  const availability = await musicAvailability();
  if (!availability.available) {
    return NextResponse.json(
      { error: UNAVAILABLE_TEXT[availability.reason], reason: availability.reason },
      { status: 409 },
    );
  }
  if (generating) {
    return NextResponse.json(
      { error: "This ClawBox is already making a track. Nothing was charged for this request.", code: "busy" },
      { status: 429 },
    );
  }

  generating = true;
  try {
    const track = await generateClawaiMusic({
      proxyUrl: clawboxAiProxyUrl(),
      token: availability.token,
      prompt,
      ...(lyrics ? { lyrics } : {}),
      ...(instrumental !== undefined ? { instrumental } : {}),
    });
    const dir = await chatGeneratedMusicDir();
    await fsp.mkdir(dir, { recursive: true });
    // Swept BEFORE the write, so the track just made is never the one trimmed.
    await pruneMediaDir(await fsp.realpath(dir), GENERATED_MUSIC_RETENTION);
    const name = `track-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${track.extension}`;
    const target = path.join(dir, name);
    // `wx`: a name that somehow exists is never overwritten.
    await fsp.writeFile(target, track.bytes, { flag: "wx" });
    return NextResponse.json({
      path: target,
      mime: track.mime,
      bytes: track.bytes.length,
      weeklyTracks: CLAWBOX_AI_MUSIC_WEEKLY_TRACKS,
    });
  } catch (err) {
    if (err instanceof ClawaiMediaError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.failure === "limit" ? "music_limit" : err.failure,
          ...(err.resetAt ? { resetAt: err.resetAt } : {}),
        },
        { status: FAILURE_STATUS[err.failure] },
      );
    }
    console.warn("[music] could not save the track:", err instanceof Error ? logSafe(err.message) : err);
    return NextResponse.json({ error: "The track was made but could not be saved on this box.", code: "failed" }, { status: 500 });
  } finally {
    generating = false;
  }
}
