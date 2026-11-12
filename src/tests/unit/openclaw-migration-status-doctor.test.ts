import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { doctorCompleteForInstalledCore } from "@/lib/openclaw-migration-status";

// Whether doctor's own run is recorded complete for the core that is installed:
// the update's gateway check starts a gateway it stopped without running doctor
// again only on this answer, so anything short of proof is `false`. The record
// is data/openclaw-migration-status.json (scripts/openclaw-db-maintenance.py);
// the installed core is the version in the core's own package.json, found from
// OPENCLAW_BIN the way the rest of the web server finds it.

const CORE = "2026.10.9";
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

describe("doctorCompleteForInstalledCore", () => {
  it("answers true when the record says ok and doctor completed for the installed core", async () => {
    record(complete());
    expect(await doctorCompleteForInstalledCore()).toBe(true);
  });

  it("compares the versions trimmed, as both writers read the same manifest", async () => {
    installCore(` ${CORE}\n`);
    record({ ...complete(), core: `${CORE}\n`, doctor: { ...complete().doctor, core: ` ${CORE}` } });
    expect(await doctorCompleteForInstalledCore()).toBe(true);
  });

  it.each([
    ["the state is degraded", { ...complete(), state: "degraded", reason: "migration-incomplete" }],
    ["the state is unknown", { ...complete(), state: "unknown", reason: "core-schema-unknown" }],
    ["the state is missing", { ...complete(), state: undefined }],
    ["doctor's verdict is incomplete", { ...complete(), doctor: { ...complete().doctor, verdict: "incomplete" } }],
    ["no doctor run is recorded", { ...complete(), doctor: null }],
    ["doctor ran for another core", { ...complete(), doctor: { ...complete().doctor, core: "2026.10.3" } }],
    ["the record is for another core", {
      ...complete(), core: "2026.10.3", doctor: { ...complete().doctor, core: "2026.10.3" },
    }],
    ["the record names no core", { ...complete(), core: "", doctor: { ...complete().doctor, core: "" } }],
    ["the record's core is not a string", { ...complete(), core: 2026, doctor: { ...complete().doctor, core: 2026 } }],
    ["the record is an array", [complete()]],
    ["the record is JSON null", null],
  ])("answers false when %s", async (_what, body) => {
    record(body === null ? "null" : body);
    expect(await doctorCompleteForInstalledCore()).toBe(false);
  });

  it("answers false when the installed core is another version", async () => {
    record(complete());
    installCore("2026.11.3");
    expect(await doctorCompleteForInstalledCore()).toBe(false);
  });

  it("answers false when the installed core cannot be read", async () => {
    record(complete());
    rmSync(path.join(root, "lib", "node_modules", "openclaw", "package.json"));
    expect(await doctorCompleteForInstalledCore()).toBe(false);
    installCore(42);
    expect(await doctorCompleteForInstalledCore()).toBe(false);
  });

  it("answers false, without throwing, when there is no record or it is torn", async () => {
    expect(await doctorCompleteForInstalledCore()).toBe(false);
    record("{\"state\": \"ok\", \"core\": \"2026.10");
    expect(await doctorCompleteForInstalledCore()).toBe(false);
  });
});
