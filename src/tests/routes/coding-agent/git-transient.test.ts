/**
 * GH-01c, at the surface the owner's browser actually sees.
 *
 * POST /setup-api/coding-agent/git answers 409 or 503 from one ternary. #518
 * set the rule: 409 means "the request cannot be satisfied as it stands" —
 * true of a folder with no commits, false of a network that is merely down.
 * A backup killed by our own timer is the second kind, and answering 409 hands
 * the owner a non-retryable client error whose body says "try again".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupOutcome } from "@/lib/coding-github";

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

describe("a transient backup failure answers 503, not 409", () => {
  it("answers 503 for gh_unreachable", async () => {
    backup.mockResolvedValue({ pushed: false, reason: "gh_unreachable", detail: "Could not reach GitHub." } satisfies BackupOutcome);

    const res = await POST(request());

    expect(res.status).toBe(503);
  });

  it("answers 503 for a killed local git probe", async () => {
    // reason stays "failed" — git did not refuse anything, it was killed —
    // but the outcome carries that the fault was transient.
    backup.mockResolvedValue({
      pushed: false,
      reason: "failed",
      detail: "Reading the folder's git remote timed out. Try again.",
      transient: true,
    } satisfies BackupOutcome);

    const res = await POST(request());

    expect(res.status).toBe(503);
    const body = await res.json() as { error?: string };
    expect(body.error ?? "").toMatch(/timed out/i);
  });

  it("still answers 409 for a request that cannot be satisfied as it stands", async () => {
    backup.mockResolvedValue({ pushed: false, reason: "nothing_to_push", detail: "The folder has no commits yet." } satisfies BackupOutcome);

    const res = await POST(request());

    expect(res.status).toBe(409);
  });

  it("still answers 409 when GitHub itself refused", async () => {
    backup.mockResolvedValue({ pushed: false, reason: "failed", detail: "Name already exists on this account" } satisfies BackupOutcome);

    const res = await POST(request());

    expect(res.status).toBe(409);
  });
});
