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
import path from "@/lib/runtime-path";
import { DATA_DIR } from "@/lib/config-store";
import { CODING_AGENT_ARTIFACTS_SUBTREE } from "@/lib/file-guard";

/**
 * The one definition of what a run id looks like. coding-agent.ts re-exports
 * it as RUN_ID_RE — it lives in this leaf so file-guard-adjacent modules can
 * validate ids without importing the whole runner.
 */
export const ARTIFACT_RUN_ID_RE = /^run-[a-z0-9]{8}$/;

/** The alphabet a run id's suffix is made of — the `[a-z0-9]` of the regex above. */
const RUN_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** `run-` + eight characters. */
const RUN_ID_PREFIX = "run-";
const RUN_ID_SUFFIX_CHARS = 8;

/**
 * Rebuild a run id out of the alphabet, or null.
 *
 * The same discipline `safeAppId` (webapp-icon.ts) and `safeTranscriptKey`
 * (harness/transcript-key.ts) apply, and for the same reason: a `.test()`
 * guard leaves the CALLER's string in play, so the value that goes on to be
 * joined into a path is still the one that arrived over the wire. Here the
 * characters are taken from the alphabet's own copy, so what reaches
 * `path.join` is made of those characters rather than merely having matched
 * them — no separator, no dot, nothing that could walk out of the root.
 */
export function safeRunId(runId: unknown): string | null {
  if (typeof runId !== "string") return null;
  if (runId.length !== RUN_ID_PREFIX.length + RUN_ID_SUFFIX_CHARS) return null;
  if (!runId.startsWith(RUN_ID_PREFIX)) return null;
  let safe = RUN_ID_PREFIX;
  for (const ch of runId.slice(RUN_ID_PREFIX.length)) {
    const at = RUN_ID_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    safe += RUN_ID_ALPHABET[at];
  }
  return safe;
}

/** Fifty files per run is plenty of history; a run writing hundreds is misbehaving. */
export const MAX_ARTIFACTS = 50;
const MAX_NAME_CHARS = 100;

/** Filenames a run may create and the route may serve: no dotfiles, no separators. */
export const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;

/**
 * The image types the artifacts route serves inline, ext → MIME. Everything
 * outside this table and INLINE_AUDIO_MIME is served text/plain — agent-written
 * HTML must never execute in the app's origin. IMAGE_EXTENSIONS derives from
 * these keys so "renders as a thumbnail" and "serves as an image" cannot drift
 * apart.
 */
export const INLINE_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * The audio a run can now produce for itself (`generate_audio` writes a WAV
 * into the project or the evidence folder). Served inline for the same reason
 * the images are: the run's page plays it with a plain <audio> element, and the
 * desktop's CSP allows `media-src 'self'`. The two tables are kept apart
 * because `artifactKind` has to tell a picture from a clip.
 */
export const INLINE_AUDIO_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

const IMAGE_EXTENSIONS = new Set(Object.keys(INLINE_IMAGE_MIME));
const AUDIO_EXTENSIONS = new Set(Object.keys(INLINE_AUDIO_MIME));
const TEXT_EXTENSIONS = new Set([".txt", ".log", ".json", ".html", ".css", ".js", ".ts", ".csv", ".xml", ".yaml", ".yml"]);
/**
 * Markdown is its own kind so the app can open it RENDERED — through the
 * chat's own markdown renderer, which draws model output as React elements
 * and never injects HTML — instead of as the plain text every other file is.
 * It is still SERVED as text/plain: the kind changes how the app draws the
 * bytes, never what the route says they are.
 */
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export type ArtifactKind = "image" | "audio" | "markdown" | "text" | "other";

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
  const ext = path.extname(name).toLowerCase();
  return INLINE_IMAGE_MIME[ext] ?? INLINE_AUDIO_MIME[ext] ?? null;
}

/**
 * The run's evidence folder. Throws on a malformed id — callers validate first.
 *
 * THE one place a run id becomes a path, so the containment lives here rather
 * than at each of the five filesystem calls downstream. Two guards, both
 * load-bearing: the id is REBUILT from the alphabet (so no separator can be in
 * it), and the folder that rebuild produces is then asserted to sit under the
 * artifacts root. The second cannot fail given the first — it is the assertion
 * that says so, next to the join it is about, for the reader and for the
 * scanner that has to see it.
 */
export function artifactsDir(runId: string): string {
  const safe = safeRunId(runId);
  if (safe === null) throw new Error(`not a run id: ${runId}`);
  const root = path.resolve(artifactsRoot());
  const dir = path.resolve(root, safe);
  if (!dir.startsWith(root + path.sep)) throw new Error(`not a run id: ${runId}`);
  return dir;
}

export function artifactKind(name: string): ArtifactKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
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

