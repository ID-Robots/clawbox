/**
 * src/lib/store-publish.ts — packing a ClawBox app and handing it to the
 * ClawBox Store. What a package must never carry (dependencies, the
 * repository, secrets, symlinks, what .gitignore names), the manifest it must
 * carry, and ONE typed outcome for every answer the portal can give.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { readTarGz } from "@/lib/tar-gz";
import { saveEnv } from "@/tests/helpers/env";

// `git init` and `git ls-files` are real processes: both ceilings, as every
// spawning suite declares them (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const resolveClawaiToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/harness/credentials", () => ({ resolveClawaiToken, CLAWBOX_AI_PROXY_URL: "https://clawbox.com/api/ai" }));
const put = vi.hoisted(() => vi.fn());
vi.mock("@vercel/blob/client", () => ({ put }));

import {
  buildPublishMetadata,
  bumpVersion,
  isExcludedFromPackage,
  mapPublishResponse,
  packagePathname,
  packProject,
  PackError,
  parseGitignore,
  PUBLISH_DIRECT_MAX_BYTES,
  publishProject,
  sendPackage,
  storePortalBase,
  storePublishStatus,
  type PackedProject,
  type PublishMetadata,
} from "@/lib/store-publish";

const BASE = "https://portal.example";
const TOKEN = "claw_test_0123456789abcdef";
let restoreEnv: () => void;
let dirs: string[] = [];
const fetchMock = vi.fn();

function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-publish-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function packedPaths(pack: PackedProject): string[] {
  return readTarGz(pack.buffer, { maxBytes: 64 * 1024 * 1024, maxEntries: 10_000 }).map((e) => e.path).sort();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  restoreEnv = saveEnv("PORTAL_WEB");
  process.env.PORTAL_WEB = BASE;
  resolveClawaiToken.mockResolvedValue(TOKEN);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("isExcludedFromPackage", () => {
  it.each([
    "node_modules/react/index.js", "web/node_modules/x.js", ".git/config", ".next/cache/a", "dist/app.js", "build/out.js",
    ".clawbox/run-notes.md", ".env", ".env.local", ".env.production", "certs/server.pem", "id.key", "deploy/KEY.PEM",
    "data/secrets.json", "data/secrets/token.txt",
  ])("leaves out %s", (rel) => {
    expect(isExcludedFromPackage(rel)).toBe(true);
  });

  it.each(["clawbox.json", "src/app.js", ".gitignore", "data/seed.json", "docs/keys.md", "env.example.md"])("keeps %s", (rel) => {
    expect(isExcludedFromPackage(rel)).toBe(false);
  });
});

describe("parseGitignore (the walk's fallback)", () => {
  it("matches names anywhere, anchored paths, folders and globs; ignores negations", () => {
    const rules = parseGitignore("# comment\n*.log\n/tmp/\ncoverage\nsecret-*.txt\n!keep.log\nlib/**/gen.js\n");
    const hit = (rel: string, isDir = false) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(rel));
    expect(hit("a/b/debug.log")).toBe(true);
    expect(hit("tmp", true)).toBe(true);
    expect(hit("src/tmp", true)).toBe(false);
    expect(hit("tmp")).toBe(false);
    expect(hit("src/coverage", true)).toBe(true);
    expect(hit("secret-notes.txt")).toBe(true);
    expect(hit("lib/a/b/gen.js")).toBe(true);
    expect(hit("lib/gen.js")).toBe(true);
    expect(hit("src/app.js")).toBe(false);
  });
});

