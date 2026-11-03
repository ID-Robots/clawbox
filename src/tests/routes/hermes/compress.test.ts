import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/hermes/compress (TASK-2127): "Shorten this conversation
 * first" on Hermes — its own `session.compress` on the resumed session, and a
 * success only when Hermes says it compressed.
 */
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-slash-exec", () => ({ runHermesSlashCommand: vi.fn() }));

import { POST } from "@/app/setup-api/hermes/compress/route";
import { getActiveHarness } from "@/lib/harness";
import { runHermesSlashCommand } from "@/lib/hermes-slash-exec";

const SESSION = "20260810_221825_609d1e";
const post = (body: unknown) => POST(new Request("http://localhost/setup-api/hermes/compress", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const ran = (result: Record<string, unknown> | undefined, output = "(no output)") =>
  ({ output, sessionId: SESSION, sessionModel: "", sessionProvider: "", ...(result ? { result } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveHarness).mockResolvedValue("hermes");
});

describe("POST /setup-api/hermes/compress", () => {
  it("runs Hermes' session.compress on the stored session and says what it took off", async () => {
    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran({ compressed: true, status: "compressed", before_tokens: 52000, after_tokens: 9000 }));
    const res = await post({ sessionId: SESSION });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ compressed: true, tokensBefore: 52000, tokensAfter: 9000 });
    expect(runHermesSlashCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION, rpc: "session.compress" }));
  });

  it("takes an in-process compression's own status as the success it is", async () => {
    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran({ status: "compressed", removed: 9, before_tokens: 52000, after_tokens: 30000 }));
    const res = await post({ sessionId: SESSION });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ compressed: true, tokensBefore: 52000, tokensAfter: 30000 });
  });

  it("is a refusal, not a success, when Hermes compressed nothing", async () => {
    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran({ status: "pending" }));
    expect((await post({ sessionId: SESSION })).status).toBe(409);

    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran({ compressed: false, message: "Nothing to compress." }));
    const res = await post({ sessionId: SESSION });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Nothing to compress.");

    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran(undefined, "Still running on the box."));
    expect((await post({ sessionId: SESSION })).status).toBe(409);
  });

  it("believes Hermes' own summary over its status: a noop, a refused or an aborted summary removed nothing", async () => {
    for (const flag of ["noop", "refused_would_grow", "aborted"]) {
      const headline = `Nothing removed (${flag}): 14 messages preserved`;
      // Token counts that went down, or none at all: the flag alone decides.
      for (const counts of [{ before_tokens: 64923, after_tokens: 30000 }, {}]) {
        vi.mocked(runHermesSlashCommand).mockResolvedValue(ran({
          status: "compressed", compressed: true, ...counts, summary: { [flag]: true, headline },
        }));
        const res = await post({ sessionId: SESSION });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe(headline);
      }
    }
  });

  it("is a refusal when the fold left the conversation no smaller (a board: one exchange of seven, 64.9k → 66.7k)", async () => {
    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran({
      status: "compressed", removed: 2, before_tokens: 64923, after_tokens: 66743,
      summary: { noop: false, refused_would_grow: false, aborted: false, headline: "Compressed: 14 → 12 messages" },
    }));
    const res = await post({ sessionId: SESSION });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The summary left this conversation no shorter (~64923 → ~66743 tokens).");
  });

  it("answers 503 when the dashboard could not be reached, and 400 for anything but a session id", async () => {
    vi.mocked(runHermesSlashCommand).mockResolvedValue(null);
    expect((await post({ sessionId: SESSION })).status).toBe(503);
    expect((await post({ sessionId: "../state.db" })).status).toBe(400);
  });

  it("does nothing on an OpenClaw box", async () => {
    vi.mocked(getActiveHarness).mockResolvedValue("openclaw");
    expect((await post({ sessionId: SESSION })).status).toBe(409);
    expect(runHermesSlashCommand).not.toHaveBeenCalled();
  });
});
