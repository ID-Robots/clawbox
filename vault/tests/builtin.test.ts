// What makes the vault a built-in part of a box rather than a lab app:
// it makes its own keyring and store on first run, the box's browser pairs by
// itself (after the owner chose a PIN, never before), cards are off unless
// switched on, and the extension is built by the service.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { AuditLog } from "../src/server/audit";
import { Auth } from "../src/server/auth";
import { CardCatalog } from "../src/server/cards";
import { Catalog } from "../src/server/catalog";
import { loadConfig, REPO_DIR } from "../src/server/config";
import { buildExtension } from "../src/server/extensiondir";
import { FillQueue } from "../src/server/fillqueue";
import { PassStore } from "../src/server/pass";
import { firstSecretFingerprint, StoreSetup } from "../src/server/storeinit";
import { UiAssets } from "../src/server/ui";
import { createTempStore, PASS_BIN, type TempStore } from "./helpers/tempstore";
import { createTestVault, EXT_ORIGIN, type TestVault } from "./helpers/vault";

const PIN = "correct horse 42";
const PASSWORD = "Bi7!builtin-Test-pw";

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("first run: the vault makes its own keyring and store", () => {
  let root = "";
  const logs: string[] = [];

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cbv-first-")));
  });
  afterAll(() => {
    Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: join(root, "gnupg") }, stdout: "ignore", stderr: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  /** The service's own configuration for an empty vault folder, as main.ts builds it. */
  function fresh(extra: Record<string, string> = {}) {
    const config = loadConfig({ HOME: root, CLAWBOX_VAULT_HOME: join(root, "vault"), CLAWBOX_VAULT_PASS_BIN: PASS_BIN, ...extra });
    const env = { ...config.passEnv, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const setup = new StoreSetup({ passBin: config.passBin, storeDir: config.storeDir, gnupgHome: config.gnupgHome, env, log: (l) => logs.push(l) });
    return { config, env, setup };
  }

  test("paths: everything lives in the vault's own folder, never the user's keyring or store", () => {
    const { config } = fresh();
    expect(config.homeDir).toBe(join(root, "vault"));
    expect(config.storeDir).toBe(join(root, "vault/store"));
    expect(config.gnupgHome).toBe(join(root, "vault/gnupg"));
    expect(config.extensionDir).toBe(join(root, "vault/extension"));
    expect(config.passEnv.GNUPGHOME).toBe(config.gnupgHome);
    expect(loadConfig({ HOME: "/home/clawbox" }).homeDir).toBe("/home/clawbox/.clawbox-vault");
    expect(config.cards).toBe(false);
    expect(loadConfig({ CLAWBOX_VAULT_CARDS: "1" }).cards).toBe(true);
    expect(loadConfig({ CLAWBOX_VAULT_CARDS: "true" }).cards).toBe(false);
    expect(() => loadConfig({ CLAWBOX_VAULT_HOST: "0.0.0.0" })).toThrow("loopback");
  });

  test("an empty folder becomes a key, a store and a git history; an entry round-trips", async () => {
    const { config, env, setup } = fresh();
    expect(setup.current()).toEqual({ ready: false });
    expect(await setup.ensure()).toEqual({ ready: true });
    expect(statSync(config.gnupgHome).mode & 0o777).toBe(0o700);
    expect(statSync(config.storeDir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(config.storeDir, ".gpg-id"))).toBe(true);
    expect(existsSync(join(config.storeDir, ".git"))).toBe(true);
    expect(readFileSync(join(config.storeDir, ".gpg-id"), "utf8").trim()).toMatch(/^[0-9A-F]{40}$/);

    const store = new PassStore({ bin: config.passBin, storeDir: config.storeDir, env });
    await store.insert("first.example.com/owner", `${PASSWORD}\nlogin: owner\nurl: https://first.example.com/login\n`);
    expect(await store.show("first.example.com/owner")).toContain(PASSWORD);
    // On disk the entry is ciphertext, and every write is a commit under the vault's own name.
    expect(readFileSync(join(config.storeDir, "first.example.com/owner.gpg")).includes(PASSWORD)).toBe(false);
    const log = Bun.spawnSync(["git", "-C", config.storeDir, "log", "--format=%an <%ae> %s"], { env: { ...process.env, ...env } }).stdout.toString();
    expect(log).toContain("ClawBox Vault <vault@clawbox.invalid>");
    expect(logs.join("\n")).not.toContain(PASSWORD);
  }, 60_000);

  test("a second start changes nothing: same key, same store", async () => {
    const { config, setup } = fresh();
    const before = readFileSync(join(config.storeDir, ".gpg-id"), "utf8");
    expect(await setup.ensure()).toEqual({ ready: true });
    expect(readFileSync(join(config.storeDir, ".gpg-id"), "utf8")).toBe(before);
    expect(await new PassStore({ bin: config.passBin, storeDir: config.storeDir, env: fresh().env }).show("first.example.com/owner")).toContain(PASSWORD);
  }, 60_000);

  test("a store whose key is gone is reported, never papered over with a new key", async () => {
    const { config, env } = fresh();
    const other = join(root, "empty-keyring");
    const setup = new StoreSetup({ passBin: config.passBin, storeDir: config.storeDir, gnupgHome: other, env: { ...env, GNUPGHOME: other } });
    const status = await setup.ensure();
    expect(status.ready).toBe(false);
    expect(status.error).toContain("its key is missing");
    Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: other }, stdout: "ignore", stderr: "ignore" });
  }, 60_000);

  test("a box without pass still serves the app, says what is missing, and tries again later", async () => {
    let now = 1_000_000;
    const dir = join(root, "no-pass");
    const setup = new StoreSetup({
      passBin: join(root, "there-is-no-pass-here"),
      storeDir: join(dir, "store"),
      gnupgHome: join(dir, "gnupg"),
      env: { HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" },
      now: () => now,
      retryAfterMs: 15_000,
    });
    const first = await setup.ensure();
    expect(first).toEqual({ ready: false, error: "pass is not installed on this box" });

    const config = { ...loadConfig({ HOME: root, CLAWBOX_VAULT_HOME: dir }), passBin: join(root, "there-is-no-pass-here") };
    const auth = new Auth(join(dir, "config"));
    const catalog = new Catalog(new PassStore({ bin: config.passBin, storeDir: config.storeDir, env: {} }));
    const app = createApp({
      config,
      catalog,
      cards: new CardCatalog(catalog.store, catalog),
      auth,
      audit: new AuditLog(join(dir, "config")),
      queue: new FillQueue({ timeoutMs: 1_000 }),
      ui: await UiAssets.build(REPO_DIR),
      log: () => undefined,
      version: "test",
      setup,
    });
    const get = (path: string, token?: string) =>
      app.fetch(new Request(`http://127.0.0.1:4796${path}`, { headers: { host: "127.0.0.1:4796", ...(token ? { authorization: `Bearer ${token}` } : {}) } }));
    expect((await get("/api/health")).status).toBe(200);
    expect((await get("/apps/clawbox-vault/")).status).toBe(200);
    const status = await json(await get("/api/ui/status"));
    expect(status.store).toEqual({ ready: false, error: "pass is not installed on this box" });
    auth.setupPin(PIN);
    const session = auth.createSession().token;
    const entries = await get("/api/ui/entries", session);
    expect(entries.status).toBe(503);
    expect(await json(entries)).toEqual({ error: "the password store is not available: pass is not installed on this box", code: "store_unavailable" });
    // Inside the retry window nothing is spawned again; after it, the next request tries.
    Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: join(dir, "gnupg") }, stdout: "ignore", stderr: "ignore" });
    now += 20_000;
    expect((await setup.ensure()).ready).toBe(false);
    Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: join(dir, "gnupg") }, stdout: "ignore", stderr: "ignore" });
  }, 60_000);

  test("the fingerprint is read from the secret key, not from a subkey or a public line", () => {
    const colons = ["pub:u:255:22:AAAA:1::::::scESC:", "fpr:::::::::1111111111111111111111111111111111111111:", "sec:u:255:22:BBBB:1::::::scESC:", "fpr:::::::::2222222222222222222222222222222222222222:", "ssb:u:255:18:CCCC:1::::::e:", "fpr:::::::::3333333333333333333333333333333333333333:"].join("\n");
    expect(firstSecretFingerprint(colons)).toBe("2222222222222222222222222222222222222222");
    expect(firstSecretFingerprint("")).toBeNull();
  });
});

