/**
 * The owner's Vercel link, and what the box can say about it.
 *
 * Two properties carry the whole feature:
 *
 *  1. THE LINK NAMES A SECRET; IT NEVER HOLDS ONE. What is stored is an id, a
 *     team and a NAME, and the token is fetched out of the encrypted store for
 *     the length of one call — with the store's own scope precedence, so the
 *     token a RUN is handed as `$VERCEL_TOKEN` and the token the BOX polls with
 *     are the same entry.
 *  2. READINESS IS TRI-STATE. "Vercel refused your token" and "this box could
 *     not reach Vercel" are different answers, and folding the second into the
 *     first sends an owner to rotate a working credential because their house
 *     internet was down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());

let root = "";
let dataDir = "";
let restoreEnv: () => void;
let links: typeof import("@/lib/vercel-link");
let store: typeof import("@/lib/project-secrets");
/** Whatever the config-store was last asked to save under the links key. */
let saved: Record<string, unknown> = {};

const SESSION_SECRET = "7c".repeat(32);
const TOKEN = "vrc_live_Xk29fLm4Qp7sT1wZ8bN3dH6jR0aC5yE";
const OTHER_TOKEN = "vrc_live_ZZZZfLm4Qp7sT1wZ8bN3dH6jR0aC5yE";

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-vercel-link-")));
  dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, ".session-secret"), SESSION_SECRET, { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;

  saved = {};
  vi.resetModules();
  configGet.mockReset().mockImplementation(async (key: string) =>
    (key === "coding_vercel_links" ? saved : undefined));
  configSet.mockReset().mockImplementation(async (key: string, value: unknown) => {
    if (key === "coding_vercel_links") saved = value as Record<string, unknown>;
  });
  vi.doMock("@/lib/config-store", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/config-store")>()),
    get: configGet,
    set: configSet,
  }));
  store = await import("@/lib/project-secrets");
  store._resetSecretKeyCacheForTests();
  links = await import("@/lib/vercel-link");
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
  vi.doUnmock("@/lib/config-store");
});

