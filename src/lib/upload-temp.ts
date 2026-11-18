/**
 * An upload is never written over the file it replaces (TASK-2446). It is
 * written to a temporary file beside its destination — same folder, so same
 * filesystem and the same ACLs — and renamed over the destination only once
 * the whole body has been accepted. An upload refused part-way (the upload
 * limit, the quota, a body that lied about its size), cut off by the client
 * or failed by the disk leaves the file it would have replaced exactly as it
 * was; only its own temporary file is removed. The rename is atomic: a
 * reader sees the old file or the new one, never a half-written one.
 *
 * The temporary file is a dot-file of a name nothing else uses
 * (`.clawbox-upload-<16 hex>.part`), and the Files listing and search leave
 * it out even with hidden files shown. SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs";
import path from "@/lib/runtime-path";

/** The name of an upload's temporary file, and nothing else. */
export const UPLOAD_TEMP_RE = /^\.clawbox-upload-[0-9a-f]{16}\.part$/;

/** Is `name` (a bare file name) an upload's temporary file? */
export function isUploadTempName(name: string): boolean {
  return UPLOAD_TEMP_RE.test(name);
}

/** A fresh temporary path for an upload to `destPath`, in the same folder. */
export function uploadTempPath(destPath: string): string {
  return path.join(path.dirname(destPath), `.clawbox-upload-${crypto.randomBytes(8).toString("hex")}.part`);
}

/**
 * Put a fully accepted upload in place: the temporary file at `tempReal`
 * (the path its descriptor was judged at, for a member of staff) is renamed
 * to the destination's name IN THE SAME FOLDER, so the rename can never land
 * anywhere the temporary file could not. A regular file it replaces passes
 * its permission bits on, as writing over it in place used to keep them; a
 * link of that name is replaced, never written through. Throws what the
 * filesystem throws (EISDIR for a folder of that name …) — the caller then
 * removes the temporary file and the destination is untouched.
 */
export function commitUploadTemp(tempReal: string, destPath: string): string {
  const target = path.join(path.dirname(tempReal), path.basename(destPath));
  let replaced: fs.Stats | null = null;
  try {
    replaced = fs.lstatSync(/* turbopackIgnore: true */ target);
  } catch {
    replaced = null;
  }
  if (replaced?.isFile()) fs.chmodSync(/* turbopackIgnore: true */ tempReal, replaced.mode & 0o7777);
  fs.renameSync(/* turbopackIgnore: true */ tempReal, target);
  return target;
}
