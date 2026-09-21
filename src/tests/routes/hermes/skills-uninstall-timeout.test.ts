import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-658 item 2 — a removal that succeeded and then ran out of time was
 * reported as a failure.
 *
 * `runHermesCli` THROWS on its deadline, and the uninstall route's catch turned
 * every throw into `CLI_FAILURE_SENTENCES[code]` + 502. So a `hermes skills
 * uninstall` that deleted the skill and then hung — on the confirmation prompt,
 * on a slow fs sync, on the interpreter's own teardown — answered "The device's
 * Hermes command took too long and was stopped." while the skill was gone. The
 * store painted "Uninstall failed" and kept the row, so the owner's next move
 * is to remove something that is not there.
 *
 * The install route has answered this correctly since PR #504: on a timeout it
 * does not answer yet, it falls through and lets the lock say what landed. The
 * removal path is the mirror image and gets the same rule.
 */

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: vi.fn(async () => ""),
  hermesConfigGetMany: vi.fn(async () => ({})),
  invalidateHermesConfigCache: vi.fn(),
}));

import { runHermesCli } from "@/lib/hermes-cli";
import { saveEnv } from "../../helpers/env";

const mockCli = vi.mocked(runHermesCli);

let hermesHome: string;
const INSTALLED = "oo-terraform";

const skillsDir = () => path.join(hermesHome, "skills");

async function writeLock(installed: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(skillsDir(), ".hub"), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir(), ".hub", "lock.json"),
    JSON.stringify({ version: 1, installed }),
  );
}

async function uninstall(id: string) {
  const { POST } = await import("@/app/setup-api/hermes/skills/uninstall/route");
  const res = await POST(
    new Request("http://localhost/setup-api/hermes/skills/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let restoreEnv: () => void;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
  restoreEnv = saveEnv("HERMES_HOME", "CLAWBOX_ROOT");
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-unto-"));
  process.env.HERMES_HOME = hermesHome;
  await fs.mkdir(path.join(skillsDir(), INSTALLED), { recursive: true });
  await fs.writeFile(path.join(skillsDir(), INSTALLED, "SKILL.md"), "# terraform\n");
  await writeLock({
    [INSTALLED]: {
      install_path: INSTALLED,
      files: ["SKILL.md"],
      identifier: INSTALLED,
      source: "clawhub",
      trust_level: "community",
      scan_verdict: "safe",
    },
  });
});

afterEach(async () => {
  restoreEnv();
  vi.restoreAllMocks();
  await fs.rm(hermesHome, { recursive: true, force: true });
});

describe("POST …/skills/uninstall — a deadline is not an outcome", () => {
  it("reports the removal that DID happen before the CLI ran out of time", async () => {
    // The CLI removed the lock entry and the directory, then hung and was
    // killed. Everything the device can be asked says the skill is gone.
    mockCli.mockImplementation(async () => {
      await writeLock({});
      await fs.rm(path.join(skillsDir(), INSTALLED), { recursive: true, force: true });
      throw new Error("hermes timed out");
    });

    const { status, body } = await uninstall(INSTALLED);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBe(INSTALLED);
  });

  it("still reports a timeout that removed nothing", async () => {
    mockCli.mockRejectedValue(new Error("hermes timed out"));

    const { status, body } = await uninstall(INSTALLED);

    expect(status).toBe(502);
    expect(body.code).toBe("cli_timeout");
    // ...and never runHermesCli's own word for its SIGKILL.
    expect(String(body.error)).not.toMatch(/hermes timed out/i);
  });

  it("does not read a lock it could not parse as proof that everything went", async () => {
    // The deadline lands in the middle of the lock rewrite. `readHubLock` used
    // to answer `{}` for truncated JSON exactly as for a lock that lists
    // nothing — so "the entry is gone" would have been true of every entry,
    // this route would have deleted the directory as well, and the answer would
    // have been ok while the device's whole store list vanished.
    mockCli.mockImplementation(async () => {
      await fs.writeFile(
        path.join(skillsDir(), ".hub", "lock.json"),
        '{"version":1,"installed":{"oo-terr',
      );
      throw new Error("hermes timed out");
    });

    const { status, body } = await uninstall(INSTALLED);

    expect(status).toBe(502);
    // Its own code, not `cli_timeout`: a deadline that left the skill plainly
    // still listed IS a failure; this one is the other thing — the removal is
    // unproven, and the store paints it as such rather than as a red failure
    // over a skill that may well be gone.
    expect(body.code).toBe("uninstall_unproven");
    // ...and the files it could not prove were removed are still there.
    await expect(fs.stat(path.join(skillsDir(), INSTALLED))).resolves.toBeTruthy();
  });

  it("refuses a body that is valid JSON but not an object", async () => {
    // `Request.json()` accepts `null`. Reading `.id` off it throws outside the
    // route's try, so a malformed request answered an uncoded 500 rather than
    // the coded 400 every other refusal on this route now carries.
    const { POST } = await import("@/app/setup-api/hermes/skills/uninstall/route");
    for (const payload of ["null", "[]", '"a string"']) {
      const res = await POST(
        new Request("http://localhost/setup-api/hermes/skills/uninstall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }),
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect(body.code).toBe("invalid_argument");
    }
  });

  it("leaves a non-timeout failure exactly as it was", async () => {
    mockCli.mockRejectedValue(new Error("Hermes is not installed on this device"));

    const { status, body } = await uninstall(INSTALLED);

    expect(status).toBe(502);
    expect(body.code).toBe("cli_missing");
  });
});
