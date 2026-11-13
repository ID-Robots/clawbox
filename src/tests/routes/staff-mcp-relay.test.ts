import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2377 (G2) — the staff MCP relay against a real (tiny) MCP server that
 * echoes the credential it was called with: each member's call carries THAT
 * member's credential and nothing of the owner's; a second member gets their
 * own; no token, no credential, a withdrawn grant, a removed user or org mode
 * off get nothing; `tools/list` is filtered and a sender is refused before
 * the server is reached.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-staff-relay-${process.pid}-${Date.now()}`);

const state = vi.hoisted(() => ({
  orgMode: true as boolean | null,
  users: ["ivan", "maria", "olga"],
  servers: {} as Record<string, unknown>,
}));

vi.mock("@/lib/org-mode-server", () => ({
  readOrgModeStrict: vi.fn(async () => state.orgMode),
  readOrgMode: vi.fn(async () => state.orgMode === true),
}));
vi.mock("@/lib/clawbox-users", () => ({
  listUsers: vi.fn(async () => state.users.map((username) => ({ username, createdAt: "2026-11-12T00:00:00Z", sv: "x" }))),
}));
vi.mock("@/lib/openclaw-config", () => ({
  get OPENCLAW_HOME() {
    return path.join(ROOT, ".openclaw");
  },
  isPlainObject: (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v),
  readConfigStrict: vi.fn(async () => ({ mcp: { servers: state.servers } })),
}));
vi.mock("@/lib/clawbox-mcp-registration", () => ({ harnessesHere: () => ({ openclaw: true, hermes: false }) }));
vi.mock("@/lib/clawbox-mcp-switch", () => ({ readClawboxMcpEnabled: vi.fn(async () => true) }));

const callsOnly = () => seen.filter((s) => s.body.includes('"tools/call"'));
interface Seen { auth: string | null; apiKey: string | null; ownerHeader: string | null; method: string; body: string }
const seen: Seen[] = [];
let upstream: http.Server;
let upstreamUrl = "";
let sse = false;

const TOOLS = [
  { name: "search", description: "search documents", inputSchema: { type: "object" } },
  { name: "whoami", description: "echo the caller", inputSchema: { type: "object" } },
  { name: "send_mail", description: "send an email", inputSchema: { type: "object" } },
  { name: "purge_index", description: "x", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  { name: "lookup_ledger", description: "harmless name, destructive by the server's word", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  { name: "create_word_document", description: "write a .docx", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
];

let relay: typeof import("@/app/setup-api/staff-mcp/[server]/route");
let resetRelayCaches: () => void;
let mcp: typeof import("@/lib/staff-mcp");
const TOKENS = { ivan: "a".repeat(64), maria: "b".repeat(64), olga: "c".repeat(64) };

beforeAll(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization ?? null, apiKey: (req.headers["x-api-key"] as string) ?? null, ownerHeader: (req.headers["x-owner"] as string) ?? null, method: req.method ?? "", body });
      // A resume needs the position it resumes from; "cr" asks for CR-only framing.
      const lastId = req.headers["last-event-id"];
      if (req.method === "GET" && lastId !== "8" && lastId !== "cr") { res.writeHead(400).end(); return; }
      if (req.method === "GET" && lastId === "cr") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`id: 9\revent: message\rdata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: TOOLS } })}\r`);
        res.end("\r");
        return;
      }
      if (req.method === "GET") {
        // A resumed stream delivering a tool list (Last-Event-ID).
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`id: 9\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: TOOLS } })}\n\n`);
        return;
      }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const msg = JSON.parse(body);
      let result: unknown = {};
      if (msg.method === "tools/list") result = { tools: TOOLS };
      if (msg.method === "tools/call") result = { content: [{ type: "text", text: `caller=${req.headers.authorization ?? req.headers["x-api-key"]}` }] };
      if (msg.method === "tools/call" && msg.params?.name === "create_word_document") {
        // Writes a fresh document and names it — and names an OLD file of the owner's too.
        const fresh = path.join(ROOT, ".openclaw", "media", "word-docs", `${msg.params.arguments?.title ?? "doc"}.docx`);
        fs.mkdirSync(path.dirname(fresh), { recursive: true });
        fs.writeFileSync(fresh, "PK");
        result = { content: [{ type: "text", text: `Saved.\nMEDIA:${fresh}\nAlso see ${path.join(ROOT, ".openclaw", "media", "word-docs", "owners-old.docx")}` }] };
      }
      const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s-1" });
        res.end(`event: message\ndata: ${reply}\n\n`);
      } else {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-1" });
        res.end(reply);
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
  state.servers = {
    docs: { url: upstreamUrl, transport: "streamable-http", headers: { "X-Owner": "owner-secret", Authorization: "Bearer owner-token" } },
    m365: { url: upstreamUrl, transport: "streamable-http" },
    filtered: { url: upstreamUrl, transport: "streamable-http", toolFilter: { include: ["whoami"] } },
    leaky: { url: `${upstreamUrl}?key=owner`, transport: "streamable-http" },
    // A tool on the box that takes no credential (TASK-2516); the owner's own entry carries a header of theirs.
    worddoc: { url: upstreamUrl, transport: "streamable-http", headers: { "X-Owner": "owner-secret" } },
  };
  process.env.CLAWBOX_ROOT = ROOT;
  vi.resetModules();
  mcp = await import("@/lib/staff-mcp");
  relay = await import("@/app/setup-api/staff-mcp/[server]/route");
  ({ resetRelayCachesForTests: resetRelayCaches } = await import("@/lib/staff-mcp-relay"));
});

beforeEach(async () => {
  state.orgMode = true;
  state.users = ["ivan", "maria", "olga"];
  sse = false;
  seen.length = 0;
  resetRelayCaches();
  await mcp.updateStaffMcpStore(() => ({
    servers: { docs: { header: "Authorization" }, m365: { header: "X-Api-Key" }, filtered: { header: "Authorization" }, leaky: { header: "Authorization" } },
    credentials: {
      ivan: { docs: "ivan-docs-token", m365: "ivan-m365-key", filtered: "ivan-f", leaky: "ivan-l" },
      maria: { docs: "maria-docs-token" },
    },
    relayTokens: TOKENS,
  }));
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function call(server: string, token: string | null, message: unknown) {
  const req = new Request(`http://127.0.0.1/setup-api/staff-mcp/${server}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Cookie: "clawbox_session=whatever",
    },
    body: JSON.stringify(message),
  });
  return relay.POST(req, { params: Promise.resolve({ server }) });
}

