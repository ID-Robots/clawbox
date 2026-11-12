import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { doctorRecordRefusal, doctorRunCompleted } from "@/lib/openclaw-migration-status";

// The writer's cases run the real helper under python: vitest's 5 s default is
// not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Whether doctor's own run is recorded complete for the core that is installed,
// and recently enough: the update's gateway check starts a gateway it stopped
// without running doctor again only when there is no reason against it, so
// anything short of proof is a reason, and the reason is its log line. The record is data/openclaw-migration-status.json
// (scripts/openclaw-db-maintenance.py); the installed core is the version in
// the core's own package.json, found from OPENCLAW_BIN the way the rest of the
// web server finds it.

const CORE = "2026.10.9";
const DAY_MS = 24 * 60 * 60 * 1000;
/** When the fixture's doctor run was recorded, and a moment a day later to judge it from. */
const RECORDED_AT = Date.parse("2026-11-09T23:40:00Z");
const NOW = RECORDED_AT + DAY_MS;
let root: string;
const saved = { root: process.env.CLAWBOX_ROOT, bin: process.env.OPENCLAW_BIN };

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "migration-doctor-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(path.join(root, "lib", "node_modules", "openclaw"), { recursive: true });
  process.env.CLAWBOX_ROOT = root;
  process.env.OPENCLAW_BIN = path.join(root, "bin", "openclaw");
  installCore(CORE);
});
afterEach(() => {
  for (const [key, value] of [["CLAWBOX_ROOT", saved.root], ["OPENCLAW_BIN", saved.bin]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function installCore(version: unknown): void {
  writeFileSync(
    path.join(root, "lib", "node_modules", "openclaw", "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
}

function record(body: unknown): void {
  writeFileSync(
    path.join(root, "data", "openclaw-migration-status.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

/** What `record-doctor` and the pre-start leave on a box whose doctor finished for this core. */
const complete = () => ({
  version: 1,
  state: "ok",
  reason: null,
  core: CORE,
  doctor: { core: CORE, verdict: "complete", at: "2026-11-09T23:40:00Z" },
});

describe("doctorRecordRefusal", () => {
  const RECORD_OLD = "doctor's recorded run is more than 30 days old";

  it("answers null when the record says ok and doctor completed for the installed core", async () => {
    record(complete());
    expect(await doctorRecordRefusal(NOW)).toBeNull();
  });

  it("compares the versions trimmed, as both writers read the same manifest", async () => {
    installCore(` ${CORE}\n`);
    record({ ...complete(), core: `${CORE}\n`, doctor: { ...complete().doctor, core: ` ${CORE}` } });
    expect(await doctorRecordRefusal(NOW)).toBeNull();
  });

  // The core retires a standalone `doctor --fix` capture once it is over 30
  // days old, at the next standalone run: a run older than that is due again.
  it("answers null up to 30 days after doctor's recorded run, and its age a millisecond later", async () => {
    record(complete());
    expect(await doctorRecordRefusal(RECORDED_AT)).toBeNull();
    expect(await doctorRecordRefusal(RECORDED_AT + 30 * DAY_MS)).toBeNull();
    expect(await doctorRecordRefusal(RECORDED_AT + 30 * DAY_MS + 1)).toBe(RECORD_OLD);
  });

  it("refuses a run recorded after the moment it is asked", async () => {
    record(complete());
    expect(await doctorRecordRefusal(RECORDED_AT - 1)).toBe("doctor's recorded run is stamped later than now");
  });

  it.each([
    ["has no time", { core: CORE, verdict: "complete" }],
    ["has a null time", { core: CORE, verdict: "complete", at: null }],
    ["has an empty time", { core: CORE, verdict: "complete", at: "" }],
    ["has a time that is not a date", { core: CORE, verdict: "complete", at: "yesterday" }],
    ["has a number for a time", { core: CORE, verdict: "complete", at: RECORDED_AT }],
  ])("refuses when doctor's run %s", async (_what, doctor) => {
    record({ ...complete(), doctor });
    expect(await doctorRecordRefusal(NOW)).toBe("doctor's recorded run has no readable time");
  });

  it("judges by the time it is called at when given none", async () => {
    record({ ...complete(), doctor: { ...complete().doctor, at: new Date().toISOString() } });
    expect(await doctorRecordRefusal()).toBeNull();
    record({ ...complete(), doctor: { ...complete().doctor, at: new Date(Date.now() - 31 * DAY_MS).toISOString() } });
    expect(await doctorRecordRefusal()).toBe(RECORD_OLD);
  });

  // Each reason is the log line's: neutral words, no value from the record.
  it.each([
    ["the state is degraded", { ...complete(), state: "degraded", reason: "migration-incomplete" }, "the migration record does not say ok"],
    ["the state is unknown", { ...complete(), state: "unknown", reason: "core-schema-unknown" }, "the migration record does not say ok"],
    ["the state is missing", { ...complete(), state: undefined }, "the migration record does not say ok"],
    ["doctor's verdict is incomplete", { ...complete(), doctor: { ...complete().doctor, verdict: "incomplete" } },
      "the migration record holds no completed doctor run"],
    ["no doctor run is recorded", { ...complete(), doctor: null }, "the migration record holds no completed doctor run"],
    ["doctor ran for another core", { ...complete(), doctor: { ...complete().doctor, core: "2026.10.3" } },
      "doctor's recorded run was for another core"],
    ["the record is for another core", {
      ...complete(), core: "2026.10.3", doctor: { ...complete().doctor, core: "2026.10.3" },
    }, "the installed core is not the record's core"],
    ["the record names no core", { ...complete(), core: "", doctor: { ...complete().doctor, core: "" } },
      "the migration record names no core"],
    ["the record's core is not a string", { ...complete(), core: 2026, doctor: { ...complete().doctor, core: 2026 } },
      "the migration record names no core"],
    ["the record is an array", [complete()], "there is no readable migration record"],
    ["the record is JSON null", null, "there is no readable migration record"],
  ])("refuses when %s", async (_what, body, why) => {
    record(body === null ? "null" : body);
    expect(await doctorRecordRefusal(NOW)).toBe(why);
  });

  it("refuses when the installed core is another version", async () => {
    record(complete());
    installCore("2026.11.3");
    expect(await doctorRecordRefusal(NOW)).toBe("the installed core is not the record's core");
  });

  it("refuses when the installed core cannot be read", async () => {
    record(complete());
    rmSync(path.join(root, "lib", "node_modules", "openclaw", "package.json"));
    expect(await doctorRecordRefusal(NOW)).toBe("the installed core is not the record's core");
    installCore(42);
    expect(await doctorRecordRefusal(NOW)).toBe("the installed core is not the record's core");
  });

  it("refuses, without throwing, when the installed core cannot be asked at all", async () => {
    record(complete());
    vi.resetModules();
    vi.doMock("@/lib/openclaw-core-generation", () => ({
      installedOpenclawCoreVersion: async () => {
        throw new Error("manifest unreadable");
      },
    }));
    try {
      const fresh = await import("@/lib/openclaw-migration-status");
      expect(await fresh.doctorRecordRefusal(NOW)).toBe("the migration record could not be judged");
    } finally {
      vi.doUnmock("@/lib/openclaw-core-generation");
      vi.resetModules();
    }
  });

  it("refuses, without throwing, when there is no record or it is torn", async () => {
    expect(await doctorRecordRefusal(NOW)).toBe("there is no readable migration record");
    record("{\"state\": \"ok\", \"core\": \"2026.10");
    expect(await doctorRecordRefusal(NOW)).toBe("there is no readable migration record");
  });
});

/**
 * Whether a `doctor --fix` that exited 0 finished the migration, by the rule
 * install.sh records its own run with (`openclaw_migration_complete`). The
 * update's gateway check records a fresh `complete` verdict only on this
 * answer, and that verdict opens install.sh's fast path too, so both must judge
 * a run by the same words.
 */
describe("doctorRunCompleted", () => {
  const INSTALL_SH = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "install.sh"),
    "utf-8",
  );
  /** The phrases install.sh's `openclaw_migration_complete` greps doctor's output for. */
  const installShPhrases = (): string[] => {
    const start = INSTALL_SH.indexOf("\nopenclaw_migration_complete() {");
    const body = INSTALL_SH.slice(start, INSTALL_SH.indexOf("\n}", start + 1));
    const pattern = /grep -qiE '([^']+)'/.exec(body)?.[1] ?? "";
    return pattern.split("|").filter(Boolean);
  };

  it("finds install.sh's rule to compare with", () => {
    expect(installShPhrases().length).toBeGreaterThan(0);
  });

  it("answers true for a run that names no unfinished migration", () => {
    expect(doctorRunCompleted("Doctor complete.\n")).toBe(true);
    expect(doctorRunCompleted("")).toBe(true);
  });

  it("answers false for every phrase install.sh reads as an unfinished migration, in any case", () => {
    for (const phrase of installShPhrases()) {
      expect(doctorRunCompleted(`- ${phrase} for agent main\n`), phrase).toBe(false);
      expect(doctorRunCompleted(phrase.toUpperCase()), phrase).toBe(false);
    }
  });
});

/**
 * The chain the update's full repair relies on, on the real record and the
 * real writer: the verdict is written by the same helper install.sh records
 * its own run with (`record-doctor`), the next check reads it, and the
 * pre-start — which rewrites the record at every gateway start, the unit's own
 * start right after the repair included — carries it forward.
 */
describe.runIf(spawnSync("python3", ["--version"]).status === 0)("a completed doctor run, recorded by install.sh's writer", () => {
  const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "scripts", "openclaw-db-maintenance.py");
  const statusFile = () => path.join(root, "data", "openclaw-migration-status.json");
  const pkg = () => path.join(root, "lib", "node_modules", "openclaw", "package.json");
  const state = () => path.join(root, "state");
  const helper = (cmd: string, args: string[]) => spawnSync("python3", ["-I", HELPER, cmd,
    "--state-dir", state(), "--config", path.join(state(), "openclaw.json"), "--data-dir", path.join(root, "data"),
    "--core-pkg", pkg(), ...args], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin", HOME: root } });
  /** The core's CLI as the pre-start may ask it; nothing here needs an answer. */
  const stubBin = () => {
    const bin = path.join(root, "bin", "openclaw");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\necho '{\"status\":\"ok\",\"totals\":{\"removedBytes\":0}}'\n", { mode: 0o755 });
    return bin;
  };
  /** The record a box carries once doctor's last run is over 30 days old. */
  const stale = () => ({
    ...complete(),
    doctor: { ...complete().doctor, at: new Date(Date.now() - 31 * DAY_MS).toISOString().replace(/\.\d+Z$/, "Z") },
  });

  beforeEach(() => {
    mkdirSync(state(), { recursive: true });
    // The helper reads the core's declared schemas: without them it says
    // `unknown`, never `ok`.
    writeFileSync(pkg(), JSON.stringify({ name: "openclaw", version: CORE, openclaw: { schemaVersions: { agent: 25, state: 20 } } }));
  });

  it("writes a verdict the next check accepts, whole, and the pre-start's rewrite keeps it", async () => {
    record(stale());
    expect(await doctorRecordRefusal()).toBe("doctor's recorded run is more than 30 days old");

    const recorded = helper("record-doctor", ["--verdict", "complete"]);
    expect(recorded.status, recorded.stderr).toBe(0);
    expect(await doctorRecordRefusal()).toBeNull();
    // Replaced whole: no temporary file left beside it, and the record parses.
    expect(readdirSync(path.join(root, "data")).filter((name) => name.includes(".tmp"))).toEqual([]);
    const fresh = JSON.parse(readFileSync(statusFile(), "utf-8")).doctor;
    expect(fresh).toMatchObject({ core: CORE, verdict: "complete" });

    const started = helper("prestart", ["--openclaw-bin", stubBin(), "--budget-seconds", "30"]);
    expect(started.status, started.stderr).toBe(0);
    expect(JSON.parse(readFileSync(statusFile(), "utf-8")).doctor).toEqual(fresh);
    expect(await doctorRecordRefusal()).toBeNull();
  });

  it("leaves a run that was not recorded as it found it, so the next update takes the full repair again", async () => {
    record(stale());
    const before = JSON.parse(readFileSync(statusFile(), "utf-8")).doctor;
    // The full repair's own pre-starts rewrite the record; no verdict follows a
    // doctor that failed or did not finish.
    const started = helper("prestart", ["--openclaw-bin", stubBin(), "--budget-seconds", "30"]);
    expect(started.status, started.stderr).toBe(0);
    expect(JSON.parse(readFileSync(statusFile(), "utf-8")).doctor).toEqual(before);
    expect(await doctorRecordRefusal()).toBe("doctor's recorded run is more than 30 days old");
  });

  it("marks a recorded run due again after a run that did not complete: the next check runs doctor, install.sh's facts stay", async () => {
    // A `complete` from before this update must not stand in for the run that
    // just failed or did not finish.
    record({ ...complete(), doctor: { ...complete().doctor, at: new Date().toISOString().replace(/\.\d+Z$/, "Z") } });
    expect(await doctorRecordRefusal()).toBeNull();
    const due = helper("doctor-due", []);
    expect(due.status, due.stderr).toBe(0);
    expect(await doctorRecordRefusal()).toBe("doctor's recorded run has no readable time");
    // What install.sh's fast path reads is untouched: the state, the core, the verdict and its core.
    const after = JSON.parse(readFileSync(statusFile(), "utf-8"));
    expect(after).toMatchObject({ state: "ok", core: CORE, doctor: { core: CORE, verdict: "complete", at: null } });
    // The pre-start keeps it due; the next completed run records it afresh.
    const started = helper("prestart", ["--openclaw-bin", stubBin(), "--budget-seconds", "30"]);
    expect(started.status, started.stderr).toBe(0);
    expect(await doctorRecordRefusal()).toBe("doctor's recorded run has no readable time");
    expect(helper("record-doctor", ["--verdict", "complete", "--source", "update"]).status).toBe(0);
    expect(await doctorRecordRefusal()).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)("leaves the record byte for byte as it was when the write cannot be made", async () => {
    record(stale());
    const before = readFileSync(statusFile());
    chmodSync(path.join(root, "data"), 0o555);
    try {
      // Said, not hidden: the writer exits non-zero when it could not write.
      expect(helper("record-doctor", ["--verdict", "complete"]).status).not.toBe(0);
    } finally {
      chmodSync(path.join(root, "data"), 0o755);
    }
    expect(readFileSync(statusFile()).equals(before)).toBe(true);
    expect(readdirSync(path.join(root, "data"))).toEqual(["openclaw-migration-status.json"]);
    expect(await doctorRecordRefusal()).toBe("doctor's recorded run is more than 30 days old");
  });
});
