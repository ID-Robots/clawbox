/**
 * Where a coding run's generated picture or clip is ALLOWED to land, and the
 * write that puts it there. SERVER ONLY.
 *
 * The two media routes hold the ClawBox AI credential and the box's voice, and
 * their only caller is a delegated run — which holds the MCP bearer, can read
 * data/.mcp-token with an unrestricted Bash, and may be acting on text it read
 * off a web page. So the fence here is the WHOLE boundary, exactly as it is for
 * /setup-api/vision/describe, and it is the same fence: the ACTIVE run's
 * working folder and its evidence folder, nothing else, ever.
 *
 * What is copied from that route, and why each part:
 *
 *   - TWO containment checks. The first on the path as TYPED, before anything
 *     touches the disk; the second on the real parent directory after symlinks
 *     are resolved, because a run can plant a link inside its own folder that
 *     leads out of it. A write has no file to realpath yet, so it is the
 *     PARENT that is resolved.
 *   - The extension is ours, never the caller's: the artifacts route and the
 *     desktop decide what a file IS from its extension, so a caller that could
 *     name `report.md` would decide what those readers serve.
 *   - isProtectedFilePath before the write, so a credential store is refused
 *     even in the impossible case that one is reachable from a run's folder.
 *   - The bytes go to a temp name in the same directory and are RENAMED into
 *     place, so a reader never sees half a picture; the temp name is removed
 *     whatever happens.
 *
 * The grant is TEMPORAL, like the browser route's file:// exception: while a
 * run is live, the bearer may write into that run's folders. With one run at a
 * time on a single-owner appliance those are the same thing.
 */
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { isProtectedFilePath } from "@/lib/file-guard";
import {
  activeRunMedia,
  MAX_AUDIO_PER_RUN,
  MAX_IMAGES_PER_RUN,
  noteRunMedia,
  releaseRunMedia,
  reserveRunMedia,
  type RunMedia,
} from "@/lib/coding-agent";
import { artifactsDir } from "@/lib/coding-agent-artifacts";

/** The longest path a caller may name. Matches the tools' own `path` cap. */
export const MAX_MEDIA_PATH_CHARS = 512;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Every refusal these routes have, as a stable code beside its English. */
export type MediaErrorCode =
  | "bad_request"
  | "no_run"
  | "switched_off"
  | "cap"
  | "outside"
  | "bad_extension"
  | "exists"
  // The bytes that came back are not the container the file name promises, so
  // nothing was written: a Hermes box speaks through its own harness, and the
  // next thing to open the file would trust the name over its contents.
  | "format"
  | "write_failed"
  // The box is already generating as much as it can queue at once. Not the
  // allowance and not a fault — the one refusal here worth asking about again.
  | "busy"
  // What the far side answered, when the refusal was not this box's. The MCP
  // rules branch on the HTTP status, but the code is what a person reading the
  // JSON needs, and "bad_request" over a 429 would be a lie in the one place
  // the run is told to stop asking.
  | "allowance"
  | "not_linked"
  | "timeout"
  | "upstream";

export function mediaError(error: string, code: MediaErrorCode, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, code, ...extra }, { status, headers: NO_STORE });
}

/** The run a media call belongs to, where it may write, and the slot it holds. */
export interface MediaTarget {
  runId: string;
  /** Which switch and which counter this call spends. */
  kind: keyof RunMedia;
  /** The absolute file the bytes will be written to. */
  file: string;
  /** How many of this kind the run has had, this call's own slot included. */
  used: number;
  /** The cap that applies to this kind. */
  cap: number;
}

interface MediaRequest {
  /** The path the caller asked for; absolute, or relative to the working folder. */
  path: unknown;
  /** ".png" or ".wav" — decided by the ROUTE, never by the caller. */
  extension: string;
  /** Which switch and which counter this call spends. */
  kind: keyof RunMedia;
  /** May an existing file be replaced? Off unless the caller says so. */
  overwrite?: boolean;
}

/**
 * Resolve where this call may write, or the refusal to answer with.
 *
 * Every gate in one place and in this order, because each one's message is
 * different and a caller that cannot tell them apart retries the wrong thing:
 * no run live (403), the owner's switch off (409), the per-run cap (409), a
 * path outside the fence (403), a name whose extension is not ours (400).
 *
 * A granted target HOLDS one of the run's slots. The caller either spends it
 * — writeMediaFile — or hands it back with releaseMediaTarget; there is no
 * third way out, because the slot is taken before the generator is called and
 * a failure that kept it would cost the run a picture it never got.
 */
export async function resolveMediaTarget(request: MediaRequest): Promise<
  { ok: true; target: MediaTarget } | { ok: false; response: NextResponse }
