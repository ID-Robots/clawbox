import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/hermes/compress compresses the CALLER's own conversation
 * only (TASK-2435 review): a ClawBox user — a member of staff on an
 * organisation box, whose chat routes are theirs — may not compress the
 * owner's session or another user's by naming its id.
 */
const h = vi.hoisted(() => ({
  principal: vi.fn(async () => ({ username: "alice", isOwner: false })),
  sessionFor: vi.fn((_p: unknown, requested: string) => requested),
}));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-slash-exec", () => ({ runHermesSlashCommand: vi.fn() }));
vi.mock("@/lib/chat-scope-server", () => ({ chatPrincipalOf: h.principal, hermesSessionFor: h.sessionFor }));

import { POST } from "@/app/setup-api/hermes/compress/route";
import { runHermesSlashCommand } from "@/lib/hermes-slash-exec";

const SESSION = "20260810_221825_609d1e";
const post = () => POST(new Request("http://localhost/setup-api/hermes/compress", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: SESSION }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /setup-api/hermes/compress — whose conversation", () => {
  it("refuses a session that is not the caller's, and runs nothing", async () => {
    h.sessionFor.mockReturnValue("");
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "not_your_chat" });
    expect(runHermesSlashCommand).not.toHaveBeenCalled();
    expect(h.sessionFor).toHaveBeenCalledWith({ username: "alice", isOwner: false }, SESSION);
  });

  it("runs on the caller's own session", async () => {
    h.sessionFor.mockImplementation((_p: unknown, requested: string) => requested);
    vi.mocked(runHermesSlashCommand).mockResolvedValue({ output: "", sessionId: SESSION, sessionModel: "", sessionProvider: "", result: { compressed: true, status: "compressed", before_tokens: 9000, after_tokens: 3000 } } as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(runHermesSlashCommand).toHaveBeenCalled();
  });
});
