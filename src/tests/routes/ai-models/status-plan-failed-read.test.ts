// `ai-models/status` answers `clawaiPlan: "free"` when the box has no ClawBox AI
// account at all — and it reached that answer from a config read that FAILED as
// well. `readConfig()` answers `{}` to an unreadable or half-written
// openclaw.json, and a `hermes config get` that times out answers `""`, so both
// looked like "no ClawBox AI profile". A paying owner's desktop then opened
// "your plan is now Free", and later celebrated a fake upgrade. The route's own
// catch says the rule — a failed read is "not known", never Free — but these
// reads never reached it.
//
// Held here against the REAL readers: a read that did not complete is not
// known (null) on both runtimes, and a box that really has no account still
// reads Free.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesCliResult } from "@/lib/hermes-cli";

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/clawai-plan-follow", () => ({ followClawaiPlanChange: vi.fn(async () => {}) }));

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { runHermesCli } from "@/lib/hermes-cli";

// A paying owner: a paired token, the Pro plan on record, and a portal that
// answers Max whenever it is asked.
const STORE: Record<string, unknown> = { clawai_token: "claw_paying123", clawai_tier: "flash", clawai_plan_tier: "pro" };
const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ tier: "max", deviceTier: "flash" }), { status: 200 }));

const saved = { openclaw: process.env.CLAWBOX_OPENCLAW_HOME, hermes: process.env.HERMES_HOME };
let root: string;
let openclawHome: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "status-plan-failed-read-"));
  openclawHome = path.join(root, ".openclaw");
  fs.mkdirSync(openclawHome);
  fs.mkdirSync(path.join(root, ".hermes"));
  fs.writeFileSync(path.join(root, ".hermes", "config.yaml"), "model:\n  provider: clawai\n");
  process.env.CLAWBOX_OPENCLAW_HOME = openclawHome;
  process.env.HERMES_HOME = path.join(root, ".hermes");
});

afterAll(() => {
  if (saved.openclaw === undefined) delete process.env.CLAWBOX_OPENCLAW_HOME;
  else process.env.CLAWBOX_OPENCLAW_HOME = saved.openclaw;
  if (saved.hermes === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = saved.hermes;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.resetModules();
  vi.mocked(get).mockImplementation(async (k: string) => STORE[k] ?? null);
  vi.mocked(set).mockResolvedValue(undefined);
  vi.mocked(runHermesCli).mockReset();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  fs.rmSync(path.join(openclawHome, "openclaw.json"), { force: true });
  (await import("@/lib/clawbox-ai-portal-tier"))._resetPortalTierCache();
});

async function plan() {
  const { GET } = await import("@/app/setup-api/ai-models/status/route");
  return (await (await GET()).json()).clawaiPlan;
}

describe("OpenClaw", () => {
  beforeEach(() => {
    vi.mocked(getActiveHarness).mockResolvedValue("openclaw");
  });

  it("does not call a half-written openclaw.json the Free plan", async () => {
    // Caught mid-write by a concurrent `openclaw config set`.
    fs.writeFileSync(path.join(openclawHome, "openclaw.json"), '{"auth":{"profiles":{"deepseek:default":{"provi');
    expect(await plan()).toBeNull();
  });

  it("still reads Free on a box that has no openclaw.json yet", async () => {
    expect(await plan()).toBe("free");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Hermes", () => {
  beforeEach(() => {
    vi.mocked(getActiveHarness).mockResolvedValue("hermes");
  });

  it("does not call a timed-out hermes config read the Free plan", async () => {
    vi.mocked(runHermesCli).mockRejectedValue(new Error("hermes config get timed out after 10000ms"));
    expect(await plan()).toBeNull();
  });

  it("still reads Free when Hermes answers that no ClawBox AI provider is set", async () => {
    vi.mocked(runHermesCli).mockImplementation(async (args: string[]) => (
      args[2] === "model.provider"
        ? { code: 0, stdout: "openrouter\n", stderr: "" }
        : { code: 1, stdout: "", stderr: `Config key not set: ${args[2]}` }
    ) as HermesCliResult);
    expect(await plan()).toBe("free");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
