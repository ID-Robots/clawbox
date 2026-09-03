import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-whatsapp", () => ({
  WHATSAPP_CHANNEL_ID: "whatsapp",
  setOpenclawWhatsappEnabled: vi.fn(async () => {}),
}));
vi.mock("@/lib/openclaw-channels", () => ({
  ensureChannelPlugin: vi.fn(async () => ({ ok: true, installed: false })),
  invalidateChannelStatus: vi.fn(),
  waitForChannelConnected: vi.fn(async () => null),
}));
vi.mock("@/lib/openclaw-config", () => ({ restartGateway: vi.fn(async () => {}) }));
vi.mock("@/lib/hermes-telegram", () => ({ ensureHermesGateway: vi.fn() }));
vi.mock("@/lib/hermes-whatsapp", async () => {
  // The pure helpers are the contract under test in the unit suite; re-use the
  // real ones here so validation is exercised end to end, and stub only the
  // writer that would touch ~/.hermes/.env.
  const actual = await vi.importActual<typeof import("@/lib/hermes-whatsapp")>(
    "@/lib/hermes-whatsapp",
  );
  return { ...actual, setHermesWhatsappConfig: vi.fn() };
});

import { getActiveHarness } from "@/lib/harness";
import { ensureHermesGateway } from "@/lib/hermes-telegram";
import { setHermesWhatsappConfig, WhatsappNotPairedError } from "@/lib/hermes-whatsapp";

const mockHarness = vi.mocked(getActiveHarness);
const mockEnsure = vi.mocked(ensureHermesGateway);
const mockSet = vi.mocked(setHermesWhatsappConfig);

let POST: typeof import("@/app/setup-api/whatsapp/configure/route").POST;

const post = (body: unknown, signal?: AbortSignal) =>
  POST(
    new Request("http://localhost/setup-api/whatsapp/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
  );

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockHarness.mockResolvedValue("hermes");
  mockSet.mockResolvedValue({
    changedKeys: ["WHATSAPP_ALLOWED_USERS"],
    paired: true,
    authorized: true,
  });
  mockEnsure.mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });
  POST = (await import("@/app/setup-api/whatsapp/configure/route")).POST;
});

