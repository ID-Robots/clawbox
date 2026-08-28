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

/** One file per run is plenty of history; a run writing hundreds is misbehaving. */
const MAX_ARTIFACTS = 50;
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
const TEXT_EXTENSIONS = new Set([".txt", ".log", ".md", ".json", ".html", ".css", ".js", ".ts", ".csv", ".xml", ".yaml", ".yml"]);

export type ArtifactKind = "image" | "text" | "other";

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
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "other";
}

/** Create the folder a run writes its evidence into. */
export function ensureArtifactsDir(runId: string): string {
  const dir = artifactsDir(runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The run's artifacts, oldest first (the order they were produced), capped at
 * MAX_ARTIFACTS. Missing folder — most runs never save anything — is [].
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
  return out.slice(0, MAX_ARTIFACTS);
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
