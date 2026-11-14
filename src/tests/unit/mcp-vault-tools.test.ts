/**
 * ClawBox Vault's tools as both runtimes get them (mcp/tools/vault.ts,
 * TASK-2524): the seven password tools on OpenClaw and on Hermes, no card tool
 * unless cards are switched on, none of them in a delegated run's servers or
 * on the trimmed surface — and, the property the family exists for, NO
 * PASSWORD IN ANYTHING THE AGENT IS HANDED, whatever the service answers.
 *
 * The vault here is a small HTTP server that plays the vault service's agent
 * API and misbehaves on purpose: it echoes the password it was sent, and adds
 * the one it "stored" to every entry and record it lists. The real service has
 * no such route (vault/tests prove that against a real pass store, and that a
 * fill report carrying the password is dropped by the service); this file
 * proves the tool layer holds even if one appeared.
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveEnv } from "../helpers/env";
import { captureRegistrar } from "../helpers/mcp-registrar";

vi.hoisted(() => {
  process.env.CLAWBOX_MCP_NO_AUTOSTART = "1";
  process.env.CLAWBOX_API_BASE = "http://127.0.0.1:9";
});
import { buildServer } from "../../../mcp/clawbox-mcp";
import { registerVaultTools, vaultCardsEnabled, vaultServiceUrl, vaultTokenFile } from "../../../mcp/tools/vault";

const PASSWORD_TOOLS = ["vault_list", "vault_match", "vault_fill", "vault_save", "vault_generate", "vault_delete", "vault_audit"];
const CARD_TOOLS = ["vault_cards_list", "vault_card_fill"];

/** What the model passes in, and what the vault "holds": neither may come back. */
const GIVEN = "Hx7!given-by-the-user-pw";
const STORED = "Qm3$stored-in-the-vault-pw";
const TOKEN = "t".repeat(43);

const ALL = {
  capabilities: { screenGrabber: "scrot" as const, imageConvert: true, journal: true, du: true },
  emailCanRead: true,
  codingAgent: true,
  canGenerateImages: true,
  providers: ["anthropic", "openai"],
};

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  origin: string | undefined;
  body: Record<string, unknown>;
}

let server: http.Server;
let port = 0;
let dir = "";
let tokenFile = "";
const seen: Seen[] = [];
/** How the fake service answers the next requests. */
let mode: "leaky" | "not_set_up" | "store_down" | "wrong_token" = "leaky";
let restore: () => void;

function leakyAnswer(method: string, url: string, body: Record<string, unknown>): unknown {
  const entry = { name: "billing.example.com/ops", login: "ops@example.com", url: "https://billing.example.com/login", updated: "2026-11-01", password: STORED, secret: { deep: STORED } };
  if (url.startsWith("/api/agent/entries")) return { entries: [entry] };
  if (url.startsWith("/api/agent/match")) return { entries: [{ ...entry, match: "exact" }], fillAllowed: true };
  if (url.startsWith("/api/agent/fill")) return { status: "filled", name: entry.name, detail: "submitted", password: STORED };
  if (url.startsWith("/api/agent/save")) return { name: `${String(body.name)} ${String(body.password ?? "")}`.trim(), created: true, generated: body.password === undefined };
  if (url.startsWith("/api/agent/generate")) return { stored: true, name: String(body.name), created: true, length: 24, symbols: true };
  if (url.startsWith("/api/agent/delete")) return { ok: true, name: body.name };
  if (url.startsWith("/api/agent/audit")) return { records: [{ ts: "2026-11-01T10:00:00Z", actor: "agent", action: "fill", name: entry.name, host: "billing.example.com", status: "filled", password: STORED }] };
  return { error: "not found", method };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "clawbox-mcp-vault-"));
  tokenFile = path.join(dir, "agent-token");
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, origin: req.headers.origin as string | undefined, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (mode === "not_set_up") return send(409, { error: "ClawBox Vault is not set up yet", code: "not_set_up" });
      if (mode === "store_down") return send(503, { error: "the password store is not available: pass is not installed on this box", code: "store_unavailable" });
      if (mode === "wrong_token") return send(401, { error: "invalid agent token" });
      const url = req.url ?? "";
      return send(url.startsWith("/api/agent/") && !url.includes("nothing") ? 200 : 404, leakyAnswer(req.method ?? "", url, body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  restore = saveEnv("CLAWBOX_VAULT_URL", "CLAWBOX_VAULT_PORT", "CLAWBOX_VAULT_TOKEN_FILE", "CLAWBOX_VAULT_HOME", "CLAWBOX_VAULT_CONFIG_DIR", "CLAWBOX_VAULT_CARDS", "CLAWBOX_MCP_PROFILE", "CLAWBOX_MCP_CODING_TOOLS", "HOME");
  process.env.CLAWBOX_VAULT_URL = `http://127.0.0.1:${port}`;
  process.env.CLAWBOX_VAULT_TOKEN_FILE = tokenFile;
  delete process.env.CLAWBOX_VAULT_CARDS;
  delete process.env.CLAWBOX_VAULT_PORT;
  delete process.env.CLAWBOX_VAULT_HOME;
  delete process.env.CLAWBOX_VAULT_CONFIG_DIR;
  seen.length = 0;
  mode = "leaky";
});

