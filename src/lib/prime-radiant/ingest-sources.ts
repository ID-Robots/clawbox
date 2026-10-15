/**
 * Finding and reading the documents an ingest turns into pages.
 *
 * - The walk is Memory Shard's (`walkFiles`: no symlinks followed, dot-entries
 *   skipped, an entry budget per folder) with an exclude list on top (see
 *   `ingest-exclude.ts`: version control, dependencies, caches, build output,
 *   worktrees, scratch folders, archives of agent runs, logs, test data,
 *   snap and flatpak — the owner's to change), plus, always, ClawBox's own
 *   output folders and any linked git worktree (a folder whose `.git` is a
 *   file): an ingest that reads its own vault, another indexer's scratch
 *   copies or a second checkout of the same project writes pages about pages.
 * - Pointed at a whole home folder, the walk reads the owner's documents and
 *   not the machine's: a code project it comes across (a `.git` folder, a
 *   package.json, a Cargo.toml …) is not gone into — unless the owner turned
 *   "Skip code projects" off, and never the folder the owner picked, which is
 *   read even when it is a project — and repository boilerplate and
 *   temporary files are left out by name. Every file and folder left out is
 *   counted by its reason ({@link SkipCounts}), never silently dropped.
 * - {@link previewFolders} answers what a job over the same folders would
 *   read, before it starts: the count, the reasons, the biggest folders.
 * - Every file is read ONCE through one no-follow handle: the size check, the
 *   SHA-256 and the bytes all come from that descriptor. The hash comes first
 *   — a document already turned into pages (or seen earlier in the same job)
 *   is never extracted again.
 * - PDF, Word, OpenDocument and RTF documents go through the extractors the
 *   box already has (`extractOne`: pdftotext, LibreOffice), run over a PRIVATE copy of the
 *   bytes that were hashed, so what is extracted is exactly what was hashed.
 * - Text and the path label are redacted here, before anything can reach a
 *   model.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs/promises";
import { constants as fsConstants, lstatSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "@/lib/runtime-path";
import { EXTRACT_ROOT, MAX_DOCUMENT_BYTES, extractOne, newWalkBudget, walkFiles } from "@/lib/memory-extract";
import { redactPath, redactText } from "./redact";
import {
  DEFAULT_INGEST_EXCLUDES,
  PROJECT_MANIFESTS,
  codeProjectMarker,
  compileExcludes,
  emptySkipCounts,
  fileSkipReason,
  type FolderEntry,
  type SkipCounts,
} from "./ingest-exclude";
import { MACHINE_TEXT_SAMPLE_CHARS, isMachineText } from "./machine-text";
import { primeRadiantRoot } from "./paths";
import { MAX_TEXT_CHARS_PER_FILE } from "./writer";

/** What an ingest reads. The box's extractors handle PDF, Word, OpenDocument and RTF documents. */
export const INGEST_EXTENSIONS = [".txt", ".md", ".pdf", ".docx", ".odt", ".rtf"] as const;
export type IngestExtension = (typeof INGEST_EXTENSIONS)[number];

/** Files one job reads at most. */
export const MAX_JOB_FILES = 5_000;

