/**
 * "What's new" for the version an update is installing (TASK-1205) — the
 * server half: which version that is, and the Highlights in its notes.
 *
 * SERVER ONLY: it reads git, the checkout, `data/` and GitHub. The wire shape
 * and the panel's fallbacks are in `@/lib/update-whats-new`, which the update
 * screen imports; the Markdown rules are in `@/lib/release-highlights`.
 *
 * NEVER IN THE UPDATE'S WAY. Nothing here is awaited by the updater: the
 * update route fires `prefetchUpdateWhatsNew` and answers without it, and the
 * screen asks `GET /setup-api/update/whats-new` on its own. Every read is
 * bounded — git by `GIT_READ_TIMEOUT_MS`, GitHub by `GITHUB_TIMEOUT_MS` — and
 * none of them WRITES to the repository: while an update runs, root is
 * fetching and resetting that same checkout, and a second `git fetch` from the
 * web server could take a ref lock out from under it. `git show` of a ref the
 * updater's own fetches keep current needs no lock and no network.
 *
 * WHICH VERSION. The updater hard-syncs the checkout to the head of the
 * branch it follows (`resolveUpdateBranch`: `origin/main`, `origin/beta`, a QA
 * pin), whatever tag the Update card named. So "the version being installed"
 * is that ref's package.json, and its notes are that ref's
 * `RELEASE-NOTES-<version>.md` — what the updater already knows, with no
 * network at all. Only when the ref carries no notes file does this ask GitHub
 * for the release body of `v<version>`, which is the same Markdown.
 *
 * SURVIVES THE RESTART. The rebuild stops this server for minutes and the
 * closing reboot restarts the gateway, so an answer read from notes is kept in
 * `data/update-whats-new.json`, keyed by the version it describes. The screen
 * keeps what it was given in memory across the outage; the file is for the
 * server that comes back (a reload, a second device) and for a moment when git
 * cannot be read at all.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from "fs/promises";
import path from "@/lib/runtime-path";
import { resolveConfigRoot } from "@/lib/config-store";
import { isSafeBranch } from "@/lib/update-branch";
import { getUpdateState, resolveUpdateBranch } from "@/lib/updater";
import { parseReleaseHighlights, type ReleaseHighlight } from "@/lib/release-highlights";
import {
  CLAWBOX_REPO,
  normalizeVersion,
  releasePageUrl,
  unknownUpdateWhatsNew,
  type UpdateWhatsNew,
} from "@/lib/update-whats-new";

const execFileAsync = promisify(execFile);

/** A `git show` of one small file. The index is local; anything slower is a box in trouble. */
export const GIT_READ_TIMEOUT_MS = 5_000;
/** GitHub, best effort: a box mid-update on a slow link waits no longer than this for a panel. */
export const GITHUB_TIMEOUT_MS = 5_000;
/** After GitHub had nothing for a version, it is not asked again for this long. */
export const GITHUB_MISS_RETRY_MS = 60_000;
/**
 * How long a cached answer stands in for a target nobody can read. An update
 * takes well under an hour; a day-old answer belongs to another update.
 */
export const CACHE_FALLBACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** The 4.0 notes are 30 KB; anything past this is not release notes. */
const MAX_NOTES_BYTES = 512 * 1024;
/** A release's JSON is its body plus a few KB of metadata. */
const MAX_RELEASE_JSON_BYTES = 1024 * 1024;

/** The updater's own first step, which syncs the checkout to the target. */
const SYNC_STEP_ID = "bootstrap_updater";

/** Where an answer read from notes is kept across the restart. */
export function updateWhatsNewCachePath(): string {
  return path.join(resolveConfigRoot(), "data", "update-whats-new.json");
}

/**
 * What this module reads, as functions, so a test can hand in each one. The
 * defaults below are the real box.
 */
export interface UpdateWhatsNewSources {
  /** The ref the updater syncs to, as `origin/<branch>`, or null. */
  upstream(): Promise<string | null>;
  /** A file's text at a git ref, or null. */
  gitShow(ref: string, file: string): Promise<string | null>;
  /** A file's text in the checkout as it is on disk, or null. */
  readCheckout(file: string): Promise<string | null>;
  /** Has THIS update already synced the checkout to its target? */
  checkoutSynced(): boolean;
  /** The GitHub release body for a tag (`v4.1.0`), or null. */
  releaseBody(tag: string): Promise<string | null>;
  now(): number;
}

