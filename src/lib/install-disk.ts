/**
 * "Will this download fit?", asked before a byte is fetched.
 *
 * Every install Settings → Local AI offers is a multi-hundred-megabyte write
 * with no natural ceiling, on the one filesystem the box's own update build
 * also needs — which is what `DISK_FREE_RESERVE_BYTES` exists to protect. A
 * download that ran the disk out used to end as whatever error the tool
 * happened to print, minutes in, with a half-written file left behind; this
 * refuses at the door and says how much room is missing.
 *
 * SERVER ONLY: statfs. The arithmetic itself is in `src/lib/local-install.ts`
 * so the panel can show the same verdict before it posts.
 */
import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { DISK_FREE_RESERVE_BYTES } from "@/lib/disk-reserve";
import { diskVerdict, type DiskVerdict } from "@/lib/local-install";
import { freeBytes } from "@/lib/project-import";

export type { DiskVerdict };

/**
 * The nearest ancestor of `dir` that exists.
 *
 * Every download here is measured against a directory that is usually NOT
 * there yet — a Whisper size's cache entry, a model directory on a fresh box —
 * and `statfs` on a path that does not exist fails, which `freeBytes` reports
 * as "the disk would not say" and this module reads as "do not refuse". That
 * is the right answer for a measurement that failed and the wrong one for a
 * path nobody has created, so the walk is what makes the check real: the
 * filesystem a leaf will land on is its nearest existing ancestor's.
 *
 * Bounded by the root, so a relative or malformed path cannot loop.
 */
async function existingAncestor(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await fs.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * What `dir`'s filesystem can spare for a download of `requiredBytes`.
 *
 * `dir` is measured, not `data/`: on this box `data/` can be a different mount
 * from `~/.cache`, and the Whisper weights and the GGUF library land on two
 * different ones.
 */
export async function checkInstallDisk(dir: string, requiredBytes: number): Promise<DiskVerdict> {
  const measurable = await existingAncestor(dir);
  const free = measurable === null ? null : await freeBytes(measurable);
  return diskVerdict(requiredBytes, free, DISK_FREE_RESERVE_BYTES);
}

/** One part of an install that writes to more than one place: where, and how much. */
export interface InstallPart {
  dir: string;
  bytes: number;
}

/**
 * Parts on the same filesystem add up; parts on different ones do not. Pure,
 * so the grouping is testable without two real mounts. A part whose device
 * could not be read is kept on its own rather than guessed into a group.
 */
export function sumPartsByDevice(
  parts: readonly { dir: string; bytes: number; device: string | null }[],
): InstallPart[] {
  const groups = new Map<string, InstallPart>();
  parts.forEach((part, index) => {
    const key = part.device ?? `unknown:${index}`;
    const group = groups.get(key);
    if (group) group.bytes += part.bytes;
    else groups.set(key, { dir: part.dir, bytes: part.bytes });
  });
  return [...groups.values()];
}

/**
 * {@link checkInstallDisk} for an install that writes to several directories
 * which may or may not share a filesystem — a package tree, a build tree under
 * /tmp and a model cache. Every filesystem the install touches is measured
 * against the sum of the parts that land on it, and the FIRST one short is the
 * verdict; when all fit, the first group's verdict is answered.
 */
export async function checkInstallDisks(parts: readonly InstallPart[]): Promise<DiskVerdict> {
  const located = await Promise.all(parts.map(async (part) => {
    const measurable = await existingAncestor(part.dir);
    const device = measurable === null ? null : await fs.stat(measurable).then((st) => String(st.dev), () => null);
    return { dir: measurable ?? part.dir, bytes: part.bytes, device };
  }));
  let first: DiskVerdict | null = null;
  for (const group of sumPartsByDevice(located)) {
    const verdict = await checkInstallDisk(group.dir, group.bytes);
    if (!verdict.ok) return verdict;
    first ??= verdict;
  }
  return first ?? (await checkInstallDisk(parts[0]?.dir ?? "/", 0));
}

/**
 * The refusal, in the shape every caller of this module answers with: a stable
 * `code` the locales word, and the three figures so the panel can say "needs
 * 1.6 GB, 900 MB free" rather than "not enough space".
 *
 * 507 Insufficient Storage, the status the Files app's upload already uses for
 * this exact condition.
 */
export function diskRefusal(verdict: DiskVerdict): NextResponse {
  return NextResponse.json(
    {
      error: "There is not enough room on this box for that download.",
      code: "disk_full",
      requiredBytes: verdict.requiredBytes,
      freeBytes: verdict.freeBytes,
      reserveBytes: verdict.reserveBytes,
      shortfallBytes: verdict.shortfallBytes,
    },
    { status: 507 },
  );
}

/**
 * Bytes under `dir`, links NOT followed.
 *
 * `lstat`, so the Hub's snapshot symlinks are counted as the few bytes they are
 * and the blobs they point at are counted once — following them would report a
 * cache at twice its size, which is the number a "remove frees N" row shows.
 */
export async function dirBytes(dir: string): Promise<number | null> {
  let total = 0;
  let seen = false;
  const walk = async (current: string): Promise<void> => {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    seen = true;
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const st = await fs.lstat(full);
        total += st.size;
      } catch {
        /* vanished under us; it is not on the disk either */
      }
    }
  };
  await walk(dir);
  return seen ? total : null;
}
