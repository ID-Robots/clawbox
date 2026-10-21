/**
 * src/lib/store-install.ts — installing a ClawBox app from the ClawBox Store.
 * The package is checked against the SHA-256 the Store published before a
 * byte of it is unpacked, it lands in the owner's project folder as <slug>
 * with the Store's receipt, and it is registered the way its manifest says.
 * Uninstalling removes only a folder that carries the receipt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { packTarGz, type TarEntry } from "@/lib/tar-gz";
import { saveEnv } from "@/tests/helpers/env";

const getDefaultDirectory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", () => ({ getDefaultDirectory }));
const resolveClawaiToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/harness/credentials", () => ({ resolveClawaiToken, CLAWBOX_AI_PROXY_URL: "https://clawbox.com/api/ai" }));
const ensureRepository = vi.hoisted(() => vi.fn());
vi.mock("@/lib/project-import", () => ({ ensureRepository, freeBytes: vi.fn(async () => null), IMPORT_FREE_RESERVE_BYTES: 0 }));
const registerOrStartServerApp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-server-start", () => ({ registerOrStartServerApp }));
const deployWebapp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/code-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-projects")>()),
  deployWebapp,
}));

import {
  clawboxStoreAppFrom,
  installClawboxApp,
  packageFetchUrl,
  packageLayout,
  verifyPackage,
  type ClawboxStoreApp,
} from "@/lib/store-install";
import { removeStoreInstalledFolder, STORE_MARKER, storeInstalledFolder } from "@/lib/store-install-receipt";

const BASE = "https://portal.example";
let restoreEnv: () => void;
let projectsRoot: string;
const fetchMock = vi.fn();

function file(p: string, body: string): TarEntry {
  return { path: p, type: "file", mode: 0o644, mtime: 1_700_000_000, data: Buffer.from(body) };
}

async function packageOf(entries: TarEntry[]): Promise<Buffer> {
  return packTarGz(entries, { maxBytes: 10 * 1024 * 1024 });
}

function sha(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function listing(pkg: Buffer, extra: Partial<ClawboxStoreApp> = {}): ClawboxStoreApp {
  return {
    slug: "hello-app",
    name: "Hello App",
    description: "Says hello",
    kind: "webapp",
    version: "1.0.0",
    packageUrl: `${BASE}/api/store/apps/hello-app/package`,
    sha256: sha(pkg),
    size: pkg.length,
    iconUrl: null,
    ...extra,
  };
}

function served(pkg: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(pkg), {
    status: 200,
    headers: { "content-type": "application/gzip", "x-clawbox-app-version": "1.0.0", "x-clawbox-package-sha256": sha(pkg), ...headers },
  });
}

const WEBAPP = [
  file("clawbox.json", JSON.stringify({ name: "Hello App", kind: "webapp" })),
  file("index.html", '<!doctype html><link rel="stylesheet" href="style.css"><p>hi</p>'),
  file("style.css", "p{color:red}"),
];

beforeEach(() => {
  restoreEnv = saveEnv("PORTAL_WEB");
  process.env.PORTAL_WEB = BASE;
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "store-install-"));
  getDefaultDirectory.mockResolvedValue(projectsRoot);
  resolveClawaiToken.mockResolvedValue("claw_test_0123456789abcdef");
  ensureRepository.mockResolvedValue({ initialized: true, detail: null });
  deployWebapp.mockResolvedValue(undefined);
  registerOrStartServerApp.mockResolvedValue({ ok: true });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

describe("verifyPackage", () => {
  const pkg = Buffer.from("the package");

  it("accepts the package the Store published", () => {
    expect(verifyPackage(pkg, { name: "A", sha256: sha(pkg), size: pkg.length }, sha(pkg))).toBeNull();
    expect(verifyPackage(pkg, { name: "A", sha256: sha(pkg).toUpperCase(), size: null }, null)).toBeNull();
  });

  it("refuses a package whose SHA-256 is not the listing's", () => {
    expect(verifyPackage(pkg, { name: "A", sha256: "0".repeat(64), size: null }))
      .toMatchObject({ ok: false, code: "sha256_mismatch", status: 422, retryable: false });
  });

  it("refuses when the portal's header disagrees, or the size does", () => {
    expect(verifyPackage(pkg, { name: "A", sha256: sha(pkg), size: null }, "f".repeat(64))).toMatchObject({ code: "sha256_mismatch" });
    expect(verifyPackage(pkg, { name: "A", sha256: sha(pkg), size: pkg.length + 1 }, null)).toMatchObject({ code: "sha256_mismatch" });
  });
});

describe("clawboxStoreAppFrom", () => {
  const record = { source: "clawbox", slug: "hello-app", name: "Hello App", kind: "webapp", version: "1.0.0", packageUrl: "/p", sha256: "a".repeat(64), size: 10, iconUrl: "https://x.example/i.png" };

  it("reads a ClawBox app's record", () => {
    expect(clawboxStoreAppFrom(record)).toMatchObject({ slug: "hello-app", kind: "webapp", sha256: "a".repeat(64), size: 10, iconUrl: "https://x.example/i.png" });
  });

  it.each([
    ["a ClawHub skill", { ...record, source: undefined }],
    ["no package", { ...record, packageUrl: undefined }],
    ["no digest", { ...record, sha256: "abc" }],
    ["a slug that could reach a path", { ...record, slug: "../x" }],
  ])("is null for %s", (_what, raw) => {
    expect(clawboxStoreAppFrom(raw)).toBeNull();
  });
});

describe("packageFetchUrl", () => {
  it("resolves a portal path, takes https anywhere, refuses plain http elsewhere", () => {
    expect(packageFetchUrl("/api/store/apps/x/package", BASE)?.toString()).toBe(`${BASE}/api/store/apps/x/package`);
    expect(packageFetchUrl("https://blob.example/x.tgz", BASE)?.toString()).toBe("https://blob.example/x.tgz");
    expect(packageFetchUrl("http://lan-host.example/x.tgz", BASE)).toBeNull();
    expect(packageFetchUrl("file:///etc/passwd", BASE)).toBeNull();
  });
});

describe("packageLayout", () => {
  it("takes the manifest from the root, or from inside one wrapping folder", () => {
    expect(packageLayout(WEBAPP)?.manifest.name).toBe("Hello App");
    const wrapped = packageLayout(WEBAPP.map((e) => ({ ...e, path: `package/${e.path}` })));
    expect(wrapped?.entries.map((e) => e.path).sort()).toEqual(["clawbox.json", "index.html", "style.css"]);
    expect(packageLayout([file("index.html", "x")])).toBeNull();
  });

  it("never unpacks a repository or the project's .clawbox, at the root or one folder down", () => {
    const hostile = [
      ...WEBAPP,
      file(".git/config", "[core]\n\tfsmonitor = touch /tmp/pwned\n"),
      { ...file(".git/hooks/pre-commit", "#!/bin/sh\ntouch /tmp/pwned\n"), mode: 0o755 },
      file("vendor/lib/.git/config", "[core]"),
      file(".clawbox/store-app.json", JSON.stringify({ source: "clawbox", slug: "someone-else", version: "9.9.9" })),
      file("docs/.clawbox-notes.md", "kept: not the project's .clawbox"),
    ];
    for (const entries of [hostile, hostile.map((e) => ({ ...e, path: `package/${e.path}` }))]) {
      expect(packageLayout(entries)?.entries.map((e) => e.path).sort()).toEqual(["clawbox.json", "docs/.clawbox-notes.md", "index.html", "style.css"]);
    }
  });
});

describe("installClawboxApp", () => {
  it("refuses a package that does not match its published SHA-256, and writes nothing", async () => {
    const pkg = await packageOf(WEBAPP);
    fetchMock.mockResolvedValue(served(pkg, { "x-clawbox-package-sha256": "" }));
    const out = await installClawboxApp(listing(pkg, { sha256: "0".repeat(64) }));
    expect(out).toMatchObject({ ok: false, code: "sha256_mismatch", status: 422 });
    expect(fs.existsSync(path.join(projectsRoot, "hello-app"))).toBe(false);
    expect(deployWebapp).not.toHaveBeenCalled();
  });

  it("unpacks a verified package as a project, with the Store's receipt, and puts its page on the desktop", async () => {
    const pkg = await packageOf(WEBAPP);
    fetchMock.mockResolvedValue(served(pkg));
    const out = await installClawboxApp(listing(pkg));
    expect(out).toMatchObject({ ok: true, appId: "hello-app", folder: "hello-app", version: "1.0.0", registered: true, webappUrl: "/setup-api/webapps?app=hello-app", alreadyInstalled: false });
    const dir = path.join(projectsRoot, "hello-app");
    expect(fs.readFileSync(path.join(dir, "style.css"), "utf-8")).toBe("p{color:red}");
    expect(JSON.parse(fs.readFileSync(path.join(dir, STORE_MARKER), "utf-8"))).toMatchObject({ source: "clawbox", slug: "hello-app", version: "1.0.0", sha256: sha(pkg) });
    expect(ensureRepository).toHaveBeenCalledWith(dir, "the ClawBox Store");
    // The one-page form a desktop web app is served as: the stylesheet inlined.
    expect(deployWebapp).toHaveBeenCalledWith("hello-app", expect.stringContaining("p{color:red}"), expect.objectContaining({ name: "Hello App" }));
    // The portal token went to the portal, which is where the package was.
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer claw_test_0123456789abcdef");
  });

  it("never sends the portal token to a package host that is not the portal", async () => {
    const pkg = await packageOf(WEBAPP);
    fetchMock.mockResolvedValue(served(pkg));
    await installClawboxApp(listing(pkg, { packageUrl: "https://blob.example/hello.tgz" }));
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("installs a package carrying a .git and a forged receipt without either", async () => {
    const pkg = await packageOf([
      ...WEBAPP,
      file(".git/config", "[core]\n\tfsmonitor = touch /tmp/pwned\n"),
      file(".clawbox/store-app.json", JSON.stringify({ source: "clawbox", slug: "hello-app", version: "9.9.9" })),
    ]);
    fetchMock.mockResolvedValue(served(pkg));
    expect(await installClawboxApp(listing(pkg))).toMatchObject({ ok: true, version: "1.0.0" });
    const dir = path.join(projectsRoot, "hello-app");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, STORE_MARKER), "utf-8"))).toMatchObject({ slug: "hello-app", version: "1.0.0", sha256: sha(pkg) });
  });

  it("starts and proxies a server app through the existing /apps/<id>/ flow", async () => {
    const pkg = await packageOf([file("clawbox.json", JSON.stringify({ name: "Server", port: 4230, start: "node server.js" })), file("server.js", "")]);
    fetchMock.mockResolvedValue(served(pkg));
    const out = await installClawboxApp(listing(pkg, { kind: "server" }));
    expect(out).toMatchObject({ ok: true, registered: true, webappUrl: "/apps/hello-app/" });
    expect(registerOrStartServerApp).toHaveBeenCalledWith(expect.objectContaining({ id: "hello-app", directory: path.join(projectsRoot, "hello-app") }));
    expect(deployWebapp).not.toHaveBeenCalled();
  });

  it("keeps the files but reports a server that would not start as not registered", async () => {
    registerOrStartServerApp.mockResolvedValue({ ok: false, reason: "not_listening", detail: "Nothing answered on port 4230." });
    const pkg = await packageOf([file("clawbox.json", JSON.stringify({ name: "Server", port: 4230 }))]);
    fetchMock.mockResolvedValue(served(pkg));
    const out = await installClawboxApp(listing(pkg));
    expect(out).toMatchObject({ ok: true, registered: false, webappUrl: null });
    expect(out.ok && out.detail).toContain("Nothing answered on port 4230.");
    expect(fs.existsSync(path.join(projectsRoot, "hello-app", "clawbox.json"))).toBe(true);
  });

  it("gives a tool a page saying where its files are", async () => {
    const pkg = await packageOf([file("clawbox.json", JSON.stringify({ name: "CLI", kind: "tool" })), file("index.html", "<p>not a window</p>")]);
    fetchMock.mockResolvedValue(served(pkg));
    expect(await installClawboxApp(listing(pkg, { kind: "tool" }))).toMatchObject({ ok: true, registered: true });
    expect(deployWebapp).toHaveBeenCalledWith("hello-app", expect.stringContaining("This is a tool"), expect.anything());
  });

  it("refuses a package with a path out of its folder, and leaves no folder behind", async () => {
    const pkg = await packageOf([file("clawbox.json", JSON.stringify({ name: "A" })), file("../escape.txt", "x")]);
    fetchMock.mockResolvedValue(served(pkg));
    expect(await installClawboxApp(listing(pkg))).toMatchObject({ ok: false, code: "invalid_package", status: 422 });
    expect(fs.existsSync(path.join(projectsRoot, "hello-app"))).toBe(false);
  });

  it("needs the Coding Agent's project folder", async () => {
    getDefaultDirectory.mockResolvedValue(null);
    expect(await installClawboxApp(listing(Buffer.from("x")))).toMatchObject({ ok: false, code: "no_project_folder", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never overwrites a folder of the same name the Store did not make", async () => {
    fs.mkdirSync(path.join(projectsRoot, "hello-app"));
    fs.writeFileSync(path.join(projectsRoot, "hello-app", "mine.txt"), "the owner's");
    expect(await installClawboxApp(listing(Buffer.from("x")))).toMatchObject({ ok: false, code: "exists", status: 409 });
    expect(fs.readFileSync(path.join(projectsRoot, "hello-app", "mine.txt"), "utf-8")).toBe("the owner's");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("installing again over the Store's own folder only retries the registration", async () => {
    const pkg = await packageOf(WEBAPP);
    fetchMock.mockResolvedValue(served(pkg));
    await installClawboxApp(listing(pkg));
    fetchMock.mockClear();
    deployWebapp.mockClear();
    const again = await installClawboxApp(listing(pkg));
    expect(again).toMatchObject({ ok: true, alreadyInstalled: true, registered: true, version: "1.0.0" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deployWebapp).toHaveBeenCalledTimes(1);
  });
});

describe("the Store's receipt and the uninstall", () => {
  it("removes a folder the Store installed, and only that", async () => {
    const pkg = await packageOf(WEBAPP);
    fetchMock.mockResolvedValue(served(pkg));
    await installClawboxApp(listing(pkg));
    expect(await storeInstalledFolder("hello-app")).toBe(path.join(projectsRoot, "hello-app"));
    expect(await removeStoreInstalledFolder("hello-app")).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, "hello-app"))).toBe(false);

    fs.mkdirSync(path.join(projectsRoot, "mine"));
    expect(await removeStoreInstalledFolder("mine")).toBe(false);
    expect(fs.existsSync(path.join(projectsRoot, "mine"))).toBe(true);
  });

  it("is never a path out of the project folder", async () => {
    expect(await storeInstalledFolder("../..")).toBeNull();
    getDefaultDirectory.mockResolvedValue(null);
    expect(await storeInstalledFolder("hello-app")).toBeNull();
  });
});