async function gitShow(ref: string, file: string): Promise<string | null> {
  const root = resolveConfigRoot();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", `safe.directory=${root}`, "-C", root, "show", `${ref}:${file}`],
      { timeout: GIT_READ_TIMEOUT_MS, maxBuffer: MAX_NOTES_BYTES, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    return String(stdout ?? "");
  } catch {
    return null;
  }
}

/**
 * Read through ONE open handle — the size is checked on the handle, never on a
 * separate stat the updater's reset could swap the file under — and never past
 * the cap, however the file grows while it is read.
 */
async function readCheckout(file: string): Promise<string | null> {
  const target = path.join(resolveConfigRoot(), file);
  let handle: FileHandle | null = null;
  try {
    handle = await open(target, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_NOTES_BYTES) return null;
    const buffer = Buffer.alloc(MAX_NOTES_BYTES + 1);
    let got = 0;
    while (got < buffer.length) {
      const { bytesRead } = await handle.read(buffer, got, buffer.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > MAX_NOTES_BYTES) return null;
    return buffer.subarray(0, got).toString("utf-8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function upstream(): Promise<string | null> {
  try {
    return (await resolveUpdateBranch(resolveConfigRoot())).upstream;
  } catch {
    // A detached checkout the updater cannot place refuses the update with its
    // own sentence; this panel just has no branch to read.
    return null;
  }
}

function checkoutSynced(): boolean {
  const state = getUpdateState();
  return state.phase === "running"
    && state.steps.some((step) => step.id === SYNC_STEP_ID && step.status === "completed");
}

async function releaseBody(tag: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${CLAWBOX_REPO}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ClawBox-updater",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RELEASE_JSON_BYTES) return null;
    const text = await res.text();
    if (text.length > MAX_RELEASE_JSON_BYTES) return null;
    const body = (JSON.parse(text) as { body?: unknown }).body;
    return typeof body === "string" ? body : null;
  } catch {
    return null;
  }
}

export const DEFAULT_SOURCES: UpdateWhatsNewSources = {
  upstream,
  gitShow,
  readCheckout,
  checkoutSynced,
  releaseBody,
  now: () => Date.now(),
};

/** The `version` of a package.json's text, normalised, or null. */
function versionOf(packageJson: string | null): string | null {
  if (!packageJson) return null;
  try {
    return normalizeVersion((JSON.parse(packageJson) as { version?: unknown }).version);
  } catch {
    return null;
  }
}

/** `beta` for `origin/beta`; null for anything the updater would not sync to. */
function channelOf(ref: string | null): string | null {
  if (!ref?.startsWith("origin/")) return null;
  const branch = ref.slice("origin/".length);
  return isSafeBranch(branch) ? branch : null;
}

interface Target {
  version: string | null;
  channel: string | null;
  /** The ref to read notes from; null when git could not name one. */
  ref: string | null;
}

/**
 * The version the updater is installing (or would install), and where to read
 * its notes. The checkout's own package.json is used only once THIS update
 * has synced it — before that it is the version being REPLACED.
 */
async function resolveTarget(sources: UpdateWhatsNewSources): Promise<Target> {
  const upstreamRef = await sources.upstream().catch(() => null);
  const channel = channelOf(upstreamRef);
  const ref = channel ? upstreamRef : null;
  let version = ref ? versionOf(await sources.gitShow(ref, "package.json")) : null;
  if (!version && sources.checkoutSynced()) version = versionOf(await sources.readCheckout("package.json"));
  return { version, channel, ref };
}

interface CachedAnswer {
  version: string;
  channel: string | null;
  highlights: ReleaseHighlight[];
  savedAt: number;
}

function isCachedAnswer(value: unknown): value is CachedAnswer {
  if (typeof value !== "object" || value === null) return false;
  const cached = value as Partial<CachedAnswer>;
  return normalizeVersion(cached.version) !== null
    && (typeof cached.channel === "string" || cached.channel === null)
    && typeof cached.savedAt === "number"
    && Array.isArray(cached.highlights)
    && cached.highlights.length > 0
    && cached.highlights.every((h) => typeof h?.title === "string" && typeof h?.body === "string");
}

async function readCache(): Promise<CachedAnswer | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(updateWhatsNewCachePath(), "utf-8"));
    return isCachedAnswer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Best effort: a panel that cannot be cached is still a panel. */
async function writeCache(answer: CachedAnswer): Promise<void> {
  const file = updateWhatsNewCachePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(answer), { mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    console.warn(
      "[update-whats-new] could not cache the release highlights:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function fromCache(cached: CachedAnswer): UpdateWhatsNew {
  return {
    version: cached.version,
    channel: cached.channel,
    source: "notes",
    highlights: cached.highlights,
    releaseUrl: releasePageUrl(cached.version),
  };
}

/** The Highlights in the first of the target's notes that has any, best source first. */
async function readHighlights(
  target: Target & { version: string },
  sources: UpdateWhatsNewSources,
): Promise<ReleaseHighlight[]> {
  const file = `RELEASE-NOTES-${target.version}.md`;
  const local: Array<() => Promise<string | null>> = [
    () => (target.ref ? sources.gitShow(target.ref, file) : Promise.resolve(null)),
    () => sources.readCheckout(file),
  ];
  for (const read of local) {
    const highlights = parseReleaseHighlights(await read().catch(() => null));
    if (highlights.length) return highlights;
  }
  const missedAt = githubMisses.get(target.version);
  if (missedAt !== undefined && sources.now() - missedAt < GITHUB_MISS_RETRY_MS) return [];
  const highlights = parseReleaseHighlights(await sources.releaseBody(`v${target.version}`).catch(() => null));
  if (highlights.length) githubMisses.delete(target.version);
  else githubMisses.set(target.version, sources.now());
  return highlights;
}

/** Versions GitHub had nothing for, and when it last said so. */
const githubMisses = new Map<string, number>();

async function compute(sources: UpdateWhatsNewSources): Promise<UpdateWhatsNew> {
  const target = await resolveTarget(sources);
  const cached = await readCache();

  if (!target.version) {
    // Nothing names the target right now — git unreadable, mid-sync. An answer
    // this update already read still describes it; an old one does not.
    if (cached && sources.now() - cached.savedAt < CACHE_FALLBACK_MAX_AGE_MS) return fromCache(cached);
    return unknownUpdateWhatsNew(null, target.channel);
  }
  if (cached?.version === target.version) return fromCache({ ...cached, channel: target.channel ?? cached.channel });

  const highlights = await readHighlights({ ...target, version: target.version }, sources);
  if (!highlights.length) return unknownUpdateWhatsNew(target.version, target.channel);

  const answer: CachedAnswer = {
    version: target.version,
    channel: target.channel,
    highlights,
    savedAt: sources.now(),
  };
  await writeCache(answer);
  return fromCache(answer);
}

/** The read in flight, shared: the update route's prefetch and the screen's first ask usually overlap. */
let inflight: Promise<UpdateWhatsNew> | null = null;

/**
 * `GET /setup-api/update/whats-new`: the version being installed and the
 * Highlights of its notes, or `source: "none"` when they cannot be read.
 * Never throws.
 */
export function readUpdateWhatsNew(sources: UpdateWhatsNewSources = DEFAULT_SOURCES): Promise<UpdateWhatsNew> {
  if (sources !== DEFAULT_SOURCES) return compute(sources).catch(() => unknownUpdateWhatsNew());
  inflight ??= compute(sources)
    .catch((err: unknown) => {
      console.warn(
        "[update-whats-new] could not read the target release's highlights:",
        err instanceof Error ? err.message : String(err),
      );
      return unknownUpdateWhatsNew();
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Read and cache the target's highlights while the server that can read them
 * is still up — called, NOT awaited, the moment an update starts, so the
 * answer is on disk before the rebuild stops this server. Never rejects.
 */
export function prefetchUpdateWhatsNew(sources: UpdateWhatsNewSources = DEFAULT_SOURCES): Promise<void> {
  return readUpdateWhatsNew(sources).then(() => undefined, () => undefined);
}

/** Tests only: forget GitHub misses between cases. */
export function resetUpdateWhatsNewMemo(): void {
  githubMisses.clear();
  inflight = null;
}