afterEach(() => restore());

function family(edition: "openclaw" | "hermes") {
  const h = captureRegistrar(edition);
  registerVaultTools(h.reg);
  return h;
}

describe("the vault tools both runtimes get", () => {
  it("are the seven password tools on OpenClaw and on Hermes, and no card tool", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      expect(family(edition).names(), edition).toEqual(PASSWORD_TOOLS);
    }
  });

  it("register the two card tools only when cards are switched on", () => {
    expect(vaultCardsEnabled({})).toBe(false);
    expect(vaultCardsEnabled({ CLAWBOX_VAULT_CARDS: "true" })).toBe(false);
    expect(vaultCardsEnabled({ CLAWBOX_VAULT_CARDS: "1" })).toBe(true);
    process.env.CLAWBOX_VAULT_CARDS = "1";
    for (const edition of ["openclaw", "hermes"] as const) {
      expect(family(edition).names(), edition).toEqual([...PASSWORD_TOOLS, ...CARD_TOOLS]);
    }
  });

  it("are on the real server's full profile on both editions, and in no other profile", async () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const full = (await buildServer(edition, "full", edition, ALL)).reg.list().map((t) => t.name);
      expect(full.filter((n) => n.startsWith("vault_")), edition).toEqual(PASSWORD_TOOLS);
      // A delegated run's servers and the trimmed surface: none of them.
      for (const profile of ["core", "browser", "run-read"] as const) {
        const names = (await buildServer(edition, profile, edition, ALL)).reg.list().map((t) => t.name);
        expect(names.filter((n) => n.startsWith("vault_")), `${edition} ${profile}`).toEqual([]);
      }
    }
  }, 60_000);

  it("declare nothing that would let a run's read-only server take them in, and only the delete as destructive", () => {
    const h = family("openclaw");
    for (const name of PASSWORD_TOOLS) {
      const { opts, description } = h.get(name);
      expect(opts.readOnly, name).not.toBe(true);
      expect(opts.family, name).toBeUndefined();
      expect(opts.profile, name).toBeUndefined();
      expect(opts.editions, name).toBeUndefined();
      expect(opts.destructive === true, name).toBe(name === "vault_delete");
      expect(description.length, name).toBeLessThanOrEqual(400);
    }
    // Every description that touches a secret says the agent does not get it.
    for (const name of ["vault_list", "vault_match", "vault_save"]) expect(h.get(name).description, name).toMatch(/[Nn]ever (returns )?a password/);
    expect(h.get("vault_fill").description).toMatch(/status only/);
    expect(h.get("vault_generate").description).toMatch(/without seeing it/);
  });
});

