import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/harness/mcp — the owner's on/off switch for the ClawBox MCP
 * server, the assistant's device tools (Settings → Harness, 2026-09-15).
 *
 * Pinned here: the GET's shape on every edition, that the POST refuses the
 * MCP bearer and a cross-origin page (a tool that could switch itself back on
 * would make the owner's "off" temporary), that OFF writes the key and then
 * unregisters and restarts each harness this edition runs, that ON writes the
 * key and re-registers, that the dual SKU does both halves, that a store that
 * cannot be written is a 500 with a code and touches nothing, and that a half
 * that failed after the key landed is a 502 carrying the re-read state.
 */

const h = vi.hoisted(() => ({
  owner: vi.fn(async () => true),
  sameOrigin: vi.fn(() => true),
  /** openclaw.json as `readConfigStrict` answers it — ONE object, so the route's delete shows in the re-read. */
  openclawConfig: {} as Record<string, unknown>,
  readConfigStrict: vi.fn(async (): Promise<Record<string, unknown>> => h.openclawConfig),
  writeConfig: vi.fn<(config: Record<string, unknown>) => Promise<void>>(async () => {}),
  restartGateway: vi.fn(async () => {}),
  hermesRead: vi.fn(async (): Promise<{ state: string; value?: string }> => ({ state: "absent" })),
  patchHermesConfig: vi.fn(async () => ({ mode: "merge", backupPath: null })),
  reload: vi.fn(async () => true),
  reloadRefused: vi.fn(async () => {}),
  gatewayStatus: vi.fn(async () => ({ value: { installed: true, running: true, scope: "system" }, answered: true })),
  ensureGateway: vi.fn(async () => ({ installed: true, running: true, scope: "system", applied: true })),
  /** Every execFile call: [command, args]. */
  execCalls: [] as [string, string[]][],
  execResult: { stdout: "[register-mcp] registered\n", stderr: "" } as { stdout: string; stderr: string } | Error,
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: h.owner }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
// PARTIAL, over the real module — see openclaw-config-mock-completeness.test.ts.
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  readConfigStrict: h.readConfigStrict,
  writeConfig: h.writeConfig,
  restartGateway: h.restartGateway,
}));
vi.mock("@/lib/hermes-config-yaml", () => ({
  resolveHermesConfigValue: h.hermesRead,
  patchHermesConfig: h.patchHermesConfig,
}));
vi.mock("@/lib/hermes-mcp-reload", () => ({
  MCP_RELOAD_ASKED: "asked Hermes to reload its MCP servers",
  reloadMcpServers: h.reload,
  reportMcpReloadRefused: h.reloadRefused,
}));
vi.mock("@/lib/hermes-telegram", () => ({
  readHermesGatewayStatus: h.gatewayStatus,
  ensureHermesGateway: h.ensureGateway,
}));
vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  const { promisify } = await import("util");
  // `promisify(execFile)` follows util.promisify.custom, which is how the real
  // execFile resolves to `{ stdout, stderr }` rather than a bare stdout.
  const execFile = ((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, errOut: string) => void) => {
    h.execCalls.push([cmd, args]);
    if (h.execResult instanceof Error) cb(h.execResult, "", "");
    else cb(null, h.execResult.stdout, h.execResult.stderr);
  }) as unknown as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: async (cmd: string, args: string[], opts: unknown) => {
      h.execCalls.push([cmd, args]);
      if (h.execResult instanceof Error) throw h.execResult;
      return { ...h.execResult, opts };
    },
  });
  return { ...actual, execFile };
});

let root: string;
let restoreEnv: () => void;
let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

function storePath(): string {
  return path.join(root, "data", "config.json");
}

function readStore(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storePath(), "utf-8")) as Record<string, unknown>;
}

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://box.local/setup-api/harness/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

