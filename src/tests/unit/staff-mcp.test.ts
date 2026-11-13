import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * TASK-2377 (G2) — the owner's staff MCP grants: the store (0600, never
 * answered in clear), the relay entries each member gets (only granted,
 * usable servers they have a credential for; their own relay token), and the
 * tool rule (the owner's filter, never a sender or a writer).
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-staff-mcp-${process.pid}-${Date.now()}`);
let mcp: typeof import("@/lib/staff-mcp");

beforeAll(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CLAWBOX_ROOT = ROOT;
  vi.resetModules();
  mcp = await import("@/lib/staff-mcp");
});

afterAll(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const httpServer = (name: string, url = "https://docs.example.com/mcp", extra: Record<string, unknown> = {}) => ({
  name, harness: "openclaw" as const, transport: "http" as const, usable: true,
  config: { type: "http" as const, url }, include: null, exclude: [], secrets: [], ...extra,
});

describe("the store", () => {
  it("is written 0600 and read back; a missing file is empty, a broken one throws", async () => {
    const file = path.join(ROOT, "store-a.json");
    expect(await mcp.readStaffMcpStore(file)).toEqual({ servers: {}, credentials: {}, relayTokens: {} });
    await mcp.updateStaffMcpStore(() => ({
      servers: { docs: { header: "Authorization" } },
      credentials: { ivan: { docs: "ivan-secret-token-123456" } },
      relayTokens: { ivan: "a".repeat(64) },
    }), file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await mcp.readStaffMcpStore(file)).credentials.ivan.docs).toBe("ivan-secret-token-123456");
    fs.writeFileSync(path.join(ROOT, "broken.json"), "{not json");
    await expect(mcp.readStaffMcpStore(path.join(ROOT, "broken.json"))).rejects.toThrow();
    expect(await mcp.readStaffMcpStoreOrEmpty(path.join(ROOT, "broken.json"))).toEqual({ servers: {}, credentials: {}, relayTokens: {} });
  });

  it("drops anything outside its shape: bad names, control characters, short tokens, reserved headers", () => {
    const parsed = mcp.parseStore({
      servers: { docs: { header: "X-Api-Key" }, "bad name": {}, "cbstaff-x": {}, mail: { header: "Cookie" } },
      credentials: { ivan: { docs: "line\nbreak", ok: "fine-token" }, "Bad User": { docs: "x" } },
      relayTokens: { ivan: "short", maria: "b".repeat(64) },
    });
    expect(parsed.servers).toEqual({ docs: { header: "X-Api-Key", needsCredential: true, writeTools: false, members: null } });
    expect(parsed.credentials).toEqual({ ivan: { ok: "fine-token" } });
    expect(parsed.relayTokens).toEqual({ maria: "b".repeat(64) });
  });

  it("forgets a removed user's credentials and relay token", async () => {
    const file = path.join(ROOT, "store-b.json");
    await mcp.updateStaffMcpStore(() => ({
      servers: { docs: { header: "Authorization" } },
      credentials: { ivan: { docs: "ivan-token" }, maria: { docs: "maria-token" } },
      relayTokens: { ivan: "a".repeat(64), maria: "b".repeat(64) },
    }), file);
    await mcp.forgetStaffMcpUser("ivan", file);
    const after = await mcp.readStaffMcpStore(file);
    expect(after.credentials).toEqual({ maria: { docs: "maria-token" } });
    expect(after.relayTokens).toEqual({ maria: "b".repeat(64) });
  });

  it("never reads a username or server named like an object's own property as set", async () => {
    const empty = mcp.parseStore({});
    expect(Object.hasOwn(empty.relayTokens, "constructor")).toBe(false);
    expect((empty.relayTokens as Record<string, unknown>).constructor).toBeUndefined();
    expect((empty.servers as Record<string, unknown>).constructor).toBeUndefined();
    const file = path.join(ROOT, "store-proto.json");
    await mcp.updateStaffMcpStore(() => ({ servers: { constructor: { header: "Authorization" } }, credentials: { constructor: { constructor: "tok" } }, relayTokens: {} }), file);
    const after = await mcp.ensureRelayTokens(["constructor"], file);
    expect(after.relayTokens.constructor).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when the store cannot even be checked", async () => {
    if (process.getuid?.() === 0) return;
    const dir = path.join(ROOT, "locked-store");
    fs.mkdirSync(dir);
    await mcp.updateStaffMcpStore(() => ({ servers: {}, credentials: { ivan: { docs: "t" } }, relayTokens: {} }), path.join(dir, "s.json"));
    fs.chmodSync(dir, 0o000);
    try {
      await expect(mcp.forgetStaffMcpUserStrict("ivan", path.join(dir, "s.json"))).rejects.toThrow();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    await mcp.forgetStaffMcpUserStrict("ivan", path.join(dir, "s.json"));
    expect((await mcp.readStaffMcpStore(path.join(dir, "s.json"))).credentials).toEqual({});
    await mcp.forgetStaffMcpUserStrict("ivan", path.join(dir, "missing.json"));
  });

  it("clears a credential written by a change that was already under way when the user went", async () => {
    const file = path.join(ROOT, "store-race.json");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // A credential write that passed its check and holds the lock…
    const write = mcp.updateStaffMcpStore(async (s) => {
      await gate;
      return { ...s, credentials: { ...s.credentials, ivan: { docs: "late-token" } } };
    }, file);
    // …and the removal's clean-up, asked meanwhile (the store does not exist yet).
    const forget = mcp.forgetStaffMcpUserStrict("ivan", file);
    release();
    await Promise.all([write, forget]);
    expect((await mcp.readStaffMcpStore(file)).credentials).toEqual({});
  });

  it("masks a credential and never shows more than its last four characters", () => {
    expect(mcp.maskCredential("abcdefghijklmnop-1234")).toBe("••••1234");
    expect(mcp.maskCredential("short")).toBe("••••");
  });

  it("checks the header a credential may travel in and words Authorization as a bearer", () => {
    expect(mcp.credentialHeaderName(undefined)).toBe("Authorization");
    expect(mcp.credentialHeaderName("X-Api-Key")).toBe("X-Api-Key");
    for (const bad of ["Cookie", "host", "Mcp-Session-Id", "content-type", "X Api", "x:y", "a\r\nb", 5]) {
      expect(mcp.credentialHeaderName(bad), String(bad)).toBeNull();
    }
    expect(mcp.credentialHeaderValue("Authorization", "tok")).toBe("Bearer tok");
    expect(mcp.credentialHeaderValue("Authorization", "Basic dXNlcjpwYXNz")).toBe("Basic dXNlcjpwYXNz");
    expect(mcp.credentialHeaderValue("X-Api-Key", "tok")).toBe("tok");
    expect(mcp.normalizeCredential("  tok  ")).toBe("tok");
    expect(mcp.normalizeCredential("a\r\nX-Evil: 1")).toBeNull();
    expect(mcp.normalizeCredential("")).toBeNull();
    expect(mcp.normalizeCredential("x".repeat(4097))).toBeNull();
  });

  it("names the member a relay token belongs to, and nobody for any other value", () => {
    const store = { servers: {}, credentials: {}, relayTokens: { ivan: "a".repeat(64), maria: "b".repeat(64) } };
    expect(mcp.userOfRelayToken(store, "a".repeat(64))).toBe("ivan");
    expect(mcp.userOfRelayToken(store, "b".repeat(64))).toBe("maria");
    expect(mcp.userOfRelayToken(store, "c".repeat(64))).toBeNull();
    expect(mcp.userOfRelayToken(store, "a".repeat(63))).toBeNull();
    expect(mcp.userOfRelayToken(store, null)).toBeNull();
  });
});

describe("which servers members of staff can be handed", () => {
  it("only Streamable HTTP servers without a credential in their address", () => {
    expect(mcp.staffServerVerdict(httpServer("docs"))).toBeNull();
    expect(mcp.staffServerVerdict({ ...httpServer("sse"), transport: "sse", config: { type: "sse", url: "https://x/sse" } })).toBe("transport");
    expect(mcp.staffServerVerdict({ name: "local", harness: "openclaw", transport: "stdio", usable: true, config: { command: "node", args: [] } })).toBe("transport");
    expect(mcp.staffServerVerdict(httpServer("q", "https://x/mcp?key=owner-secret"))).toBe("urlCredential");
    expect(mcp.staffServerVerdict(httpServer("u", "https://owner:pw@x/mcp"))).toBe("urlCredential");
    expect(mcp.staffServerVerdict({ name: "o", harness: "openclaw", transport: "http", usable: false, reason: "oauth" })).toBe("unusable");
    // A credential travels encrypted, or only to this box.
    expect(mcp.staffServerVerdict(httpServer("plain", "http://docs.example.com/mcp"))).toBe("insecure");
    expect(mcp.staffServerVerdict(httpServer("local", "http://127.0.0.1:8080/mcp"))).toBeNull();
    expect(mcp.staffServerVerdict(httpServer("local6", "http://[::1]:8080/mcp"))).toBeNull();
    // A NAME is whatever the resolver says: `localhost` is not trusted with a credential in clear.
    expect(mcp.staffServerVerdict(httpServer("localname", "http://localhost/mcp"))).toBe("insecure");
  });
});

describe("each member's relay entries", () => {
  const store = {
    servers: { docs: { header: "Authorization" }, m365: { header: "X-Api-Key" }, gone: { header: "Authorization" }, local: { header: "Authorization" } },
    credentials: { ivan: { docs: "ivan-docs", m365: "ivan-m365", gone: "x", local: "y" }, maria: { docs: "maria-docs" } },
    relayTokens: { ivan: "a".repeat(64), maria: "b".repeat(64), olga: "c".repeat(64) },
  };
  const servers = [
    httpServer("docs", "https://docs.example.com/mcp", { include: ["search", "fetch"], exclude: [] }),
    httpServer("m365"),
    { name: "local", harness: "openclaw" as const, transport: "stdio" as const, usable: true, config: { command: "node", args: [] } },
    httpServer("ungranted"),
  ];
  const plan = () => mcp.planStaffMcpEntries({ staff: ["ivan", "maria", "olga"], store, servers, relayBase: "http://127.0.0.1" });

  it("gives each member only granted, usable servers they have a credential for", () => {
    const entries = plan();
    expect(entries.get("ivan")?.map((e) => e.server)).toEqual(["docs", "m365"]);
    expect(entries.get("maria")?.map((e) => e.server)).toEqual(["docs"]);
    // No credential: no tools from that server (and none at all here).
    expect(entries.has("olga")).toBe(false);
  });

  it("points each entry at the relay with THAT member's token and the owner's tool filter, never the owner's headers", () => {
    const ivan = plan().get("ivan")!;
    const maria = plan().get("maria")!;
    expect(ivan[0].config).toEqual({
      url: "http://127.0.0.1/setup-api/staff-mcp/docs",
      transport: "streamable-http",
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
      toolFilter: { include: ["search", "fetch"] },
    });
    expect(maria[0].config.headers).toEqual({ Authorization: `Bearer ${"b".repeat(64)}` });
    expect(JSON.stringify([...plan().values()])).not.toContain("ivan-docs");
    expect(ivan[0].name).not.toBe(maria[0].name);
  });

  it("names entries within OpenClaw's 30-character server prefix, distinct per member and server", () => {
    const names = [...plan().values()].flat().map((e) => e.name);
    for (const name of names) {
      expect(name.startsWith("cbstaff-")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(mcp.staffEntryName("ivan", "a-very-long-server-name-indeed")).toMatch(/^cbstaff-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(mcp.staffEntryName("ivan", "docs")).toBe(`cbstaff-${mcp.userTag("ivan")}-docs`);
  });

  it("writes the guard's grants by agent id", () => {
    const doc = mcp.grantsDocument(plan());
    expect(Object.keys(doc.agents).sort()).toEqual(["clawbox-staff-ivan", "clawbox-staff-maria"]);
    expect(doc.agents["clawbox-staff-maria"]).toEqual([mcp.staffEntryName("maria", "docs")]);
  });

  it("mints a relay token for a member with a credential and none yet", async () => {
    const file = path.join(ROOT, "store-c.json");
    await mcp.updateStaffMcpStore(() => ({ servers: { docs: { header: "Authorization" } }, credentials: { ivan: { docs: "t" } }, relayTokens: {} }), file);
    const after = await mcp.ensureRelayTokens(["ivan", "maria"], file);
    expect(after.relayTokens.ivan).toMatch(/^[0-9a-f]{64}$/);
    expect(after.relayTokens.maria).toBeUndefined();
  });
});

describe("which tools a member's call may reach", () => {
  const open = { include: null, exclude: [] };
  it("never one that sends or changes something, whatever the owner's filter says", () => {
    for (const name of ["send_mail", "sendMail", "create_event", "delete-file", "update_document", "upload", "reply_to_message", "forwardEmail", "write_note", "move_item", "share_link", "run_query", "sendmail", "deletefile", "wipe_cache", "refund_order", "Destroy"]) {
      expect(mcp.staffToolAllowed(name, open), name).toBe(false);
      expect(mcp.staffToolAllowed(name, { include: [name], exclude: [] }), name).toBe(false);
    }
    for (const name of ["search", "search_documents", "get_document", "list_messages", "fetch", "read_mail", "get_email", "get_settings", "address_lookup", "running_jobs"]) {
      expect(mcp.staffToolAllowed(name, open), name).toBe(true);
    }
  });

  it("follows the owner's include and exclude lists", () => {
    expect(mcp.staffToolAllowed("fetch", { include: ["search"], exclude: [] })).toBe(false);
    expect(mcp.staffToolAllowed("search", { include: ["search"], exclude: [] })).toBe(true);
    expect(mcp.staffToolAllowed("search", { include: null, exclude: ["search"] })).toBe(false);
  });

  it("believes a server that calls its own tool destructive or not read-only", () => {
    expect(mcp.staffToolAllowed("search", open, { destructiveHint: true })).toBe(false);
    expect(mcp.staffToolAllowed("search", open, { readOnlyHint: false })).toBe(false);
    expect(mcp.staffToolAllowed("search", open, { readOnlyHint: true })).toBe(true);
    expect(mcp.staffToolAllowed("", open)).toBe(false);
    expect(mcp.staffToolAllowed(undefined, open)).toBe(false);
  });
});

describe("a tool on the box that takes no credential, granted to all staff or by name (TASK-2516)", () => {
  const servers = [httpServer("worddoc", "http://127.0.0.1:8765/mcp"), httpServer("docs"), httpServer("ungranted", "http://127.0.0.1:9000/mcp")];
  const tokens = { ivan: "a".repeat(64), maria: "b".repeat(64), olga: "c".repeat(64) };
  const plan = (worddoc: Record<string, unknown>) => mcp.planStaffMcpEntries({
    staff: ["ivan", "maria", "olga"],
    store: mcp.parseStore({ servers: { worddoc, docs: {} }, credentials: { ivan: { docs: "ivan-docs" } }, relayTokens: tokens }),
    servers,
    relayBase: "http://127.0.0.1",
  });

  it("gives every member of staff the server, each through their own relay token, with no credential needed", () => {
    const entries = plan({ needsCredential: false });
    expect(entries.get("ivan")?.map((e) => e.server)).toEqual(["docs", "worddoc"]);
    expect(entries.get("maria")?.map((e) => e.server)).toEqual(["worddoc"]);
    expect(entries.get("olga")?.[0].config.headers).toEqual({ Authorization: `Bearer ${"c".repeat(64)}` });
  });

  it("gives a server granted by name to those members only", () => {
    const entries = plan({ needsCredential: false, members: ["maria"] });
    expect(entries.get("maria")?.map((e) => e.server)).toEqual(["worddoc"]);
    expect(entries.get("olga")).toBeUndefined();
    expect(entries.get("ivan")?.map((e) => e.server)).toEqual(["docs"]);
  });

  it("never hands staff a server the owner did not grant", () => {
    const all = [...plan({ needsCredential: false }).values()].flat().map((e) => e.server);
    expect(all).not.toContain("ungranted");
    expect(mcp.grantsDocument(plan({ needsCredential: false })).agents["clawbox-staff-olga"]).toEqual([mcp.staffEntryName("olga", "worddoc")]);
  });

  it("mints a relay token for every member reached by a server that takes no credential", async () => {
    const file = path.join(ROOT, "store-open.json");
    await mcp.updateStaffMcpStore(() => mcp.parseStore({ servers: { worddoc: { needsCredential: false, members: ["olga"] } } }), file);
    const store = await mcp.ensureRelayTokens(["ivan", "olga"], file);
    expect(Object.keys(store.relayTokens)).toEqual(["olga"]);
  });

  it("takes a removed user's name out of every grant's member list", async () => {
    const file = path.join(ROOT, "store-members.json");
    await mcp.updateStaffMcpStore(() => mcp.parseStore({ servers: { worddoc: { members: ["ivan", "maria"] }, docs: {} } }), file);
    await mcp.forgetStaffMcpUser("ivan", file);
    const after = await mcp.readStaffMcpStore(file);
    expect(after.servers.worddoc.members).toEqual(["maria"]);
    expect(after.servers.docs.members).toBeNull();
  });

  it("lets create/edit tools through only where the owner ticked them — never a sender, a deleter or a destructive tool", () => {
    const strict = { include: null, exclude: [] };
    const writes = { include: null, exclude: [], writeTools: true };
    for (const name of ["create_word_document", "createDocument", "write_file", "append_rows", "save_docx", "update_document"]) {
      expect(mcp.staffToolAllowed(name, strict), name).toBe(false);
      expect(mcp.staffToolAllowed(name, writes), name).toBe(true);
    }
    for (const name of ["send_email", "create_and_send", "delete_document", "share_file", "publish_post", "run_macro", "move_file", "sendmail", "upload_file"]) {
      expect(mcp.staffToolAllowed(name, writes), name).toBe(false);
    }
    expect(mcp.staffToolAllowed("create_document", writes, { readOnlyHint: false })).toBe(true);
    expect(mcp.staffToolAllowed("create_document", strict, { readOnlyHint: false })).toBe(false);
    expect(mcp.staffToolAllowed("create_document", writes, { destructiveHint: true })).toBe(false);
    // The owner's own filter still narrows.
    expect(mcp.staffToolAllowed("create_document", { include: ["search"], exclude: [], writeTools: true })).toBe(false);
  });
});

describe("tool names the review found (TASK-2516)", () => {
  const strict = { include: null, exclude: [] };
  const writes = { include: null, exclude: [], writeTools: true };
  it("refuses who-may-do-what tools even with create/edit ticked", () => {
    for (const name of ["set_permissions", "add_member", "update_acl", "updateRole", "add_user"]) expect(mcp.staffToolAllowed(name, writes), name).toBe(false);
  });
  it("reads a verb at the end of a run-together word too", () => {
    for (const name of ["mailsend", "filedelete", "docpublish"]) {
      expect(mcp.staffToolAllowed(name, strict), name).toBe(false);
      expect(mcp.staffToolAllowed(name, writes), name).toBe(false);
    }
    for (const name of ["search", "get_settings", "lookup_address", "list_running_jobs"]) expect(mcp.staffToolAllowed(name, strict), name).toBe(true);
  });
  it("plans no entry from a credential named like an object property", () => {
    const entries = mcp.planStaffMcpEntries({
      staff: ["olga"],
      store: mcp.parseStore({ servers: { constructor: {} }, relayTokens: { olga: "c".repeat(64) } }),
      servers: [httpServer("constructor")],
      relayBase: "http://127.0.0.1",
    });
    expect(entries.size).toBe(0);
  });
});
