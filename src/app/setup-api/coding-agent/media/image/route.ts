import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { ClawaiImageError, generateClawaiImageBytes } from "@/lib/harness/clawai-images";
import { GenerationSlotBusy, withGenerationSlot } from "@/lib/webapp-icon";
import {
  mediaError,
  releaseMediaTarget,
  resolveMediaTarget,
  writeMediaFile,
  type MediaErrorCode,
} from "@/lib/coding-agent-media";

export const dynamic = "force-dynamic";

/**
 * POST { path, prompt, size? } → a PNG written into the active coding run's
 * folder, so a run can put a real picture in the project it is building.
 *
 * A run's model cannot draw and has no credential of its own; the box has
 * both, and already spends them on a web app's desktop icon
 * (src/lib/webapp-icon.ts). This is the same generator with the same slot,
 * pointed at the run's own folder instead of data/icons.
 *
 * WHERE it may write is decided by src/lib/coding-agent-media.ts and nowhere
 * else — the MCP tool's own check is a courtesy for a mistyped path, and the
 * bearer it holds is the same one a prompt-injected run holds.
 *
 * ALWAYS a PNG. The proxy may answer jpg or webp, so the bytes go through
 * sharp on the way out: a file called .png that is not one would be served
 * under a lying Content-Type by every reader that trusts the extension, and
 * that includes the app's own artifacts route.
 */

/** The longest prompt a run may send. Room for a described scene, not a novel. */
const MAX_PROMPT_CHARS = 2_000;

/** What the caller may ask for, and the pixels each means. The proxy draws 1024. */
const SIZES: Record<string, number> = { "1024": 1024, "512": 512, "256": 256 };

/**
 * One picture being drawn plus this many waiting; anything past that is told
 * to come back later.
 *
 * The MCP client gives a call 180 s (IMAGE_CALL_TIMEOUT_MS) and the upstream
 * budget for ONE picture is 120 s, so a third caller could not be served
 * inside its own deadline anyway — queueing it would only keep a connection
 * and a promise alive on an 8 GB box for an answer nobody is still waiting for.
 */
const MAX_WAITING_PICTURES = 2;

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return mediaError("Invalid request body", "bad_request", 400);
  }
  // A literal `null` body parses cleanly, so the catch never runs and reading
  // `.prompt` off it threw where this route had already promised a 400 — the
  // one answer a model can act on. Same for an array or a bare number.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return mediaError("Invalid request body", "bad_request", 400);
  }
  const body = parsed as { path?: unknown; prompt?: unknown; size?: unknown; overwrite?: unknown };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
  if (!prompt) return mediaError("Say what the picture should show.", "bad_request", 400);
  // `in` would also answer for what every object inherits, so a caller naming
  // "constructor" got a FUNCTION where the pixel count belongs — which sharp
  // then refused, leaving the picture at whatever size the proxy drew.
  const size = typeof body.size === "string" && Object.hasOwn(SIZES, body.size) ? SIZES[body.size] : SIZES["1024"];

  const resolved = await resolveMediaTarget({
    path: body.path,
    extension: ".png",
    kind: "images",
    overwrite: body.overwrite === true,
  });
  if (!resolved.ok) return resolved.response;
  const { target } = resolved;

  let kept = false;
  try {
    let picture: { bytes: Buffer; size: number | null };
    try {
      // The SAME slot the icon pipeline uses: pictures for a run, for a chat and
      // for an app's icon all come out of one per-UTC-day allowance, so N asks
      // at once must open one upstream request rather than N. Bounded here and
      // not in the icon pipeline, because this caller is a REQUEST: a queue
      // that only drains at 120 s an entry would hold open connections and
      // pending promises on the box long after the run gave up waiting.
      const generated = await withGenerationSlot(
        () => generateClawaiImageBytes(prompt),
        { maxWaiting: MAX_WAITING_PICTURES },
      );
      picture = await asPng(generated.bytes, generated.extension, size);
    } catch (err) {
      if (err instanceof GenerationSlotBusy) {
        // 429 is what the MCP rules read as "carry on without", which is the
        // right answer: the box is drawing, not broken.
        return mediaError(
          "This ClawBox is already drawing as many pictures as it can queue. Try again later.",
          "busy",
          429,
        );
      }
      if (err instanceof ClawaiImageError) {
        // The image module already decided which status a customer should see
        // and wrote the sentence for it; the code is what the tool branches on.
        return mediaError(err.message, reasonFor(err.status), err.status);
      }
      console.warn("[coding-agent/media/image] failed:", err instanceof Error ? err.message : err);
      return mediaError("The picture could not be generated.", "write_failed", 502);
    }

    const written = await writeMediaFile(target, picture.bytes);
    if (!written.ok) return written.response;
    kept = true;
    return NextResponse.json(
      { path: target.file, bytes: picture.bytes.length, size: picture.size, used: written.used, cap: target.cap },
      { headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    // The slot was taken before a penny was spent, so every way out of here
    // that produced no file has to hand it back — otherwise a run that met a
    // refused upstream twenty times would have "used" its whole allowance
    // without a single picture to show for it.
    if (!kept) releaseMediaTarget(target);
  }
}

/**
 * The picture as a PNG, and the size it actually came out at.
 *
 * sharp is loaded lazily and its failure is not fatal, exactly as in
 * webapp-icon's shrinkIcon: a box whose native binding will not load still
 * gets the picture, at whatever size the proxy sent — and the caller is told
 * the byte count either way. What it must NOT do is answer the size that was
 * ASKED for over bytes nothing resized: the reply is what the run writes into
 * its report and lays its page out against. So a passthrough answers a null
 * size and the run is told nothing about pixels rather than something untrue.
 * A non-PNG that survives that path is refused rather than written under a
 * name that lies about it.
 */
async function asPng(
  bytes: Buffer,
  extension: string,
  size: number,
): Promise<{ bytes: Buffer; size: number | null }> {
  try {
    const { default: sharp } = await import("sharp");
    const converted = await sharp(bytes).resize(size, size, { fit: "cover" }).png({ compressionLevel: 9 }).toBuffer();
    return { bytes: converted, size };
  } catch {
    if (extension !== "png") {
      throw new ClawaiImageError(502, "ClawBox AI sent the picture in a format this box could not convert.");
    }
    return { bytes, size: null };
  }
}

/** A stable code beside the sentence the customer reads — see MediaErrorCode. */
function reasonFor(status: number): MediaErrorCode {
  if (status === 429) return "allowance";
  if (status === 503) return "not_linked";
  if (status === 504) return "timeout";
  return "upstream";
}
