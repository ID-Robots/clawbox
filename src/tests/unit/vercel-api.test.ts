/**
 * The Vercel REST client, against a fake API.
 *
 * The properties under test are the ones a real box depends on and a fake
 * cannot be trusted to stumble into:
 *  - the TOKEN goes in the Authorization header and NEVER into a returned
 *    sentence, however loudly the far side echoes it back;
 *  - a network fault, a rate limit and a 5xx are TRANSIENT; a 401 and a 404
 *    are not — the watcher waits through the first set and ends on the second,
 *    and folding them together is how a box goes on polling with a credential
 *    its owner revoked (or gives up on a build because the house Wi-Fi blinked);
 *  - `teamId` is sent only when there IS a team, because an empty one is a 403;
 *  - a build log is read whether it arrives as a JSON array or as newline-
 *    delimited JSON, and what is kept is the TAIL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractLogText,
  listDeployments,
  MAX_BUILD_LOG_CHARS,
  promoteDeployment,
  readBuildLog,
  readDeployment,
  readProject,
  tailOf,
  verifyToken,
  type VercelAuth,
} from "@/lib/vercel";

const TOKEN = "vrc_live_Xk29fLm4Qp7sT1wZ8bN3dH6jR0aC5yE"; // gitleaks:allow
const AUTH: VercelAuth = { token: TOKEN, teamId: null };
const TEAM: VercelAuth = { token: TOKEN, teamId: "team_acme" };

/** Every request the fake served, so a test can assert what was asked. */
let calls: { url: URL; method: string; auth: string | null }[];

function answer(status: number, body: unknown, asText = false): Response {
  return new Response(asText ? String(body) : JSON.stringify(body), {
    status,
    headers: { "content-type": asText ? "text/plain" : "application/json" },
  });
}

/** Point `fetch` at a handler that sees one request and answers it. */
function fakeApi(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", auth: headers.Authorization ?? null });
    return handler(url, init);
  }));
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("how a call is made", () => {
  it("sends the token as a bearer and asks api.vercel.com", async () => {
    fakeApi(() => answer(200, { user: { username: "acme" } }));
    await verifyToken(AUTH);
    expect(calls[0].url.origin).toBe("https://api.vercel.com");
    expect(calls[0].url.pathname).toBe("/v2/user");
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it("sends teamId only when there is a team — an empty one is a 403 on Vercel", async () => {
    fakeApi(() => answer(200, { user: {} }));
    await verifyToken(AUTH);
    expect(calls[0].url.searchParams.has("teamId")).toBe(false);
    await verifyToken(TEAM);
    expect(calls[1].url.searchParams.get("teamId")).toBe("team_acme");
  });

  it("encodes an id into the path rather than pasting it in", async () => {
    fakeApi(() => answer(200, { id: "prj_1", name: "app" }));
    await readProject(AUTH, "weird/../id");
    expect(calls[0].url.pathname).toBe("/v9/projects/weird%2F..%2Fid");
  });
});

describe("what a failure is called", () => {
  const kinds: [number, string][] = [
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "rate"],
    [500, "upstream"],
    [503, "upstream"],
    [400, "refused"],
    [422, "refused"],
  ];

  for (const [status, kind] of kinds) {
    it(`reads ${status} as ${kind}`, async () => {
      fakeApi(() => answer(status, { error: { message: "no" } }));
      const res = await verifyToken(AUTH);
      expect(res.ok).toBe(false);
      expect((res as { kind: string }).kind).toBe(kind);
      expect((res as { status: number }).status).toBe(status);
    });
  }

  it("reads a thrown fetch as a NETWORK fault, which is waited through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND api.vercel.com"); }));
    const res = await verifyToken(AUTH);
    expect(res).toMatchObject({ ok: false, kind: "network" });
    expect((res as { detail: string }).detail).toContain("ENOTFOUND");
  });

  it("quotes Vercel's own message, and falls back to the status when there is none", async () => {
    fakeApi(() => answer(403, { error: { message: "Not authorized: token expired" } }));
    expect((await verifyToken(AUTH) as { detail: string }).detail).toContain("token expired");
    fakeApi(() => answer(418, "I am a teapot", true));
    expect((await verifyToken(AUTH) as { detail: string }).detail).toContain("418");
  });

  it("NEVER lets the token into a sentence, even when the far side echoes it", async () => {
    // The failure mode this guards: the detail goes onto a run record, which a
    // route the MCP bearer reaches answers.
    fakeApi(() => answer(403, { error: { message: `The token ${TOKEN} is not valid for this scope` } }));
    const res = await verifyToken(AUTH);
    const detail = (res as { detail: string }).detail;
    expect(detail).not.toContain(TOKEN);
    expect(detail).toContain("<token>");
  });

  it("reports an answer it could not parse as upstream rather than as an empty success", async () => {
    fakeApi(() => answer(200, "<html>maintenance</html>", true));
    expect(await verifyToken(AUTH)).toMatchObject({ ok: false, kind: "upstream" });
  });
});

