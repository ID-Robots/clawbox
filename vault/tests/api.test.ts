// API auth (unpaired / wrong origin / wrong token rejected), the agent fill
// round trip, and a grep test that secrets never reach logs, the audit log,
// the state files or non-secret responses.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTempStore, passShowExitCode, type TempStore } from "./helpers/tempstore";
import { createTestVault, EXT_ORIGIN, pairExtension, type TestVault } from "./helpers/vault";

const PASSWORD = "Wq3%api-Secret-Test-77";
const PIN = "correct horse 42";
let store: TempStore;
let v: TestVault;
let ui = "";
let ext = "";
const responses: string[] = [];
const consoleLines: string[] = [];
const originalLog = console.log;
const originalError = console.error;

async function body(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  responses.push(text);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  console.log = (...a: unknown[]) => consoleLines.push(a.join(" "));
  console.error = (...a: unknown[]) => consoleLines.push(a.join(" "));
  store = createTempStore();
  v = await createTestVault(store, { withUi: true });
}, 60_000);

afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
  store?.cleanup();
});

describe("desktop app assets in the sandboxed desktop frame", () => {
  test("stylesheet, script and icon may be loaded by an opaque-origin frame; the page and the API stay same-origin", async () => {
    for (const asset of ["app.css", "app.js", "favicon.png"]) {
      const res = await v.request(`/apps/clawbox-vault/${asset}`);
      expect(res.status, asset).toBe(200);
      expect(res.headers.get("cross-origin-resource-policy"), asset).toBe("cross-origin");
    }
    const page = await v.request("/apps/clawbox-vault/");
    expect(page.status).toBe(200);
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const api = await v.request("/apps/clawbox-vault/api/health");
    expect(api.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });
});

describe("auth", () => {
  test("health and the UI page are public; nothing else is", async () => {
    expect((await v.request("/api/health")).status).toBe(200);
    const page = await v.request("/apps/clawbox-vault/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await v.request("/apps/clawbox-vault")).status).toBe(308);
    for (const path of ["/api/agent/entries", "/api/ext/entries", "/api/ui/entries", "/api/ext/commands", "/api/ui/info"]) {
      expect((await v.request(path)).status).toBe(401);
      expect((await v.request(`/apps/clawbox-vault${path}`)).status).toBe(401);
    }
  });

  test("the agent API needs the agent token, refuses browser origins, and waits for the owner's PIN", async () => {
    expect((await v.request("/api/agent/entries", { token: "x".repeat(43) })).status).toBe(401);
    expect((await v.request("/api/agent/entries", { token: v.mcpToken, origin: "https://evil.example.org" })).status).toBe(403);
    expect((await v.request("/api/agent/entries", { token: v.mcpToken, origin: EXT_ORIGIN })).status).toBe(403);
    // Until the owner has chosen a PIN the assistant can neither read nor store anything.
    for (const [path, init] of [
      ["/api/agent/entries", {}],
      ["/api/agent/audit", {}],
      ["/api/agent/save", { body: { name: "early.example.com/x", login: "x", url: "https://early.example.com" } }],
      ["/api/agent/fill", { body: { url: "https://early.example.com" } }],
    ] as const) {
      const early = await v.request(path, { token: v.mcpToken, ...init });
      expect(early.status, path).toBe(409);
      expect((await body(early)).code, path).toBe("not_set_up");
    }
    expect(await v.catalog.exists("early.example.com/x")).toBe(false);
  });

  test("the box's browser cannot pair before the owner has chosen a PIN", async () => {
    const early = await v.request("/api/pair/auto", { body: { secret: v.auth.autoPairSecret }, origin: EXT_ORIGIN });
    expect(early.status).toBe(409);
    expect((await body(early)).code).toBe("not_set_up");
    expect(v.auth.extension()).toBeNull();
  });

  test("DNS-rebinding hosts are refused", async () => {
    expect((await v.request("/api/health", { host: "rebind.attacker.example:4796" })).status).toBe(421);
    expect((await v.request("/api/health", { host: "localhost:4796" })).status).toBe(200);
    expect((await v.request("/api/health", { host: "clawbox.local" })).status).toBe(200);
  });

  test("the UI needs the PIN; wrong PINs are rate limited", async () => {
    expect(await body(await v.request("/api/ui/status"))).toEqual({ pinSet: false, unlocked: false, cards: false, store: { ready: true } });
    expect((await v.request("/api/ui/setup", { body: { pin: "123" } })).status).toBe(400);
    const setup = await body(await v.request("/api/ui/setup", { body: { pin: PIN } }));
    ui = setup.token as string;
    expect((await v.request("/api/ui/setup", { body: { pin: "another-pin" } })).status).toBe(409);
    expect((await v.request("/api/ui/entries", { token: ui })).status).toBe(200);
    expect((await v.request("/api/ui/unlock", { body: { pin: "wrong-pin" } })).status).toBe(401);
    const again = await body(await v.request("/api/ui/unlock", { body: { pin: PIN } }));
    expect(typeof again.token).toBe("string");
    // The PIN is the owner's go-ahead: the agent API answers from here on.
    expect((await v.request("/api/agent/entries", { token: v.mcpToken })).status).toBe(200);
  });

  test("pairing: only a chrome-extension origin with the right code, once", async () => {
    expect((await v.request("/api/pair", { body: { code: "000000" }, origin: EXT_ORIGIN })).status).toBe(401); // no code active
    const { code } = (await body(await v.request("/api/ui/pairing", { body: {}, token: ui }))) as { code: string };
    expect(code).toMatch(/^\d{6}$/);
    expect((await v.request("/api/pair", { body: { code }, origin: "https://evil.example.org" })).status).toBe(403);
    expect((await v.request("/api/pair", { body: { code } })).status).toBe(403);
    const wrong = code === "123456" ? "654321" : "123456";
    expect((await v.request("/api/pair", { body: { code: wrong }, origin: EXT_ORIGIN })).status).toBe(401);
    const paired = await body(await v.request("/api/pair", { body: { code }, origin: EXT_ORIGIN }));
    ext = paired.token as string;
    expect(ext).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await v.request("/api/pair", { body: { code }, origin: EXT_ORIGIN })).status).toBe(401); // used up
    // Only the hash is stored.
    const state = readFileSync(join(store.configDir, "state.json"), "utf8");
    expect(state).not.toContain(ext);
    expect(state).toContain(EXT_ORIGIN);
  });

  test("a pairing code dies after five wrong attempts", async () => {
    const { code } = (await body(await v.request("/api/ui/pairing", { body: {}, token: ui }))) as { code: string };
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) await v.request("/api/pair", { body: { code: wrong }, origin: EXT_ORIGIN });
    expect((await v.request("/api/pair", { body: { code }, origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" })).status).toBe(401);
  });

  test("the extension token only works from the paired origin", async () => {
    expect((await v.request("/api/ext/entries", { token: ext, origin: EXT_ORIGIN })).status).toBe(200);
    expect((await v.request("/api/ext/entries", { token: ext })).status).toBe(200); // Chrome sends no Origin on extension GETs
    expect((await v.request("/api/ext/entries", { token: ext, origin: "https://evil.example.org" })).status).toBe(403);
    expect((await v.request("/api/ext/entries", { token: ext, origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" })).status).toBe(403);
    expect((await v.request("/api/ext/entries", { token: v.mcpToken, origin: EXT_ORIGIN })).status).toBe(401);
    expect((await v.request("/api/ui/entries", { token: ext })).status).toBe(401);
    expect((await v.request("/api/agent/entries", { token: ext })).status).toBe(401);
  });

  test("extension requests: token first, then an Origin header only if one is present", async () => {
    const raw = (path: string, headers: Record<string, string>) =>
      v.app.fetch(new Request(`http://127.0.0.1:4796${path}`, { headers: { host: "127.0.0.1:4796", ...headers } }));
    for (const path of ["/api/ext/status", "/api/ext/commands?wait=0", "/api/ext/entries"]) {
      // valid token + no Origin (Chrome's GET from the extension to its host_permissions) -> ok
      const noOrigin = await v.request(path, { token: ext });
      expect(noOrigin.status).toBe(200);
      expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
      // valid token + the paired Origin -> ok
      const paired = await v.request(path, { token: ext, origin: EXT_ORIGIN });
      expect(paired.status).toBe(200);
      expect(paired.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
      // valid token + a foreign Origin, an opaque "null" Origin or an empty one -> 403
      for (const origin of ["https://evil.example.org", "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba", "null"]) {
        const res = await v.request(path, { token: ext, origin });
        expect(res.status).toBe(403);
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
      expect((await raw(path, { authorization: `Bearer ${ext}`, origin: "" })).status).toBe(403);
      // no token or an invalid one -> 401, with or without an Origin
      for (const origin of [undefined, EXT_ORIGIN, "https://evil.example.org"]) {
        expect((await v.request(path, { origin })).status).toBe(401);
        expect((await v.request(path, { token: "x".repeat(43), origin })).status).toBe(401);
        expect((await v.request(path, { token: v.mcpToken, origin })).status).toBe(401);
      }
    }
    // The same rule straight on Auth.
    expect(v.auth.checkExtension(ext, null)).toBe("ok");
    expect(v.auth.checkExtension(ext, EXT_ORIGIN)).toBe("ok");
    expect(v.auth.checkExtension(ext, "https://evil.example.org")).toBe("forbidden_origin");
    expect(v.auth.checkExtension(ext, "")).toBe("forbidden_origin");
    expect(v.auth.checkExtension(null, null)).toBe("unauthorized");
    expect(v.auth.checkExtension("x".repeat(43), EXT_ORIGIN)).toBe("unauthorized");
  });

  test("CORS: allowed only for the paired extension origin", async () => {
    const pre = await v.app.fetch(new Request("http://127.0.0.1:4796/api/ext/entries", { method: "OPTIONS", headers: { origin: EXT_ORIGIN } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    const evil = await v.app.fetch(new Request("http://127.0.0.1:4796/api/ext/entries", { method: "OPTIONS", headers: { origin: "https://evil.example.org" } }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const res = await v.request("/api/ext/entries", { token: ext, origin: "https://evil.example.org" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await v.request("/api/ext/entries", { token: ext, origin: EXT_ORIGIN });
    expect(ok.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
  });
});

describe("entries and secrets", () => {
  test("the agent saves with a password but never gets it back", async () => {
    const saved = await body(
      await v.request("/api/agent/save", {
        token: v.mcpToken,
        body: { name: "billing.example.com/ops", login: "ops@example.com", url: "https://billing.example.com/login", password: PASSWORD },
      }),
    );
    expect(saved).toEqual({ name: "billing.example.com/ops", created: true, generated: false });
    expect(passShowExitCode(store, "billing.example.com/ops")).toBe(0);
    const list = await body(await v.request("/api/agent/entries", { token: v.mcpToken }));
    expect(JSON.stringify(list)).not.toContain(PASSWORD);
    const match = await body(await v.request("/api/agent/match?url=https%3A%2F%2Fbilling.example.com%2Fx", { token: v.mcpToken }));
    expect((match.entries as Array<{ name: string; match: string }>)[0]).toMatchObject({ name: "billing.example.com/ops", match: "exact" });
  });

  test("a generated password is stored, not returned", async () => {
    const gen = await body(await v.request("/api/agent/save", { token: v.mcpToken, body: { name: "signup.example.com/bot", login: "bot", url: "https://signup.example.com" } }));
    expect(gen).toEqual({ name: "signup.example.com/bot", created: true, generated: true });
    const stored = (await v.catalog.read("signup.example.com/bot")).password;
    expect(stored.length).toBe(24);
    expect(responses.join("\n")).not.toContain(stored);
    const info = await body(await v.request("/api/agent/generate", { token: v.mcpToken, body: { length: 32 } }));
    expect(info).toMatchObject({ stored: false, length: 32 });
    expect((await v.request("/api/agent/generate", { token: v.mcpToken, body: { name: "signup.example.com/bot" } })).status).toBe(409);
  });

  test("only the paired extension (fill/copy) and the unlocked UI (reveal) get plaintext", async () => {
    const fill = await body(
      await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { name: "billing.example.com/ops", purpose: "fill", pageUrl: "https://billing.example.com/login" } }),
    );
    expect(fill.password).toBe(PASSWORD);
    // A fill for a page of another site is refused.
    expect(
      (await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { name: "billing.example.com/ops", purpose: "fill", pageUrl: "https://evil.example.org/" } })).status,
    ).toBe(403);
    const reveal = await body(await v.request("/api/ui/reveal", { token: ui, body: { name: "billing.example.com/ops" } }));
    expect(reveal.password).toBe(PASSWORD);
    // Entry details for the UI carry no password and no 2FA secret.
    const detail = await body(await v.request("/api/ui/entry?name=billing.example.com%2Fops", { token: ui }));
    expect(Object.keys(detail)).not.toContain("password");
    responses.splice(responses.length - 3, 3); // the three intentional plaintext responses above
  });

  test("bad input never echoes the body", async () => {
    const raw = `{"name":"x/y","password":"${PASSWORD}"`;
    const res = await v.request("/api/agent/save", { token: v.mcpToken, raw });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(PASSWORD);
    const multi = await v.request("/api/agent/save", { token: v.mcpToken, body: { name: "../x", login: "a", url: "", password: PASSWORD } });
    expect(multi.status).toBe(400);
    expect(await multi.text()).not.toContain(PASSWORD);
    const nl = await v.request("/api/agent/save", { token: v.mcpToken, body: { name: "x.example/y", login: "a", url: "", password: `${PASSWORD}\nlogin: injected` } });
    expect(nl.status).toBe(400);
    expect(await nl.text()).not.toContain(PASSWORD);
  });

  test("save prompt check compares server-side and answers new / update / same", async () => {
    const check = (password: string, login = "ops@example.com") =>
      v.request("/api/ext/check", { token: ext, origin: EXT_ORIGIN, body: { url: "https://billing.example.com/login", login, password } }).then(body);
    expect(await check(PASSWORD)).toEqual({ kind: "same", name: "billing.example.com/ops" });
    expect(await check("a-new-password-1")).toEqual({ kind: "update", name: "billing.example.com/ops" });
    expect(await check("whatever-1", "someone@example.com")).toEqual({ kind: "new", suggestedName: "example.com/someone@example.com" });
    const http = await body(await v.request("/api/ext/check", { token: ext, origin: EXT_ORIGIN, body: { url: "http://billing.example.com/login", login: "x", password: "y-123456" } }));
    expect(http).toEqual({ kind: "ignore" });
  });
});

describe("agent fill round trip", () => {
  test("command → extension long-poll → one-time secret → status back to the agent", async () => {
    const poll = v.request("/api/ext/commands?wait=2000", { token: ext, origin: EXT_ORIGIN }).then(body);
    await Bun.sleep(20);
    const fill = v.request("/api/agent/fill", { token: v.mcpToken, body: { url: "https://billing.example.com/login", submit: true } }).then(body);
    const { commands } = (await poll) as { commands: Array<{ id: string; name: string; entryUrl: string; submit: boolean }> };
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "billing.example.com/ops", entryUrl: "https://billing.example.com/login", submit: true });
    expect(JSON.stringify(commands)).not.toContain(PASSWORD);
    const secret = await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { commandId: commands[0]!.id } });
    expect(((await secret.json()) as { password: string }).password).toBe(PASSWORD);
    // The secret of a command is released once.
    expect((await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { commandId: commands[0]!.id } })).status).toBe(404);
    await v.request("/api/ext/result", { token: ext, origin: EXT_ORIGIN, body: { id: commands[0]!.id, status: "filled" } });
    expect(await fill).toEqual({ status: "filled", name: "billing.example.com/ops" });
  });

  test("a fill report that carries the password never reaches the agent: the detail is dropped whole", async () => {
    // The extension held the password for a moment; whatever it writes into
    // its report, the agent's answer and the logs stay clean.
    const answer = async (detail: string) => {
      const poll = v.request("/api/ext/commands?wait=2000", { token: ext, origin: EXT_ORIGIN }).then(body);
      await Bun.sleep(20);
      const fill = v.request("/api/agent/fill", { token: v.mcpToken, body: { url: "https://billing.example.com/login" } });
      const { commands } = (await poll) as { commands: Array<{ id: string }> };
      await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { commandId: commands[0]!.id } });
      await v.request("/api/ext/result", { token: ext, origin: EXT_ORIGIN, body: { id: commands[0]!.id, status: "filled", detail } });
      return (await fill).text();
    };
    const leaked = await answer(`typed ${PASSWORD} into #password`);
    expect(leaked).not.toContain(PASSWORD);
    expect(JSON.parse(leaked)).toEqual({ status: "filled", name: "billing.example.com/ops" });
    // An ordinary detail is passed on as before.
    expect(JSON.parse(await answer("submitted"))).toEqual({ status: "filled", name: "billing.example.com/ops", detail: "submitted" });
    expect(v.logs.join("\n")).not.toContain(PASSWORD);
    expect(v.logs.join("\n")).toContain("fill detail for billing.example.com/ops held a secret and was dropped");
  });

  test("statuses that need no browser: no_entry, origin_mismatch, locked, timeout", async () => {
    const fill = (b: Record<string, unknown>) => v.request("/api/agent/fill", { token: v.mcpToken, body: b }).then(body);
    expect(await fill({ url: "https://nothing.example.org/" })).toEqual({ status: "no_entry" });
    expect((await fill({ url: "http://billing.example.com/login" })).status).toBe("origin_mismatch");
    expect((await fill({ url: "https://evil.example.org/", name: "billing.example.com/ops" })).status).toBe("origin_mismatch");
    await v.request("/api/ext/lock", { token: ext, origin: EXT_ORIGIN, body: {} });
    expect((await fill({ url: "https://billing.example.com/login" })).status).toBe("locked");
    expect((await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { name: "billing.example.com/ops", purpose: "copy" } })).status).toBe(423);
    // A wrong PIN must not look like "unpaired" (401) to the extension.
    expect((await v.request("/api/ext/unlock", { token: ext, origin: EXT_ORIGIN, body: { pin: "nope-nope" } })).status).toBe(403);
    expect((await v.request("/api/ext/status", { token: ext, origin: EXT_ORIGIN })).status).toBe(200);
    expect((await v.request("/api/ext/unlock", { token: ext, origin: EXT_ORIGIN, body: { pin: PIN } })).status).toBe(200);
    // Recently connected, but no poll picks the command up: extension_offline.
    expect((await fill({ url: "https://billing.example.com/login" })).status).toBe("extension_offline");
    // The extension takes the command but never answers: timeout.
    const poll = v.request("/api/ext/commands?wait=2000", { token: ext, origin: EXT_ORIGIN }).then(body);
    await Bun.sleep(20);
    const pending = fill({ url: "https://billing.example.com/login" });
    expect(((await poll).commands as unknown[]).length).toBe(1);
    expect((await pending).status).toBe("timeout");
  }, 15_000);

  test("delete needs confirm: true", async () => {
    expect((await v.request("/api/agent/delete", { token: v.mcpToken, body: { name: "signup.example.com/bot" } })).status).toBe(400);
    expect((await v.request("/api/agent/delete", { token: v.mcpToken, body: { name: "signup.example.com/bot", confirm: true } })).status).toBe(200);
    expect(passShowExitCode(store, "signup.example.com/bot")).not.toBe(0);
  });
});

describe("no secrets in logs, audit log, state files or non-secret responses (grep test)", () => {
  function filesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]));
  }

  test("audit log records actions without secrets", async () => {
    const records = (await body(await v.request("/api/agent/audit?limit=200", { token: v.mcpToken }))).records as Array<{ action: string }>;
    const actions = records.map((r) => r.action);
    for (const a of ["create", "fill", "secret_released", "paired", "unlock_failed", "delete"]) expect(actions).toContain(a);
    expect(statSync(v.audit.file).mode & 0o777).toBe(0o600);
    expect(statSync(v.auth.mcpTokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(store.configDir).mode & 0o777).toBe(0o700);
  });

  test("grep finds no password, PIN or token anywhere it must not be", async () => {
    const generated = (await v.catalog.list()).length; // keep the catalog warm; no secrets involved
    expect(generated).toBeGreaterThan(0);
    const secrets = [PASSWORD, PIN, ext, ui];
    const haystacks: Record<string, string> = {
      "service log": v.logs.join("\n"),
      console: consoleLines.join("\n"),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const s of secrets) expect({ where, found: text.includes(s) }).toEqual({ where, found: false });
    }
    // Responses legitimately carry the session/pairing tokens they hand out,
    // but never the password or the PIN.
    const replies = responses.join("\n");
    for (const s of [PASSWORD, PIN]) expect({ found: replies.includes(s) }).toEqual({ found: false });
    // grep(1) over the config dir: audit.jsonl, state.json, agent-token.
    for (const s of [PASSWORD, PIN, ext, ui]) {
      const grep = Bun.spawnSync(["grep", "-rF", "--", s, store.configDir], { stdout: "pipe", stderr: "pipe" });
      expect({ secret: s.slice(0, 3), exit: grep.exitCode }).toEqual({ secret: s.slice(0, 3), exit: 1 });
    }
    // and over the store: ciphertext only.
    expect(Bun.spawnSync(["grep", "-rF", "--", PASSWORD, store.storeDir]).exitCode).toBe(1);
    expect(filesUnder(store.configDir).map((f) => f.split("/").pop()).sort()).toEqual(["agent-token", "audit.jsonl", "state.json"]);
  });
});
