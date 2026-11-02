/**
 * POST /setup-api/providers/sign-out — "Sign out of <Provider>" on every
 * connected row. The owner's alone: middleware admits the MCP bearer to every
 * /setup-api/* path, so the route refuses it in-handler with the real cookie
 * verifier, the way providers/enabled does. The sign-out's own answer is
 * passed through with its status (src/lib/provider-sign-out.ts is tested in
 * src/tests/unit/provider-sign-out.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const signOut = vi.hoisted(() => ({ signOutOfProvider: vi.fn() }));
vi.mock("@/lib/provider-sign-out", () => signOut);
// The real module's constants (the cookie verifier reads `DATA_DIR` at import)
// over an in-memory store.
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
}));

const SESSION_SECRET = "a".repeat(64);

let POST: (req: Request) => Promise<Response>;
let restore: () => void;

function request(init: { cookie?: boolean; bearer?: string; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = `clawbox_session=${createSessionCookie(3600, SESSION_SECRET)}`;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request("http://localhost/setup-api/providers/sign-out", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? { provider: "openrouter" }),
  });
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  signOut.signOutOfProvider.mockResolvedValue({ ok: true, changed: true, gatewayRestarting: false });
  ({ POST } = await import("@/app/setup-api/providers/sign-out/route"));
});

afterEach(() => restore());

describe("POST /setup-api/providers/sign-out", () => {
  it("signs the owner out of the row's provider and says what happened", async () => {
    const res = await POST(request({ cookie: true, body: { provider: " openrouter " } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedOut: true, provider: "openrouter", changed: true, gatewayRestarting: false });
    expect(signOut.signOutOfProvider).toHaveBeenCalledWith("openrouter");
  });

  it("refuses the MCP bearer — what the agent holds — and no session, 403 owner_only, signing nothing out", async () => {
    for (const init of [{ bearer: "any-valid-looking-token-value" }, {}]) {
      const res = await POST(request(init));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ kind: "owner_only" });
    }
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
  });

  it("refuses a body that names no provider", async () => {
    for (const init of [{ raw: "{not json" }, { body: {} }, { body: { provider: 7 } }, { body: ["openai"] }, { raw: "\"openai\"" }]) {
      const res = await POST(request({ cookie: true, ...init }));
      expect(res.status, JSON.stringify(init)).toBe(400);
    }
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
  });

  it("passes the sign-out's refusals through with their status", async () => {
    for (const [kind, status] of [
      ["unknown_provider", 404],
      ["is_default", 409],
      ["default_unreadable", 409],
      ["sign_in_in_progress", 409],
      ["still_signed_in", 500],
      ["restart_refused", 502],
    ] as const) {
      signOut.signOutOfProvider.mockResolvedValueOnce({ ok: false, kind, error: `refused: ${kind}` });
      const res = await POST(request({ cookie: true }));
      expect(res.status, kind).toBe(status);
      expect(await res.json()).toEqual({ error: `refused: ${kind}`, kind });
    }
  });
});
