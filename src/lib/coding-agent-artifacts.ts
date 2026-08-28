/**
 * The evidence a coding-agent run leaves behind — screenshots it took, test
 * output it saved — lives in data/coding-agent-artifacts/<runId>/, one folder
 * per run, written by the run itself (the folder is on the run's PATH of
 * allowed places via DATA_DIR_PUBLIC_SUBTREES) and by the browser MCP layer
 * when it saves a screenshot on the run's behalf.
 *
 * Nothing here is persisted in the run record: like transcriptPath, the
 * listing is derived from disk at read time by the runs route, so a web-server
 * restart cannot lose or corrupt it. When a run record is dropped (history
 * trim, owner clear), its folder goes with it — an artifact whose run no
 * longer exists is unreachable and would sit on the flash forever.
 *
 * Sync fs on purpose, matching the runs store: these are small directories
 * (listing caps at MAX_ARTIFACTS entries) read on an owner-facing route.
 */
import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { CODING_AGENT_ARTIFACTS_SUBTREE } from "@/lib/file-guard";

/**
 * The one definition of what a run id looks like. coding-agent.ts re-exports
 * it as RUN_ID_RE — it lives in this leaf so file-guard-adjacent modules can
 * validate ids without importing the whole runner.
 */
export const ARTIFACT_RUN_ID_RE = /^run-[a-z0-9]{8}$/;

/** Fifty files per run is plenty of history; a run writing hundreds is misbehaving. */
export const MAX_ARTIFACTS = 50;
const MAX_NAME_CHARS = 100;

/** Filenames a run may create and the route may serve: no dotfiles, no separators. */
export const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;

/**
 * The image types the artifacts route serves inline, ext → MIME. Everything
 * else is served text/plain — agent-written HTML must never execute in the
 * app's origin. IMAGE_EXTENSIONS derives from these keys so "renders as a
 * thumbnail" and "serves as an image" cannot drift apart.
 */
export const INLINE_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_EXTENSIONS = new Set(Object.keys(INLINE_IMAGE_MIME));
const TEXT_EXTENSIONS = new Set([".txt", ".log", ".json", ".html", ".css", ".js", ".ts", ".csv", ".xml", ".yaml", ".yml"]);
/**
 * Markdown is its own kind so the app can open it RENDERED — through the
 * chat's own markdown renderer, which draws model output as React elements
 * and never injects HTML — instead of as the plain text every other file is.
 * It is still SERVED as text/plain: the kind changes how the app draws the
 * bytes, never what the route says they are.
 */
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export type ArtifactKind = "image" | "markdown" | "text" | "other";

/**
 * The run's own account of what it did, kept next to its screenshots.
 *
 * The final message of a run is markdown — "## What I built", a table of
 * files — and lived only in the run record, where a history trim took it with
 * the run. As a file in the evidence folder it is one more artifact: listed,
 * served and opened like a screenshot, and copied out with the folder.
 */
export const REPORT_FILE = "report.md";

export interface RunArtifact {
  name: string;
  bytes: number;
  modifiedAt: number;
  kind: ArtifactKind;
}

export function artifactsRoot(): string {
  return path.join(DATA_DIR, CODING_AGENT_ARTIFACTS_SUBTREE);
}

/** The MIME type an artifact may be served inline with, or null → text/plain. */
export function artifactMimeType(name: string): string | null {
  return INLINE_IMAGE_MIME[path.extname(name).toLowerCase()] ?? null;
}

/** The run's evidence folder. Throws on a malformed id — callers validate first. */
export function artifactsDir(runId: string): string {
  if (!ARTIFACT_RUN_ID_RE.test(runId)) throw new Error(`not a run id: ${runId}`);
  return path.join(artifactsRoot(), runId);
}

export function artifactKind(name: string): ArtifactKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "other";
}

/**
 * Save a settled run's summary as REPORT_FILE in its evidence folder.
 *
 * Only when no report is there yet: a run that chose to write its own
 * report.md knows more about its work than the closing message does, so the
 * agent's file wins and this is a no-op. Written to a
 * dotfile first and renamed into place, so a listing that races the write
 * sees either nothing (dotfiles are never listed) or the whole file. The
 * file's 0644 matches the screenshots beside it; what keeps the evidence to
 * the box's own user is the folder's 0700 (ensureArtifactsDir), not the file.
 *
 * Answers whether a file was written. Never throws: the report is a
 * convenience on top of a run that has already finished, and no failure to
 * save it may change what the run record says about that run.
 */
export function writeRunReport(runId: string, markdown: string): boolean {
  if (!ARTIFACT_RUN_ID_RE.test(runId)) return false;
  const body = markdown.trim();
  if (!body) return false;
  try {
    const dir = artifactsDir(runId);
    const target = path.join(dir, REPORT_FILE);
    if (fs.existsSync(target)) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${REPORT_FILE}.tmp`);
    fs.writeFileSync(tmp, `${body}\n`, { mode: 0o644 });
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.warn(`[coding-agent] could not save ${REPORT_FILE} for ${runId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Create the folder a run writes its evidence into.
 *
 * The folder's mode is decided HERE and nowhere else: 0700, the box's own
 * user, because a run's screenshots can show whatever page it opened. The
 * runner calls this before a run starts; the browser MCP layer
 * (mcp/tools/browser.ts, which cannot import this module) mkdirs lazily with
 * the same mode as its fallback. mkdir never changes the mode of a folder
 * that exists, so whichever writer runs first decides — they must agree.
 */
export function ensureArtifactsDir(runId: string): string {
  const dir = artifactsDir(runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The run's artifacts, oldest first (the order they were produced). Past
 * MAX_ARTIFACTS the NEWEST survive: the last screenshots and the report.md
 * written at settle are what the owner needs to see, and a run that archived
 * hundreds loses its first ones from the list, never from disk. Missing
 * folder — most runs never save anything — is [].
 */
export function listArtifacts(runId: string): RunArtifact[] {
  let dir: string;
  let names: string[];
  try {
    dir = artifactsDir(runId);
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: RunArtifact[] = [];
  for (const name of names) {
    if (name.length > MAX_NAME_CHARS || !ARTIFACT_NAME_RE.test(name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({ name, bytes: stat.size, modifiedAt: stat.mtimeMs, kind: artifactKind(name) });
  }
  out.sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name));
  return out.slice(-MAX_ARTIFACTS);
}

/**
 * Resolve one artifact to its absolute path, or null when the name is
 * malformed, escapes the folder, or is not a regular file. The name check
 * alone forbids traversal (no separators, no leading dot); the realpath
 * containment check backs it up against symlinks a run might have planted.
 */
export function artifactFilePath(runId: string, name: string): string | null {
  if (!ARTIFACT_RUN_ID_RE.test(runId)) return null;
  if (name.length > MAX_NAME_CHARS || !ARTIFACT_NAME_RE.test(name)) return null;
  const dir = artifactsDir(runId);
  const abs = path.join(dir, name);
  try {
    const real = fs.realpathSync(abs);
    const realDir = fs.realpathSync(dir);
    if (real !== path.join(realDir, name)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** Delete a dropped run's folder. Never throws — cleanup must not break its caller. */
export function removeArtifacts(runId: string): void {
  if (!ARTIFACT_RUN_ID_RE.test(runId)) return;
  try {
    fs.rmSync(artifactsDir(runId), { recursive: true, force: true });
  } catch (err) {
    console.error(`[coding-agent] could not remove artifacts of ${runId}:`, err instanceof Error ? err.message : err);
  }
}
