import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { startRootStep } from "@/lib/root-step-runner";
import { runOpenclawConfigSet } from "@/lib/openclaw-config";
import { patchHermesConfig } from "@/lib/hermes-config-yaml";
import { saveEnv } from "@/tests/helpers/env";

/**
 * TASK-514 — the ClawBox thinks it lives in UTC.
 *
 * Measured again read-only on BOTH boxes at beta 3ee0e2ce, 2026-09-06:
 * `timedatectl show -p Timezone --value` = `Etc/UTC` on each, `date` prints
 * 21:41 while the wall clock beside them reads 00:41; `agents.defaults
 * .userTimezone` is absent from `~/.openclaw/openclaw.json` on the OpenClaw
 * box and `hermes config get timezone --json` answers `""` on the Hermes box.
 *
 * Both harnesses own a native key for this and ClawBox writes neither:
 *  - OpenClaw: `agents.defaults.userTimezone` — an IANA zone that feeds the
 *    system prompt's Temporal Context block, message envelopes, heartbeat
 *    active hours and cron (`docs/concepts/timezone.md` in the installed
 *    2026.8.1). Unset ⇒ the core resolves the HOST zone, which is Etc/UTC.
 *  - Hermes: top-level `timezone` in `~/.hermes/config.yaml`
 *    (`hermes_cli/config_defaults.py:2166-2168`, "IANA timezone … Empty string
 *    means use server-local time").
 *
 * The OS zone matters on top of both: Hermes' own prompt tells the agent
 * "Current time, date, timezone → use terminal (e.g. `date`)"
 * (`agent/prompt_builder.py:499`), and the Terminal app is the owner's too.
 */

// One real `mkfifo` runs here (the planted-node case below): vitest's 5 s test
// and 10 s hook defaults are not enough for a file that starts a process on a
// loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts, which
// fails this file without the declaration.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-timezone-tests-${process.pid}-${Date.now()}`);
const TZ_ENV_PATH = path.join(TEST_ROOT, "data", "timezone.env");

const { getMock, setMock, hasHermesHarnessMock, openclawIsAbsentMock, ownerSessionMock, sameOriginMock } =
  vi.hoisted(() => ({
    getMock: vi.fn(),
    setMock: vi.fn(),
    hasHermesHarnessMock: vi.fn(() => false),
    openclawIsAbsentMock: vi.fn(() => false),
    ownerSessionMock: vi.fn(async () => true),
    sameOriginMock: vi.fn(() => true),
  }));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: ownerSessionMock }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: sameOriginMock }));

vi.mock("@/lib/root-step-runner", () => ({
  ROOT_STEP_LAUNCHER: "/usr/local/libexec/clawbox/clawbox-run-root-step.sh",
  startRootStep: vi.fn(async () => {}),
}));
vi.mock("@/lib/config-store", () => ({ get: getMock, set: setMock }));
vi.mock("@/lib/edition-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/edition-source")>()),
  hasHermesHarness: hasHermesHarnessMock,
}));
// PARTIAL, over the real module: a whole-module factory drops
// `GatewayNotReadyError` and every other export, which
// openclaw-config-mock-completeness.test.ts exists to stop.
vi.mock("@/lib/openclaw-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/openclaw-config")>()),
  runOpenclawConfigSet: vi.fn(async () => {}),
  openclawIsAbsent: openclawIsAbsentMock,
}));
vi.mock("@/lib/hermes-config-yaml", async (orig) => ({
  ...(await orig<typeof import("@/lib/hermes-config-yaml")>()),
  patchHermesConfig: vi.fn(async () => ({ mode: "merge", backupPath: null })),
}));
// A landed OS leg re-arms both device-local schedulers (F-B): whole-module
// mocks, because the real ones read the box's `~/.clawkeep/*.json` and would
// arm a real backup timer inside this worker. Their behaviour is pinned in
// src/tests/routes/system/timezone-process-zone.test.ts, not here.
vi.mock("@/lib/clawkeep-scheduler", () => ({ refresh: vi.fn(async () => {}) }));
vi.mock("@/lib/clawkeep-memory-scheduler", () => ({ refresh: vi.fn(async () => {}) }));

const mockStartRootStep = vi.mocked(startRootStep);
const mockConfigSet = vi.mocked(runOpenclawConfigSet);
const mockPatchHermes = vi.mocked(patchHermesConfig);

let restoreEnv: () => void;

beforeAll(async () => {
  // TZ too: a successful POST now sets the process zone, and a worker that
  // kept Europe/Sofia would hand it to every file that runs after this one.
  restoreEnv = saveEnv("CLAWBOX_ROOT", "TZ");
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(path.dirname(TZ_ENV_PATH), { recursive: true });
});

