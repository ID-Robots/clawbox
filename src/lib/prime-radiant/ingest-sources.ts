/**
 * Finding and reading the documents an ingest turns into pages.
 *
 * - The walk is Memory Shard's (`walkFiles`: no symlinks followed, dot-entries
 *   skipped, an entry budget per folder) with an exclude list on top —
 *   dependency trees, caches, build output and Prime Radiant's own folder,
 *   because an ingest that reads its own vault (or another indexer's scratch
 *   copies) writes pages about pages.
 * - Every file is read ONCE through one no-follow handle: the size check, the
 *   SHA-256 and the bytes all come from that descriptor. The hash comes first
 *   — a document already turned into pages (or seen earlier in the same job)
 *   is never extracted again.
 * - PDF and Word documents go through the extractors the box already has
 *   (`extractOne`: pdftotext, LibreOffice), run over a PRIVATE copy of the
 *   bytes that were hashed, so what is extracted is exactly what was hashed.
 * - Text and the path label are redacted here, before anything can reach a
 *   model.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import os from "os";
import path from "@/lib/runtime-path";
import { EXTRACT_ROOT, MAX_DOCUMENT_BYTES, extractOne, newWalkBudget, walkFiles } from "@/lib/memory-extract";
import { redactPath, redactText } from "./redact";
import { primeRadiantRoot } from "./paths";
import { MAX_TEXT_CHARS_PER_FILE } from "./writer";

/** What an ingest reads. The box's extractors handle PDF and Word documents. */
export const INGEST_EXTENSIONS = [".txt", ".md", ".pdf", ".docx"] as const;
export type IngestExtension = (typeof INGEST_EXTENSIONS)[number];

/** Folders never walked into, whatever folder the owner picked. */
export const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "__pycache__",
  "venv",
  "site-packages",
  "dist",
  "build",
  "target",
  "coverage",
  "Trash",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

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

/** The label a document is known by everywhere outside this box: home folded, secrets redacted. */
export function sourceLabel(abs: string): string {
  return redactPath(abs, { homeDir: os.homedir() }).text;
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
  truncated: boolean;
}

/**
 * Every ingestible file under `folders`, in walk order, at most
 * {@link MAX_JOB_FILES}. `labelOf` names a file for the outside (default:
 * {@link sourceLabel}); an upload names its files by their upload name.
 */
export async function scanFolders(
  folders: readonly string[],
  options: { labelOf?: (abs: string) => string; maxFiles?: number; signal?: AbortSignal } = {},
): Promise<ScanResult> {
  const labelOf = options.labelOf ?? sourceLabel;
  const maxFiles = options.maxFiles ?? MAX_JOB_FILES;
  const files: ScannedFile[] = [];
  const notes: string[] = [];
  let unsupported = 0;
  let truncated = false;
  const seen = new Set<string>();
  const own = ownOutputDirs();
  const skipDir = (full: string, name: string) => SKIPPED_DIR_NAMES.has(name) || own.some((o) => inside(o, path.resolve(full)));
  for (const folder of folders) {
    const budget = newWalkBudget();
    for await (const abs of walkFiles(path.resolve(folder), budget, 0, { skipDir })) {
      options.signal?.throwIfAborted();
      const ext = path.extname(abs).toLowerCase();
      if (!isIngestExtension(ext)) {
        unsupported += 1;
        continue;
      }
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({ abs, label: labelOf(abs), ext });
    }
    const label = labelOf(folder);
    if (budget.rootUnreadable) notes.push(`${label} could not be read.`);
    else if (budget.unreadable > 0) notes.push(`${budget.unreadable} folder(s) inside ${label} could not be read.`);
    if (budget.truncated) notes.push(`${label} holds more entries than one scan reads; only the first part was read.`);
    if (truncated) {
      notes.push(`Only the first ${maxFiles} documents are read in one ingest; run it again for the rest.`);
      break;
    }
  }
  return { files, notes, unsupported, truncated };
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