describe("no password in anything the agent is handed", () => {
  it("every tool, on both editions, against a service that leaks in every reply", async () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const h = family(edition);
      const outputs: string[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const out = await h.call(name, args);
        outputs.push(JSON.stringify(out));
        return out;
      };
      const saved = await call("vault_save", { name: "billing.example.com/ops", login: "ops@example.com", url: "https://billing.example.com/login", password: GIVEN, note: "invoices" });
      expect(saved.isError).toBe(false);
      await call("vault_save", { name: "new.example.com/bot", login: "bot@example.com", url: "https://new.example.com/join" });
      await call("vault_generate", { name: "other.example.org/admin", login: "admin", url: "https://other.example.org" });
      await call("vault_list", {});
      await call("vault_list", { query: "billing" });
      await call("vault_match", { url: "https://billing.example.com/invoices" });
      const fill = await call("vault_fill", { url: "https://billing.example.com/login", submit: true });
      expect(fill.isError).toBe(false);
      if (!fill.isError) expect(fill.text).toMatch(/^filled \(billing\.example\.com\/ops\)/);
      await call("vault_audit", { limit: 50 });
      await call("vault_delete", { name: "other.example.org/admin", confirm: true });

      const all = outputs.join("\n");
      // The password the model itself passed in is scrubbed from every reply…
      expect(all.includes(GIVEN), edition).toBe(false);
      // …a password a service added to an entry, a record or a fill answer is never forwarded…
      expect(all.includes(STORED), edition).toBe(false);
      expect(all, edition).toContain("billing.example.com/ops");
      // …and nothing is passed through beside the prose: no structured copy for a host to render.
      expect(all, edition).not.toContain("structuredContent");
      // The token is the service's business, never the agent's.
      expect(all.includes(TOKEN), edition).toBe(false);
    }
    // What the tools sent: the token, as a bearer, and never a browser Origin.
    expect(seen.length).toBeGreaterThan(10);
    for (const req of seen) {
      expect(req.auth, req.url).toBe(`Bearer ${TOKEN}`);
      expect(req.origin, req.url).toBeUndefined();
    }
    // The given password did reach the service, once per edition: it is stored, not dropped.
    expect(seen.filter((r) => r.url === "/api/agent/save" && r.body.password === GIVEN)).toHaveLength(2);
    // A new sign-up sends none: the vault makes it.
    expect(seen.filter((r) => r.url === "/api/agent/save" && r.body.password === undefined)).toHaveLength(2);
  });

  it("the service's agent routes hand out no entry secret to begin with", () => {
    // The other half of the rule, read off the source: no agent route of the
    // vault service reads an entry into its answer (vault/tests drive the real
    // service against a real pass store and grep every reply).
    const app = fs.readFileSync(path.join(process.cwd(), "vault/src/server/app.ts"), "utf8");
    const agent = app.slice(app.indexOf("async function agentRoute"), app.indexOf("function corsFor"));
    expect(agent.length).toBeGreaterThan(1000);
    expect(agent).not.toMatch(/entry\.password|catalog\.read\(/);
    // And the one place a fill's wording comes back from the browser drops a detail that holds the password.
    expect(app).toMatch(/async function withoutSecret\(/);
    expect(app).toMatch(/withoutSecret\(await queue\.submit\(/);
  });
});

describe("what the agent is told when the vault cannot answer", () => {
  it("not set up: the owner has to choose a PIN, and the agent is told not to retry", async () => {
    mode = "not_set_up";
    for (const name of ["vault_list", "vault_fill", "vault_save"]) {
      const out = await family("hermes").call(name, { url: "https://billing.example.com/login", name: "a.example.com/b", login: "b", password: GIVEN });
      expect(out.isError, name).toBe(true);
      if (out.isError) {
        expect(out.error.code, name).toBe("CONFLICT");
        expect(out.error.message, name).toMatch(/not set up/);
        expect(out.error.next, name).toMatch(/choose a vault PIN/);
        expect(JSON.stringify(out.error), name).not.toContain(GIVEN);
      }
    }
  });

  it("the store is unavailable, the service is down, the token is wrong or missing", async () => {
    mode = "store_down";
    const down = await family("openclaw").call("vault_list", {});
    expect(down.isError && down.error.code).toBe("ENDPOINT_DOWN");

    mode = "wrong_token";
    const wrong = await family("openclaw").call("vault_list", {});
    expect(wrong.isError).toBe(false);
    if (!wrong.isError) {
      expect(wrong.result.isError).toBe(true);
      expect(wrong.text).toMatch(/rejected the agent token/);
      expect(wrong.text).not.toContain(TOKEN);
    }

    mode = "leaky";
    process.env.CLAWBOX_VAULT_URL = "http://127.0.0.1:9";
    const refused = await family("openclaw").call("vault_list", {});
    expect(refused.isError && refused.error.code).toBe("ENDPOINT_DOWN");

    process.env.CLAWBOX_VAULT_URL = `http://127.0.0.1:${port}`;
    process.env.CLAWBOX_VAULT_TOKEN_FILE = path.join(dir, "there-is-no-token");
    const before = seen.length;
    const missing = await family("openclaw").call("vault_list", {});
    expect(missing.isError && missing.error.code).toBe("ENDPOINT_DOWN");
    expect(seen.length).toBe(before);
  });

  it("refuses a token other users can read, and never sends it anywhere but loopback", async () => {
    const loose = path.join(dir, "loose-token");
    fs.writeFileSync(loose, `${TOKEN}\n`, { mode: 0o644 });
    fs.chmodSync(loose, 0o644);
    process.env.CLAWBOX_VAULT_TOKEN_FILE = loose;
    const before = seen.length;
    const out = await family("openclaw").call("vault_list", {});
    expect(out.isError && out.error.code).toBe("AUTH_FAILED");
    expect(seen.length).toBe(before);

    process.env.CLAWBOX_VAULT_TOKEN_FILE = tokenFile;
    for (const url of ["http://vault.example.com:4796", "https://127.0.0.1:4796", "http://127.0.0.1.example.com:4796", "http://127.0.0.1:4796@evil.example.org"]) {
      process.env.CLAWBOX_VAULT_URL = url;
      const far = await family("openclaw").call("vault_list", {});
      expect(far.isError, url).toBe(true);
      if (far.isError) expect(far.error.message, url).toMatch(/loopback/);
    }
    expect(seen.length).toBe(before);
  });

  it("a card tool is not there to call while cards are off", async () => {
    const h = family("openclaw");
    for (const name of CARD_TOOLS) {
      const out = await h.call(name, { url: "https://shop.example.com/checkout" });
      expect(out.isError, name).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("where the tools look for the service and its token", () => {
  it("defaults to the box's own vault folder and port, and follows the box's overrides", () => {
    expect(vaultServiceUrl({})).toBe("http://127.0.0.1:4796");
    expect(vaultServiceUrl({ CLAWBOX_VAULT_PORT: "4999" })).toBe("http://127.0.0.1:4999");
    expect(vaultServiceUrl({ CLAWBOX_VAULT_URL: "http://localhost:4796/" })).toBe("http://localhost:4796");
    expect(vaultTokenFile({ HOME: "/home/clawbox" })).toBe("/home/clawbox/.clawbox-vault/agent-token");
    expect(vaultTokenFile({ HOME: "/home/clawbox", CLAWBOX_VAULT_HOME: "/srv/vault" })).toBe("/srv/vault/agent-token");
    expect(vaultTokenFile({ CLAWBOX_VAULT_TOKEN_FILE: "/run/vault/token" })).toBe("/run/vault/token");
  });
});
