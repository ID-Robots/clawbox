import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

vi.mock("@/lib/updater", () => ({
  dismissSettledUpdate: vi.fn(),
}));

import { dismissSettledUpdate } from "@/lib/updater";

const mockDismiss = vi.mocked(dismissSettledUpdate);

/**
 * The update state lives in the web server's memory, so the failure of
 * 2026-09-05 outlived the page that started it and reached every window opened
 * afterwards. System Update renders such a run now; this is what its Dismiss
 * button calls, so dismissing survives a reload instead of hiding the panel
 * until the next mount re-adopts the same dead run.
 */
describe("POST /setup-api/update/dismiss", () => {
  let dismissPost: (req: Request) => Promise<Response>;
  let session: SessionFixture;

  function request(cookie?: string): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    session = installSessionFixture();
    mockDismiss.mockResolvedValue({ dismissed: true });

    const mod = await import("@/app/setup-api/update/dismiss/route");
    dismissPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    session.cleanup();
  });

  it("forgets the settled run", async () => {
    const res = await dismissPost(request(session.cookie));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dismissed: true });
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });

  it("answers 409 rather than pretending, while a run owns the box", async () => {
    mockDismiss.mockResolvedValue({
      dismissed: false,
      reason: "in-progress" as const,
      error: "An update is in progress",
    });

    const res = await dismissPost(request(session.cookie));

    expect(res.status).toBe(409);
    expect((await res.json()).dismissed).toBe(false);
  });

  it("says the write failed rather than reporting a dismissal that did not happen", async () => {
    // `void set(...)` and `return true` meant a store that refused the write
    // still answered 200: the owner's Dismiss looked like it took, and the
    // record was still there for the next poll to raise the same failure from.
    // It is not a 409 either — nothing is in progress.
    mockDismiss.mockResolvedValue({
      dismissed: false,
      reason: "not-written" as const,
      error: "The device could not save that change — see the server log.",
    });

    const res = await dismissPost(request(session.cookie));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.dismissed).toBe(false);
    expect(body.error).toMatch(/could not save that change/);
  });

  it("refuses a caller with no session", async () => {
    const res = await dismissPost(request());

    expect(res.status).toBe(401);
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});
