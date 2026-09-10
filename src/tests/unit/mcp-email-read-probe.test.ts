/**
 * "Could not ask" is not "no", on the one gate this server acts on while it
 * runs.
 *
 * `probeEmailReadStatus` feeds `watchEmailReadability`, which WITHDRAWS
 * `email_list`/`email_read` from a live connection on a definite `false`. So
 * every way the device can fail to answer the question has to come back as
 * `null` — including the ways that arrive as a perfectly ordinary HTTP 200,
 * which is what `/setup-api/email/status` sends when it could not read the
 * config store at all.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { probeEmailReadStatus } from "../../../mcp/lib/context";

function answers(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeEmailReadStatus", () => {
  it("answers true only when the device says the agent may read", async () => {
    answers({ configured: true, canRead: true });
    expect(await probeEmailReadStatus()).toBe(true);
  });

  it("answers false for a mode that keeps the mailbox shut", async () => {
    answers({ configured: true, canRead: false });
    expect(await probeEmailReadStatus()).toBe(false);
  });

  it("answers false for a device with no mail account", async () => {
    answers({ configured: false, canRead: false });
    expect(await probeEmailReadStatus()).toBe(false);
  });

  it("answers null when the device could not read its own store", async () => {
    // The failure this exists for: `data/config.json` left root-owned by an
    // update, or one EIO off the eMMC. The route still answers 200 and
    // `configured: false`, because the ordinary config read swallows both — so
    // without this flag a working mailbox loses its tools inside a poll.
    answers({ configured: false, canRead: false, storeUnreadable: true });
    expect(await probeEmailReadStatus()).toBeNull();
  });

  it("answers null when an account exists and the device did not answer the question", async () => {
    // A web server rolled back to a build that predates the three-mode setting,
    // under a live MCP child. Silence is not a "no".
    answers({ configured: true });
    expect(await probeEmailReadStatus()).toBeNull();
  });

  it("answers null when nothing answered at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    expect(await probeEmailReadStatus()).toBeNull();
  });

  it("answers null on an error status, rather than guessing", async () => {
    answers({ error: "Status check failed" }, 500);
    expect(await probeEmailReadStatus()).toBeNull();
  });
});
