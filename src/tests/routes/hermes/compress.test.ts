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

  it("is a refusal, not a success, when Hermes compressed nothing", async () => {
    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran({ compressed: false, message: "Nothing to compress." }));
    const res = await post({ sessionId: SESSION });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Nothing to compress.");

    vi.mocked(runHermesSlashCommand).mockResolvedValue(ran(undefined, "Still running on the box."));
    expect((await post({ sessionId: SESSION })).status).toBe(409);
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