describe("attaching a Vercel project", () => {
  it("stores the id, the team and the NAME of a secret — and no credential", async () => {
    const link = await links.setVercelLink({
      scope: "shop", projectId: "prj_abc", teamId: "team_acme", tokenSecretName: "VERCEL_TOKEN",
    });
    expect(link).toMatchObject({ projectId: "prj_abc", teamId: "team_acme", tokenSecretName: "VERCEL_TOKEN" });
    // The headline: nothing that could be a token is in what was written.
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(await links.readVercelLink("shop")).toMatchObject({ projectId: "prj_abc" });
  });

  it("treats an absent, null or empty team as a personal account", async () => {
    for (const teamId of [undefined, null, ""]) {
      const link = await links.setVercelLink({ scope: "shop", projectId: "prj_abc", teamId, tokenSecretName: "VERCEL_TOKEN" });
      expect(link.teamId, String(teamId)).toBeNull();
    }
  });

  it("keeps createdAt when the link is changed", async () => {
    const first = await links.setVercelLink({ scope: "shop", projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" });
    const second = await links.setVercelLink({ scope: "shop", projectId: "prj_b", tokenSecretName: "VERCEL_TOKEN" });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.projectId).toBe("prj_b");
  });

  it("refuses an identifier that is not one — these reach a URL path", async () => {
    for (const projectId of ["../../etc", "prj a", "prj/abc", "", "x".repeat(200), null, 7]) {
      await expect(
        links.setVercelLink({ scope: "shop", projectId, tokenSecretName: "VERCEL_TOKEN" }),
        String(projectId),
      ).rejects.toMatchObject({ code: "invalid_project" });
    }
    await expect(links.setVercelLink({ scope: "shop", projectId: "prj_a", teamId: "team acme", tokenSecretName: "X" }))
      .rejects.toMatchObject({ code: "invalid_team" });
  });

  it("refuses a token name that is not an environment variable name", async () => {
    for (const name of ["vercel token", "1TOKEN", "", null]) {
      await expect(
        links.setVercelLink({ scope: "shop", projectId: "prj_a", tokenSecretName: name }),
        String(name),
      ).rejects.toMatchObject({ code: "invalid_secret_name" });
    }
  });

  it("refuses the BOX scope — a box-wide link would deploy every project to one place", async () => {
    await expect(links.setVercelLink({ scope: store.BOX_SCOPE, projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" }))
      .rejects.toMatchObject({ code: "invalid_scope" });
    await expect(links.setVercelLink({ scope: "", projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" }))
      .rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("detaches, and leaves the owner's stored token alone", async () => {
    await store.setSecret({ name: "VERCEL_TOKEN", value: TOKEN, scope: store.BOX_SCOPE });
    await links.setVercelLink({ scope: "shop", projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" });
    expect(await links.deleteVercelLink("shop")).toBe(true);
    expect(await links.readVercelLink("shop")).toBeNull();
    // Not this store's to delete: the secret may be box-wide and in use.
    expect((await store.listSecrets()).map((s) => s.name)).toEqual(["VERCEL_TOKEN"]);
    expect(await links.deleteVercelLink("shop")).toBe(false);
  });

  it("drops a malformed stored entry rather than the owner's whole map", async () => {
    saved = { shop: { projectId: "prj_a", teamId: null, tokenSecretName: "VERCEL_TOKEN", createdAt: 1, updatedAt: 1 }, junk: { nope: true } };
    const all = await links.readVercelLinks();
    expect(Object.keys(all)).toEqual(["shop"]);
  });
});

describe("resolving the token", () => {
  it("opens the entry the owner named, and prefers the PROJECT's over the box's", async () => {
    await store.setSecret({ name: "VERCEL_TOKEN", value: OTHER_TOKEN, scope: store.BOX_SCOPE });
    await store.setSecret({ name: "VERCEL_TOKEN", value: TOKEN, scope: "shop" });
    const link = await links.setVercelLink({ scope: "shop", projectId: "prj_a", teamId: "team_x", tokenSecretName: "VERCEL_TOKEN" });
    expect(await links.resolveVercelAuth(link, "shop")).toEqual({ token: TOKEN, teamId: "team_x" });
    // A project with no entry of its own falls back to the box's.
    expect(await links.resolveVercelAuth(link, "other")).toEqual({ token: OTHER_TOKEN, teamId: "team_x" });
  });

  it("does NOT need the injection switch or the entry's tick — that gates a RUN, not the box", async () => {
    // Both off: a run would be handed nothing, and the box must still be able
    // to tell its owner whether their project built.
    await store.setSecret({ name: "VERCEL_TOKEN", value: TOKEN, scope: store.BOX_SCOPE, inject: false });
    const link = await links.setVercelLink({ scope: "shop", projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" });
    expect((await links.resolveVercelAuth(link, "shop")).token).toBe(TOKEN);
  });

  it("says the secret is missing rather than calling with nothing", async () => {
    const link = await links.setVercelLink({ scope: "shop", projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" });
    await expect(links.resolveVercelAuth(link, "shop")).rejects.toMatchObject({ code: "token_missing" });
  });
});

describe("readiness", () => {
  async function link() {
    await store.setSecret({ name: "VERCEL_TOKEN", value: TOKEN, scope: store.BOX_SCOPE });
    await links.setVercelLink({ scope: "shop", projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" });
  }

  it("is 'not linked' on a project with no attachment, and asks Vercel nothing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await links.checkVercelReadiness("shop")).toMatchObject({ linked: false, ready: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is ready when the token works and the project resolves", async () => {
    await link();
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      (String(url).includes("/v2/user")
        ? answer(200, { user: { username: "acme" } })
        : answer(200, { id: "prj_a", name: "acme-app" }))));
    expect(await links.checkVercelReadiness("shop")).toMatchObject({
      linked: true, ready: true, tokenPresent: true, tokenValid: true,
      projectResolves: true, username: "acme", projectName: "acme-app", problems: [],
    });
  });

  it("says the TOKEN is wrong only when Vercel says so", async () => {
    await link();
    vi.stubGlobal("fetch", vi.fn(async () => answer(401, { error: { message: "invalid token" } })));
    const readiness = await links.checkVercelReadiness("shop");
    expect(readiness).toMatchObject({ tokenValid: false, ready: false, code: "auth" });
    expect(readiness.problems[0]).toMatch(/refused/i);
  });

  it("leaves the verdict UNKNOWN when the box could not ask — never 'your token is wrong'", async () => {
    await link();
    for (const fail of [
      async () => { throw new Error("offline"); },
      async () => answer(503, { error: { message: "down" } }),
      async () => answer(429, { error: { message: "slow down" } }),
    ]) {
      vi.stubGlobal("fetch", vi.fn(fail));
      const readiness = await links.checkVercelReadiness("shop");
      expect(readiness.tokenValid).toBeNull();
      expect(readiness.ready).toBe(false);
      expect(readiness.problems).toHaveLength(1);
    }
  });

  it("says the project is not there when Vercel 404s it, with the token still good", async () => {
    await link();
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      (String(url).includes("/v2/user")
        ? answer(200, { user: { username: "acme" } })
        : answer(404, { error: { message: "not found" } }))));
    const readiness = await links.checkVercelReadiness("shop");
    expect(readiness).toMatchObject({ tokenValid: true, projectResolves: false, ready: false, code: "not_found" });
    expect(readiness.problems[0]).toContain("prj_a");
  });

  it("leaves the project verdict unknown when the SECOND call is the one that could not be made", async () => {
    await link();
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      (String(url).includes("/v2/user")
        ? answer(200, { user: { username: "acme" } })
        : answer(500, { error: { message: "boom" } }))));
    expect(await links.checkVercelReadiness("shop")).toMatchObject({ tokenValid: true, projectResolves: null, ready: false });
  });

  it("reports a missing secret without ever asking Vercel", async () => {
    await links.setVercelLink({ scope: "shop", projectId: "prj_a", tokenSecretName: "VERCEL_TOKEN" });
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const readiness = await links.checkVercelReadiness("shop");
    expect(readiness).toMatchObject({ linked: true, tokenPresent: false, ready: false, code: "token_missing" });
    expect(readiness.problems[0]).toContain("VERCEL_TOKEN");
    expect(spy).not.toHaveBeenCalled();
  });
});
