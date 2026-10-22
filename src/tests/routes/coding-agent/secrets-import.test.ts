/**
 * /setup-api/coding-agent/secrets/import — "Import from assistant".
 *
 * A key the main assistant already holds (today: a line of the Hermes `.env`)
 * is COPIED into the owner's secret store, so it does not have to be typed in
 * again. The properties under test:
 *
 *  1. OWNER ONLY, SAME ORIGIN. The agent holds the MCP bearer, which middleware
 *     admits to every /setup-api/* path. A grant it could make to itself is not
 *     a grant, so the bearer, a second ClawBox user and another page in the
 *     owner's browser all get 403 and nothing is copied.
 *  2. NAMES ONLY. The picker's list and every answer name a key and never carry
 *     its value — not the copy's answer, not a refusal, not the audit log.
 *  3. A COPY, UN-TICKED. The value lands in the store through the same sealing
 *     as a typed one, with `inject: false`: the owner's three gates still decide
 *     whether a run ever sees it.
 *  4. THE DENYLIST. The box's own wiring (the session secret, the gateway and
 *     MCP tokens, the channel and mail credentials, the model-provider keys) is
 *     never listed and never copied, whatever the request names.
 *  5. AN AUDIT LINE per copy: name, scope, action, time — no value.
 *
 * The store, the cipher and the Hermes `.env` reader are the REAL ones, over a
 * fixture root and a fixture HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
/** The edition seam: does this box run Hermes (the `hermes` or `dual` SKU)? */
const hasHermesHarness = vi.hoisted(() => vi.fn());
/** Config the fixture box holds, read through the mocked store. */
let config: Record<string, unknown> = {};

const SESSION_SECRET = "a".repeat(64);
/** A bearer that really verifies, so "the agent" in these tests is the agent. */
const MCP_TOKEN = "c".repeat(48);
/** The fixture's own placeholder — what must never come back out. */
const VALUE = "placeholder-value-12345";
const SECOND_USER = { username: "alice", sv: "a1b2c3d4e5f60718" };

let root = "";
let home = "";
let restoreEnv: () => void;
let route: typeof import("@/app/setup-api/coding-agent/secrets/import/route");
let store: typeof import("@/lib/project-secrets");

