/**
 * Free space every write that can grow without bound must leave on the disk.
 *
 * ONE number for the whole box rather than a copy beside each writer, because
 * the reserve is not about the writer — it is about what a full disk kills:
 * every tmp+rename write of `data/config.json` and `data/kv.json`, the
 * gateway's own state under `~/.openclaw`, and above all the in-app update's
 * build, which runs on the same filesystem and was what an owner lost on
 * 2026-09-05 when the disk ran out under it. A project import and a Files-app
 * upload are the two things a person (or the agent, holding the bearer) can
 * point at the disk with no natural ceiling; both stop here.
 *
 * 512 MiB is the margin a Next standalone build plus the swapfile's bookkeeping
 * need to complete on the Orin's NVMe; a larger reserve would refuse uploads
 * on a disk the owner still has a working gigabyte on.
 */
export const DISK_FREE_RESERVE_BYTES = 512 * 1024 * 1024;
