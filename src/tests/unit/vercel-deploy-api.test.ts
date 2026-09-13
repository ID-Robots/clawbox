/**
 * Creating a deployment, against a fake API.
 *
 * The properties under test are the ones a real account depends on and a fake
 * cannot stumble into:
 *  - a GIT-CONNECTED project deploys a REF and uploads nothing; a project with
 *    no repository uploads its files and names them by hash. Which one is read
 *    from Vercel's own project record, never guessed;
 *  - a PREVIEW carries no `target` field at all and production carries
 *    `target: "production"`. `POST /v13/deployments` does not define the value
 *    `"preview"`: sending it is usually refused, and has been seen to be
 *    accepted and turned into a PRODUCTION deployment on the project's own
 *    domain — so "the preview request has no target key" is pinned literally;
 *  - an answer that came back on the production target is never treated as a
 *    preview, whatever was asked for;
 *  - a caller that names both a ref and files, or neither, is REFUSED rather
 *    than having one of them silently win;
 *  - the token goes in the Authorization header and never into a sentence,
 *    however loudly the far side echoes it back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeployment,
  parseGitLink,
  parseProductionDomain,
  readProject,
  uploadDeployFile,
  type VercelAuth,
} from "@/lib/vercel";

const TOKEN = "vrc_live_Xk29fLm4Qp7sT1wZ8bN3dH6jR0aC5yE"; // gitleaks:allow
const AUTH: VercelAuth = { token: TOKEN, teamId: null };

let calls: { url: URL; method: string; auth: string | null; body: unknown; headers: Record<string, string> }[];

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeApi(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: unknown = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    } else if (init.body) {
      body = init.body;
    }
    calls.push({ url, method: init.method ?? "GET", auth: headers.Authorization ?? null, body, headers });
    return handler(url, init);
  }));
}

const CREATED = {
  id: "dpl_new",
  readyState: "QUEUED",
  url: "shop-abc123.vercel.app",
  inspectorUrl: "https://vercel.com/acme/shop/dpl_new",
  target: "production",
};

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("which shape a project is", () => {
  it("reads a GitHub link off the project record, with the repo id Vercel wants", () => {
    expect(parseGitLink({ type: "github", repoId: 12345, org: "acme", repo: "shop", productionBranch: "main" })).toEqual({
      type: "github", repoId: "12345", org: "acme", repo: "shop", defaultBranch: "main",
    });
  });

  it("reads an owner/repo pair for a provider that names no id", () => {
    expect(parseGitLink({ type: "gitlab", namespace: "acme", slug: "shop" })).toMatchObject({
      type: "gitlab", repoId: null, org: "acme", repo: "shop",
    });
  });

  it("reads a link that names NO repository as not connected — the upload path always works", () => {
    // Deploying "the ref of nothing" is a 400 from Vercel with a sentence
    // nobody can act on; falling back to the files is the answer that deploys.
    expect(parseGitLink({ type: "github" })).toBeNull();
    expect(parseGitLink({})).toBeNull();
    expect(parseGitLink(null)).toBeNull();
  });

  it("carries the git link and the production domain off one project read", async () => {
    fakeApi(() => answer(200, {
      id: "prj_acme",
      name: "shop",
      link: { type: "github", repoId: 99, org: "acme", repo: "shop" },
      targets: { production: { alias: ["shop.example.com"] } },
    }));
    const read = await readProject(AUTH, "prj_acme");
    expect(read).toMatchObject({ ok: true, name: "shop", productionDomain: "shop.example.com" });
    expect(read.ok && read.gitLink?.repoId).toBe("99");
    // ONE call: the domain is read from the record this box already fetches.
    expect(calls).toHaveLength(1);
  });
});

describe("the production domain", () => {
  it("prefers the production target's alias, then the project's own list", () => {
    expect(parseProductionDomain({ targets: { production: { alias: ["a.example"] } }, alias: ["b.example"] })).toBe("a.example");
    expect(parseProductionDomain({ alias: [{ domain: "b.example" }] })).toBe("b.example");
  });

  it("is null rather than invented for a project that has never gone live", () => {
    // Naming `<name>.vercel.app` in a confirmation could name somebody else's
    // project; "no domain" is the honest sentence.
    expect(parseProductionDomain({ name: "shop" })).toBeNull();
  });

  it("refuses anything that is not a bare host — this ends up in an href", () => {
    expect(parseProductionDomain({ alias: ["https://evil.example/path"] })).toBeNull();
    expect(parseProductionDomain({ alias: ["a b"] })).toBeNull();
  });
});

describe("a git-connected project", () => {
  it("deploys a REF and uploads nothing", async () => {
    fakeApi(() => answer(200, CREATED));
    const made = await createDeployment(AUTH, {
      projectId: "prj_acme",
      projectName: "shop",
      target: "production",
      gitRef: "main",
      gitLink: { type: "github", repoId: "99", org: "acme", repo: "shop", defaultBranch: "main" },
    });
    expect(made.ok).toBe(true);
    expect(made.ok && made.deployment.id).toBe("dpl_new");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v13/deployments");
    expect(calls[0].body).toMatchObject({
      name: "shop",
      project: "prj_acme",
      target: "production",
      gitSource: { type: "github", ref: "main", repoId: "99", org: "acme", repo: "shop" },
    });
    expect((calls[0].body as { files?: unknown }).files).toBeUndefined();
  });

  it("refuses a ref for a project with no repository rather than sending it", async () => {
    fakeApi(() => answer(200, CREATED));
    const made = await createDeployment(AUTH, { projectId: "prj_acme", target: "preview", gitRef: "main", gitLink: null });
    expect(made.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("a project with no repository", () => {
  const FILES = [{ file: "index.html", sha: "a".repeat(40), size: 12 }];

  it("names the uploaded files by hash and asks Vercel not to stop and ask", async () => {
    fakeApi(() => answer(200, { ...CREATED, target: null }));
    const made = await createDeployment(AUTH, { projectId: "prj_acme", target: "preview", files: FILES });
    expect(made.ok).toBe(true);
    expect(calls[0].body).toMatchObject({ project: "prj_acme", files: FILES, projectSettings: {} });
    // Headless: there is nobody to confirm a framework guess to, so a
    // deployment that waited for one would build for ever.
    expect(calls[0].url.searchParams.get("skipAutoDetectionConfirmation")).toBe("1");
  });

  it("uploads the bytes under their content address", async () => {
    fakeApi(() => answer(200, {}));
    const sent = await uploadDeployFile(AUTH, { file: "index.html", sha: "b".repeat(40), size: 3, data: new Uint8Array([1, 2, 3]) });
    expect(sent.ok).toBe(true);
    expect(calls[0].url.pathname).toBe("/v2/files");
    expect(calls[0].headers["x-vercel-digest"]).toBe("b".repeat(40));
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
  });
});

describe("the target field", () => {
  const FILES = [{ file: "index.html", sha: "a".repeat(40), size: 12 }];

  it("sends NO target key at all for a preview", async () => {
    fakeApi(() => answer(200, { ...CREATED, target: null }));
    const made = await createDeployment(AUTH, { projectId: "prj_acme", target: "preview", files: FILES });
    expect(made.ok).toBe(true);
    // Not "target is undefined" — the KEY is absent. Vercel refuses the literal
    // string "preview" outright, and has been seen to accept it and publish to
    // production; a preview is the absence of the field.
    expect(Object.keys(calls[0].body as object)).not.toContain("target");
  });

  it("sends target: production, and only that, for a production deploy", async () => {
    fakeApi(() => answer(200, CREATED));
    const made = await createDeployment(AUTH, { projectId: "prj_acme", target: "production", files: FILES });
    expect(made.ok).toBe(true);
    expect((calls[0].body as { target?: unknown }).target).toBe("production");
  });

  it("refuses to call an answer that came back on PRODUCTION a preview", async () => {
    // The state that published to a live domain under the words "deploy a
    // preview". Nothing here can take that deployment back, so the answer is a
    // refusal that names it and says where to look.
    fakeApi(() => answer(200, { ...CREATED, target: "production" }));
    const made = await createDeployment(AUTH, { projectId: "prj_acme", target: "preview", files: FILES });
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.kind).toBe("wrong_target");
    expect(made.ok === false && made.detail).toContain("dpl_new");
    expect(made.ok === false && made.detail).toContain("production");
  });

  it("accepts a production deployment that came back on production", async () => {
    fakeApi(() => answer(200, CREATED));
    const made = await createDeployment(AUTH, { projectId: "prj_acme", target: "production", files: FILES });
    expect(made.ok).toBe(true);
  });
});

describe("what is refused before anything is sent", () => {
  it("refuses both a ref and files, and refuses neither", async () => {
    fakeApi(() => answer(200, CREATED));
    const both = await createDeployment(AUTH, {
      projectId: "p", target: "preview", gitRef: "main",
      gitLink: { type: "github", repoId: "1", org: "a", repo: "b", defaultBranch: null },
      files: [{ file: "a", sha: "c".repeat(40), size: 1 }],
    });
    const neither = await createDeployment(AUTH, { projectId: "p", target: "preview" });
    expect(both.ok).toBe(false);
    expect(neither.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("the token", () => {
  it("never reaches a failure sentence, however loudly Vercel echoes it back", async () => {
    fakeApi(() => answer(403, { error: { message: `token ${TOKEN} is not allowed` } }));
    const made = await createDeployment(AUTH, { projectId: "p", target: "preview", files: [{ file: "a", sha: "d".repeat(40), size: 1 }] });
    expect(made.ok).toBe(false);
    expect(made.ok === false && made.detail).not.toContain(TOKEN);
    expect(made.ok === false && made.detail).toContain("<token>");
  });
});

describe("the account a deployment is made under", () => {
  it("scopes by the team the caller named, over the one on the credential", async () => {
    fakeApi(() => answer(200, { ...CREATED, target: null }));
    await createDeployment({ token: TOKEN, teamId: "team_default" }, {
      projectId: "p", teamId: "team_named", target: "preview", files: [{ file: "a", sha: "e".repeat(40), size: 1 }],
    });
    expect(calls[0].url.searchParams.get("teamId")).toBe("team_named");
  });
});