describe("the box's own browser pairs by itself", () => {
  let store: TempStore;
  let v: TestVault;
  let ui = "";

  beforeAll(async () => {
    store = createTempStore();
    v = await createTestVault(store);
  }, 60_000);
  afterAll(() => store?.cleanup());

  const auto = (secret: unknown, origin: string | null = EXT_ORIGIN) => v.request("/api/pair/auto", { body: { secret }, origin });

  test("not before the owner chose a PIN: nothing is saved or filled on an untouched box", async () => {
    const res = await auto(v.auth.autoPairSecret);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("not_set_up");
    expect(v.auth.extension()).toBeNull();
    // "Not yet" is the normal state of a new box and is not written down as a failure.
    expect(v.audit.recent(50).some((r) => r.action === "pair_failed")).toBe(false);
  });

  test("with the PIN set: the secret from the extension folder, from an extension origin, gets a token", async () => {
    ui = ((await json(await v.request("/api/ui/setup", { body: { pin: PIN } }))) as { token: string }).token;
    expect((await auto(v.auth.autoPairSecret, "https://evil.example.org")).status).toBe(403);
    expect((await auto(v.auth.autoPairSecret, null)).status).toBe(403);
    expect((await auto("x".repeat(43))).status).toBe(401);
    expect((await auto(undefined)).status).toBe(401);
    expect(v.auth.extension()).toBeNull();

    const paired = await auto(v.auth.autoPairSecret);
    expect(paired.status).toBe(200);
    const token = (await json(paired)).token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await v.request("/api/ext/status", { token, origin: EXT_ORIGIN })).status).toBe(200);
    expect(await json(await v.request("/api/ext/status", { token, origin: EXT_ORIGIN }))).toEqual({ paired: true, locked: false, cards: false });
    // Only a hash of the token and never the pairing secret is kept on disk.
    const state = readFileSync(v.auth.stateFile, "utf8");
    expect(state).not.toContain(token);
    expect(state).not.toContain(v.auth.autoPairSecret);
    const info = await json(await v.request("/api/ui/pairing", { token: ui }));
    expect(info).toMatchObject({ extension: { origin: EXT_ORIGIN, locked: false }, auto: true });
  });

  test("the secret is this run's: a restarted service does not accept the old one", () => {
    const again = new Auth(store.configDir);
    expect(again.autoPairSecret).not.toBe(v.auth.autoPairSecret);
    expect(again.autoPairSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(again.claimAutoPairing(v.auth.autoPairSecret, EXT_ORIGIN)).toEqual({ ok: false, reason: "invalid_secret" });
  });

  test("Unpair in the app holds: the browser stays out until the owner pairs it again", async () => {
    expect((await v.request("/api/ui/pairing", { method: "DELETE", token: ui })).status).toBe(200);
    expect(v.auth.extension()).toBeNull();
    const refused = await auto(v.auth.autoPairSecret);
    expect(refused.status).toBe(409);
    expect((await json(refused)).code).toBe("auto_pair_off");
    expect(await json(await v.request("/api/ui/pairing", { token: ui }))).toMatchObject({ extension: null, auto: false });
    // It survives a restart of the service: the choice is in state.json.
    expect(new Auth(store.configDir).autoPairEnabled()).toBe(false);

    expect((await v.request("/api/ui/pairing/auto", { body: {} })).status).toBe(401); // the PIN session, like every UI route
    expect((await v.request("/api/ui/pairing/auto", { body: {}, token: ui })).status).toBe(200);
    expect((await auto(v.auth.autoPairSecret)).status).toBe(200);
    expect(v.auth.extension()?.origin).toBe(EXT_ORIGIN);
  });
});