describe("POST /setup-api/whatsapp/configure", () => {
  it("rejects malformed JSON", async () => {
    const res = await post("{ not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON");
  });

  it("rejects well-formed JSON that is not an object", async () => {
    // `null`, `true`, numbers and arrays all parse. The ConfigureBody
    // annotation is erased at runtime, so a `null` body used to reach
    // `body.allowedUsers`, throw a TypeError, and come back as a 500 carrying
    // the raw JavaScript message. These are bad requests, not server faults.
    for (const raw of ["null", "true", "42", '"a string"', "[]"]) {
      const res = await post(raw);
      expect(res.status, `body ${raw}`).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON");
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("never writes Hermes env on an OpenClaw device", async () => {
    // The 501 this used to assert is gone — OpenClaw has its own leg now (see
    // openclaw.test.ts). The invariant that survives, and matters more, is that
    // setHermesWhatsappConfig() is not what answers there: it writes
    // ~/.hermes/.env, which on an OpenClaw box configures nothing and leaves a
    // credential file behind for a harness that is not installed.
    mockHarness.mockResolvedValue("openclaw");
    await post({ enabled: false });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects an empty body rather than pretending to save", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Nothing to update");
  });

  it("normalises the allowlist it forwards", async () => {
    const res = await post({ allowedUsers: ["+1 (555) 123-4567", "359 88 123 4567"] });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({ allowedUsers: ["15551234567", "359881234567"] });
  });

  it("rejects a bad number instead of silently dropping it", async () => {
    // Silently dropping would leave the owner staring at an allowlist that
    // quietly excludes the number they just typed.
    const res = await post({ allowedUsers: ["15551234567", "12"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid phone number");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a non-array or non-string allowlist", async () => {
    expect((await post({ allowedUsers: "15551234567" })).status).toBe(400);
    expect((await post({ allowedUsers: [15551234567] })).status).toBe(400);
  });

  it("caps the allowlist size", async () => {
    const many = Array.from({ length: 65 }, (_, i) => `1555000${String(i).padStart(4, "0")}`);
    const res = await post({ allowedUsers: many });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("only accepts the two documented modes", async () => {
    // BOTH documented modes, not just one: asserting "bot" alone would still
    // pass if the allowlist were narrowed to "bot" and self-chat quietly
    // stopped being settable from the panel.
    expect((await post({ mode: "bot" })).status).toBe(200);
    expect((await post({ mode: "self-chat" })).status).toBe(200);
    expect(mockSet).toHaveBeenLastCalledWith({ mode: "self-chat" });
    expect((await post({ mode: "selfchat" })).status).toBe(400);
    expect((await post({ mode: "self_chat" })).status).toBe(400);
  });

  it("requires a boolean for enabled", async () => {
    const res = await post({ enabled: "true" });
    expect(res.status).toBe(400);
  });

  it("maps the not-paired refusal to 409 rather than a 500", async () => {
    mockSet.mockRejectedValue(new WhatsappNotPairedError());
    const res = await post({ enabled: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_paired");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("restarts the gateway after a successful write", async () => {
    const body = await (await post({ mode: "bot" })).json();
    expect(mockEnsure).toHaveBeenCalled();
    expect(body).toMatchObject({ success: true, restarted: true });
  });

  it("does not let a browser that walked away cancel the restart its own write needs", async () => {
    // The owner adds his number to the allowlist and the browser disconnects
    // during the save. ~/.hermes/.env already holds the new
    // WHATSAPP_ALLOWED_USERS, so the only thing that can still make it true is
    // the gateway restart below — and passing `request.signal` into it means
    // `runHermesCli` refuses before it even starts. The running gateway keeps
    // the old allowlist and keeps refusing him, while the "restart_pending"
    // warning goes to a client that is gone.
    const controller = new AbortController();
    mockSet.mockImplementation(async () => {
      controller.abort();
      return { changedKeys: ["WHATSAPP_ALLOWED_USERS"], paired: true, authorized: true };
    });
    mockEnsure.mockImplementation(async (signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("hermes call cancelled");
      return { installed: true, running: true, scope: "system" as const, applied: true };
    });

    const res = await post({ allowedUsers: ["15551234567"] }, controller.signal);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, restarted: true });
    // No argument, deliberately: past the first durable write, finish the job.
    expect(mockEnsure).toHaveBeenCalledWith();
  });

  it("still reports success when the gateway will not come up", async () => {
    // The .env write already happened; a restart failure is a warning, never a
    // failed save (same contract as /telegram/configure).
    mockEnsure.mockRejectedValue(new Error("systemctl: unit masked"));
    const res = await post({ mode: "bot" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, restarted: false, warning: "restart_pending" });
  });

  it("reports success without a restart when the gateway is not running", async () => {
    mockEnsure.mockResolvedValue({ installed: false, running: false, scope: null, applied: false });
    const body = await (await post({ mode: "bot" })).json();
    expect(body).toMatchObject({ success: true, restarted: false, warning: "restart_pending" });
  });

  it("skips the restart entirely when nothing actually changed", async () => {
    mockSet.mockResolvedValue({ changedKeys: [], paired: true, authorized: true });
    const body = await (await post({ mode: "bot" })).json();
    expect(body).toMatchObject({ success: true, unchanged: true, restarted: false });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("warns when a paired box would end up authorizing nobody", async () => {
    // The gateway checks the sender separately from the pairing, so this is the
    // difference between "saved" and "saved, and your box will ignore you".
    mockSet.mockResolvedValue({
      changedKeys: ["WHATSAPP_ENABLED", "WHATSAPP_ALLOWED_USERS"],
      paired: true,
      authorized: false,
    });
    const body = await (await post({ enabled: true, allowedUsers: [] })).json();
    expect(body).toMatchObject({ success: true, warning: "no_allowed_users" });
  });

  it("does not cry 'no users' about a box that was never paired", async () => {
    mockSet.mockResolvedValue({
      changedKeys: ["WHATSAPP_MODE"],
      paired: false,
      authorized: false,
    });
    const body = await (await post({ mode: "bot" })).json();
    expect(body.warning).toBeUndefined();
  });

  it("keeps the authorization warning when the restart also fails", async () => {
    // Two things are wrong; the more actionable one is not allowed to hide the
    // other, and "restart_pending" is the recoverable half.
    mockSet.mockResolvedValue({
      changedKeys: ["WHATSAPP_ENABLED"],
      paired: true,
      authorized: false,
    });
    mockEnsure.mockResolvedValue({ installed: false, running: false, scope: null, applied: false });
    const body = await (await post({ enabled: true })).json();
    expect(body).toMatchObject({ success: true, restarted: false, warning: "no_allowed_users" });
  });

  it("returns 500 without echoing the exception message", async () => {
    // Filesystem failures under ~/.hermes carry absolute paths and syscall
    // names. The panel translates a fixed string; the real cause is logged.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSet.mockRejectedValue(new Error("ENOSPC: no space left on device, open '/home/clawbox/.hermes/.env'"));
    const res = await post({ mode: "bot" });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to save");
    expect(JSON.stringify(body)).not.toContain("/home/clawbox");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