> {
  const run = activeRunMedia();
  if (!run) {
    return {
      ok: false,
      response: mediaError(
        "No coding run is active on this box, and this is a coding run's tool.",
        "no_run",
        403,
      ),
    };
  }
  if (!run.media[request.kind]) {
    return {
      ok: false,
      response: mediaError(
        request.kind === "images"
          ? "Generating pictures is switched off for coding runs in the Coding Agent settings."
          : "Generating audio is switched off for coding runs in the Coding Agent settings.",
        "switched_off",
        409,
      ),
    };
  }
  // The cheap read first, so a run that is plainly out of pictures is told so
  // before anything touches the disk. It is not the authority — the
  // reservation at the bottom is — but it carries the same numbers and saves
  // the path work.
  const cap = request.kind === "images" ? MAX_IMAGES_PER_RUN : MAX_AUDIO_PER_RUN;
  if (run.generated[request.kind] >= cap) {
    return { ok: false, response: capReached(request.kind, run.generated[request.kind], cap) };
  }

  const given = typeof request.path === "string" ? request.path.trim() : "";
  if (!given || given.length > MAX_MEDIA_PATH_CHARS || given.includes("\0")) {
    return { ok: false, response: mediaError("Pass a file path to write to.", "bad_request", 400) };
  }
  if (path.extname(given).toLowerCase() !== request.extension) {
    return {
      ok: false,
      response: mediaError(`The file name must end in ${request.extension}.`, "bad_extension", 400),
    };
  }

  const roots = await mediaRoots(run.id, run.directory);
  const resolved = path.resolve(run.directory, given);
  // The typed path, before anything touches the disk.
  if (!roots.some((root) => resolved.startsWith(root + path.sep))) {
    return { ok: false, response: outside() };
  }
  // The real parent, so a symlink planted in the run's own folder cannot lead
  // the write out of it. The FILE has no realpath yet — that is the point.
  let realParent: string;
  try {
    realParent = await fs.realpath(path.dirname(resolved));
  } catch {
    return {
      ok: false,
      response: mediaError("There is no folder at that path to write into.", "bad_request", 400),
    };
  }
  const file = path.join(realParent, path.basename(resolved));
  if (!roots.some((root) => file === root || file.startsWith(root + path.sep))) {
    return { ok: false, response: outside() };
  }
  if (isProtectedFilePath(file)) return { ok: false, response: outside() };
  if (!request.overwrite && (await exists(file))) {
    return {
      ok: false,
      response: mediaError("There is already a file with that name; pick another.", "exists", 409),
    };
  }

  // Last, and only once everything else has passed: the slot is spent from
  // here on, and a refusal after it was taken would have to give it back.
  const slot = reserveRunMedia(run.id, request.kind);
  if (!slot.ok) {
    return {
      ok: false,
      response: slot.reason === "cap"
        ? capReached(request.kind, slot.used, slot.cap)
        : mediaError(
          "The coding run this call belongs to has finished.",
          "no_run",
          403,
        ),
    };
  }
  return { ok: true, target: { runId: run.id, kind: request.kind, file, used: slot.used, cap: slot.cap } };
}

/** Give a granted target's slot back. Idempotent per target: call it once,
 *  from the one place that knows nothing was written. */
export function releaseMediaTarget(target: MediaTarget): void {
  releaseRunMedia(target.runId, target.kind);
}

function capReached(kind: keyof RunMedia, used: number, cap: number): NextResponse {
  return mediaError(
    `This run has already had its ${cap} ${kind === "images" ? "pictures" : "clips"}.`,
    "cap",
    409,
    { used, cap },
  );
}

function outside(): NextResponse {
  return mediaError(
    "That path is outside the active coding run's working and evidence folders.",
    "outside",
    403,
  );
}

/**
 * The two folders a run may write into, realpath'd — a root that does not
 * exist grants nothing, and a symlinked root grants exactly what it points at.
 */
async function mediaRoots(runId: string, directory: string): Promise<string[]> {
  const roots: string[] = [];
  for (const root of [directory, artifactsDir(runId)]) {
    try {
      roots.push(await fs.realpath(root));
    } catch {
      // not there yet — grants nothing
    }
  }
  return roots;
}

/**
 * Put the bytes at `target.file` through a temp name in the same directory.
 *
 * `rename` so a reader — the run's own page, the artifacts listing — sees
 * either nothing or the whole file, never a partial picture. The temp name is
 * dot-prefixed because ARTIFACT_NAME_RE excludes dotfiles: a listing that
 * raced this write inside the evidence folder must not show the scratch file.
 *
 * Records the file against the run on success, and answers how many of this
 * kind the run has had — the count the slot was taken at, not a fresh read,
 * because a run that settled while the voice was speaking no longer counts
 * anything and the caller still deserves the number it spent.
 */
export async function writeMediaFile(
  target: MediaTarget,
  bytes: Buffer,
): Promise<{ ok: true; used: number } | { ok: false; response: NextResponse }> {
  const tmp = path.join(path.dirname(target.file), `.${path.basename(target.file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, bytes, { mode: 0o644 });
    await fs.rename(tmp, target.file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    console.warn("[coding-agent-media] write failed:", err instanceof Error ? err.message : err);
    return { ok: false, response: mediaError("The file could not be written.", "write_failed", 500) };
  }
  noteRunMedia(target.runId, target.file);
  return { ok: true, used: target.used };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
