/**
 * /setup-api/prime-radiant/settings — every Prime Radiant setting in one place.
 *
 * GET → `{ settings, defaults, limits, nightly: { nextRunAt }, rates, opusSource }`: the
 * settings in force (the file's valid sections over the defaults — ingest
 * exclude list, parallelism and nightly folders; cost-rate overrides; the
 * nightly schedule; the Opus tier; the contradiction pass; domains and their
 * owners), the defaults, the cost rates they price with, and which account
 * the second opinion would use tonight (`opusSource`: `api_key`,
 * `subscription` or `none` — a read of the account pool and the `claude`
 * sign-in, never a model call). Never creates anything.
 *
 * PUT — a patch: only the sections and fields named change, each validated
 * strictly; a bad field refuses the whole patch (400 `invalid`) and writes
 * nothing; `null` puts a field (or a whole section) back to its default. Ingest
 * folders follow the folder picker's rule (404 `folder_not_found`, 400
 * `folder_refused`, with `index`). The nightly timer is re-armed after a save.
 * The owner (cookie AND same origin), or the assistant through the MCP bearer
 * — whose tool asks for the owner's word first — except the cost rates and
 * the Opus model, which decide what the Opus cap measures (403 `owner_only`
 * for the bearer). Never another site.
 */
import { requireSession } from "@/lib/route-auth";
import { resolveFolderInsideBrowseRoot } from "@/lib/browse-folder";
import { isOwnOutput } from "@/lib/prime-radiant/ingest-sources";
import { nextRunAtMs, refresh } from "@/lib/prime-radiant/nightly-scheduler";
import { detectOpusSource } from "@/lib/prime-radiant/opus-source";
import { fail, json, readJsonBody, writerGuard } from "@/lib/prime-radiant/route-helpers";
import {
  defaultSettings,
  effectiveCostRates,
  MAX_DOMAINS,
  MAX_INGEST_FOLDERS,
  MAX_INGEST_PARALLEL,
  MAX_OPUS_CAP_USD,
  MAX_OPUS_MAX_PAGES,
  MIN_INGEST_PARALLEL,
  MIN_OPUS_CAP_USD,
  MIN_OPUS_MAX_PAGES,
  readSettings,
  readSettingsPatch,
  SettingsError,
  writeSettings,
} from "@/lib/prime-radiant/settings";

export const dynamic = "force-dynamic";

const LIMITS = {
  ingestParallel: { min: MIN_INGEST_PARALLEL, max: MAX_INGEST_PARALLEL },
  ingestFolders: MAX_INGEST_FOLDERS,
  opusCapUsd: { min: MIN_OPUS_CAP_USD, max: MAX_OPUS_CAP_USD },
  opusSampleRate: { min: 0, max: 1 },
  opusMaxPages: { min: MIN_OPUS_MAX_PAGES, max: MAX_OPUS_MAX_PAGES },
  domains: MAX_DOMAINS,
};

const OPUS_SOURCE_BUDGET_MS = 3_000;

async function answer() {
  // Bounded: a pool or PATH read that stalls must not hold the page (or a save that already landed).
  const opusSource = await Promise.race([
    detectOpusSource().then((d) => d.source),
    new Promise<"none">((resolve) => setTimeout(() => resolve("none"), OPUS_SOURCE_BUDGET_MS).unref?.()),
  ]).catch(() => "none" as const);
  return { settings: readSettings(), defaults: defaultSettings(), limits: LIMITS, nightly: { nextRunAt: nextRunAtMs() }, rates: effectiveCostRates(), opusSource };
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  return json(await answer());
}

export async function PUT(req: Request) {
  const gate = await writerGuard(req, "Changing Prime Radiant's settings");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  let patch;
  try {
    patch = readSettingsPatch(read.body);
  } catch (err) {
    return fail("invalid", err instanceof SettingsError ? err.message : "The settings could not be read.", 400);
  }
  // What the Opus dollar cap is MEASURED in stays the owner's: a rate of 0, or
  // a model with no rate, prices every call at nothing and the cap never trips.
  if (!gate.writer.person && (patch.costRates !== undefined || (patch.opus && patch.opus.model !== undefined))) {
    return fail("owner_only", "Only the owner can change the cost rates or the Opus model: they are what the spending cap measures.", 403);
  }
  const folders = patch.ingest?.folders;
  if (Array.isArray(folders)) {
    if (folders.length > MAX_INGEST_FOLDERS) return fail("invalid", `Choose at most ${MAX_INGEST_FOLDERS} folders.`, 400);
    const resolved: string[] = [];
    for (const [index, asked] of folders.entries()) {
      const r = await resolveFolderInsideBrowseRoot(asked);
      if (!r.ok) return json({ error: r.status === 400 ? "That is not a folder." : "Folder not found.", code: "folder_not_found", index }, r.status);
      if (isOwnOutput(r.dir)) return json({ error: "That folder holds ClawBox's own files.", code: "folder_refused", index }, 400);
      if (!resolved.includes(r.dir)) resolved.push(r.dir);
    }
    patch = { ...patch, ingest: { ...patch.ingest, folders: resolved } };
  }
  try {
    writeSettings(patch);
  } catch (err) {
    if (err instanceof SettingsError) return fail("invalid", err.message, 400);
    console.error("[prime-radiant] settings:", err instanceof Error ? err.message : err);
    return fail("write_failed", "The settings could not be saved.", 500);
  }
  await refresh().catch(() => undefined);
  return json(await answer());
}