const whoami = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "whoami", arguments: {} } };

describe("a tool on the box that takes no credential (TASK-2516)", () => {
  const createDoc = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "create_word_document", arguments: { title: "Q4" } } };
  const listTools = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };
  const grant = (worddoc: Record<string, unknown>) => mcp.updateStaffMcpStore((store) => ({ ...store, servers: { ...store.servers, worddoc: { header: "Authorization", ...worddoc } } }));

  it("serves every member through their own token, sending no credential and nothing of the owner's", async () => {
    await grant({ needsCredential: false });
    const res = await call("worddoc", TOKENS.olga, whoami);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("caller=undefined");
    expect(callsOnly()[0]).toMatchObject({ auth: null, apiKey: null, ownerHeader: null });
  });

  it("offers and passes the create/edit tool only where the owner ticked it — the sender stays refused", async () => {
    await grant({ needsCredential: false });
    const strict = await (await call("worddoc", TOKENS.olga, listTools)).json();
    expect(strict.result.tools.map((t: { name: string }) => t.name)).toEqual(["search", "whoami"]);
    expect((await (await call("worddoc", TOKENS.olga, createDoc)).json()).error?.code).toBe(-32601);

    await grant({ needsCredential: false, writeTools: true });
    resetRelayCaches();
    const open = await (await call("worddoc", TOKENS.olga, listTools)).json();
    expect(open.result.tools.map((t: { name: string }) => t.name)).toEqual(["search", "whoami", "create_word_document"]);
    seen.length = 0;
    const made = await (await call("worddoc", TOKENS.olga, createDoc)).json();
    expect(made.result).toBeTruthy();
    expect(callsOnly()).toHaveLength(1);
    const send = { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "send_mail", arguments: {} } };
    expect((await (await call("worddoc", TOKENS.olga, send)).json()).error?.code).toBe(-32601);
    expect(callsOnly()).toHaveLength(1);
  });

  it("refuses a member the owner did not name, before the server is reached", async () => {
    await grant({ needsCredential: false, members: ["maria"] });
    const res = await call("worddoc", TOKENS.olga, whoami);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_granted");
    expect(seen).toHaveLength(0);
    expect((await call("worddoc", TOKENS.maria, whoami)).status).toBe(200);
  });

  it("records the files a member's own tool call wrote as theirs (provenance), never an older file it merely names", async () => {
    await grant({ needsCredential: false, writeTools: true });
    const old = path.join(ROOT, ".openclaw", "media", "word-docs", "owners-old.docx");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "PK");
    const hourAgo = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(old, hourAgo, hourAgo);
    for (const as of [sse, !sse]) {
      sse = as;
      const res = await call("worddoc", TOKENS.olga, { ...createDoc, params: { name: "create_word_document", arguments: { title: `olga-${as ? "sse" : "json"}` } } });
      expect(res.status).toBe(200);
      await res.text(); // the body read to its end, as the gateway does
    }
    const owners = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "chat-media-owners.json"), "utf-8")) as Record<string, string>;
    const docs = path.join(fs.realpathSync(ROOT), ".openclaw", "media", "word-docs");
    expect(owners[path.join(docs, "olga-sse.docx")]).toBe("olga");
    expect(owners[path.join(docs, "olga-json.docx")]).toBe("olga");
    expect(owners[path.join(docs, "owners-old.docx")]).toBeUndefined();
  });

  it("is not served to staff at all while it is not granted", async () => {
    const res = await call("worddoc", TOKENS.olga, whoami);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_granted");
    expect(seen).toHaveLength(0);
  });
});

