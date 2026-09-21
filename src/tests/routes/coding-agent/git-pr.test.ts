/**
 * The git route's second POST: `action: "pr"` opens a pull request for the
 * branch the project is on. The route is the gate and the mapping — owner
 * only, the same folder resolver a run uses, a refusal's reason as its
 * status — and the library behind it is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPrOutcome } from "@/lib/coding-pr";

const openPr = vi.hoisted(() => vi.fn<() => Promise<ProjectPrOutcome>>());
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  openProjectPullRequest: openPr,
}));
const backup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-github")>()),
  backupToGitHub: backup,
  githubStatus: vi.fn(async () => ({ installed: true, connected: true, login: "yalexx", loginCommand: "gh auth login" })),
  disconnectGitHub: vi.fn(),
}));
const owner = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: owner }));
const resolve = vi.hoisted(() => vi.fn(async () => ({ directory: "/home/clawbox/Projects/site", projectId: null })));
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  resolveWorkingDirectory: resolve,
}));

let POST: (req: Request) => Promise<Response>;

function request(body: unknown): Request {
  return new Request("http://localhost/setup-api/coding-agent/git", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.resetModules();
  openPr.mockReset();
  backup.mockReset();
  owner.mockResolvedValue(true);
  ({ POST } = await import("@/app/setup-api/coding-agent/git/route"));
});

describe("POST /setup-api/coding-agent/git { action: \"pr\" }", () => {
  it("opens the pull request for the resolved folder and answers it", async () => {
    openPr.mockResolvedValue({ ok: true, number: 7, url: "https://github.com/yalexx/site/pull/7", branch: "clawbox/run-1", base: "master", existing: false });
    const res = await POST(request({ directory: "/home/clawbox/Projects/site", action: "pr" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ number: 7, url: "https://github.com/yalexx/site/pull/7", existing: false });
    expect(openPr).toHaveBeenCalledWith("/home/clawbox/Projects/site");
    expect(backup).not.toHaveBeenCalled();
  });

  it("answers a refusal with its reason: 409 for a request wrong as it stands, 503 for a probe worth retrying", async () => {
    openPr.mockResolvedValue({ ok: false, reason: "on_base", detail: "The project is on its default branch (master), so there is nothing to compare." });
    let res = await POST(request({ projectId: "site", action: "pr" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.stringContaining("default branch"), kind: "on_base" });

    openPr.mockResolvedValue({ ok: false, reason: "no_remote", detail: "This project is not on GitHub yet." });
    res = await POST(request({ projectId: "site", action: "pr" }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("no_remote");

    openPr.mockResolvedValue({ ok: false, reason: "failed", detail: "Reading the current branch timed out.", transient: true });
    res = await POST(request({ projectId: "site", action: "pr" }));
    expect(res.status).toBe(503);
  });

  it("is the owner's gesture: the bearer is refused, and an unknown action is a bad request", async () => {
    owner.mockResolvedValue(false);
    expect((await POST(request({ projectId: "site", action: "pr" }))).status).toBe(403);
    owner.mockResolvedValue(true);
    expect((await POST(request({ projectId: "site", action: "merge" }))).status).toBe(400);
    expect(openPr).not.toHaveBeenCalled();
  });

  it("leaves the backup POST as it was when no action is named", async () => {
    backup.mockResolvedValue({ pushed: true, repo: "yalexx/site", created: false, branch: "master" });
    const res = await POST(request({ projectId: "site" }));
    expect(res.status).toBe(200);
    expect(backup).toHaveBeenCalledWith("/home/clawbox/Projects/site");
    expect(openPr).not.toHaveBeenCalled();
  });
});
