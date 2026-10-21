import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/settings/path-guard — the owner's switch for the protected-path
 * guard (TASK-1661). Pinned: on by default, only an explicit false is off, the
 * POST refuses a non-owner (the agent's MCP bearer) and a cross-origin page,
 * the key is written and the gateway restarted, and the pre-start's result is
 * read back from openclaw.json.
 */

const h = vi.hoisted(() => ({
  owner: vi.fn(async () => true),
  sameOrigin: vi.fn(() => true),
  openclawConfig: {} as Record<string, unknown>,
  readConfigStrict: vi.fn(async (): Promise<Record<string, unknown>> => h.openclawConfig),
  restartGateway: vi.fn(async () => {}),
}));

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: h.owner }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  readConfigStrict: h.readConfigStrict,
  restartGateway: h.restartGateway,
}));

let root: string;
let restoreEnv: () => void;
let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

const storePath = () => path.join(root, "data", "config.json");
const entry = (enabled: boolean) => ({ plugins: { entries: { "clawbox-path-guard": { enabled } } } });
const post = (body: unknown) =>
  POST(new Request("http://box.local/setup-api/settings/path-guard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_EDITION", "CLAWBOX_EDITION_FILE");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-path-guard-route-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_EDITION = "openclaw";
  process.env.CLAWBOX_EDITION_FILE = path.join(root, "no-such-edition.env");
  ({ GET, POST } = await import("@/app/setup-api/settings/path-guard/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(storePath(), { force: true });
  h.openclawConfig = entry(true);
  h.owner.mockResolvedValue(true);
  h.sameOrigin.mockReturnValue(true);
  h.restartGateway.mockReset();
  h.restartGateway.mockResolvedValue(undefined);
});

describe("GET", () => {
  it("is on by default and reports the plugin entry", async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true, loaded: true });
  });

  it("reads only an explicit false as off", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_path_guard_enabled: "false" }));
    expect((await (await GET()).json()).enabled).toBe(true);
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_path_guard_enabled: false }));
    expect((await (await GET()).json()).enabled).toBe(false);
  });
});

describe("POST", () => {
  it("refuses a caller without an owner session — the agent cannot switch its own guard off", async () => {
    h.owner.mockResolvedValue(false);
    const r = await post({ enabled: false });
    expect(r.status).toBe(403);
    expect(fs.existsSync(storePath())).toBe(false);
    expect(h.restartGateway).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin page", async () => {
    h.sameOrigin.mockReturnValue(false);
    expect((await post({ enabled: false })).status).toBe(403);
  });

  it("rejects a non-boolean body", async () => {
    expect((await post({ enabled: "no" })).status).toBe(400);
  });

  it("saves off, restarts the gateway and reads the pre-start's result back", async () => {
    h.restartGateway.mockImplementation(async () => { h.openclawConfig = entry(false); });
    const r = await post({ enabled: false });
    expect(r.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(storePath(), "utf-8")).clawbox_path_guard_enabled).toBe(false);
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
    expect(await r.json()).toMatchObject({ enabled: false, loaded: false });
  });

  it("is a 502 with the saved state when the gateway did not come back", async () => {
    h.restartGateway.mockRejectedValue(new Error("timeout"));
    const r = await post({ enabled: false });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ enabled: false, code: "apply_failed" });
  });
});