afterAll(async () => {
  restoreEnv();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

/** A store where nothing about the timezone has ever been written. */
function storeEmpty(): void {
  getMock.mockResolvedValue(undefined);
}

/** A store recording `tz`, how it got there, and whether the harness took it. */
function storeHas(tz: string, source: "adopted" | "explicit", applied = true): void {
  getMock.mockImplementation(async (key: string) => {
    if (key === "timezone") return tz;
    if (key === "timezone_source") return source;
    if (key === "timezone_applied") return applied ? tz : undefined;
    return undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ownerSessionMock.mockResolvedValue(true);
  sameOriginMock.mockReturnValue(true);
  storeEmpty();
  setMock.mockResolvedValue(undefined);
  hasHermesHarnessMock.mockReturnValue(false);
  openclawIsAbsentMock.mockReturnValue(false);
  mockStartRootStep.mockResolvedValue(undefined);
  mockConfigSet.mockResolvedValue(undefined);
  mockPatchHermes.mockResolvedValue({ mode: "merge", backupPath: null });
});

afterEach(async () => {
  await fs.rm(TZ_ENV_PATH, { force: true });
});

/** Every temp the route could have left behind, found by shape rather than name. */
async function leftoverTemps(): Promise<string[]> {
  const dir = path.dirname(TZ_ENV_PATH);
  const base = path.basename(TZ_ENV_PATH);
  return (await fs.readdir(dir)).filter((f) => f !== base && f.includes(base));
}

function post(body: unknown): Request {
  return new Request("http://localhost/setup-api/system/timezone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

import { UI_ROOT_STEPS, WEB_ROOT_STEPS } from "@/lib/root-steps";

describe("the privilege the timezone step adds", () => {
  it("is startable by the web server and NOT by install/run-step", () => {
    // `install/run-step` gates on UI_ROOT_STEPS and is reachable with the MCP
    // bearer, so a name on that list is a step the AGENT can start by name.
    expect(WEB_ROOT_STEPS).toContain("set_timezone");
    expect(UI_ROOT_STEPS).not.toContain("set_timezone");
  });
});

describe("/setup-api/system/timezone", () => {
  it("tells the OpenClaw harness the zone through its own userTimezone key", async () => {
    const mod = await import("@/app/setup-api/system/timezone/route");

    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));

    expect(res.status).toBe(200);
    expect(mockConfigSet).toHaveBeenCalledWith(
      expect.arrayContaining(["agents.defaults.userTimezone", "Europe/Sofia"]),
    );
  });

  it("sets the OS zone through the root step, so `date` and the Terminal agree", async () => {
    const mod = await import("@/app/setup-api/system/timezone/route");

    await mod.POST(post({ timezone: "Europe/Sofia" }));

    expect(await fs.readFile(TZ_ENV_PATH, "utf-8")).toContain("TIMEZONE=Europe/Sofia");
    expect(mockStartRootStep).toHaveBeenCalledWith("set_timezone");
  });

  it("writes the Hermes edition's own top-level timezone key", async () => {
    hasHermesHarnessMock.mockReturnValue(true);
    openclawIsAbsentMock.mockReturnValue(true);
    const mod = await import("@/app/setup-api/system/timezone/route");

    await mod.POST(post({ timezone: "Europe/Sofia" }));

    expect(mockPatchHermes).toHaveBeenCalledWith({ set: { timezone: "Europe/Sofia" } });
    // No OpenClaw on that SKU — writing openclaw.json there manufactures the
    // state whose absence defines the edition.
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("does not claim a running Hermes agent is already using the new zone", async () => {
    // Measured read-only on the Hermes box, 2026-09-06: `gateway/run.py:2529`
    // bridges config.yaml's `timezone` into HERMES_TIMEZONE when the gateway
    // STARTS, and hermes_time.py caches the resolved zone for the process.
    hasHermesHarnessMock.mockReturnValue(true);
    openclawIsAbsentMock.mockReturnValue(true);
    const mod = await import("@/app/setup-api/system/timezone/route");

    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));
    const body = await res.json();

    // Pending is not a failure: the write landed, so the answer stays a 200.
    expect(res.status).toBe(200);
    expect(body.applied).toBe(true);
    expect(String(body.warning)).toMatch(/restart/i);
  });

  it("refuses a zone that is not an IANA name", async () => {
    const mod = await import("@/app/setup-api/system/timezone/route");

    for (const bad of ["../../etc/passwd", "Europe/Sofia; rm -rf /", "+03:00", "", "Mars/Olympus"]) {
      const res = await mod.POST(post({ timezone: bad }));
      expect(res.status, `${bad} was accepted`).toBe(400);
    }
    expect(mockStartRootStep).not.toHaveBeenCalled();
  });

  it("answers 400 — not 500 — for a JSON body that is not an object", async () => {
    // `request.json()` resolves just as happily for `null`, a string, a number
    // and an array as for an object. Reading `.timezone` off `null` throws, and
    // Next.js turns that into a bare 500, so the one body shape most likely to
    // arrive from a broken client got the one answer the route never documents.
    const mod = await import("@/app/setup-api/system/timezone/route");

    for (const bad of [null, "Europe/Sofia", 5, [], true]) {
      const res = await mod.POST(post(bad));
      expect(res.status, `${JSON.stringify(bad)} was not refused with 400`).toBe(400);
    }
    expect(mockStartRootStep).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("reports a failed write of timezone.env in its own error shape", async () => {
    // A real filesystem refusal, not a mock: `data/timezone.env` is a directory
    // here, so the write lands in the temp fine and `fs.rename` onto it rejects
    // with EISDIR — the same catch a read-only or full `data/` reaches. Nothing
    // has been recorded and no root step has run at that point, so the caller
    // must be told the zone was NOT saved.
    await fs.rm(TZ_ENV_PATH, { force: true });
    await fs.mkdir(TZ_ENV_PATH, { recursive: true });
    try {
      const mod = await import("@/app/setup-api/system/timezone/route");

      const res = await mod.POST(post({ timezone: "Europe/Sofia" }));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(String(body.error)).toMatch(/could not be saved/i);
      expect(body.success).toBeUndefined();
      expect(mockStartRootStep).not.toHaveBeenCalled();
      expect(mockConfigSet).not.toHaveBeenCalled();
      expect(setMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(TZ_ENV_PATH, { recursive: true, force: true });
    }
  });

  it("replaces a planted node at timezone.env instead of opening it", async () => {
    // The same actor that can write this file can replace it. `writeFile`
    // FOLLOWS a symlink — truncating whatever it points at and leaving the link
    // for the next request — and on a FIFO it blocks in open(2) for ever, with
    // no timeout on a route TimezoneAdopter fires on every desktop load.
    const target = path.join(TEST_ROOT, "data", "collateral.txt");
    await fs.writeFile(target, "not the timezone\n");
    const plants: [string, () => Promise<void>][] = [
      ["symlink", async () => { await fs.symlink(target, TZ_ENV_PATH); }],
      // The status is CHECKED: without a FIFO the POST just writes to a clean
      // path and every assertion below still holds, so the one shape that
      // hangs for ever would be skipped green.
      ["FIFO", async () => {
        const made = spawnSync("mkfifo", [TZ_ENV_PATH]);
        expect(made.error ?? null, "mkfifo did not run").toBeNull();
        expect(made.status, "mkfifo failed").toBe(0);
        expect((await fs.lstat(TZ_ENV_PATH)).isFIFO()).toBe(true);
      }],
    ];

    for (const [name, plant] of plants) {
      await fs.rm(TZ_ENV_PATH, { force: true });
      await plant();
      vi.resetModules();
      const mod = await import("@/app/setup-api/system/timezone/route");

      const res = await mod.POST(post({ timezone: "Europe/Sofia" }));

      expect(res.status, name).toBe(200);
      const stat = await fs.lstat(TZ_ENV_PATH);
      expect(stat.isFile(), name).toBe(true);
      expect(stat.isSymbolicLink(), name).toBe(false);
      expect(await fs.readFile(TZ_ENV_PATH, "utf-8")).toContain("TIMEZONE=Europe/Sofia");
      expect(await fs.readFile(target, "utf-8"), name).toBe("not the timezone\n");
    }
    await fs.rm(target, { force: true });
  });

  it("does not let two overlapping requests write each other's zone", async () => {
    // TimezoneAdopter fires this route on every desktop load, so two tabs are
    // two overlapping requests, and the write sequence awaits between its
    // steps. A temp path shared between them makes one unlink the other's file
    // — a 500 over a healthy data/ — or rename the OTHER request's zone into
    // place and then report its own as applied, leaving the store, the reply
    // and the file the root step reads all disagreeing.
    await fs.rm(TZ_ENV_PATH, { force: true });
    const mod = await import("@/app/setup-api/system/timezone/route");

    const results = await Promise.all(
      Array.from({ length: 12 }, () => mod.POST(post({ timezone: "Europe/Sofia" }))),
    );

    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(await fs.readFile(TZ_ENV_PATH, "utf-8")).toBe("TIMEZONE=Europe/Sofia\n");
    expect(await leftoverTemps()).toEqual([]);
  });

  it("leaves no temp file behind when the write cannot land", async () => {
    await fs.rm(TZ_ENV_PATH, { force: true });
    await fs.mkdir(TZ_ENV_PATH, { recursive: true });
    try {
      const mod = await import("@/app/setup-api/system/timezone/route");

      expect((await mod.POST(post({ timezone: "Europe/Sofia" }))).status).toBe(500);
      // Scanned by SHAPE, not by a fixed name: the temp is
      // `.timezone.env.<uuid>.tmp`, so asserting on `${TZ_ENV_PATH}.tmp` would
      // pass whether or not the catch cleaned anything up.
      expect(await leftoverTemps()).toEqual([]);
    } finally {
      await fs.rm(TZ_ENV_PATH, { recursive: true, force: true });
    }
  });

  it("does adopt when the box has never been told a zone", async () => {
    const mod = await import("@/app/setup-api/system/timezone/route");

    const res = await mod.POST(post({ timezone: "America/New_York", adopt: true }));
    const body = await res.json();

    expect(body.changed).toBe(true);
    expect(body.timezone).toBe("America/New_York");
    expect(mockStartRootStep).toHaveBeenCalledWith("set_timezone");
  });

  it("never lets an offer overwrite a zone a person chose", async () => {
    storeHas("Europe/Sofia", "explicit");
    const mod = await import("@/app/setup-api/system/timezone/route");

    const res = await mod.POST(post({ timezone: "America/New_York", adopt: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.changed).toBe(false);
    expect(body.timezone).toBe("Europe/Sofia");
    expect(mockStartRootStep).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("re-offers over an ADOPTED zone, so a box that changed hands is not stuck", async () => {
    // "First browser to open the desktop wins for ever" strands a box QA'd in
    // one country and used in another: there is no other way to change it.
    storeHas("Europe/Sofia", "adopted");
    const mod = await import("@/app/setup-api/system/timezone/route");

    const body = await (await mod.POST(post({ timezone: "America/New_York", adopt: true }))).json();

    expect(body.changed).toBe(true);
    expect(body.timezone).toBe("America/New_York");
  });

  it("costs nothing when the same zone is offered again to a box that took it", async () => {
    storeHas("Europe/Sofia", "adopted");
    const mod = await import("@/app/setup-api/system/timezone/route");

    const body = await (await mod.POST(post({ timezone: "Europe/Sofia", adopt: true }))).json();

    expect(body.changed).toBe(false);
    expect(mockStartRootStep).not.toHaveBeenCalled();
  });

  it("takes the same zone again when the harness write never landed", async () => {
    // The false success this pair of keys exists for: `openclaw config set`
    // wants 10-12 s on a Jetson and can fail while the gateway is still coming
    // up. If "we were told" alone silenced the offer, that box would answer in
    // UTC for ever with its own state saying the timezone was adopted.
    storeHas("Europe/Sofia", "adopted", false);
    const mod = await import("@/app/setup-api/system/timezone/route");

    const body = await (await mod.POST(post({ timezone: "Europe/Sofia", adopt: true }))).json();

    expect(body.changed).toBe(true);
    expect(mockConfigSet).toHaveBeenCalled();
  });

  it("records the zone as APPLIED only after the harness took it", async () => {
    mockConfigSet.mockRejectedValue(new Error("config set exited 1"));
    const mod = await import("@/app/setup-api/system/timezone/route");

    await mod.POST(post({ timezone: "Europe/Sofia" }));

    expect(setMock).toHaveBeenCalledWith("timezone", "Europe/Sofia");
    expect(setMock).not.toHaveBeenCalledWith("timezone_applied", "Europe/Sofia");
  });

  it("canonicalises the spelling ICU accepts but the device's zoneinfo will not", async () => {
    // `europe/sofia` passes ICU (case-insensitive) and fails the root side's
    // case-sensitive filesystem lookup, which used to discard it in silence.
    const mod = await import("@/app/setup-api/system/timezone/route");

    const body = await (await mod.POST(post({ timezone: "europe/sofia" }))).json();

    expect(body.timezone).toBe("Europe/Sofia");
    expect(await fs.readFile(TZ_ENV_PATH, "utf-8")).toContain("TIMEZONE=Europe/Sofia");
    expect(mockConfigSet).toHaveBeenCalledWith(
      expect.arrayContaining(["agents.defaults.userTimezone", "Europe/Sofia"]),
    );
  });

  it("refuses the agent's bearer and a cross-origin page", async () => {
    // middleware admits any /setup-api/* request carrying a valid MCP bearer,
    // so without this the agent could move the box's clock, both harness zones,
    // OpenClaw's heartbeat active hours and its cron.
    const mod = await import("@/app/setup-api/system/timezone/route");

    ownerSessionMock.mockResolvedValue(false);
    expect((await mod.POST(post({ timezone: "Europe/Sofia" }))).status).toBe(403);

    ownerSessionMock.mockResolvedValue(true);
    sameOriginMock.mockReturnValue(false);
    expect((await mod.POST(post({ timezone: "Europe/Sofia" }))).status).toBe(403);

    expect(mockStartRootStep).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("says the device clock could not be changed when the root step is refused", async () => {
    mockStartRootStep.mockRejectedValue(new Error("systemctl start failed"));
    const mod = await import("@/app/setup-api/system/timezone/route");

    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(String(body.warning)).toMatch(/clock|Terminal/i);
  });

  it("names BOTH legs when both fail", async () => {
    // `harness.failure ?? osFailure` reported only the harness half, so an
    // owner whose clock had also not moved was never told about the clock.
    mockStartRootStep.mockRejectedValue(new Error("unit failed"));
    mockConfigSet.mockRejectedValue(new Error("config set exited 1"));
    const mod = await import("@/app/setup-api/system/timezone/route");

    const body = await (await mod.POST(post({ timezone: "Europe/Sofia" }))).json();

    expect(String(body.warning)).toMatch(/assistant|agent|harness/i);
    expect(String(body.warning)).toMatch(/clock|Terminal/i);
  });

  it("writes the env file 0600, and keeps it 0600 on a rewrite", async () => {
    // install.sh reads this as root and data/ is clawbox-writable. `writeFile`'s
    // `mode` is ignored when the destination already exists, which is half of
    // why the write goes through a fresh temp and a rename — so the second
    // write is the one that matters here.
    await fs.rm(TZ_ENV_PATH, { force: true });
    const mod = await import("@/app/setup-api/system/timezone/route");

    await mod.POST(post({ timezone: "Europe/Sofia" }));
    const first = (await fs.stat(TZ_ENV_PATH)).mode & 0o777;
    await mod.POST(post({ timezone: "America/New_York" }));
    const second = (await fs.stat(TZ_ENV_PATH)).mode & 0o777;

    expect(first.toString(8)).toBe("600");
    expect(second.toString(8)).toBe("600");
  });

  it("does not record the zone as applied when only the OS leg failed", async () => {
    // Recording it there was a permanent false success: GET answered
    // `applied: true`, TimezoneAdopter stopped offering, and `date`, the
    // Terminal and every log line stayed on Etc/UTC for ever, because nothing
    // else re-runs step_set_timezone. Leaving the marker unset IS the retry.
    mockStartRootStep.mockRejectedValue(new Error("unit failed"));
    const mod = await import("@/app/setup-api/system/timezone/route");

    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.applied).toBe(false);
    expect(setMock).not.toHaveBeenCalledWith("timezone_applied", "Europe/Sofia");
    // "until the next reboot" promised a repair that does not exist: nothing
    // reads data/timezone.env at boot.
    expect(String(body.warning)).not.toMatch(/reboot/i);
  });

  it("does not report success when the harness write failed", async () => {
    // False success is the class this repo keeps producing: the OS zone landing
    // while the agent still answers in UTC is exactly half a fix, and the owner
    // must not be told it worked.
    mockConfigSet.mockRejectedValue(new Error("config set exited 1"));
    const mod = await import("@/app/setup-api/system/timezone/route");

    const res = await mod.POST(post({ timezone: "Europe/Sofia" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(String(body.warning ?? body.error)).toMatch(/assistant|agent|harness/i);
  });

  it("reports what the box currently believes, and whether it landed", async () => {
    storeHas("Europe/Sofia", "adopted");
    const mod = await import("@/app/setup-api/system/timezone/route");

    const body = await (await mod.GET()).json();

    expect(body.timezone).toBe("Europe/Sofia");
    expect(typeof body.os).toBe("string");
    expect(body.applied).toBe(true);
    expect(body.acceptsAdoption).toBe(true);
  });

  it("tells a browser not to offer over a zone a person chose", async () => {
    storeHas("Europe/Sofia", "explicit");
    const mod = await import("@/app/setup-api/system/timezone/route");

    const body = await (await mod.GET()).json();

    expect(body.acceptsAdoption).toBe(false);
  });

  it("reports a recorded-but-unapplied zone as not applied", async () => {
    storeHas("Europe/Sofia", "adopted", false);
    const mod = await import("@/app/setup-api/system/timezone/route");

    expect((await (await mod.GET()).json()).applied).toBe(false);
  });
});