export function isIngestExtension(ext: string): ext is IngestExtension {
  return (INGEST_EXTENSIONS as readonly string[]).includes(ext);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Folders whose contents are ClawBox's own output, never the owner's documents. */
export function ownOutputDirs(): string[] {
  return [path.resolve(primeRadiantRoot()), path.resolve(EXTRACT_ROOT)];
}

/** Whether `dir` is (or is inside) one of ClawBox's own output folders. */
export function isOwnOutput(dir: string): boolean {
  const resolved = path.resolve(dir);
  return ownOutputDirs().some((own) => inside(own, resolved));
}

/**
 * A linked git worktree: a folder whose `.git` is a FILE pointing back at the
 * main repository. Its documents are the same project's, a second time.
 */
export function isLinkedWorktree(dir: string): boolean {
  try {
    return lstatSync(path.join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/**
 * The box's own key for {@link sourceLabel}'s discriminator: random, kept
 * beside the vault (never inside it), created on first use.
 */
function labelKey(): Buffer {
  const file = path.join(primeRadiantRoot(), ".label-key");
  try {
    const key = readFileSync(file);
    if (key.length >= 32) return key;
  } catch {
    // Not there yet.
  }
  const key = crypto.randomBytes(32);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, key, { mode: 0o600, flag: "wx" });
  } catch {
    // Another caller wrote it first: use theirs.
    try {
      const theirs = readFileSync(file);
      if (theirs.length >= 32) return theirs;
    } catch {
      // Unreadable: this call's key still keeps the label distinct within the job.
    }
  }
  return key;
}

/**
 * The label a document is known by everywhere outside this box: home folded,
 * secrets redacted. The label is also a page's identity (a changed document
 * updates its page in place), so when redaction folded something away — two
 * paths that differ only in an e-mail address read alike once redacted — a
 * short keyed hash of the real path is appended (`…/notes.md#1a2b3c4d5e6f`).
 * Keyed, so the hash cannot be used to guess what was redacted.
 */
export function sourceLabel(abs: string): string {
  return redactedLabel(abs, abs, os.homedir());
}

/**
 * `display` redacted as a path, with the keyed tag of `identity` (the real
 * file) appended when redaction changed it — the one rule behind a folder
 * file's label and a dropped file's (`upload/<batch>/<name>`).
 */
export function redactedLabel(display: string, identity: string, homeDir?: string): string {
  const r = redactPath(display, { homeDir });
  if (r.kinds.length === 0) return r.text;
  const tag = crypto.createHmac("sha256", labelKey()).update(identity).digest("hex").slice(0, 12);
  return `${r.text}#${tag}`;
}

/** Entries a code-project check reads from one folder before it falls back to asking for the markers by name. */
const MAX_PROBE_ENTRIES = 2_000;

/**
 * What makes `dir` a code project (see `codeProjectMarker`), or null. Reads
 * at most {@link MAX_PROBE_ENTRIES} entries; a bigger folder is then asked
 * for `.git` and each manifest by name, so a marker listed late is not
 * missed. Symlinks are never followed. An unreadable folder is no project
 * (the walk reports it as unreadable).
 */
export async function codeProjectIn(dir: string): Promise<string | null> {
  const entries: FolderEntry[] = [];
  let complete = true;
  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch {
    return null;
  }
  try {
    for await (const e of handle) {
      if (entries.length >= MAX_PROBE_ENTRIES) {
        complete = false;
        break;
      }
      entries.push({ name: e.name, dir: e.isDirectory() });
    }
  } catch {
    // Stopped being readable mid-listing: judge what was read.
  }
  const marker = codeProjectMarker(entries);
  if (marker || complete) return marker;
  const named: FolderEntry[] = [];
  for (const name of [".git", ".obsidian", ...PROJECT_MANIFESTS]) {
    try {
      const st = await fs.lstat(path.join(dir, name));
      named.push({ name, dir: st.isDirectory() });
    } catch {
      // Not there.
    }
  }
  return codeProjectMarker(named);
}

export interface ScannedFile {
  abs: string;
  label: string;
  ext: IngestExtension;
}

export interface ScanResult {
  files: ScannedFile[];
  /** Notes worded for the owner (a folder unreadable, a walk cut short). */
  notes: string[];
  /** Files of a kind the ingest does not read. */
  unsupported: number;
  /** Folders left out: the exclude list, a linked worktree, ClawBox's own output. */
  excluded: number;
  /**
   * Everything left out, by reason. A scan fills the reasons it decides
   * (code projects, excluded folders, boilerplate, temporary files, other
   * kinds); `machineText` and `tooLarge` are decided once a file is read.
   */
  skips: SkipCounts;
  /** The code projects not gone into, absolute, in walk order (at most {@link MAX_LISTED_PROJECTS}). */
  codeProjects: string[];
  truncated: boolean;
}

/** Code projects a scan names (the count in `skips` is always complete). */
export const MAX_LISTED_PROJECTS = 50;

export interface ScanOptions {
  labelOf?: (abs: string) => string;
  /** How a picked folder is named in the notes (default `labelOf`). */
  folderLabelOf?: (abs: string) => string;
  maxFiles?: number;
  signal?: AbortSignal;
  /** Folder-name patterns never walked into (default {@link DEFAULT_INGEST_EXCLUDES}). */
  exclude?: readonly string[];
  /**
   * Leave out code projects found during the walk (default true; the
   * settings' "Skip code projects"). The folders passed in are read even
   * when they are projects themselves.
   */
  skipCodeProjects?: boolean;
  /**
   * Leave out boilerplate and temporary files by name (default true). A drop
   * passes false: the owner chose every one of those files.
   */
  skipByName?: boolean;
}

/**
 * Every ingestible file under `folders`, in walk order, at most
 * {@link MAX_JOB_FILES}. `labelOf` names a file for the outside (default:
 * {@link sourceLabel}); an upload names its files by their upload name.
 */
export async function scanFolders(folders: readonly string[], options: ScanOptions = {}): Promise<ScanResult> {
  const labelOf = options.labelOf ?? sourceLabel;
  const maxFiles = options.maxFiles ?? MAX_JOB_FILES;
  const skipCodeProjects = options.skipCodeProjects ?? true;
  const skipByName = options.skipByName ?? true;
  const files: ScannedFile[] = [];
  const notes: string[] = [];
  const skips = emptySkipCounts();
  const codeProjects: string[] = [];
  let truncated = false;
  const seen = new Set<string>();
  const own = ownOutputDirs();
  const excludedName = compileExcludes(options.exclude ?? DEFAULT_INGEST_EXCLUDES);
  const skipDir = async (full: string, name: string) => {
    if (excludedName(name) || own.some((o) => inside(o, path.resolve(full))) || isLinkedWorktree(full)) {
      skips.excludedFolder += 1;
      return true;
    }
    if (skipCodeProjects && (await codeProjectIn(full))) {
      skips.codeProject += 1;
      if (codeProjects.length < MAX_LISTED_PROJECTS) codeProjects.push(full);
      return true;
    }
    return false;
  };
  for (const folder of folders) {
    const budget = newWalkBudget();
    const firstOfFolder = files.length;
    for await (const abs of walkFiles(path.resolve(folder), budget, 0, { skipDir })) {
      options.signal?.throwIfAborted();
      if (seen.has(abs)) continue;
      seen.add(abs);
      const name = path.basename(abs);
      const byName = skipByName ? fileSkipReason(name) : null;
      if (byName === "temp") {
        skips.temp += 1;
        continue;
      }
      const ext = path.extname(abs).toLowerCase();
      if (!isIngestExtension(ext)) {
        skips.unsupported += 1;
        continue;
      }
      if (byName === "boilerplate") {
        skips.boilerplate += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({ abs, label: labelOf(abs), ext });
    }
    // The walk lists a directory in the filesystem's own order (hash order on
    // ext4), which differs from box to box; a job's files, its batches and its
    // file list are handed out in path order instead, so the same folder is
    // always ingested the same way.
    sortByPath(files, firstOfFolder);
    const label = (options.folderLabelOf ?? labelOf)(folder);
    if (budget.rootUnreadable) notes.push(`${label} could not be read.`);
    else if (budget.unreadable > 0) notes.push(`${budget.unreadable} folder(s) inside ${label} could not be read.`);
    if (budget.truncated) notes.push(`${label} holds more entries than one scan reads; only the first part was read.`);
    if (truncated) {
      notes.push(truncationNote(maxFiles));
      break;
    }
  }
  return { files, notes, unsupported: skips.unsupported, excluded: skips.excludedFolder, skips, codeProjects, truncated };
}

function truncationNote(maxFiles: number): string {
  return `Only the first ${maxFiles} documents are read in one ingest; run it again for the rest.`;
}

/** Whether a text file's opening reads as machine output; any other kind is never judged. */
export function machineTextFile(ext: IngestExtension, text: string): boolean {
  return (ext === ".txt" || ext === ".md") && isMachineText(text);
}

/** The opening of a text file (enough for the machine-text check), through a no-follow handle; null when unreadable. */
async function readHead(abs: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    // UTF-8 takes up to four bytes a character: read enough for the whole sample.
    const buf = Buffer.alloc(MACHINE_TEXT_SAMPLE_CHARS * 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Folders a preview names, biggest first. */
export const PREVIEW_TOP_FOLDERS = 8;
/** Files a preview looks at in parallel. */
const PREVIEW_PARALLEL = 16;

export interface IngestPreview {
  /** Documents a job over the same folders would read (before the already-ingested ones are recognised). */
  documents: number;
  /** Everything left out, by reason. */
  skips: SkipCounts;
  /** Where the documents are: each picked folder's first level, biggest first, labelled like a source. */
  topFolders: Array<{ label: string; documents: number }>;
  /** Labels of the code projects not gone into (at most {@link MAX_LISTED_PROJECTS}). */
  codeProjects: string[];
  /** More documents than one job reads (`limit`): a job reads the first part. */
  truncated: boolean;
  /** The most documents one job reads ({@link MAX_JOB_FILES}, unless the caller set another cap). */
  limit: number;
  notes: string[];
}

/**
 * What a job over `folders` would read, without reading it: the same scan,
 * then each file's size (too large?) and, for `.txt`/`.md`, its opening (machine
 * text?). Nothing leaves the box and nothing is written.
 */
export async function previewFolders(
  folders: readonly string[],
  options: Pick<ScanOptions, "exclude" | "skipCodeProjects" | "signal" | "maxFiles"> = {},
): Promise<IngestPreview> {
  const scan = await scanFolders(folders, { ...options, labelOf: (abs) => abs, folderLabelOf: sourceLabel });
  const skips = { ...scan.skips };
  const keep = new Array<boolean>(scan.files.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < scan.files.length) {
      const i = next++;
      options.signal?.throwIfAborted();
      const file = scan.files[i];
      let size: number;
      try {
        const st = await fs.lstat(file.abs);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      if (size > MAX_DOCUMENT_BYTES) {
        skips.tooLarge += 1;
        continue;
      }
      if (file.ext === ".txt" || file.ext === ".md") {
        const head = await readHead(file.abs);
        if (head !== null && machineTextFile(file.ext, head)) {
          skips.machineText += 1;
          continue;
        }
      }
      keep[i] = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREVIEW_PARALLEL, scan.files.length) }, worker));

  // Overlapping picks (~ and ~/Documents): a file counts under the most specific one.
  const roots = folders.map((f) => path.resolve(f)).sort((a, b) => b.length - a.length);
  const byFolder = new Map<string, number>();
  let documents = 0;
  scan.files.forEach((file, i) => {
    if (!keep[i]) return;
    documents += 1;
    const root = roots.find((r) => inside(r, file.abs)) ?? path.dirname(file.abs);
    const parts = path.relative(root, file.abs).split(path.sep);
    const group = parts.length > 1 ? path.join(root, parts[0]) : root;
    byFolder.set(group, (byFolder.get(group) ?? 0) + 1);
  });
  const topFolders = [...byFolder.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, PREVIEW_TOP_FOLDERS)
    .map(([dir, n]) => ({ label: sourceLabel(dir), documents: n }));
  return {
    documents,
    skips,
    topFolders,
    codeProjects: scan.codeProjects.map(sourceLabel),
    truncated: scan.truncated,
    limit: options.maxFiles ?? MAX_JOB_FILES,
    // `truncated` says it, in the owner's language.
    notes: scan.notes.filter((n) => n !== truncationNote(options.maxFiles ?? MAX_JOB_FILES)),
  };
}

/** Sorts `files[from..]` in place by absolute path (code-unit order, locale-free). */
function sortByPath(files: ScannedFile[], from: number): void {
  const tail = files.splice(from).sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
  files.push(...tail);
}

/** The bytes of one file through one no-follow handle, with their hash. */
export async function readFileOnce(abs: string, maxBytes = MAX_DOCUMENT_BYTES): Promise<
  { ok: true; sha256: string; data: Buffer } | { ok: false; reason: "unreadable" | "too-large" | "not-a-file"; bytes?: number }
> {
  let handle;
  try {
    handle = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: "not-a-file" };
    if (st.size > maxBytes) return { ok: false, reason: "too-large", bytes: st.size };
    const data = await handle.readFile();
    if (data.length > maxBytes) return { ok: false, reason: "too-large", bytes: data.length };
    return { ok: true, sha256: crypto.createHash("sha256").update(data).digest("hex"), data };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close();
  }
}

/** Text as the model sees it: NULs and control noise out, blank runs collapsed, redacted, capped. */
export function prepareText(raw: string, max = MAX_TEXT_CHARS_PER_FILE): { text: string; truncated: boolean } {
  const cleaned = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const redacted = redactText(cleaned).text;
  if (redacted.length <= max) return { text: redacted, truncated: false };
  return { text: redacted.slice(0, max), truncated: true };
}

export type Extractor = (file: string, out: string) => Promise<boolean>;

/**
 * Text of one document whose bytes were already read. `.txt`/`.md` decode as
 * UTF-8; anything else is written to `scratch` (a private folder) and
 * extracted from that copy.
 */
export async function extractText(
  data: Buffer,
  ext: IngestExtension,
  scratch: string,
  extractor: Extractor = extractOne,
): Promise<string | null> {
  if (ext === ".txt" || ext === ".md") return data.toString("utf8");
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  const stem = crypto.randomBytes(8).toString("hex");
  const input = path.join(scratch, `${stem}${ext}`);
  const out = path.join(scratch, `${stem}.out.txt`);
  try {
    await fs.writeFile(input, data, { mode: 0o600, flag: "wx" });
    if (!(await extractor(input, out))) return null;
    return await fs.readFile(out, "utf8");
  } catch {
    return null;
  } finally {
    await fs.rm(input, { force: true });
    await fs.rm(out, { force: true });
  }
}