function hermesEnv(text: string): void {
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".hermes", ".env"), text, { mode: 0o600 });
}

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function secondUserCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0, { u: SECOND_USER.username, sv: SECOND_USER.sv })}`;
}

function request(init: {
  method?: "GET" | "POST";
  cookie?: string;
  bearer?: string;
  body?: unknown;
  origin?: string | null;
} = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin !== null) headers.origin = init.origin ?? "http://clawbox.local";
  const method = init.method ?? "POST";
  return new Request("http://clawbox.local/setup-api/coding-agent/secrets/import", {
    method,
    headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(init.body ?? { name: "IMPORT_ME_TOKEN", scope: "@box" }) }),
  });
}

function auditText(): string {
  try {
    return fs.readFileSync(path.join(root, "data", "secrets-audit.log"), "utf-8");
  } catch {
    return "";
  }
}

function storeText(): string {
  try {
    return fs.readFileSync(path.join(root, "data", "secrets.json"), "utf-8");
  } catch {
    return "";
  }
}

beforeEach(async () => {
  restoreEnv = saveEnv(
    "CLAWBOX_ROOT", "HOME", "HERMES_HOME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "CLAWBOX_USER",
  );
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-secrets-import-")));
  home = path.join(root, "home");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // The store's key comes from this file, never from SESSION_SECRET.
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "5b".repeat(32), { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  process.env.HOME = home;
  delete process.env.HERMES_HOME;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  process.env.CLAWBOX_USER = "clawbox";

  hermesEnv([
    "# Hermes' own template comments are skipped",
    `IMPORT_ME_TOKEN=${VALUE}`,
    "SESSION_SECRET=box-session-secret-value",
    "TELEGRAM_BOT_TOKEN=123456:telegram-placeholder",
    "OPENROUTER_API_KEY=sk-or-placeholder-0000",
    "ANTHROPIC_API_KEY=sk-ant-placeholder-0000",
    "SHORT_TOKEN=abc",
    "CONTROL_TOKEN=control-\u0001-placeholder",
    "export EXPORTED_API_KEY=exported-placeholder-0000",
    // Cloud credentials and the box's own plan token: held, never offered.
    "AWS_ACCESS_KEY_ID=aws-key-id-placeholder-0000",
    "AWS_SECRET_ACCESS_KEY=aws-secret-placeholder-0000",
    "AWS_SESSION_TOKEN=aws-session-placeholder-0000",
    "CLAWBOX_AI_TOKEN=clawbox-ai-placeholder-0000",
    // An inline comment is not part of the value, the way Hermes reads it.
    "COMMENTED_TOKEN=commented-value-0000 # rotated in spring",
    "",
  ].join("\n"));

  vi.resetModules();
  config = { clawbox_users: [{ username: SECOND_USER.username, sv: SECOND_USER.sv, createdAt: "" }] };
  configGet.mockReset().mockImplementation(async (key: string) => config[key]);
  configSet.mockReset().mockResolvedValue(undefined);
  hasHermesHarness.mockReset().mockReturnValue(true);
  vi.doMock("@/lib/config-store", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/config-store")>()),
    get: configGet,
    set: configSet,
  }));
  vi.doMock("@/lib/edition-source", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/edition-source")>()),
    hasHermesHarness,
  }));
  store = await import("@/lib/project-secrets");
  store._resetSecretKeyCacheForTests();
  route = await import("@/app/setup-api/coding-agent/secrets/import/route");
});

afterEach(() => {
  restoreEnv();
  vi.doUnmock("@/lib/config-store");
  vi.doUnmock("@/lib/edition-source");
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the copy", () => {
  it("copies one assistant key into the box scope, un-ticked, and answers no value", async () => {
    const res = await route.POST(request({ cookie: ownerCookie(), body: { name: "IMPORT_ME_TOKEN", scope: "@box" } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text).imported).toEqual({ name: "IMPORT_ME_TOKEN", scope: "@box" });

    const listed = await store.listSecrets();
    expect(listed).toContainEqual(expect.objectContaining({ name: "IMPORT_ME_TOKEN", scope: "@box", inject: false, readable: true }));
    // Sealed like a typed value: never in the clear in the store file.
    expect(storeText()).not.toContain(VALUE);
  });

  it("copies into one project's scope when the owner picks a project", async () => {
    const res = await route.POST(request({ cookie: ownerCookie(), body: { name: "IMPORT_ME_TOKEN", scope: "shop" } }));
    expect(res.status).toBe(200);
    expect(await store.listSecrets()).toContainEqual(expect.objectContaining({ name: "IMPORT_ME_TOKEN", scope: "shop", inject: false }));
  });

  it("is a COPY: the assistant's own file is left exactly as it was", async () => {
    const before = fs.readFileSync(path.join(home, ".hermes", ".env"), "utf-8");
    await route.POST(request({ cookie: ownerCookie() }));
    expect(fs.readFileSync(path.join(home, ".hermes", ".env"), "utf-8")).toBe(before);
  });

  it("refuses to overwrite an entry the owner already has under that name and scope", async () => {
    await store.setSecret({ name: "IMPORT_ME_TOKEN", value: "the-owners-own-value-0000", scope: "@box", inject: true });
    const res = await route.POST(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("exists");
    // Still the owner's value and the owner's tick.
    const [row] = (await store.listSecrets()).filter((s) => s.name === "IMPORT_ME_TOKEN");
    expect(row.inject).toBe(true);
  });

  it("writes one audit line: name, scope, action, time — never the value", async () => {
    await route.POST(request({ cookie: ownerCookie() }));
    const lines = auditText().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ action: "import", name: "IMPORT_ME_TOKEN", scope: "@box", source: "hermes" });
    expect(typeof entry.at).toBe("string");
    expect(auditText()).not.toContain(VALUE);
    expect((fs.statSync(path.join(root, "data", "secrets-audit.log")).mode & 0o777).toString(8)).toBe("600");
  });

  it("copies with the expiry the owner picked: one run, or a date", async () => {
    const res = await route.POST(request({ cookie: ownerCookie(), body: { name: "IMPORT_ME_TOKEN", scope: "@box", expiresAt: "run" } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text).imported).toEqual({ name: "IMPORT_ME_TOKEN", scope: "@box", expiresAt: "run" });
    expect(await store.listSecrets()).toContainEqual(expect.objectContaining({ name: "IMPORT_ME_TOKEN", inject: false, expiresAt: "run", expired: false }));

    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const dated = await route.POST(request({ cookie: ownerCookie(), body: { name: "IMPORT_ME_TOKEN", scope: "shop", expiresAt: until } }));
    expect(dated.status).toBe(200);
    expect(await store.listSecrets()).toContainEqual(expect.objectContaining({ scope: "shop", inject: false, expiresAt: until }));
    expect(auditText()).not.toContain(VALUE);
  });

  it("refuses an expiry that is already over, and copies nothing", async () => {
    const res = await route.POST(request({ cookie: ownerCookie(), body: { name: "IMPORT_ME_TOKEN", scope: "@box", expiresAt: "2001-01-01T00:00:00.000Z" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_expiry");
    expect(await store.listSecrets()).toEqual([]);
    expect(auditText()).toBe("");
  });

  it("copies the value without the line's inline comment", async () => {
    const res = await route.POST(request({ cookie: ownerCookie(), body: { name: "COMMENTED_TOKEN", scope: "@box" } }));
    expect(res.status).toBe(200);
    await store.setSecretInject({ name: "COMMENTED_TOKEN", scope: "@box", inject: true });
    config[store.SECRET_INJECT_CONFIG_KEY] = true;
    expect((await store.resolveSecretsForRun({ project: null, runId: "run-0000c0de" })).env).toEqual({ COMMENTED_TOKEN: "commented-value-0000" });
  });
});

describe("who may copy", () => {
  it("refuses the MCP bearer — the agent cannot grant itself anything", async () => {
    const res = await route.POST(request({ bearer: MCP_TOKEN }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(await store.listSecrets()).toEqual([]);
    expect(auditText()).toBe("");
  });

  it("refuses a second ClawBox user: this is the owner's call alone", async () => {
    const res = await route.POST(request({ cookie: secondUserCookie() }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(await store.listSecrets()).toEqual([]);
  });

  it("refuses another origin, even with the owner's own cookie", async () => {
    for (const origin of ["http://evil.example", "null"]) {
      const res = await route.POST(request({ cookie: ownerCookie(), origin }));
      expect(res.status, origin).toBe(403);
      expect((await res.json()).kind, origin).toBe("cross_origin");
    }
    expect(await store.listSecrets()).toEqual([]);
  });

  it("refuses the bearer on the list too", async () => {
    const res = await route.GET(request({ method: "GET", bearer: MCP_TOKEN }));
    expect(res.status).toBe(403);
  });
});

describe("what may be copied", () => {
  it("refuses a denylisted name even when the assistant holds it", async () => {
    for (const name of [
      "SESSION_SECRET", "TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "CLAWBOX_AI_TOKEN",
    ]) {
      const res = await route.POST(request({ cookie: ownerCookie(), body: { name, scope: "@box" } }));
      expect(res.status, name).toBe(400);
      const body = await res.json();
      expect(["not_importable", "reserved_name"], name).toContain(body.code);
      expect(JSON.stringify(body), name).not.toContain("box-session-secret-value");
    }
    expect(await store.listSecrets()).toEqual([]);
    expect(auditText()).toBe("");
  });

  it("answers 404 for a name the assistant does not hold", async () => {
    const res = await route.POST(request({ cookie: ownerCookie(), body: { name: "NOT_THERE_TOKEN", scope: "@box" } }));
    expect(res.status).toBe(404);
    // Its own code: the store's `not_found` means the OWNER's list changed.
    expect((await res.json()).code).toBe("not_held");
  });

  it("treats a value the store would refuse as one it does not hold — too short to redact, or control characters", async () => {
    for (const name of ["SHORT_TOKEN", "CONTROL_TOKEN"]) {
      const res = await route.POST(request({ cookie: ownerCookie(), body: { name, scope: "@box" } }));
      expect(res.status, name).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text).code, name).toBe("not_held");
      expect(text, name).not.toContain("placeholder");
    }
    expect(await store.listSecrets()).toEqual([]);
    expect(auditText()).toBe("");
  });

  it("refuses a malformed name or scope before it reads the assistant's file", async () => {
    for (const body of [{ name: "lower_case", scope: "@box" }, { name: "IMPORT_ME_TOKEN", scope: "../etc" }, {}]) {
      const res = await route.POST(request({ cookie: ownerCookie(), body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("the picker's list", () => {
  it("answers names only, without the denylisted ones or values no copy could keep", async () => {
    const res = await route.GET(request({ method: "GET", cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain("placeholder");
    const body = JSON.parse(text);
    const names = body.names.map((n: { name: string }) => n.name);
    // SHORT_TOKEN and CONTROL_TOKEN are held, but the store would refuse their
    // values, so offering them would only lead to a refusal.
    expect(names).toEqual(["COMMENTED_TOKEN", "EXPORTED_API_KEY", "IMPORT_ME_TOKEN"]);
    for (const row of body.names) expect(Object.keys(row).sort()).toEqual(["name", "source"]);
    expect(body.sources).toEqual(["hermes"]);
  });

  it("never offers an AWS credential or one of the box's CLAWBOX_ names", async () => {
    const { listAssistantSecrets } = await import("@/lib/assistant-secrets");
    const names = (await listAssistantSecrets()).map((n) => n.name);
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "CLAWBOX_AI_TOKEN"]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("answers an empty list on a box whose assistant has no .env", async () => {
    fs.rmSync(path.join(home, ".hermes"), { recursive: true, force: true });
    const res = await route.GET(request({ method: "GET", cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    expect((await res.json()).names).toEqual([]);
  });
});

describe("the switch", () => {
  it("is off when the box's config says so: no list, no copy", async () => {
    config.coding_agent_secret_import = false;
    const list = await route.GET(request({ method: "GET", cookie: ownerCookie() }));
    expect(list.status).toBe(404);
    expect((await list.json()).code).toBe("disabled");
    const copy = await route.POST(request({ cookie: ownerCookie() }));
    expect(copy.status).toBe(404);
    expect(await store.listSecrets()).toEqual([]);
    expect(auditText()).toBe("");
  });

  it("tells only the owner that it is off", async () => {
    config.coding_agent_secret_import = false;
    const res = await route.GET(request({ method: "GET", bearer: MCP_TOKEN }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });
});

describe("a box without Hermes", () => {
  it("offers nothing: OpenClaw's own store never gives a credential back", async () => {
    // A leftover .env from another edition is not this box's assistant.
    hasHermesHarness.mockReturnValue(false);
    const list = await route.GET(request({ method: "GET", cookie: ownerCookie() }));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ names: [], sources: [] });
    const copy = await route.POST(request({ cookie: ownerCookie() }));
    expect(copy.status).toBe(404);
    expect(await store.listSecrets()).toEqual([]);
  });
});
