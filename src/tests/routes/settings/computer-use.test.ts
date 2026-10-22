import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/settings/computer-use — the owner's switch for Hermes' built-in
 * computer_use toolset. Pinned: both methods are a 404 while
 * CLAWBOX_COMPUTER_USE_SETTING is not 1 and write nothing; with the flag on,
 * GET reads the tri-state key, POST is owner-only and same-origin, the
 * OpenClaw-only edition is `supported: false` and stores nothing, and on
 * Hermes/dual the key is saved and applied at once — a refused apply is a 502
 * that still carries the saved state.
 */

const h = vi.hoisted(() => ({
  owner: vi.fn(async () => true),
  sameOrigin: vi.fn(() => true),
  apply: vi.fn(async (_enabled: boolean) => ({ applied: true, gatewayRestarted: null as boolean | null, error: null as string | null })),
}));

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: h.owner }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/computer-use-apply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/computer-use-apply")>()),
  applyComputerUseSwitch: h.apply,
}));

let root: string;
let restoreEnv: () => void;
let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

const storePath = () => path.join(root, "data", "config.json");
const stored = () => (fs.existsSync(storePath()) ? JSON.parse(fs.readFileSync(storePath(), "utf-8")) : {});
const post = (body: unknown) =>
  POST(new Request("http://box.local/setup-api/settings/computer-use", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_EDITION", "CLAWBOX_EDITION_FILE", "CLAWBOX_COMPUTER_USE_SETTING");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-computer-use-route-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_EDITION_FILE = path.join(root, "no-such-edition.env");
  ({ GET, POST } = await import("@/app/setup-api/settings/computer-use/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(storePath(), { force: true });
  process.env.CLAWBOX_EDITION = "hermes";
  process.env.CLAWBOX_COMPUTER_USE_SETTING = "1";
  h.owner.mockResolvedValue(true);
  h.sameOrigin.mockReturnValue(true);
  h.apply.mockReset();
  h.apply.mockResolvedValue({ applied: true, gatewayRestarted: null, error: null });
});

describe("with the flag off (the default)", () => {
  it.each([undefined, "0", "true"])("refuses both methods and writes nothing (flag %s)", async (flag) => {
    if (flag === undefined) delete process.env.CLAWBOX_COMPUTER_USE_SETTING;
    else process.env.CLAWBOX_COMPUTER_USE_SETTING = flag;
    const g = await GET();
    expect(g.status).toBe(404);
    expect((await g.json()).code).toBe("setting_off");
    const p = await post({ enabled: false });
    expect(p.status).toBe(404);
    expect(fs.existsSync(storePath())).toBe(false);
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("reads an absent key as unmanaged — Hermes keeps its default", async () => {
    expect(await (await GET()).json()).toEqual({ supported: true, state: "unmanaged", enabled: true });
  });

  it("reads only a boolean as a decision", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_computer_use: "false" }));
    expect((await (await GET()).json()).state).toBe("unmanaged");
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_computer_use: false }));
    expect(await (await GET()).json()).toEqual({ supported: true, state: "off", enabled: false });
  });

  it("is unsupported on the OpenClaw-only edition, and supported on dual", async () => {
    process.env.CLAWBOX_EDITION = "openclaw";
    expect(await (await GET()).json()).toEqual({ supported: false, state: null, enabled: false });
    process.env.CLAWBOX_EDITION = "dual";
    expect((await (await GET()).json()).supported).toBe(true);
  });
});

describe("POST", () => {
  it("refuses a caller without an owner session — the agent cannot grant itself the desktop", async () => {
    h.owner.mockResolvedValue(false);
    expect((await post({ enabled: true })).status).toBe(403);
    expect(fs.existsSync(storePath())).toBe(false);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin page", async () => {
    h.sameOrigin.mockReturnValue(false);
    expect((await post({ enabled: false })).status).toBe(403);
  });

  it("rejects a non-boolean body", async () => {
    expect((await post({ enabled: "no" })).status).toBe(400);
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("stores nothing on the OpenClaw-only edition and says it is unsupported", async () => {
    process.env.CLAWBOX_EDITION = "openclaw";
    const r = await post({ enabled: false });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ supported: false, code: "unsupported" });
    expect(fs.existsSync(storePath())).toBe(false);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("saves off, applies it and answers the saved state", async () => {
    const r = await post({ enabled: false });
    expect(r.status).toBe(200);
    expect(stored().clawbox_computer_use).toBe(false);
    expect(h.apply).toHaveBeenCalledWith(false);
    expect(await r.json()).toMatchObject({ supported: true, state: "off", enabled: false, applied: { hermes: true } });
  });

  it("saves on, and keeps every other key in the store", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_mcp_enabled: true }));
    const r = await post({ enabled: true });
    expect(r.status).toBe(200);
    expect(stored()).toEqual({ clawbox_mcp_enabled: true, clawbox_computer_use: true });
    expect(h.apply).toHaveBeenCalledWith(true);
  });

  it("is a 502 with the saved state when Hermes did not take it", async () => {
    h.apply.mockResolvedValue({ applied: false, gatewayRestarted: null, error: "not yet" });
    const r = await post({ enabled: false });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ state: "off", code: "apply_failed", error: "not yet", applied: { hermes: false } });
    expect(stored().clawbox_computer_use).toBe(false);
  });

  it("is a 500 over a settings file it cannot parse, and logs the kind of failure, never a window of the file", async () => {
    // V8 quotes the input around the fault: here, the bare token whole.
    fs.writeFileSync(storePath(), '{"a": "x", "bot_token": zq7secret}');
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await post({ enabled: false });
      expect(r.status).toBe(500);
      expect((await r.json()).code).toBe("store_write_failed");
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain("the switch could not be saved");
      expect(logged).not.toContain("zq7secret");
      expect(h.apply).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
