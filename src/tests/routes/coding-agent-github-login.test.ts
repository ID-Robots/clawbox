/**
 * POST /setup-api/coding-agent/github-login — TASK-1014 / CodeQL alert 513
 * (js/user-controlled-bypass).
 *
 * The body's `action` chooses between three operations that each end in this
 * box holding somebody's GitHub credential. It used to be compared against a
 * string literal at each arm, so the value steering the dispatch was the
 * caller's own; the verb is now DRAWN from a three-entry allow-list and an
 * unknown one is refused before any arm runs.
 *
 * The owner gate and the same-origin gate are unchanged and still run first —
 * pinned here too, because an allow-list on the verb would be worth nothing if
 * the refactor had moved them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerSession: vi.fn(async () => true),
  isSameOriginRequest: vi.fn(() => true),
  startDeviceLogin: vi.fn(async () => ({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" })),
  pollDeviceLogin: vi.fn(async () => ({ status: "pending" as string, login: undefined as string | undefined })),
  cancelDeviceLogin: vi.fn(() => {}),
  noteGitHubAccountChanged: vi.fn(() => {}),
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: mocks.hasOwnerSession }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock("@/lib/coding-github", () => ({
  startDeviceLogin: mocks.startDeviceLogin,
  pollDeviceLogin: mocks.pollDeviceLogin,
  cancelDeviceLogin: mocks.cancelDeviceLogin,
}));
vi.mock("@/lib/project-import", () => ({ noteGitHubAccountChanged: mocks.noteGitHubAccountChanged }));

let POST: (req: Request) => Promise<Response>;
let errorLog: ReturnType<typeof vi.spyOn>;

const req = (body: unknown) =>
  new Request("http://localhost/setup-api/coding-agent/github-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Every arm of this route logs; the suite is not about the journal. */
beforeEach(async () => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.hasOwnerSession.mockResolvedValue(true);
  mocks.isSameOriginRequest.mockReturnValue(true);
  mocks.pollDeviceLogin.mockResolvedValue({ status: "pending", login: undefined });
  vi.resetModules();
  POST = (await import("@/app/setup-api/coding-agent/github-login/route")).POST;
});

afterEach(() => {
  errorLog.mockRestore();
  vi.clearAllMocks();
});

describe("the three known verbs still work", () => {
  it("starts a device flow", async () => {
    const res = await POST(req({ action: "start" }));
    expect(res.status).toBe(200);
    expect((await res.json()).userCode).toBe("ABCD-1234");
    expect(mocks.startDeviceLogin).toHaveBeenCalledTimes(1);
  });

  it("polls one, and notes the account change when it connects", async () => {
    mocks.pollDeviceLogin.mockResolvedValue({ status: "connected", login: "octocat" });
    const res = await POST(req({ action: "poll" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("connected");
    expect(mocks.noteGitHubAccountChanged).toHaveBeenCalledTimes(1);
  });

  it("does not note an account change while the flow is still pending", async () => {
    await POST(req({ action: "poll" }));
    expect(mocks.noteGitHubAccountChanged).not.toHaveBeenCalled();
  });

  it("cancels one", async () => {
    const res = await POST(req({ action: "cancel" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.cancelDeviceLogin).toHaveBeenCalledTimes(1);
  });

  it("relays a start that the backend refused", async () => {
    mocks.startDeviceLogin.mockResolvedValue({ error: "gh is not installed" } as never);
    const res = await POST(req({ action: "start" }));
    expect(res.status).toBe(503);
  });
});

describe("an action outside the allow-list reaches nothing", () => {
  it.each([
    ["an unknown verb", "delete"],
    ["a near miss", "Start"],
    ["one with whitespace", " poll"],
    ["an empty string", ""],
    ["a prototype key", "__proto__"],
    ["a prototype method name", "constructor"],
    ["one that names a real export", "startDeviceLogin"],
  ])("refuses %s with a 400", async (_label, action) => {
    const res = await POST(req({ action }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown action/);
    expect(mocks.startDeviceLogin).not.toHaveBeenCalled();
    expect(mocks.pollDeviceLogin).not.toHaveBeenCalled();
    expect(mocks.cancelDeviceLogin).not.toHaveBeenCalled();
  });

  it.each([
    ["a number", 1],
    ["true", true],
    ["null", null],
    ["an array", ["poll"]],
    ["an object that stringifies to a verb", { toString: () => "poll" }],
  ])("refuses %s rather than coercing it to a verb", async (_label, action) => {
    const res = await POST(req({ action }));
    expect(res.status).toBe(400);
    expect(mocks.pollDeviceLogin).not.toHaveBeenCalled();
    expect(mocks.cancelDeviceLogin).not.toHaveBeenCalled();
  });

  it("refuses a body with no action at all, and a body that is not an object", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req("poll"))).status).toBe(400);
    expect((await POST(req(["poll"]))).status).toBe(400);
    expect(mocks.pollDeviceLogin).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://localhost/setup-api/coding-agent/github-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{oops",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid request body");
  });

  it("does not echo a hostile action back as a log line or a header", async () => {
    const forged = `poll${String.fromCharCode(13)}${String.fromCharCode(10)}[coding-agent] GitHub connected as attacker`;
    const res = await POST(req({ action: forged }));
    expect(res.status).toBe(400);
    const said = (await res.json()).error as string;
    expect(said).not.toContain(String.fromCharCode(10));
    expect(said).not.toContain(String.fromCharCode(13));
  });
});

describe("the gates that run before the verb is even read", () => {
  it("refuses a caller with no owner session, whatever the action", async () => {
    mocks.hasOwnerSession.mockResolvedValue(false);
    for (const action of ["start", "poll", "cancel"]) {
      const res = await POST(req({ action }));
      expect(res.status).toBe(403);
      expect((await res.json()).kind).toBe("owner_only");
    }
    expect(mocks.startDeviceLogin).not.toHaveBeenCalled();
    expect(mocks.pollDeviceLogin).not.toHaveBeenCalled();
    expect(mocks.cancelDeviceLogin).not.toHaveBeenCalled();
  });

  it("refuses a cross-site POST that carries the owner's cookie", async () => {
    mocks.isSameOriginRequest.mockReturnValue(false);
    const res = await POST(req({ action: "start" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("cross_origin");
    expect(mocks.startDeviceLogin).not.toHaveBeenCalled();
  });

  it("answers the owner gate before the origin gate", async () => {
    // The bearer must get the same answer every owner-only route gives.
    mocks.hasOwnerSession.mockResolvedValue(false);
    mocks.isSameOriginRequest.mockReturnValue(false);
    expect((await POST(req({ action: "start" }))).status).toBe(403);
    expect((await (await POST(req({ action: "start" }))).json()).kind).toBe("owner_only");
  });
});