describe("packProject", () => {
  const files = {
    "clawbox.json": JSON.stringify({ name: "Hello App", kind: "webapp" }),
    "index.html": "<!doctype html><p>hi</p>",
    "src/app.js": "console.log(1)",
    ".gitignore": "*.log\ntmp/\n",
    "debug.log": "noise",
    "tmp/cache.txt": "noise",
    "node_modules/dep/index.js": "dep",
    "dist/bundle.js": "built",
    "build/out.js": "built",
    ".next/trace": "built",
    ".env": "SECRET=1",
    ".env.local": "SECRET=2",
    "server.pem": "-----BEGIN-----",
    "deploy.key": "key",
    "data/secrets.json": "{}",
    "data/seed.json": "{}",
    ".clawbox/run-notes.md": "box state",
  };
  const kept = [".gitignore", "clawbox.json", "data/seed.json", "index.html", "src/app.js"];

  it("packs the app and nothing it must not carry (a folder that is not its own repository)", async () => {
    const dir = tempProject(files);
    fs.symlinkSync(os.homedir(), path.join(dir, "home-link"));
    fs.symlinkSync(path.join(dir, "index.html"), path.join(dir, "linked.html"));
    const pack = await packProject(dir);
    expect(packedPaths(pack)).toEqual(kept);
    expect(pack.files[0]).toBe("clawbox.json");
    expect(pack.manifest.name).toBe("Hello App");
    expect(pack.size).toBe(pack.buffer.length);
    expect(pack.sha256).toBe(crypto.createHash("sha256").update(pack.buffer).digest("hex"));
  });

  it("asks git what .gitignore leaves out when the folder is its own repository", async () => {
    const dir = tempProject({ ...files, "notes/private.md": "mine", "notes/.gitignore": "private.md\n" });
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    const pack = await packProject(dir);
    // The nested .gitignore is git's own rule — the walk would not know it.
    expect(packedPaths(pack)).toEqual([...kept, "notes/.gitignore"].sort());
  });

  it("packs clawbox.json even where .gitignore names it", async () => {
    const dir = tempProject({ "clawbox.json": JSON.stringify({ name: "A" }), ".gitignore": "clawbox.json\n", "a.txt": "a" });
    expect(packedPaths(await packProject(dir))).toEqual([".gitignore", "a.txt", "clawbox.json"]);
  });

  it.each([
    ["no clawbox.json", { "index.html": "x" }],
    ["a clawbox.json without a name", { "clawbox.json": JSON.stringify({ kind: "webapp" }) }],
    ["a clawbox.json that is not JSON", { "clawbox.json": "{ name: nope" }],
  ])("refuses a project with %s", async (_what, projectFiles) => {
    await expect(packProject(tempProject(projectFiles))).rejects.toMatchObject({ reason: "no_manifest" });
    await expect(packProject(tempProject(projectFiles))).rejects.toBeInstanceOf(PackError);
  });
});

describe("mapPublishResponse", () => {
  it("201 is a new app, 200 a new version of one", () => {
    const created = mapPublishResponse(201, { app: { slug: "hello", version: "1.0.0" }, created: true }, BASE);
    expect(created).toEqual({ ok: true, app: { slug: "hello", version: "1.0.0" }, created: true, storeUrl: `${BASE}/portal/apps` });
    const updated = mapPublishResponse(200, { app: { slug: "hello", url: "https://store.example/apps/hello" }, created: false }, BASE);
    expect(updated).toMatchObject({ ok: true, created: false, storeUrl: "https://store.example/apps/hello" });
  });

  it("coming_soon carries the portal's message and the upgrade page as an absolute URL", () => {
    const out = mapPublishResponse(403, { code: "coming_soon", message: "Publishing opens with the Developer plan.", upgradeUrl: "/portal/apps" }, BASE);
    expect(out).toEqual({
      ok: false,
      code: "coming_soon",
      message: "Publishing opens with the Developer plan.",
      status: 403,
      retryable: false,
      upgradeUrl: `${BASE}/portal/apps`,
    });
  });

  it("never lets a hostile upgradeUrl leave the http(s) schemes", () => {
    const out = mapPublishResponse(403, { code: "coming_soon", message: "x", upgradeUrl: "javascript:alert(1)" }, BASE);
    expect(out.ok === false && out.upgradeUrl).toBe(`${BASE}/portal/apps`);
  });

  it("409 is slug_taken, about the slug", () => {
    expect(mapPublishResponse(409, { code: "slug_taken", message: "Taken." }, BASE)).toMatchObject({ ok: false, code: "slug_taken", field: "slug", status: 409, message: "Taken." });
  });

  it("413 is package_too_large", () => {
    expect(mapPublishResponse(413, { code: "package_too_large", message: "Over 50 MB." }, BASE)).toMatchObject({ ok: false, code: "package_too_large", status: 413 });
  });

  it("400 keeps the field it names", () => {
    expect(mapPublishResponse(400, { code: "invalid_version", message: "Version must go up.", field: "version" }, BASE))
      .toMatchObject({ ok: false, code: "invalid", field: "version", message: "Version must go up.", status: 400 });
  });

  it.each(["store_unavailable", "package_storage_unavailable"])("503 %s is store_unavailable, retryable", (code) => {
    expect(mapPublishResponse(503, { code, message: "Later." }, BASE)).toMatchObject({ ok: false, code: "store_unavailable", retryable: true, status: 503 });
  });

  it("the token errors map to token_rejected — and never to a 401 of the box's own", () => {
    for (const status of [401, 403]) {
      const out = mapPublishResponse(status, { error: { message: "Invalid token.", type: "auth", code: "invalid_token" } }, BASE);
      expect(out).toMatchObject({ ok: false, code: "token_rejected", status: 409 });
    }
    expect(mapPublishResponse(503, { error: { message: "Down.", type: "x", code: "unavailable" } }, BASE)).toMatchObject({ code: "store_unavailable" });
  });

  it("a success without the app, and anything unknown, is upstream", () => {
    expect(mapPublishResponse(201, {}, BASE)).toMatchObject({ ok: false, code: "upstream" });
    expect(mapPublishResponse(500, null, BASE)).toMatchObject({ ok: false, code: "upstream", retryable: true, status: 502 });
  });
});

