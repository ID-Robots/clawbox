/**
 * POST /setup-api/ai-models/clawai/sign-out — the owner's alone (the MCP
 * bearer gets the same 403 as no session), and the sign-out's own answer
 * passed through with its status (src/lib/clawai-sign-out.ts is tested in
 * src/tests/unit/clawai-sign-out.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.hoisted(() => ({ signOutOfClawboxAi: vi.fn() }));
vi.mock("@/lib/clawai-sign-out", () => signOut);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn() }));
vi.mock("@/lib/owner-session", () => owner);

let POST: (req: Request) => Promise<Response>;

const req = () => new Request("http://localhost/setup-api/ai-models/clawai/sign-out", { method: "POST", headers: { host: "localhost" } });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  owner.hasPersonSession.mockResolvedValue(true);
  signOut.signOutOfClawboxAi.mockResolvedValue({ ok: true, changed: true, gatewayRestarting: false });
  ({ POST } = await import("@/app/setup-api/ai-models/clawai/sign-out/route"));
});

describe("POST /setup-api/ai-models/clawai/sign-out", () => {
  it("signs out for the owner and says what happened", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedOut: true, changed: true, gatewayRestarting: false });
    expect(signOut.signOutOfClawboxAi).toHaveBeenCalledTimes(1);
  });

  it("refuses anything but the owner's browser session 403 owner_only, and signs nothing out", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect(signOut.signOutOfClawboxAi).not.toHaveBeenCalled();
  });

  it("passes the sign-out's refusals through: 409 for the edition and a sign-in mid-write, 500 for a credential still there", async () => {
    for (const [kind, status] of [["not_supported", 409], ["sign_in_in_progress", 409], ["still_signed_in", 500]] as const) {
      signOut.signOutOfClawboxAi.mockResolvedValueOnce({ ok: false, kind, error: `refused: ${kind}` });
      const res = await POST(req());
      expect(res.status, kind).toBe(status);
      expect(await res.json()).toEqual({ error: `refused: ${kind}`, kind });
    }
  });
});
