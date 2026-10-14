/**
 * /setup-api/prime-radiant/settings — every Prime Radiant setting in one place.
 *
 * GET → `{ settings, defaults, limits, nightly: { nextRunAt }, rates }`: the
 * settings in force (the file's valid sections over the defaults — ingest
 * exclude list, parallelism and nightly folders; cost-rate overrides; the
 * nightly schedule; the Opus tier; the contradiction pass; domains and their
 * owners), the defaults, and the cost rates they price with. Never creates
 * anything.
 *
 * PUT — a patch: only the sections and fields named change, each validated
 * strictly; a bad field refuses the whole patch (400 `invalid`) and writes
 * nothing; `null` puts a field (or a whole section) back to its default. Ingest
 * folders follow the folder picker's rule (404 `folder_not_found`, 400
 * `folder_refused`, with `index`). The nightly timer is re-armed after a save.
 * OWNER ONLY, cookie AND same origin.
 */
import { requireSession } from "@/lib/route-auth";
import { resolveFolderInsideBrowseRoot } from "@/lib/browse-folder";
import { isOwnOutput } from "@/lib/prime-radiant/ingest-sources";
import { nextRunAtMs, refresh } from "@/lib/prime-radiant/nightly-scheduler";
import { fail, json, ownerWriteGuard, readJsonBody } from "@/lib/prime-radiant/route-helpers";
import {
  defaultSettings,
  effectiveCostRates,
  MAX_DOMAINS,
  MAX_INGEST_FOLDERS,
  MAX_INGEST_PARALLEL,
  MAX_OPUS_CAP_USD,
  MIN_INGEST_PARALLEL,
  MIN_OPUS_CAP_USD,
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
  domains: MAX_DOMAINS,
};

function answer() {
  return { settings: readSettings(), defaults: defaultSettings(), limits: LIMITS, nightly: { nextRunAt: nextRunAtMs() }, rates: effectiveCostRates() };
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  return json(answer());
}

export async function PUT(req: Request) {
  const denied = await ownerWriteGuard(req, "Changing Prime Radiant's settings");
  if (denied) return denied;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  let patch;
  try {
    patch = readSettingsPatch(read.body);
  } catch (err) {
    return fail("invalid", err instanceof SettingsError ? err.message : "The settings could not be read.", 400);
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
  return json(answer());
}
