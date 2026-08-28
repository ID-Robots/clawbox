/**
 * GH-01b. The backup route answers `outcome.detail ?? outcome.reason`, and the
 * card's `readError()` shows `data.error` whenever it is a non-empty string. So
 * every refusal that carries no detail is rendered to the owner as the raw enum
 * token: the error banner reads literally `not_connected`.
 *
 * `no_gh` and `not_connected` are the two that carry none — and they are
 * exactly the two branches #518 rewrote when it split `no_gh` away from
 * `gh_unreachable`. Every other refusal in the same function was given a
 * sentence.
 *
 * This is the same class as the blank detail #518 removed from the killed push:
 * the surface renders `detail ?? reason` and is handed something that is not a
 * sentence. The fix has to be at the route as well as in the library, because
 * the fallback is what makes a reason added later leak the same way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupOutcome, BackupFailure } from "@/lib/coding-github";

const backup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-github")>()),
  backupToGitHub: backup,
  githubStatus: vi.fn(async () => ({ installed: true, connected: true, login: "yalexx", loginCommand: "gh auth login" })),
  disconnectGitHub: vi.fn(),
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => true) }));

vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  resolveWorkingDirectory: vi.fn(async () => ({ directory: "/home/clawbox/Projects/site", projectId: null })),
}));

let POST: (req: Request) => Promise<Response>;

function request(): Request {
  return new Request("http://localhost/setup-api/coding-agent/git", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: "/home/clawbox/Projects/site" }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  backup.mockReset();
  ({ POST } = await import("@/app/setup-api/coding-agent/git/route"));
});

/** Every refusal the library can answer. Listing them here is the point: the
 *  rule is about the class, not about the two that happen to be bare today. */
const REASONS: BackupFailure[] = [
  "no_gh",
  "gh_unreachable",
  "not_connected",
  "nothing_to_push",
  "not_a_repo",
  "failed",
];

describe("the owner is never shown the enum token", () => {
  for (const reason of REASONS) {
    it(`answers a sentence, not "${reason}", when the library gives no detail`, async () => {
      backup.mockResolvedValue({ pushed: false, reason } satisfies BackupOutcome);

      const res = await POST(request());
      const body = await res.json() as { error?: string; kind?: string };

      // `kind` is the machine-readable half and must keep the token: the card
      // branches on it. `error` is the half a human reads.
      expect(body.kind).toBe(reason);
      expect(body.error ?? "").not.toBe(reason);
      // A sentence, not a snake_case identifier.
      expect(body.error ?? "").not.toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect((body.error ?? "").trim()).not.toBe("");
    });
  }

  it("still prefers the library's own detail when there is one", async () => {
    // The discriminator: the fallback must not start overwriting the specific
    // message git or gh actually produced.
    backup.mockResolvedValue({
      pushed: false,
      reason: "failed",
      detail: "GraphQL: Name already exists on this account",
    } satisfies BackupOutcome);

    const res = await POST(request());
    const body = await res.json() as { error?: string };

    expect(body.error).toBe("GraphQL: Name already exists on this account");
  });
});