function edition(name: "openclaw" | "hermes" | "dual") {
  process.env.CLAWBOX_EDITION = name;
}

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_EDITION", "CLAWBOX_EDITION_FILE");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mcp-route-"));
  // The route's own root, captured by config-store at import time — so the
  // import comes AFTER the env is pointed at it.
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_EDITION_FILE = path.join(root, "no-such-edition.env");
  ({ GET, POST } = await import("@/app/setup-api/harness/mcp/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  edition("openclaw");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(storePath(), { force: true });
  h.openclawConfig = { gateway: { port: 18789 }, mcp: { servers: { clawbox: { command: "bun" }, other: { url: "x" } } } };
  h.owner.mockResolvedValue(true);
  h.sameOrigin.mockReturnValue(true);
  h.readConfigStrict.mockImplementation(async () => h.openclawConfig);
  h.writeConfig.mockResolvedValue(undefined);
  h.restartGateway.mockResolvedValue(undefined);
  h.hermesRead.mockResolvedValue({ state: "present" });
  // A landed unset reads back as absent — the route asks the file after it.
  h.patchHermesConfig.mockImplementation(async () => {
    h.hermesRead.mockResolvedValue({ state: "absent" });
    return { mode: "merge", backupPath: null };
  });
  h.reload.mockResolvedValue(true);
  h.reloadRefused.mockResolvedValue(undefined);
  h.gatewayStatus.mockResolvedValue({ value: { installed: true, running: true, scope: "system" }, answered: true });
  h.ensureGateway.mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });
  h.execCalls.length = 0;
  h.execResult = { stdout: "[register-mcp] registered\n", stderr: "" };
});

afterEach(() => {
  fs.rmSync(storePath(), { force: true });
});

describe("GET /setup-api/harness/mcp", () => {
  it("answers on when the store has never been asked, with the OpenClaw registration and no Hermes half", async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ enabled: true, registered: { openclaw: true, hermes: null } });
  });

  it("reads only an explicit false as off", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_mcp_enabled: false }));
    expect((await (await GET()).json()).enabled).toBe(false);
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_mcp_enabled: "false" }));
    expect((await (await GET()).json()).enabled).toBe(true);
  });

  it("says OpenClaw is not registered when openclaw.json has no entry", async () => {
    h.openclawConfig = { mcp: { servers: { other: {} } } };
    expect((await (await GET()).json()).registered).toEqual({ openclaw: false, hermes: null });
    h.openclawConfig = {};
    expect((await (await GET()).json()).registered).toEqual({ openclaw: false, hermes: null });
  });

  it("answers null for an openclaw.json that could not be read — never 'not registered'", async () => {
    h.readConfigStrict.mockRejectedValue(new Error("EACCES"));
    expect((await (await GET()).json()).registered.openclaw).toBeNull();
  });

  it("on the Hermes edition answers the config.yaml half and no OpenClaw half", async () => {
    edition("hermes");
    expect((await (await GET()).json()).registered).toEqual({ openclaw: null, hermes: true });
    h.hermesRead.mockResolvedValue({ state: "absent" });
    expect((await (await GET()).json()).registered).toEqual({ openclaw: null, hermes: false });
    h.hermesRead.mockResolvedValue({ state: "unreadable" });
    expect((await (await GET()).json()).registered).toEqual({ openclaw: null, hermes: null });
    expect(h.hermesRead).toHaveBeenCalledWith("mcp_servers.clawbox");
  });

  it("on the dual SKU answers both halves", async () => {
    edition("dual");
    expect((await (await GET()).json()).registered).toEqual({ openclaw: true, hermes: true });
  });
});

