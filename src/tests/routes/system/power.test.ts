import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { execFile } from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

// The route uses promisify(execFile), so the mock must invoke the trailing
// callback for the awaited call to resolve/reject.
function resolveOnce() {
  mockExecFile.mockImplementationOnce(((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    cb(null, "", "");
    return undefined as never;
  }) as unknown as typeof execFile);
}

function rejectOnce(error: Error) {
  mockExecFile.mockImplementationOnce(((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null) => void;
    cb(error);
    return undefined as never;
  }) as unknown as typeof execFile);
}

describe("/setup-api/system/power", () => {
  let POST: (req: Request) => Promise<Response>;
  let session: SessionFixture;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    session = installSessionFixture();
    const mod = await import("@/app/setup-api/system/power/route");
    POST = mod.POST;
  });

  afterEach(() => {
    session.cleanup();
  });

  it("awaits systemctl poweroff for the shutdown action", async () => {
    resolveOnce();
    const req = new Request("http://localhost/setup-api/system/power", {
      headers: { Cookie: session.cookie },
      method: "POST",
      body: JSON.stringify({ action: "shutdown" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, action: "shutdown" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", "poweroff"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it("awaits systemctl reboot for the restart action", async () => {
    resolveOnce();
    const req = new Request("http://localhost/setup-api/system/power", {
      headers: { Cookie: session.cookie },
      method: "POST",
      body: JSON.stringify({ action: "restart" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, action: "restart" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", "reboot"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it("returns 500 when the power command fails to dispatch", async () => {
    rejectOnce(new Error("sudo: a password is required"));
    const req = new Request("http://localhost/setup-api/system/power", {
      headers: { Cookie: session.cookie },
      method: "POST",
      body: JSON.stringify({ action: "shutdown" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toContain("password is required");
  });

  it("rejects an invalid action without invoking execFile", async () => {
    const req = new Request("http://localhost/setup-api/system/power", {
      headers: { Cookie: session.cookie },
      method: "POST",
      body: JSON.stringify({ action: "invalid" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns 400 on an invalid JSON body", async () => {
    const req = new Request("http://localhost/setup-api/system/power", {
      headers: { Cookie: session.cookie },
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
