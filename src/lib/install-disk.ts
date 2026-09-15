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
 * What `dir`'s filesystem can spare for a download of `requiredBytes`.
 *
 * `dir` is measured, not its parent: on this box `data/` can be a different
 * mount from `~/.cache`, and the Whisper weights and the GGUF library land on
 * two different ones.
 */
export async function checkInstallDisk(dir: string, requiredBytes: number): Promise<DiskVerdict> {
  return diskVerdict(requiredBytes, await freeBytes(dir), DISK_FREE_RESERVE_BYTES);
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