describe("POST /setup-api/harness/mcp — who may flip it", () => {
  it("refuses the MCP bearer with 403 owner_only and touches nothing", async () => {
    h.owner.mockResolvedValue(false);
    const res = await post({ enabled: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
    expect(fs.existsSync(storePath())).toBe(false);
    expect(h.writeConfig).not.toHaveBeenCalled();
    expect(h.restartGateway).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin page with 403 cross_origin and touches nothing", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await post({ enabled: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
    expect(fs.existsSync(storePath())).toBe(false);
    expect(h.restartGateway).not.toHaveBeenCalled();
  });

  it("refuses a body that is not { enabled: boolean }", async () => {
    for (const body of [{}, { enabled: "false" }, [true], "nope"]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe("bad_body");
    }
    expect(fs.existsSync(storePath())).toBe(false);
  });
});

describe("POST /setup-api/harness/mcp — OpenClaw", () => {
  it("off: writes the key, removes mcp.servers.clawbox, restarts the gateway and answers the re-read state", async () => {
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(readStore().clawbox_mcp_enabled).toBe(false);
    expect(h.writeConfig).toHaveBeenCalledTimes(1);
    const written = h.writeConfig.mock.calls[0][0] as { mcp: { servers: Record<string, unknown> }; gateway: unknown };
    expect(written.mcp.servers).toEqual({ other: { url: "x" } });
    expect(written.gateway).toEqual({ port: 18789 });
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({
      enabled: false,
      registered: { openclaw: false, hermes: null },
      applied: { openclaw: { restarted: true }, hermes: null },
    });
    // Nothing Hermes on this edition.
    expect(h.patchHermesConfig).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.execCalls).toEqual([]);
  });

  it("off with nothing registered: writes no config, still restarts", async () => {
    h.openclawConfig = { gateway: { port: 18789 } };
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(h.writeConfig).not.toHaveBeenCalled();
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
  });

  it("on: writes the key and restarts — the gateway's own pre-start is the registration", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_mcp_enabled: false }));
    const res = await post({ enabled: true });
    expect(res.status).toBe(200);
    expect(readStore().clawbox_mcp_enabled).toBe(true);
    expect(h.writeConfig).not.toHaveBeenCalled();
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
    expect((await res.json()).enabled).toBe(true);
  });

  it("off over an unreadable openclaw.json: the key is saved, nothing is written, and the answer is a 502 with a code", async () => {
    h.readConfigStrict.mockRejectedValue(new Error("EACCES"));
    const res = await post({ enabled: false });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("openclaw_config_unreadable");
    expect(typeof body.error).toBe("string");
    // The state travels with the refusal: the switch IS saved.
    expect(body.enabled).toBe(false);
    expect(readStore().clawbox_mcp_enabled).toBe(false);
    expect(h.writeConfig).not.toHaveBeenCalled();
    expect(h.restartGateway).not.toHaveBeenCalled();
  });

  it("on over a pre-start that left the entry out: 502 openclaw_not_registered, the switch saved, restarted true", async () => {
    // The pre-start skips the entry with only a journal WARN (a short token, a
    // full disk); a restart that succeeded proves nothing about that.
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_mcp_enabled: false }));
    h.openclawConfig = { gateway: { port: 18789 } };
    const res = await post({ enabled: true });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("openclaw_not_registered");
    expect(body.enabled).toBe(true);
    expect(body.applied.openclaw).toEqual({ restarted: true });
    expect(readStore().clawbox_mcp_enabled).toBe(true);
  });

  it("on over an openclaw.json it cannot read back is not called a failure — could not look is not 'not registered'", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_mcp_enabled: false }));
    h.readConfigStrict.mockRejectedValue(new Error("EACCES"));
    const res = await post({ enabled: true });
    expect(res.status).toBe(200);
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
  });

  it("a gateway that did not come back is a 502 gateway_restart_failed over a saved switch", async () => {
    h.restartGateway.mockRejectedValue(new Error("nothing listening"));
    const res = await post({ enabled: false });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("gateway_restart_failed");
    expect(body.enabled).toBe(false);
    expect(body.applied.openclaw).toEqual({ restarted: false });
    expect(readStore().clawbox_mcp_enabled).toBe(false);
  });
});