describe("whose credential travels", () => {
  it("sends each member's own credential, in the owner's chosen header, and nothing of the owner's", async () => {
    const res = await call("docs", TOKENS.ivan, whoami);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("caller=Bearer ivan-docs-token");
    expect(callsOnly()[0].auth).toBe("Bearer ivan-docs-token");
    expect(seen.every((s) => s.ownerHeader === null && !s.body.includes(TOKENS.ivan))).toBe(true);

    const second = await call("docs", TOKENS.maria, whoami);
    expect(JSON.stringify(await second.json())).toContain("caller=Bearer maria-docs-token");
    expect(callsOnly()[1].auth).toBe("Bearer maria-docs-token");

    await call("m365", TOKENS.ivan, whoami);
    expect(callsOnly()[2].apiKey).toBe("ivan-m365-key");
    expect(callsOnly()[2].auth).toBeNull();
  });

  it("refuses a call with no relay token or someone else's guess, without reaching the server", async () => {
    expect((await call("docs", null, whoami)).status).toBe(401);
    expect((await call("docs", "d".repeat(64), whoami)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("gives a member with no credential nothing from that server", async () => {
    const res = await call("m365", TOKENS.maria, whoami);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("no_credential");
    expect((await call("docs", TOKENS.olga, whoami)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("stops at once when the grant, the user or the switch goes", async () => {
    state.orgMode = false;
    expect((await call("docs", TOKENS.ivan, whoami)).status).toBe(403);
    state.orgMode = null;
    expect((await call("docs", TOKENS.ivan, whoami)).status).toBe(403);
    state.orgMode = true;
    state.users = ["maria"];
    expect((await call("docs", TOKENS.ivan, whoami)).status).toBe(403);
    state.users = ["ivan", "maria"];
    await mcp.updateStaffMcpStore((s) => ({ ...s, servers: { m365: { header: "X-Api-Key" } } }));
    expect((await call("docs", TOKENS.ivan, whoami)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("never relays to a server whose address carries the owner's credential", async () => {
    expect((await call("leaky", TOKENS.ivan, whoami)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

describe("which tools a member reaches", () => {
  it("filters the tool list (JSON): no sender, nothing destructive", async () => {
    const res = await call("docs", TOKENS.ivan, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (await res.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["search", "whoami"]);
  });

  it("filters the tool list in an SSE answer too", async () => {
    sse = true;
    const res = await call("docs", TOKENS.ivan, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("mcp-session-id")).toBe("s-1");
    const text = await res.text();
    expect(text).toContain("event: message");
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(data.result.tools.map((t: { name: string }) => t.name)).toEqual(["search", "whoami"]);
  });

  it("keeps the owner's tool filter", async () => {
    const res = await call("filtered", TOKENS.ivan, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect((await res.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["whoami"]);
    const refused = await call("filtered", TOKENS.ivan, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search", arguments: {} } });
    expect((await refused.json()).error.code).toBe(-32601);
  });

  it("answers a call to a sender with an error and never reaches the server", async () => {
    const res = await call("docs", TOKENS.ivan, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "send_mail", arguments: { to: "x" } } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(9);
    expect(body.error.message).toContain("not available to members of staff");
    expect(callsOnly()).toHaveLength(0);
  });

  it("refuses a whole batch that names a refused tool", async () => {
    const res = await call("docs", TOKENS.ivan, [whoami, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "delete_all" } }]);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.every((m: { error?: unknown }) => m.error)).toBe(true);
    expect(callsOnly()).toHaveLength(0);
  });
});

describe("a resumed stream", () => {
  it("filters an event framed with CR-only line endings", async () => {
    const req = new Request("http://127.0.0.1/setup-api/staff-mcp/docs", { method: "GET", headers: { Authorization: `Bearer ${TOKENS.ivan}`, "Last-Event-ID": "cr" } });
    const res = await relay.GET(req, { params: Promise.resolve({ server: "docs" }) });
    const text = await res.text();
    expect(text).not.toContain("send_mail");
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(data.result.tools.map((t: { name: string }) => t.name)).toEqual(["search", "whoami"]);
  });

  it("does not answer a resume without the position it resumes from", async () => {
    const req = new Request("http://127.0.0.1/setup-api/staff-mcp/docs", { method: "GET", headers: { Authorization: `Bearer ${TOKENS.ivan}` } });
    expect((await relay.GET(req, { params: Promise.resolve({ server: "docs" }) })).status).toBe(400);
  });

  it("filters a tool list delivered on a GET", async () => {
    const req = new Request("http://127.0.0.1/setup-api/staff-mcp/docs", { method: "GET", headers: { Authorization: `Bearer ${TOKENS.ivan}`, "Last-Event-ID": "8" } });
    const res = await relay.GET(req, { params: Promise.resolve({ server: "docs" }) });
    const text = await res.text();
    expect(text).toContain("id: 9");
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(data.result.tools.map((t: { name: string }) => t.name)).toEqual(["search", "whoami"]);
  });

  it("refuses a server named like an object's own property", async () => {
    expect((await call("constructor", TOKENS.ivan, whoami)).status).toBe(404);
  });
});

describe("a call is judged by what the server listed", () => {
  it("looks the tool list up when it has none, then calls a listed, allowed tool", async () => {
    const res = await call("docs", TOKENS.ivan, whoami);
    expect(JSON.stringify(await res.json())).toContain("caller=Bearer ivan-docs-token");
    expect(seen.map((s) => JSON.parse(s.body).method)).toEqual(["tools/list", "tools/call"]);
    expect(seen.every((s) => s.auth === "Bearer ivan-docs-token")).toBe(true);
  });

  it("refuses a tool the server marks destructive even when its name sends nothing, listed before or not", async () => {
    const cold = await call("docs", TOKENS.ivan, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lookup_ledger" } });
    expect((await cold.json()).error.code).toBe(-32601);
    await call("docs", TOKENS.ivan, { jsonrpc: "2.0", id: 6, method: "tools/list" });
    const warm = await call("docs", TOKENS.ivan, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lookup_ledger" } });
    expect((await warm.json()).error.code).toBe(-32601);
    expect(seen.some((s) => s.body.includes('"tools/call"'))).toBe(false);
  });

  it("refuses a tool the server does not list at all", async () => {
    const res = await call("docs", TOKENS.ivan, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "hidden_lookup" } });
    expect((await res.json()).error.code).toBe(-32601);
    expect(seen.some((s) => s.body.includes('"tools/call"'))).toBe(false);
  });
});

describe("the route", () => {
  it("refuses a name that is not a server's, and a relay entry's own prefix", async () => {
    const res = await relay.POST(new Request("http://127.0.0.1/setup-api/staff-mcp/x", { method: "POST", body: "{}" }), { params: Promise.resolve({ server: "cbstaff-12345678-docs" }) });
    expect(res.status).toBe(404);
  });
});
