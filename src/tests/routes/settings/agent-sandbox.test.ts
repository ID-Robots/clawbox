import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/settings/agent-sandbox — the owner's switch for the agent tool
 * sandbox. Pinned: OFF by default and only an exact true is on; GET spawns
 * nothing while the switch is off; the POST refuses a non-owner (the agent's
 * MCP bearer), a cross-origin page and a Hermes edition before anything is
 * saved; on writes the key, restarts the gateway, reads the mode back and
 * starts the runtime install when the box has none.
 */

type Cb = (err: unknown, out?: { stdout: string; stderr: string }) => void;

const h = vi.hoisted(() => ({
  owner: vi.fn(async () => true),
  sameOrigin: vi.fn(() => true),
  openclawConfig: {} as Record<string, unknown>,
  readConfigStrict: vi.fn(async (): Promise<Record<string, unknown>> => h.openclawConfig),
  restartGateway: vi.fn(async () => {}),
  startRootStep: vi.fn(async (_step: string, _opts?: unknown) => {}),
  podmanReady: true,
  execFile: vi.fn(),
}));

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: h.owner }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  readConfigStrict: h.readConfigStrict,
  restartGateway: h.restartGateway,
}));
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: h.startRootStep }));
vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return { ...orig, execFile: h.execFile, default: { ...orig, execFile: h.execFile } };
});

let root: string;
let restoreEnv: () => void;
let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

const KEY = "clawbox_agent_sandbox_enabled";
const BUDGET = { memoryBytes: 512 * 1024 ** 2, diskBytes: 2 * 1024 ** 3 };
const storePath = () => path.join(root, "data", "config.json");
const withMode = (mode: string) => ({ agents: { defaults: { sandbox: { mode } } } });
const post = (body: unknown) =>
  POST(new Request("http://box.local/setup-api/settings/agent-sandbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_EDITION", "CLAWBOX_EDITION_FILE");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-agent-sandbox-route-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_EDITION = "openclaw";
  process.env.CLAWBOX_EDITION_FILE = path.join(root, "no-such-edition.env");
  ({ GET, POST } = await import("@/app/setup-api/settings/agent-sandbox/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CLAWBOX_EDITION = "openclaw";
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(storePath(), { force: true });
  h.openclawConfig = {};
  h.podmanReady = true;
  h.owner.mockResolvedValue(true);
  h.sameOrigin.mockReturnValue(true);
  h.restartGateway.mockReset();
  h.restartGateway.mockResolvedValue(undefined);
  h.startRootStep.mockReset();
  h.startRootStep.mockResolvedValue(undefined);
  h.execFile.mockReset();
  h.execFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: Cb) => {
    if (cmd === "podman") {
      return h.podmanReady
        ? cb(null, { stdout: "", stderr: "" })
        : cb(Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" }));
    }
    if (cmd === "/usr/bin/systemctl") return cb(null, { stdout: "ActiveState=inactive\n", stderr: "" });
    return cb(new Error(`unexpected command ${cmd}`));
  });
});

describe("GET", () => {
  it("is off by default, reads OpenClaw's default mode, and spawns nothing while off", async () => {
    const r = await GET();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      available: true,
      enabled: false,
      known: true,
      mode: "off",
      runtime: null,
      provisioning: null,
      budget: BUDGET,
    });
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("reads only an exact true as on, and then reports the runtime", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ [KEY]: "true" }));
    expect((await (await GET()).json()).enabled).toBe(false);
    fs.writeFileSync(storePath(), JSON.stringify({ [KEY]: true }));
    h.openclawConfig = withMode("non-main");
    expect(await (await GET()).json()).toMatchObject({ enabled: true, mode: "non-main", runtime: "ready", provisioning: false });
  });

  it("says the store could not be read rather than guessing on", async () => {
    fs.writeFileSync(storePath(), "{torn");
    expect(await (await GET()).json()).toMatchObject({ enabled: false, known: false });
  });

  it("is not available on a Hermes edition", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    expect(await (await GET()).json()).toMatchObject({ available: false, mode: null, runtime: null });
  });
});

describe("POST", () => {
  it("refuses a caller without an owner session — the agent cannot switch its own sandbox off", async () => {
    h.owner.mockResolvedValue(false);
    const r = await post({ enabled: false });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("owner_only");
    expect(fs.existsSync(storePath())).toBe(false);
    expect(h.restartGateway).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin page", async () => {
    h.sameOrigin.mockReturnValue(false);
    const r = await post({ enabled: true });
    expect(r.status).toBe(403);
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("refuses a Hermes edition before anything is saved", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    const r = await post({ enabled: true });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("not_openclaw");
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it.each([[{ enabled: "yes" }], [{}], [[true]], [null]])("rejects the body %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("saves on, restarts the gateway, reads the pre-start's mode back and installs the missing runtime", async () => {
    h.podmanReady = false;
    h.restartGateway.mockImplementation(async () => { h.openclawConfig = withMode("non-main"); });
    const r = await post({ enabled: true });
    expect(r.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(storePath(), "utf-8"))[KEY]).toBe(true);
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
    expect(h.startRootStep).toHaveBeenCalledWith("openclaw_config", { noBlock: true });
    expect(await r.json()).toMatchObject({
      enabled: true,
      mode: "non-main",
      runtime: "missing",
      // The install it just started, even before systemd shows it running.
      provisioning: true,
      applied: { openclaw: { restarted: true }, provisioning: true },
    });
  });

  it("saves off and restarts, leaving the runtime alone", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ [KEY]: true }));
    h.restartGateway.mockImplementation(async () => { h.openclawConfig = withMode("off"); });
    const r = await post({ enabled: false });
    expect(r.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(storePath(), "utf-8"))[KEY]).toBe(false);
    expect(h.startRootStep).not.toHaveBeenCalled();
    expect(await r.json()).toMatchObject({ enabled: false, mode: "off", runtime: null });
  });

  it("is a 502 with the saved state when the gateway did not come back", async () => {
    h.restartGateway.mockRejectedValue(new Error("timeout"));
    const r = await post({ enabled: false });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ enabled: false, code: "apply_failed" });
  });
});
