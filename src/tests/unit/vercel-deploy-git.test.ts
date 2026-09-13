/**
 * A git-connected Vercel project: WHICH repository gets built.
 *
 * The property under test: **the box refuses to deploy a branch when the
 * repository Vercel is connected to is not the one this folder pushes to.**
 * Both repositories having a `main` is the ordinary case, so without this the
 * owner presses Deploy on one project and Vercel builds somebody else's code of
 * the same name — silently, and successfully.
 *
 * And its other half: "could not tell" is never a refusal. A remote this box
 * cannot parse (a self-hosted GitLab, an SSH alias) and a link Vercel described
 * without an owner/repo pair leave the question open, and refusing on those
 * would take the feature away from every setup outside github.com.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-git", () => ({ gitInfo }));

const readVercelLink = vi.hoisted(() => vi.fn());
const resolveVercelAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-link", () => ({ readVercelLink, resolveVercelAuth }));

const readProject = vi.hoisted(() => vi.fn());
const createDeployment = vi.hoisted(() => vi.fn());
const uploadDeployFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel")>()),
  readProject,
  createDeployment,
  uploadDeployFile,
}));

const collectDeployFiles = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-files", () => ({ collectDeployFiles }));

import { deployProject } from "@/lib/vercel-deploy";

const TOKEN = "vrc_live_Xk29fLm4Qp7sT1wZ8bN3dH6jR0aC5yE"; // gitleaks:allow
const DEPLOYMENT = {
  id: "dpl_1", readyState: "queued" as const, url: "https://x.vercel.app",
  inspectorUrl: null, target: "preview", branch: null, sha: null, createdAt: null, errorMessage: null,
};

function link(gitLink: unknown) {
  readProject.mockResolvedValue({ ok: true, id: "prj_acme", name: "shop", gitLink, productionDomain: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  readVercelLink.mockResolvedValue({ projectId: "prj_acme", teamId: null, tokenSecretName: "VERCEL_TOKEN", createdAt: 1, updatedAt: 1 });
  resolveVercelAuth.mockResolvedValue({ token: TOKEN, teamId: null });
  createDeployment.mockResolvedValue({ ok: true, deployment: DEPLOYMENT });
  collectDeployFiles.mockResolvedValue({ ok: true, files: [{ file: "a", sha: "a".repeat(40), size: 1, data: new Uint8Array([1]) }], bytes: 1, usedGit: true, skipped: [] });
  uploadDeployFile.mockResolvedValue({ ok: true, uploaded: true });
  gitInfo.mockResolvedValue({ branch: "main", commits: 3, remote: "https://github.com/acme/shop.git", lastCommit: null });
  link({ type: "github", repoId: "9", org: "acme", repo: "shop", defaultBranch: "main" });
});

const input = { scope: "shop", directory: "/p/shop", target: "preview" as const };

describe("which repository Vercel will build", () => {
  it("deploys the branch when the remote and the Vercel project agree", async () => {
    const made = await deployProject(input);
    expect(made.ok).toBe(true);
    expect(made.ok && made.source).toBe("git");
    expect(createDeployment.mock.calls[0][1]).toMatchObject({ gitRef: "main" });
  });

  it("refuses when they name DIFFERENT repositories, and names both", async () => {
    link({ type: "github", repoId: "9", org: "other", repo: "shop", defaultBranch: "main" });
    const made = await deployProject(input);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.code).toBe("wrong_repository");
    expect(made.detail).toContain("other/shop");
    expect(made.detail).toContain("acme/shop");
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it("compares case-insensitively — GitHub does", async () => {
    gitInfo.mockResolvedValue({ branch: "main", commits: 3, remote: "git@github.com:ACME/Shop.git", lastCommit: null });
    expect((await deployProject(input)).ok).toBe(true);
  });

  it("does NOT refuse when the remote is one this box cannot read", async () => {
    // A self-hosted GitLab or an SSH alias leaves the question open, and
    // refusing on "could not tell" would take the feature away from every
    // setup outside github.com.
    gitInfo.mockResolvedValue({ branch: "main", commits: 3, remote: "git@git.example.internal:acme/shop.git", lastCommit: null });
    expect((await deployProject(input)).ok).toBe(true);
  });

  it("does NOT refuse when Vercel described the link without an owner and repo", async () => {
    link({ type: "github", repoId: "9", org: null, repo: null, defaultBranch: null });
    expect((await deployProject(input)).ok).toBe(true);
  });
});

describe("what a git deploy needs before it is worth sending", () => {
  it("refuses a folder with no remote — Vercel clones from there, not from this box", async () => {
    gitInfo.mockResolvedValue({ branch: "main", commits: 3, remote: null, lastCommit: null });
    const made = await deployProject(input);
    expect(made.ok === false && made.code).toBe("no_remote");
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it("refuses a folder with no branch, and a detached HEAD", async () => {
    for (const branch of [null, "HEAD"]) {
      gitInfo.mockResolvedValue({ branch, commits: 0, remote: "https://github.com/acme/shop.git", lastCommit: null });
      const made = await deployProject(input);
      expect(made.ok === false && made.code, String(branch)).toBe("no_branch");
    }
    expect(createDeployment).not.toHaveBeenCalled();
  });
});

describe("a project with no repository", () => {
  it("uploads the folder and names the files by hash, asking git about nothing", async () => {
    link(null);
    const made = await deployProject(input);
    expect(made.ok).toBe(true);
    expect(made.ok && made.source).toBe("files");
    expect(made.ok && made.fileCount).toBe(1);
    expect(uploadDeployFile).toHaveBeenCalledTimes(1);
    // The bytes are not repeated in the deployment: it names them by hash.
    expect(createDeployment.mock.calls[0][1].files[0]).toEqual({ file: "a", sha: "a".repeat(40), size: 1 });
  });

  it("carries the collector's own refusal through rather than deploying nothing", async () => {
    link(null);
    collectDeployFiles.mockResolvedValue({ ok: false, code: "ignores_unreadable", detail: "could not ask git" });
    const made = await deployProject(input);
    expect(made.ok === false && made.code).toBe("ignores_unreadable");
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it("does not create a deployment when an upload failed", async () => {
    link(null);
    uploadDeployFile.mockResolvedValue({ ok: false, kind: "network", detail: "connection reset", status: null });
    const made = await deployProject(input);
    expect(made.ok === false && made.code).toBe("network");
    expect(createDeployment).not.toHaveBeenCalled();
  });
});

describe("the link and the credential", () => {
  it("refuses a project with no Vercel project attached, before any call", async () => {
    readVercelLink.mockResolvedValue(null);
    const made = await deployProject(input);
    expect(made.ok === false && made.code).toBe("not_linked");
    expect(readProject).not.toHaveBeenCalled();
  });

  it("never takes a Vercel project from the caller — only from the owner's link", async () => {
    await deployProject(input);
    // The link's id, every time.
    expect(createDeployment.mock.calls[0][1].projectId).toBe("prj_acme");
    expect(readVercelLink).toHaveBeenCalledWith("shop");
  });
});
