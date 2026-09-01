/**
 * Turning the owner's documents into something the memory index can read.
 *
 * OpenClaw's indexer accepts `.md` and NOTHING ELSE (`isAllowedMemoryFilePath`
 * in its bundle — plus an images/audio path for multimodal, which is not this).
 * So a folder of PDFs added as a source would be walked, and every file in it
 * silently skipped. That is worse than refusing: the owner would be told their
 * documents are indexed while nothing of them was.
 *
 * ClawBox therefore does the extraction itself. Each source folder gets a
 * DERIVED folder of Markdown under data/memory-extracted/, and it is the
 * derived folder that is registered alongside the original — so `.md` the owner
 * already had is indexed in place, and everything else arrives as its extracted
 * text.
 *
 * SERVER ONLY: it spawns pdftotext and libreoffice.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";
import { runChild } from "@/lib/child-run";
import { EXTRACTABLE_EXTENSIONS } from "@/lib/memory-shard-state";

/** Where derived Markdown lives. One folder per source. */
export const EXTRACT_ROOT = path.join(DATA_DIR, "memory-extracted");

/** A document over this size is skipped: the extractors are happy to spend
 *  minutes on a huge scan, and this runs while the owner is watching a wizard. */
const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

/** One extractor call's budget. */
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * The environment the extractors get, built by the caller as runChild requires.
 *
 * HOME matters: LibreOffice writes a profile there and refuses to start without
 * a writable one, and a headless convert with no HOME fails in a way that reads
 * like an unreadable document rather than a missing directory.
 */
const EXTRACT_ENV = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/home/clawbox",
  LANG: "C.UTF-8",
  NO_COLOR: "1",
};

/** How deep into a source folder to walk. */
const MAX_DEPTH = 6;

/** Documents per source, so one enormous folder cannot stall the wizard. */
const MAX_FILES = 500;

/**
 * Directory entries walked per source — files of any kind and folders alike.
 * MAX_FILES bounds the extraction, not the walk that finds the documents: a
 * code checkout under a chosen folder has a node_modules of hundreds of
 * thousands of entries, none of them extractable, and the walk read every one
 * of them on a six-core Jetson before the count above could say stop.
 */
const MAX_ENTRIES = 20_000;

export interface ExtractionResult {
  /** The derived folder, or null when the source held nothing to extract. */
  derived: string | null;
  extracted: number;
  skipped: number;
  /** Why files were skipped, worded for the owner. Empty when none were. */
  notes: string[];
}

/** A stable folder name for a source, so re-running reuses the same output. */
export function derivedFolderFor(source: string): string {
  const digest = crypto.createHash("sha256").update(path.resolve(source)).digest("hex").slice(0, 12);
  return path.join(EXTRACT_ROOT, `${path.basename(source).replace(/[^A-Za-z0-9._-]/g, "-")}-${digest}`);
}

/** The walk's budget, shared across every level of the recursion. */
interface WalkBudget {
  left: number;
  /** Set once the budget ran out with entries still unread. */
  truncated: boolean;
}

async function* walk(dir: string, budget: WalkBudget, depth = 0): AsyncGenerator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Every entry costs one, whatever it is: the budget bounds the work of
    // looking, and an unsupported file took just as long to find.
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    budget.left -= 1;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    // isDirectory() is false for a symlink, which is what keeps a link loop out
    // of the walk — the same reason the folder picker reads it this way.
    if (entry.isDirectory()) yield* walk(full, budget, depth + 1);
    else if (entry.isFile()) yield full;
  }
}

/** Extract one document to Markdown. Returns false when it could not be read. */
async function extractOne(file: string, out: string): Promise<boolean> {
  const ext = path.extname(file).toLowerCase();

  if (ext === ".txt" || ext === ".md") {
    await fs.copyFile(file, out);
    return true;
  }

  if (ext === ".pdf") {
    // `-layout` keeps columns and tables readable as text rather than
    // interleaving them line by line, which is what makes the extracted file
    // worth embedding at all.
    const r = await runChild("pdftotext", ["-layout", "-enc", "UTF-8", file, out], { timeoutMs: EXTRACT_TIMEOUT_MS, env: EXTRACT_ENV });
    return r.code === 0;
  }

  // .docx / .odt / .rtf via LibreOffice, which writes <basename>.txt into the
  // output directory rather than to a path we choose.
  const dir = path.dirname(out);
  const r = await runChild(
    "libreoffice",
    ["--headless", "--convert-to", "txt:Text", "--outdir", dir, file],
    { timeoutMs: EXTRACT_TIMEOUT_MS, env: EXTRACT_ENV },
  );
  if (r.code !== 0) return false;
  const produced = path.join(dir, `${path.basename(file, path.extname(file))}.txt`);
  try {
    await fs.rename(produced, out);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract every document under `source` into its derived folder.
 *
 * Incremental: a file whose extracted copy is newer than the original is left
 * alone, so re-running after adding one PDF costs one conversion rather than
 * the whole folder.
 */
export async function extractDocuments(source: string): Promise<ExtractionResult> {
  const derived = derivedFolderFor(source);
  let extracted = 0;
  let skipped = 0;
  const notes: string[] = [];
  let seen = 0;
  let sawExtractable = false;
  const budget: WalkBudget = { left: MAX_ENTRIES, truncated: false };

  for await (const file of walk(path.resolve(source), budget)) {
    if (seen >= MAX_FILES) {
      notes.push(`Only the first ${MAX_FILES} files in this folder were read.`);
      break;
    }
    const ext = path.extname(file).toLowerCase();
    if (!(EXTRACTABLE_EXTENSIONS as readonly string[]).includes(ext)) continue;
    seen += 1;
    sawExtractable = true;

    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      skipped += 1;
      continue;
    }
    if (stat.size > MAX_DOCUMENT_BYTES) {
      skipped += 1;
      notes.push(`${path.basename(file)} is too large to read.`);
      continue;
    }

    // The derived name keeps the relative path readable AND unique: `a/b.pdf`
    // and `a__b.pdf` flatten to the same name, and with only that name the
    // second document was skipped as already current — silently missing from
    // the index. The digest of the real relative path tells them apart.
    const relativePath = path.relative(path.resolve(source), file);
    const flat = relativePath.replace(/[\\/]/g, "__");
    const suffix = crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 12);
    const out = path.join(derived, `${flat}-${suffix}.md`);
    try {
      const previous = await fs.stat(out);
      // Already extracted and still current.
      if (previous.mtimeMs >= stat.mtimeMs) continue;
    } catch {
      // Not extracted yet.
    }

    await fs.mkdir(derived, { recursive: true });
    if (await extractOne(file, out)) extracted += 1;
    else {
      skipped += 1;
      notes.push(`${path.basename(file)} could not be read.`);
    }
  }

  // The note belongs to the folder rather than to a file, and goes FIRST so
  // the cut to three below keeps it: the owner should hear that the scan
  // stopped short before hearing which single file could not be read.
  if (budget.truncated) {
    notes.unshift(`This folder holds more than ${MAX_ENTRIES} entries; only the first were scanned.`);
  }

  return {
    derived: sawExtractable ? derived : null,
    extracted,
    skipped,
    // Three is enough for the owner to see the shape of the problem without the
    // step turning into a log.
    notes: notes.slice(0, 3),
  };
}