describe("cards are off unless switched on", () => {
  let store: TempStore;
  let v: TestVault;
  let ui = "";
  let ext = "";

  beforeAll(async () => {
    store = createTempStore();
    v = await createTestVault(store, { withUi: true });
    ui = ((await json(await v.request("/api/ui/setup", { body: { pin: PIN } }))) as { token: string }).token;
    ext = ((await json(await v.request("/api/pair/auto", { body: { secret: v.auth.autoPairSecret }, origin: EXT_ORIGIN }))) as { token: string }).token;
  }, 60_000);
  afterAll(() => store?.cleanup());

  test("every card route answers 404 to the app, the extension and the agent alike", async () => {
    const routes: Array<[string, "GET" | "POST" | "DELETE"]> = [
      ["/api/ui/cards", "GET"],
      ["/api/ui/cards", "POST"],
      ["/api/ui/card?name=cards/x", "GET"],
      ["/api/ui/card?name=cards/x", "DELETE"],
      ["/api/ui/card-reveal", "POST"],
      ["/api/ext/cards", "GET"],
      ["/api/ext/card-secret", "POST"],
      ["/api/ext/card-decision", "POST"],
      ["/api/ext/card-check", "POST"],
      ["/api/ext/card-save", "POST"],
      ["/api/agent/cards", "GET"],
      ["/api/agent/card-fill", "POST"],
    ];
    for (const [path, method] of routes) {
      const token = path.startsWith("/api/ui/") ? ui : path.startsWith("/api/ext/") ? ext : v.mcpToken;
      const origin = path.startsWith("/api/ext/") ? EXT_ORIGIN : null;
      const body = method === "POST" ? { name: "cards/x", number: "4242424242424242", exp: "12/34", url: "https://shop.example.com/checkout" } : undefined;
      const res = await v.request(path, { method, token, origin, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await json(res), `${method} ${path}`).toEqual({ error: "not found" });
      // And under the desktop's base path as well.
      expect((await v.request(`/apps/clawbox-vault${path}`, { method, token, origin, ...(body ? { body } : {}) })).status, path).toBe(404);
    }
    expect(await v.cards.list()).toEqual([]);
  });

  test("the app and the extension are told cards are off", async () => {
    expect((await json(await v.request("/api/ui/status"))).cards).toBe(false);
    expect((await json(await v.request("/api/ui/info", { token: ui }))).cards).toBe(false);
    expect((await json(await v.request("/api/ext/status", { token: ext, origin: EXT_ORIGIN }))).cards).toBe(false);
  });

  test("the desktop page ships the card screens hidden and names no card tool as available", async () => {
    const html = await (await v.request("/apps/clawbox-vault/")).text();
    expect(html).toMatch(/<button class="nav-item" data-view="cards" id="nav-cards" hidden>/);
    expect(html).toMatch(/<span id="agent-card-tools" hidden>/);
    expect(html).toMatch(/id="agent-card-note" hidden>/);
    // No leftovers of the lab app: nothing to install by hand, no MCP snippet to copy.
    expect(html).not.toContain("Load unpacked");
    expect(html).not.toContain("mcp-snippet");
    const info = await json(await v.request("/api/ui/info", { token: ui }));
    expect(Object.keys(info).sort()).toEqual(["auditFile", "cards", "configDir", "extensionDir", "serviceUrl", "storeDir", "version"]);
  });

  test("logins are untouched by the switch", async () => {
    const saved = await v.request("/api/agent/save", { token: v.mcpToken, body: { name: "shop.example.com/me", login: "me", url: "https://shop.example.com/login", password: PASSWORD } });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await json(saved))).not.toContain(PASSWORD);
    expect(((await json(await v.request("/api/agent/entries", { token: v.mcpToken }))).entries as unknown[]).length).toBe(1);
  });
});