describe("verifyToken and readProject", () => {
  it("answers the account name when Vercel gives one", async () => {
    fakeApi(() => answer(200, { user: { username: "acme-ops" } }));
    expect(await verifyToken(AUTH)).toEqual({ ok: true, username: "acme-ops" });
  });

  it("is still ok for an account with no username — the token is what was asked about", async () => {
    fakeApi(() => answer(200, { user: {} }));
    expect(await verifyToken(AUTH)).toEqual({ ok: true, username: null });
  });

  it("resolves a project and keeps the id the caller asked about when Vercel omits one", async () => {
    fakeApi(() => answer(200, { name: "acme-app" }));
    expect(await readProject(AUTH, "acme-app")).toEqual({ ok: true, id: "acme-app", name: "acme-app" });
  });
});

describe("listDeployments", () => {
  it("asks for the project's page and parses every row it can", async () => {
    fakeApi((url) => {
      expect(url.pathname).toBe("/v6/deployments");
      expect(url.searchParams.get("projectId")).toBe("prj_1");
      return answer(200, {
        deployments: [
          { uid: "dpl_2", state: "BUILDING", url: "b.vercel.app", meta: { githubCommitSha: "bbb" } },
          { nothing: true },
          { uid: "dpl_1", state: "READY", url: "a.vercel.app", meta: { githubCommitSha: "aaa" } },
        ],
      });
    });
    const res = await listDeployments(AUTH, "prj_1");
    expect(res.ok).toBe(true);
    // The unreadable row is DROPPED, not allowed to take the page with it.
    expect((res as { deployments: { id: string }[] }).deployments.map((d) => d.id)).toEqual(["dpl_2", "dpl_1"]);
  });

  it("answers an empty list for a project with no deployments, not a failure", async () => {
    fakeApi(() => answer(200, {}));
    expect(await listDeployments(AUTH, "prj_1")).toEqual({ ok: true, deployments: [] });
  });
});

describe("readDeployment", () => {
  it("answers the one deployment", async () => {
    fakeApi(() => answer(200, { id: "dpl_9", readyState: "READY", url: "x.vercel.app" }));
    const res = await readDeployment(AUTH, "dpl_9");
    expect(res).toMatchObject({ ok: true, deployment: { id: "dpl_9", readyState: "ready" } });
  });

  it("reports an answer with no id rather than inventing a deployment", async () => {
    fakeApi(() => answer(200, { nothing: true }));
    expect(await readDeployment(AUTH, "dpl_9")).toMatchObject({ ok: false, kind: "upstream" });
  });
});

describe("the build log", () => {
  it("reads a JSON array of events", async () => {
    fakeApi(() => answer(200, [{ payload: { text: "line one" } }, { text: "line two" }]));
    expect(await readBuildLog(AUTH, "dpl_1")).toEqual({ ok: true, log: "line one\nline two" });
  });

  it("reads newline-delimited JSON, which is the other shape that endpoint serves", async () => {
    const ndjson = '{"type":"stdout","payload":{"text":"npm install"}}\n{"type":"stdout","payload":{"text":"failed"}}';
    fakeApi(() => answer(200, ndjson, true));
    expect(await readBuildLog(AUTH, "dpl_1")).toEqual({ ok: true, log: "npm install\nfailed" });
  });

  it("hands back RAW text when it is neither — the agent needs the log, not nothing", () => {
    expect(extractLogText("error: build failed\n  at foo.js:1")).toBe("error: build failed\n  at foo.js:1");
  });

  it("keeps the TAIL, cut on a line boundary, because the error is at the end", () => {
    const log = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const tail = tailOf(log);
    expect(tail.length).toBeLessThanOrEqual(MAX_BUILD_LOG_CHARS);
    expect(tail.endsWith("line 4999")).toBe(true);
    // Cut on a boundary: the first kept line is whole.
    expect(tail.split("\n")[0]).toMatch(/^line \d+$/);
  });

  it("leaves a short log alone", () => {
    expect(tailOf("one\ntwo\n")).toBe("one\ntwo");
  });
});

describe("promoteDeployment", () => {
  it("POSTs to the project's promote endpoint", async () => {
    fakeApi(() => answer(200, {}));
    expect(await promoteDeployment(AUTH, "prj_1", "dpl_1")).toEqual({ ok: true, promoted: true });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v10/projects/prj_1/promote/dpl_1");
  });

  it("is a failure with a kind when Vercel refuses it", async () => {
    fakeApi(() => answer(403, { error: { message: "insufficient scope" } }));
    expect(await promoteDeployment(AUTH, "prj_1", "dpl_1")).toMatchObject({ ok: false, kind: "auth" });
  });

  it("is the ONLY verb in this module that is not a GET", async () => {
    fakeApi(() => answer(200, { user: {} }));
    await verifyToken(AUTH);
    await readProject(AUTH, "prj_1");
    await listDeployments(AUTH, "prj_1");
    await readDeployment(AUTH, "dpl_1").catch(() => null);
    await readBuildLog(AUTH, "dpl_1").catch(() => null);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});
