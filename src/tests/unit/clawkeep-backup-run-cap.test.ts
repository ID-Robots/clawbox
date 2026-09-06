import fs from "fs/promises";
import path from "path";

import { describe, expect, it } from "vitest";

import { BACKUP_RUN_CAP_MS, RESTORE_RUN_CAP_MS } from "@/lib/clawkeep-protection";

/**
 * TASK-675 — a large ClawKeep backup is killed by the box while it is working.
 *
 * The customer case is a 12 GB archive. PR #607 (multipart chunking) and the
 * portal's credential-TTL fix together made that run finish, and the board
 * records the validated 12 GiB run finishing in ~86 minutes. Four separate
 * caps stood in its way, none of them reached by the others:
 *
 *   - `openclaw.py`'s `create_archive` default, 30 minutes — the FIRST wall on
 *     the OpenClaw edition, since `agent.create_archive()` passes no timeout;
 *   - `runBackup()`'s kill timer, `BACKUP_RUN_CAP_MS`, 60 minutes;
 *   - on the restore side, `verify_archive`'s 5 minutes, and a
 *     `RESTORE_TIMEOUT_MS` of 30 — half the backup's.
 *
 * Each turns "this step is slow" into "this backup failed" for exactly the
 * step that is slow. None of the numbers is one ClawBox has to invent:
 * ClawKeep ships its own unit for this binary and declares `TimeoutStartSec`
 * there. These tests read that unit and the daemon's own source, so raising
 * one cap and forgetting another is red here rather than shipped.
 */

const MINUTE = 60_000;
/** The board's measured duration of the validated 12 GiB run. */
const MEASURED_12GIB_RUN_MS = 86 * MINUTE;

const repoFile = (rel: string) => fs.readFile(path.join(process.cwd(), rel), "utf8");

/** What `clawkeepd.service` — ClawKeep's own unit for this binary — allows. */
async function declaredDaemonTimeoutMs(): Promise<number> {
  const unit = await repoFile("clawkeep/systemd/clawkeepd.service");
  const declared = /^TimeoutStartSec=(\d+)([smh])$/m.exec(unit);
  expect(declared, "clawkeepd.service must declare TimeoutStartSec").not.toBeNull();
  const [, value, unitLetter] = declared!;
  const scale = unitLetter === "h" ? 3_600_000 : unitLetter === "m" ? 60_000 : 1_000;
  return Number(value) * scale;
}

describe("the cap a ClawKeep backup run is given", () => {
  it("is not stricter than the one ClawKeep's own service unit declares", async () => {
    // The bridge spawns the very binary this unit was written for. Being
    // stricter than it means the box kills runs the daemon considers normal —
    // and it is the box, not the daemon, the owner hears from.
    expect(BACKUP_RUN_CAP_MS).toBeGreaterThanOrEqual(await declaredDaemonTimeoutMs());
  });

  it("outlasts the 12 GB backup this task exists to make work", () => {
    expect(BACKUP_RUN_CAP_MS).toBeGreaterThan(MEASURED_12GIB_RUN_MS);
  });

  it("is not undercut by the daemon's own per-step caps on the OpenClaw edition", async () => {
    // The bridge cap is the only ceiling CLAWBOX imposes; it is not the only
    // one that exists. `agent.create_archive()` and `agent.verify_archive()`
    // pass no timeout, so `openclaw.py`'s defaults bind those steps first —
    // they were 30 and 5 minutes, so on OpenClaw a 12 GB backup died half an
    // hour in and never reached the bridge's timer at all. Read out of the
    // Python rather than restated here.
    const py = await repoFile("clawkeep/clawkeep/openclaw.py");
    const declared = /^SUBPROCESS_TIMEOUT_S = ([\d\s*]+)$/m.exec(py);
    expect(declared, "openclaw.py must declare SUBPROCESS_TIMEOUT_S").not.toBeNull();
    const seconds = declared![1].split("*").reduce((a, b) => a * Number(b.trim()), 1);

    expect(seconds * 1000).toBeGreaterThanOrEqual(BACKUP_RUN_CAP_MS);
    expect(seconds * 1000).toBeGreaterThanOrEqual(RESTORE_RUN_CAP_MS);

    // And both step functions must take that default, not a tighter literal.
    for (const fn of ["create_archive", "verify_archive"]) {
      const at = py.indexOf(`def ${fn}(`);
      expect(at, `openclaw.py must define ${fn}`).toBeGreaterThan(-1);
      expect(py.slice(at, at + 400), `${fn} must use SUBPROCESS_TIMEOUT_S`)
        .toContain("timeout: float = SUBPROCESS_TIMEOUT_S");
    }
  });
});

describe("the cap a ClawKeep restore is given", () => {
  it("is at least the backup's, for work that is at least symmetric", () => {
    // The download mirrors the upload; decrypt, extract and `openclaw backup
    // verify` come on top. It had HALF the backup's budget.
    expect(RESTORE_RUN_CAP_MS).toBeGreaterThanOrEqual(BACKUP_RUN_CAP_MS);
    expect(RESTORE_RUN_CAP_MS).toBeGreaterThan(MEASURED_12GIB_RUN_MS);
  });

  it("is the same window the restoring flag is believed for", async () => {
    // `isRestoring()` DELETES a flag it judges stale, and `restoring` is the
    // only signal that survives a page reload, so a shorter window drops the
    // shelf's orange shield back to a calm green verdict while the box's own
    // state is still being replaced. One constant, not two numbers that
    // happen to agree — which is exactly how they came apart.
    const src = await repoFile("src/lib/clawkeep.ts");
    expect(src).toContain("const RESTORING_FLAG_MAX_AGE_MS = RESTORE_RUN_CAP_MS;");
    expect(src).toContain("const RESTORE_TIMEOUT_MS = RESTORE_RUN_CAP_MS;");
  });
});
