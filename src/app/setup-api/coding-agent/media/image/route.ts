import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { ClawaiImageError, generateClawaiImageBytes } from "@/lib/harness/clawai-images";
import { withGenerationSlot } from "@/lib/webapp-icon";
import { mediaError, resolveMediaTarget, writeMediaFile, type MediaErrorCode } from "@/lib/coding-agent-media";

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

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { path?: unknown; prompt?: unknown; size?: unknown; overwrite?: unknown };
  try {
    body = await request.json();
  } catch {
    return mediaError("Invalid request body", "bad_request", 400);
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
  if (!prompt) return mediaError("Say what the picture should show.", "bad_request", 400);
  const size = typeof body.size === "string" && body.size in SIZES ? SIZES[body.size] : SIZES["1024"];

  const resolved = await resolveMediaTarget({
    path: body.path,
    extension: ".png",
    kind: "images",
    overwrite: body.overwrite === true,
  });
  if (!resolved.ok) return resolved.response;
  const { target } = resolved;

  let bytes: Buffer;
  try {
    // The SAME slot the icon pipeline uses: pictures for a run, for a chat and
    // for an app's icon all come out of one per-UTC-day allowance, so N asks
    // at once must open one upstream request rather than N.
    const generated = await withGenerationSlot(() => generateClawaiImageBytes(prompt));
    bytes = await asPng(generated.bytes, generated.extension, size);
  } catch (err) {
    if (err instanceof ClawaiImageError) {
      // The image module already decided which status a customer should see
      // and wrote the sentence for it; the code is what the tool branches on.
      return mediaError(err.message, reasonFor(err.status), err.status);
    }
    console.warn("[coding-agent/media/image] failed:", err instanceof Error ? err.message : err);
    return mediaError("The picture could not be generated.", "write_failed", 502);
  }

  const written = await writeMediaFile(target, "images", bytes);
  if (!written.ok) return written.response;
  return NextResponse.json(
    { path: target.file, bytes: bytes.length, size, used: written.used, cap: target.cap },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The picture as a PNG of the size asked for.
 *
 * sharp is loaded lazily and its failure is not fatal, exactly as in
 * webapp-icon's shrinkIcon: a box whose native binding will not load still
 * gets the picture, at whatever size and format the proxy sent — and the
 * caller is told the byte count either way. A non-PNG that survives that path
 * is refused rather than written under a name that lies about it.
 */
async function asPng(bytes: Buffer, extension: string, size: number): Promise<Buffer> {
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(bytes).resize(size, size, { fit: "cover" }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    if (extension !== "png") {
      throw new ClawaiImageError(502, "ClawBox AI sent the picture in a format this box could not convert.");
    }
    return bytes;
  }
}

/** A stable code beside the sentence the customer reads — see MediaErrorCode. */
function reasonFor(status: number): MediaErrorCode {
  if (status === 429) return "allowance";
  if (status === 503) return "not_linked";
  if (status === 504) return "timeout";
  return "upstream";
}