describe("the service builds the extension the browser loads", () => {
  let out = "";
  beforeAll(() => {
    out = realpathSync(mkdtempSync(join(tmpdir(), "cbv-ext-")));
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("a complete MV3 folder with this run's pairing secret, readable by the box user only", async () => {
    const dir = join(out, "default");
    await buildExtension({ repoDir: REPO_DIR, outDir: dir, pairSecret: "s".repeat(43) });
    for (const file of ["manifest.json", "popup.html", "popup.css", "confirm.html", "offscreen.html", "icons/vault.png", "pairing.json"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    for (const name of ["background", "content", "popup", "offscreen", "confirm"]) {
      const code = readFileSync(join(dir, "build", `${name}.js`), "utf8");
      expect(code.length, name).toBeGreaterThan(200);
      // Classic scripts, as the manifest loads them.
      expect(/^\s*(import|export)\s/m.test(code), name).toBe(false);
    }
    expect(JSON.parse(readFileSync(join(dir, "pairing.json"), "utf8"))).toEqual({ secret: "s".repeat(43) });
    expect(statSync(join(dir, "pairing.json")).mode & 0o777).toBe(0o600);
    // Every file landed by rename: nothing half-written is left for a browser that starts meanwhile.
    expect(readdirSync(dir).concat(readdirSync(join(dir, "build"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    // The pairing file must stay unreadable to web pages.
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).toContain("connect-src 'self' http://127.0.0.1:4796");
    expect(readFileSync(join(dir, "build/background.js"), "utf8")).toContain("/api/pair/auto");
  }, 60_000);

  test("cards are compiled out by default and in only on request", async () => {
    const off = join(out, "default");
    const on = join(out, "cards");
    await buildExtension({ repoDir: REPO_DIR, outDir: on, cards: true });
    // The worker and the page script carry the switch; the popup is told by the worker.
    for (const name of ["background", "content"]) {
      expect(readFileSync(join(off, "build", `${name}.js`), "utf8"), name).toContain("CARDS_ENABLED = false");
      expect(readFileSync(join(on, "build", `${name}.js`), "utf8"), name).toContain("CARDS_ENABLED = true");
    }
    // Without a secret the browser pairs with a code only.
    expect(JSON.parse(readFileSync(join(on, "pairing.json"), "utf8"))).toEqual({});
  }, 60_000);

  test("a service on another port is named in the bundle and the CSP; anything but loopback is refused", async () => {
    const dir = join(out, "port");
    await buildExtension({ repoDir: REPO_DIR, outDir: dir, service: "http://127.0.0.1:4999", nameSuffix: "(test 4999)" });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.name).toBe("ClawBox Vault (test 4999)");
    expect(manifest.content_security_policy.extension_pages).toContain("http://127.0.0.1:4999");
    expect(readFileSync(join(dir, "build/background.js"), "utf8")).toContain('"http://127.0.0.1:4999"');
    await expect(buildExtension({ repoDir: REPO_DIR, outDir: join(out, "bad"), service: "http://vault.example.com:4796" })).rejects.toThrow("127.0.0.1");
  }, 60_000);
});
