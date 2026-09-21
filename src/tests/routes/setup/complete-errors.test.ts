import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({
  setMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionSigningSecret: vi.fn(),
  createSessionCookie: vi.fn(),
  getSessionGeneration: vi.fn(async () => 0),
}));

import { setMany } from "@/lib/config-store";
import { createSessionCookie, getSessionSigningSecret } from "@/lib/auth";

const mockSetMany = vi.mocked(setMany);
const mockGetSessionSigningSecret = vi.mocked(getSessionSigningSecret);
const mockCreateSessionCookie = vi.mocked(createSessionCookie);

// The handler's own session check (`@/lib/route-auth`) deliberately reads
// data/config.json and data/.session-secret off disk rather than through the
// two modules mocked above, so those mocks cannot let a request in. This suite
// is about what happens AFTER the gate, so it goes through the e2e-install
// harness's door — CLAWBOX_TEST_MODE — and points CLAWBOX_ROOT at an empty temp
// tree so route-auth never reads the box's real data/.
let testRoot: string;
let previousRoot: string | undefined;
let previousTestMode: string | undefined;

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-setup-complete-errors-"));
  previousRoot = process.env.CLAWBOX_ROOT;
  previousTestMode = process.env.CLAWBOX_TEST_MODE;
  process.env.CLAWBOX_ROOT = testRoot;
  process.env.CLAWBOX_TEST_MODE = "1";
});

afterAll(() => {
  if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = previousRoot;
  if (previousTestMode === undefined) delete process.env.CLAWBOX_TEST_MODE;
  else process.env.CLAWBOX_TEST_MODE = previousTestMode;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function post(): Request {
  return new Request("http://localhost/setup-api/setup/complete", { method: "POST" });
}

describe("POST /setup-api/setup/complete error paths", () => {
  let completePost: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSetMany.mockResolvedValue();
    mockGetSessionSigningSecret.mockResolvedValue("test-secret");
    mockCreateSessionCookie.mockReturnValue("signed-cookie");

    const mod = await import("@/app/setup-api/setup/complete/route");
    completePost = mod.POST;
  });

  it("still succeeds when auto-login cookie creation fails", async () => {
    mockGetSessionSigningSecret.mockRejectedValueOnce(new Error("secret unavailable"));

    const response = await completePost(post());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rolls back and returns 500 when setup completion persistence fails", async () => {
    mockSetMany
      .mockRejectedValueOnce(new Error("write failed"))
      .mockRejectedValue(new Error("rollback failed"));

    const response = await completePost(post());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "write failed" });
    expect(mockSetMany).toHaveBeenNthCalledWith(1, {
      setup_complete: true,
      setup_completed_at: expect.any(String),
      setup_progress_step: undefined,
    });
    expect(mockSetMany).toHaveBeenNthCalledWith(2, {
      setup_complete: undefined,
      setup_completed_at: undefined,
    });
  });

  // Under the harness the gate stands aside; without it, the mocks above are
  // not a session and the handler never reaches setMany. Pins that the escape
  // hatch is the env flag and nothing this suite's mocks could counterfeit.
  it("refuses an anonymous POST outside test mode before touching the store", async () => {
    process.env.CLAWBOX_TEST_MODE = "0";
    try {
      const response = await completePost(post());

      expect(response.status).toBe(401);
      expect(mockSetMany).not.toHaveBeenCalled();
      expect(mockCreateSessionCookie).not.toHaveBeenCalled();
    } finally {
      process.env.CLAWBOX_TEST_MODE = "1";
    }
  });
});