describe("buildPublishMetadata", () => {
  const manifest = { name: "Tinder Clone", description: "Swipe", kind: null, port: 4230, start: null, stripBasePath: false };

  it("derives the slug from the name and the kind from the port", () => {
    expect(buildPublishMetadata(manifest, "folder", { version: "1.0.0" }))
      .toEqual({ slug: "tinder-clone", name: "Tinder Clone", description: "Swipe", kind: "server", version: "1.0.0", iconUrl: "" });
  });

  it("prefers the manifest's slug, and the owner's over both", () => {
    expect(buildPublishMetadata({ ...manifest, slug: "swiper" }, "f", { version: "1.0.0" })).toMatchObject({ slug: "swiper" });
    expect(buildPublishMetadata({ ...manifest, slug: "swiper" }, "f", { version: "1.0.0", slug: "mine" })).toMatchObject({ slug: "mine" });
  });

  it.each([
    [{ version: "1.0" }, "version"],
    [{ version: "1.0.0", slug: "Not A Slug" }, "slug"],
    [{ version: "1.0.0", iconUrl: "http://plain.example/icon.png" }, "iconUrl"],
    [{ version: "1.0.0", description: "x".repeat(301) }, "description"],
  ])("refuses %o, naming the field", (input, field) => {
    expect(buildPublishMetadata(manifest, "f", input)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("bumps the patch, or starts at 1.0.0", () => {
    expect(bumpVersion("1.2.3")).toBe("1.2.4");
    expect(bumpVersion("2.0.9-beta.1")).toBe("2.0.10");
    expect(bumpVersion(undefined)).toBe("1.0.0");
    expect(bumpVersion("latest")).toBe("1.0.0");
  });
});

describe("sending the package", () => {
  const metadata: PublishMetadata = { slug: "hello", name: "Hello", description: "Hi", kind: "webapp", version: "1.0.0", iconUrl: "" };
  const pack = (size: number): PackedProject => ({
    buffer: Buffer.alloc(size, 1),
    size,
    sha256: "0".repeat(64),
    files: ["clawbox.json"],
    manifest: { name: "Hello", description: null, kind: "webapp", port: null, start: null, stripBasePath: false },
  });

  it("sends a package up to 4 MB inside the publish request, under the box's portal token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { app: { slug: "hello", version: "1.0.0" }, created: true }));
    const out = await sendPackage(metadata, pack(1024), TOKEN, BASE);
    expect(out).toMatchObject({ ok: true, created: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/store/publish`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const form = init.body as FormData;
    expect(JSON.parse(String(form.get("metadata")))).toEqual(metadata);
    const sent = form.get("package") as File;
    expect(sent.size).toBe(1024);
    expect(sent.name).toBe("hello-1.0.0.tgz");
    expect(put).not.toHaveBeenCalled();
  });

  it("uploads a larger one to blob storage with a client token, then publishes it by URL", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { clientToken: "vercel_blob_client_token" }))
      .mockResolvedValueOnce(jsonResponse(200, { app: { slug: "hello", version: "1.0.0" }, created: false }));
    put.mockResolvedValue({ url: "https://blob.example/store/apps/hello/1.0.0.tgz" });
    const out = await sendPackage(metadata, pack(PUBLISH_DIRECT_MAX_BYTES + 1), TOKEN, BASE);
    expect(out).toMatchObject({ ok: true, created: false });
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(`${BASE}/api/store/publish/upload`);
    expect(JSON.parse(String(tokenInit.body))).toEqual({
      type: "blob.generate-client-token",
      payload: { pathname: packagePathname("hello", "1.0.0"), clientPayload: null, multipart: true },
    });
    expect(put).toHaveBeenCalledWith("store/apps/hello/1.0.0.tgz", expect.any(Buffer), expect.objectContaining({ access: "private", token: "vercel_blob_client_token", multipart: true }));
    const [publishUrl, publishInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(publishUrl).toBe(`${BASE}/api/store/publish`);
    expect(JSON.parse(String(publishInit.body))).toEqual({ ...metadata, packageUrl: "https://blob.example/store/apps/hello/1.0.0.tgz" });
  });

  it("maps a refused upload token like a refused publish", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: "coming_soon", message: "Soon.", upgradeUrl: "/portal/apps" }));
    expect(await sendPackage(metadata, pack(PUBLISH_DIRECT_MAX_BYTES + 1), TOKEN, BASE)).toMatchObject({ ok: false, code: "coming_soon" });
    expect(put).not.toHaveBeenCalled();
  });

  it("a network failure is unreachable, retryable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await sendPackage(metadata, pack(10), TOKEN, BASE)).toMatchObject({ ok: false, code: "unreachable", retryable: true });
  });
});

describe("publishProject", () => {
  const project = () => {
    const directory = tempProject({ "clawbox.json": JSON.stringify({ name: "Hello App" }), "index.html": "<p>hi</p>" });
    return { folder: path.basename(directory), directory };
  };

  it("refuses a project the listing does not have, and one without a manifest", async () => {
    expect(await publishProject("nope", { version: "1.0.0" }, async () => null)).toMatchObject({ ok: false, code: "not_found", status: 404 });
    const bare = tempProject({ "index.html": "x" });
    expect(await publishProject("bare", { version: "1.0.0" }, async () => ({ folder: "bare", directory: bare }))).toMatchObject({ ok: false, code: "no_manifest" });
  });

  it("is not_linked without a portal token, and asks nothing of the portal", async () => {
    resolveClawaiToken.mockResolvedValue(null);
    const p = project();
    expect(await publishProject(p.folder, { version: "1.0.0" }, async () => p)).toMatchObject({ ok: false, code: "not_linked", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays coming_soon from the portal end to end", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { code: "coming_soon", message: "Coming soon with the Developer plan.", upgradeUrl: "/portal/apps" }));
    const p = project();
    expect(await publishProject(p.folder, { version: "1.0.0" }, async () => p)).toMatchObject({
      ok: false, code: "coming_soon", message: "Coming soon with the Developer plan.", upgradeUrl: `${BASE}/portal/apps`,
    });
  });
});

describe("storePublishStatus", () => {
  it("is not linked, and cannot publish, without a token", async () => {
    resolveClawaiToken.mockResolvedValue(null);
    expect(await storePublishStatus()).toMatchObject({ linked: false, canPublish: false, code: "not_linked" });
  });

  it("relays canPublish and the owner's apps", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { canPublish: true, apps: [{ slug: "hello", version: "1.0.0" }] }));
    expect(await storePublishStatus()).toMatchObject({ linked: true, canPublish: true, apps: [{ slug: "hello", version: "1.0.0" }] });
    fetchMock.mockResolvedValue(jsonResponse(200, { canPublish: false, apps: [] }));
    expect(await storePublishStatus()).toMatchObject({ linked: true, canPublish: false, code: "coming_soon", upgradeUrl: `${BASE}/portal/apps` });
  });

  it("a rejected token reads as not linked; an unreachable portal as unknown", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: "Invalid token", type: "auth", code: "invalid_token" } }));
    expect(await storePublishStatus()).toMatchObject({ linked: false, canPublish: false, code: "token_rejected" });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await storePublishStatus()).toMatchObject({ linked: true, canPublish: null, code: "unreachable" });
  });
});

describe("storePortalBase", () => {
  it("is PORTAL_WEB when set, else the AI proxy's origin", () => {
    expect(storePortalBase()).toBe(BASE);
    delete process.env.PORTAL_WEB;
    expect(storePortalBase()).toBe("https://clawbox.com");
  });
});