/**
 * Directory names an evidence folder never keeps: a Python environment, an
 * npm install, bytecode caches. Matched at any depth, and removed whole.
 */
export const INTERPRETER_TREES: ReadonlySet<string> = new Set(["venv", ".venv", "node_modules", "__pycache__"]);

/**
 * How many entries a prune looks at before it stops. An evidence folder is
 * screenshots and a report; one past this is misbehaving, and the prune is a
 * settle step that must not stall on it. Interpreter trees are removed without
 * being walked, so a large node_modules costs one entry here.
 */
const MAX_PRUNE_ENTRIES = 10_000;

/** One thing a prune removed: its path inside the evidence folder, and why. */
export interface PrunedArtifact {
  path: string;
  reason: "interpreter" | "link";
}

/** Does this symlink resolve to something that exists INSIDE the folder? */
function linkStaysInside(abs: string, realDir: string): boolean {
  try {
    const real = fs.realpathSync(abs);
    return real === realDir || real.startsWith(realDir + path.sep);
  } catch {
    // Dangling, a loop, or unreadable: nothing the folder can vouch for.
    return false;
  }
}

/**
 * Take out of a settled run's evidence folder what an evidence folder must not
 * host: interpreter trees (INTERPRETER_TREES) and symlinks that do not resolve
 * to something inside the folder — a dangling one included.
 *
 * A run that made a Python environment in its evidence folder left a
 * `venv/bin/python` symlink pointing out of the box's data/ — at a Python, or
 * into the run's worktree, where it dangled once the worktree was removed. The
 * box builds its own dashboard from the checkout data/ sits in, and Next's
 * build refuses a symlink that leads out of the project ("Symlink … is invalid,
 * it points out of the filesystem root"): one run's leftover failed every
 * update until someone deleted it by hand. None of it is evidence — the
 * listing never showed a directory or a link, and the serving route refuses
 * both — so it goes.
 *
 * Nothing is followed: directories are read with their own entry types, a link
 * is removed as a link (never its target), and an evidence folder that is
 * itself a symlink loses only that link. Answers what was removed, for the
 * run's progress feed. Never throws: this runs on the settle path of a run that
 * has already finished.
 *
 * Only for a run with nothing of its own still running. The walk and the
 * removals are separate steps by path, so a process of the run's could swap a
 * directory it has read for a link out of the folder in between, and the
 * removal would reach through it; checking each path first would only move
 * that race. finishRun skips the prune for a run that left something running
 * (`leftover`), and waits for a process group it has just signalled to be gone.
 */
export async function pruneArtifacts(runId: string): Promise<PrunedArtifact[]> {
  if (!ARTIFACT_RUN_ID_RE.test(runId)) return [];
  const pruned: PrunedArtifact[] = [];
  try {
    const dir = artifactsDir(runId);
    let top: fs.Stats;
    try {
      top = fs.lstatSync(dir);
    } catch {
      return [];
    }
    if (top.isSymbolicLink()) {
      await fs.promises.unlink(dir);
      return [{ path: ".", reason: "link" }];
    }
    if (!top.isDirectory()) return [];
    const realDir = fs.realpathSync(dir);

    const trees: string[] = [];
    const links: string[] = [];
    const pending = [""];
    let seen = 0;
    while (pending.length > 0 && seen < MAX_PRUNE_ENTRIES) {
      const rel = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++seen > MAX_PRUNE_ENTRIES) break;
        const child = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isSymbolicLink()) links.push(child);
        else if (entry.isDirectory()) (INTERPRETER_TREES.has(entry.name) ? trees : pending).push(child);
      }
    }
    if (seen > MAX_PRUNE_ENTRIES) {
      console.warn(`[coding-agent] ${runId}: evidence folder has more than ${MAX_PRUNE_ENTRIES} entries; pruned only what was looked at`);
    }

    for (const rel of trees) {
      try {
        await fs.promises.rm(path.join(dir, rel), { recursive: true, force: true });
        pruned.push({ path: rel, reason: "interpreter" });
      } catch (err) {
        console.warn(`[coding-agent] ${runId}: could not remove ${rel} from the evidence folder:`, err instanceof Error ? err.message : err);
      }
    }
    // After the trees: a link into a tree that just went now dangles, and goes
    // with it.
    for (const rel of links) {
      const abs = path.join(dir, rel);
      if (linkStaysInside(abs, realDir)) continue;
      try {
        await fs.promises.unlink(abs);
        pruned.push({ path: rel, reason: "link" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        console.warn(`[coding-agent] ${runId}: could not remove the link ${rel} from the evidence folder:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn(`[coding-agent] could not prune the evidence folder of ${runId}:`, err instanceof Error ? err.message : err);
  }
  return pruned;
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
