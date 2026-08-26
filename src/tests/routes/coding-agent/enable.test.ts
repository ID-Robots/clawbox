/**
 * POST /setup-api/coding-agent/enable — the owner's switch.
 *
 * The property under test: the AGENT cannot flip it. Middleware admits the
 * MCP bearer to every /setup-api/* path and the agent holds that bearer, so
 * this route has to refuse it in-handler with the real cookie verifier, the
 * way email/pending does. A valid bearer and no credential get the identical
 * 403, so the answer leaks nothing about which one was tried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));

const setEnabled = vi.hoisted(() => vi.fn());
const getStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", () => ({
  setCodingAgentEnabled: setEnabled,
  getCodingAgentStatus: getStatus,
}));

import { get as configGet } from "@/lib/config-store";

const SESSION_SECRET = "a".repeat(64);
const STATUS = { enabled: true, ready: false, readiness: { ready: false, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: false, problems: ["ClawBox AI is not connected."] }, running: 0, harnessCommand: "claude-ds", maxTaskChars: 4000 };

let POST: (req: Request) => Promise<Response>;
let restore: () => void;

function ownerCookie(gen = 0): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, gen)}`;
}

function request(init: { cookie?: string; bearer?: string; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request("http://localhost/setup-api/coding-agent/enable", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? { enabled: true }),
  });
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  vi.mocked(configGet).mockImplementation(async () => undefined);
  getStatus.mockResolvedValue(STATUS);
  setEnabled.mockResolvedValue(undefined);
  const route = await import("@/app/setup-api/coding-agent/enable/route");
  POST = route.POST;
});

afterEach(() => restore());

describe("who may flip the switch", () => {
  it("refuses the MCP bearer, which is what the agent holds", async () => {
    const res = await POST(request({ bearer: "any-valid-looking-token-value" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("refuses a request with no credential with the identical answer", async () => {
    const withBearer = await POST(request({ bearer: "any-valid-looking-token-value" }));
    const bare = await POST(request());
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual(await withBearer.json());
  });

  it("refuses a forged cookie", async () => {
    const res = await POST(request({ cookie: `clawbox_session=${createSessionCookie(3600, "b".repeat(64), 0)}` }));
    expect(res.status).toBe(403);
  });

  it("accepts the owner's browser session and answers the re-read status", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(await res.json()).toEqual(STATUS);
  });

  it("turns it off the same way", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: false } }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(false);
  });
});

describe("the body", () => {
  it("must be { enabled: boolean }", async () => {
    for (const bad of ["true", 1, null, {}, []]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { enabled: bad } }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("rejects non-JSON", async () => {
    const res = await POST(request({ cookie: ownerCookie(), raw: "not json" }));
    expect(res.status).toBe(400);
  });

  it("checks the session before it looks at the body", async () => {
    const res = await POST(request({ raw: "not json" }));
    expect(res.status).toBe(403);
  });
});
