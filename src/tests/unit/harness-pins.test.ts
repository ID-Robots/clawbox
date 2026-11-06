import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHermesPin, readOpenclawPin } from "../../../scripts/harness-pins.mjs";

/**
 * ONE pin per harness, and every place that has to repeat it agrees.
 *
 * The OpenClaw pin is `config/openclaw-target.txt` and the Hermes pin is the
 * default of `HERMES_PIN_COMMIT` in install.sh — scripts/harness-pins.mjs says
 * why those two and not a new file. Everything else that names a version is a
 * fallback for the moment the source cannot be read, or a table keyed by it,
 * and the case for each is here. A pin bump that forgets one of them fails
 * this file, not a box.
 *
 * What only upstream can answer — the pinned package's own state schema and
 * Node engine, and whether the Hermes tag still points at the pinned commit —
 * is checked by the `harness-contract` CI job against the real harness.
 */
// The build-stamp case starts a real node: see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string) => fs.readFileSync(path.join(REPO, file), "utf-8");

const OPENCLAW_PIN = readOpenclawPin(REPO);
const HERMES_PIN = readHermesPin(REPO);

describe("the OpenClaw pin", () => {
  it("is one version, in config/openclaw-target.txt", () => {
    expect(OPENCLAW_PIN, "config/openclaw-target.txt").toMatch(/^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
  });

  it("pins the same core version everywhere it is written down", () => {
    // THREE fallbacks, and every one of them is for the same moment: the pin
    // file cannot be read. `OPENCLAW_VERSION` in each installer is the version
    // a corrupted or partial install lands on; `OPENCLAW_VERSION_FALLBACK` in
    // the updater is what the UI's "Latest" column and the managed-plugin
    // reinstall use. They drifted once, and the cost was not a cosmetic one:
    // install.sh fell back to the new pin while updater.ts fell back to the old,
    // so the UI answered "no OpenClaw update available" over a box that had one
    // (false success) and the channel plugins were pinned to the previous core's
    // version on the new core. Nothing can derive these — they exist for the
    // moment the shared file is unavailable — so this case is the guard.
    for (const installer of ["install.sh", "install-x64.sh"]) {
      const fallback = /^OPENCLAW_VERSION="([^"]*)"$/m.exec(read(installer))?.[1];
      expect(fallback, `OPENCLAW_VERSION in ${installer}`).toBe(OPENCLAW_PIN);
    }
    const fallback = /^const OPENCLAW_VERSION_FALLBACK = "([^"]*)";$/m.exec(read("src/lib/updater.ts"))?.[1];
    expect(fallback, "OPENCLAW_VERSION_FALLBACK in src/lib/updater.ts").toBe(OPENCLAW_PIN);
  });

  it("records which state schema the pinned core supports", () => {
    // The thing a bump forgets most easily: OpenClaw migrates
    // `state/openclaw.sqlite` forward and never back, so a core that meets a
    // newer file refuses to open it and the box loses its assistant mid-update.
    // `OPENCLAW_STATE_SCHEMA_BY_VERSION` is what the updater's pre-flight
    // compares against, and `openclawStateSchemaFor` answers null for a version
    // it has never been told about — which makes the pre-flight stand down
    // silently. Bumping the pin without adding its row would therefore not fail
    // anything at runtime; it would just quietly switch the guard off. This is
    // the guard for the guard; the harness-contract job checks the number.
    //
    // Read from the source rather than imported: importing the updater pulls
    // its whole Node surface into a test that only wants one table.
    const table = /OPENCLAW_STATE_SCHEMA_BY_VERSION[^{]*\{([^}]*)\}/.exec(read("src/lib/updater.ts"))?.[1];
    expect(table, "OPENCLAW_STATE_SCHEMA_BY_VERSION in src/lib/updater.ts").toBeTypeOf("string");
    expect(table, `no state schema recorded for the pinned ${OPENCLAW_PIN}`).toMatch(
      new RegExp(`"${String(OPENCLAW_PIN).replaceAll(".", "\\.")}"\\s*:\\s*\\d+`),
    );
  });

  it("records which agent-database schema the pinned core supports", () => {
    // The same guard for the agent databases, which move on their own: the
    // 2026.10.6 pin took them to 25 with the state database still on 20, and a
    // pre-flight that read only the state table let a box that had run it
    // install 2026.10.3, whose repair step then refused every agent database.
    const table = /OPENCLAW_AGENT_SCHEMA_BY_VERSION[^{]*\{([^}]*)\}/.exec(read("src/lib/updater.ts"))?.[1];
    expect(table, "OPENCLAW_AGENT_SCHEMA_BY_VERSION in src/lib/updater.ts").toBeTypeOf("string");
    expect(table, `no agent schema recorded for the pinned ${OPENCLAW_PIN}`).toMatch(
      new RegExp(`"${String(OPENCLAW_PIN).replaceAll(".", "\\.")}"\\s*:\\s*\\d+`),
    );
  });

  it("is not copied into the e2e image", () => {
    // The image models a box BEFORE the update and installs no core of its own,
    // so a version there could only be a comment — and a comment that names
    // the pin is the copy nobody bumps.
    const copies = read("e2e-install/Dockerfile").split("\n").filter((l) => l.includes(String(OPENCLAW_PIN)));
    expect(copies, "e2e-install/Dockerfile lines naming the pin").toEqual([]);
  });
});

describe("the Hermes pin", () => {
  it("is the full commit, with the release tag it is named for", () => {
    expect(HERMES_PIN?.commit, "HERMES_PIN_COMMIT in install.sh").toMatch(/^[0-9a-f]{40}$/);
    expect(HERMES_PIN?.tag, "the `# Current pin: upstream tag …` line in install.sh").toMatch(/^v\d/);
  });

  it("names its tag on the line right above the pin", () => {
    // The tag is the human half of the pin, and the only copy of it: the CI job
    // asks upstream whether it still points at the commit, so it has to sit
    // where a bump edits the commit.
    const lines = read("install.sh").split("\n");
    const at = lines.findIndex((l) => l.startsWith("HERMES_PIN_COMMIT="));
    expect(lines[at - 1]).toContain(`# Current pin: upstream tag ${HERMES_PIN?.tag} `);
  });
});

describe("the build stamp", () => {
  it("records the pins the tree carries", () => {
    // scripts/write-build-info.mjs reads both pins itself (it must never fail a
    // build, so it imports nothing it could miss). Run it over a tree holding
    // only the two pin sources and compare.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pins-"));
    try {
      fs.mkdirSync(path.join(dir, "config"));
      fs.copyFileSync(path.join(REPO, "install.sh"), path.join(dir, "install.sh"));
      fs.copyFileSync(path.join(REPO, "config/openclaw-target.txt"), path.join(dir, "config/openclaw-target.txt"));
      const run = spawnSync("node", [path.join(REPO, "scripts/write-build-info.mjs")], {
        cwd: dir,
        env: { ...process.env, CLAWBOX_ROOT: dir },
        encoding: "utf-8",
      });
      expect(run.status, run.stderr).toBe(0);
      const info = JSON.parse(fs.readFileSync(path.join(dir, ".next/build-info.json"), "utf-8"));
      expect(info.openclawPin).toBe(OPENCLAW_PIN);
      expect(info.hermesPin).toBe(HERMES_PIN?.commit);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