describe("POST /setup-api/harness/mcp — Hermes", () => {
  beforeEach(() => edition("hermes"));

  it("off: writes the key, unsets mcp_servers.clawbox, reloads the dashboard's MCP servers and restarts a running gateway", async () => {
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(readStore().clawbox_mcp_enabled).toBe(false);
    expect(h.patchHermesConfig).toHaveBeenCalledWith({ unset: ["mcp_servers.clawbox"] });
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.ensureGateway).toHaveBeenCalledTimes(1);
    expect(h.execCalls).toEqual([]);
    // Nothing OpenClaw on this edition.
    expect(h.writeConfig).not.toHaveBeenCalled();
    expect(h.restartGateway).not.toHaveBeenCalled();
    expect((await res.json()).applied).toEqual({ openclaw: null, hermes: { reloaded: true, gatewayRestarted: true } });
  });

  it("on: writes the key, runs register-mcp.sh the way the web-server boot does, then reloads", async () => {
    fs.writeFileSync(storePath(), JSON.stringify({ clawbox_mcp_enabled: false }));
    const res = await post({ enabled: true });
    expect(res.status).toBe(200);
    expect(readStore().clawbox_mcp_enabled).toBe(true);
    expect(h.execCalls).toEqual([["/bin/bash", [path.join(root, "scripts", "register-mcp.sh")]]]);
    expect(h.patchHermesConfig).not.toHaveBeenCalled();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect((await res.json()).applied.hermes).toEqual({ reloaded: true, gatewayRestarted: true });
  });

  it("leaves a gateway that is not running alone, and says so", async () => {
    h.gatewayStatus.mockResolvedValue({ value: { installed: true, running: false, scope: "system" }, answered: true });
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(h.ensureGateway).not.toHaveBeenCalled();
    expect((await res.json()).applied.hermes.gatewayRestarted).toBeNull();
  });

  it("a dashboard that would not reload is reported, not an error", async () => {
    h.reload.mockResolvedValue(false);
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(h.reloadRefused).toHaveBeenCalledTimes(1);
    expect((await res.json()).applied.hermes.reloaded).toBe(false);
  });

  it("off that a straddling boot-script save put back: removed once more, and a 502 hermes_still_registered when it stays", async () => {
    // The Node YAML writer cannot take register-mcp.sh's flock; the file is
    // asked back rather than trusted.
    h.patchHermesConfig.mockResolvedValue({ mode: "merge", backupPath: null });
    h.hermesRead.mockResolvedValue({ state: "present" });
    const res = await post({ enabled: false });
    expect(h.patchHermesConfig).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("hermes_still_registered");
    expect(body.enabled).toBe(false);
    expect(readStore().clawbox_mcp_enabled).toBe(false);
  });

  it("off that a straddling save put back once: the second removal lands and the answer is a plain success", async () => {
    let calls = 0;
    h.patchHermesConfig.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) h.hermesRead.mockResolvedValue({ state: "absent" });
      return { mode: "merge", backupPath: null };
    });
    h.hermesRead.mockResolvedValue({ state: "present" });
    const res = await post({ enabled: false });
    expect(h.patchHermesConfig).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("a config.yaml that could not be written is a 502 hermes_unregister_failed over a saved switch", async () => {
    h.patchHermesConfig.mockRejectedValue(new Error("EACCES: permission denied, open '/home/x/.hermes/config.yaml'"));
    const res = await post({ enabled: false });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("hermes_unregister_failed");
    expect(body.error).not.toContain("/home/x");
    expect(readStore().clawbox_mcp_enabled).toBe(false);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("a register-mcp.sh that failed is a 502 hermes_register_failed", async () => {
    h.execResult = new Error("Command failed: exit 1");
    const res = await post({ enabled: true });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("hermes_register_failed");
    expect(readStore().clawbox_mcp_enabled).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/harness/mcp — the dual SKU", () => {
  beforeEach(() => edition("dual"));

  it("off: does both halves", async () => {
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(h.writeConfig).toHaveBeenCalledTimes(1);
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
    expect(h.patchHermesConfig).toHaveBeenCalledWith({ unset: ["mcp_servers.clawbox"] });
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect((await res.json()).applied).toEqual({
      openclaw: { restarted: true },
      hermes: { reloaded: true, gatewayRestarted: true },
    });
  });

  it("on: restarts the gateway AND runs the Hermes script", async () => {
    const res = await post({ enabled: true });
    expect(res.status).toBe(200);
    expect(h.restartGateway).toHaveBeenCalledTimes(1);
    expect(h.execCalls).toHaveLength(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("a failed OpenClaw half does not stop the Hermes half, and the first failure is the one reported", async () => {
    h.restartGateway.mockRejectedValue(new Error("down"));
    const res = await post({ enabled: false });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("gateway_restart_failed");
    expect(h.patchHermesConfig).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe("POST /setup-api/harness/mcp — the store", () => {
  it("a store that cannot be written is a 500 store_write_failed, and no harness is touched", async () => {
    // A torn store: config-store refuses to write over what it cannot read.
    fs.writeFileSync(storePath(), "{\"clawbox_mcp_enabled\": fal");
    const res = await post({ enabled: false });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "store_write_failed" });
    expect(fs.readFileSync(storePath(), "utf-8")).toBe("{\"clawbox_mcp_enabled\": fal");
    expect(h.writeConfig).not.toHaveBeenCalled();
    expect(h.restartGateway).not.toHaveBeenCalled();
    expect(h.patchHermesConfig).not.toHaveBeenCalled();
  });
});
