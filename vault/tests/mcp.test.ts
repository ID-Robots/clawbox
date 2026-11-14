// The agent's tools: no tool response ever contains the test password, neither
// when called in-process nor through ClawBox's real MCP server (the one both
// runtimes start) over stdio against a live service.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { callTool, CARD_TOOL_NAMES, TOOLS, toolsFor, type VaultCall } from "../src/mcp/tools";
import { createTempStore, passShowExitCode, type TempStore } from "./helpers/tempstore";
import { createTestVault, EXT_ORIGIN, pairExtension, type TestVault } from "./helpers/vault";

const PASSWORD = "Mc9&mcp-Tool-Test-pw";
let store: TempStore;
let v: TestVault;
let ext = "";

const call: VaultCall = async (method, path, body) => {
  const res = await v.request(path, { method, token: v.mcpToken, ...(body !== undefined ? { body } : {}) });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
};

/** Plays the extension: answers the next fill command with `status`. */
async function extensionAnswers(status: string): Promise<void> {
  const res = await v.request("/api/ext/commands?wait=2000", { token: ext, origin: EXT_ORIGIN });
  const { commands } = (await res.json()) as { commands: Array<{ id: string }> };
  for (const c of commands) {
    await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { commandId: c.id } });
    await v.request("/api/ext/result", { token: ext, origin: EXT_ORIGIN, body: { id: c.id, status } });
  }
}

beforeAll(async () => {
  store = createTempStore();
  v = await createTestVault(store);
  ext = (await pairExtension(v)).ext;
}, 60_000);

afterAll(() => store?.cleanup());

describe("MCP tools (in-process)", () => {
  const outputs: string[] = [];
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(name, args, call);
    outputs.push(JSON.stringify(r));
    return r;
  };

  test("tool list: the seven password tools; the two card tools only with cards on", () => {
    expect(toolsFor(false).map((t) => t.name)).toEqual(["vault_list", "vault_match", "vault_fill", "vault_save", "vault_generate", "vault_delete", "vault_audit"]);
    expect(toolsFor(true).map((t) => t.name)).toEqual([...toolsFor(false).map((t) => t.name), "vault_cards_list", "vault_card_fill"]);
    expect(toolsFor(true)).toEqual(TOOLS);
    expect([...CARD_TOOL_NAMES]).toEqual(["vault_cards_list", "vault_card_fill"]);
  });

  test("a card tool called with cards off is an unknown tool and reaches no service", async () => {
    let reached = 0;
    const counting: VaultCall = async () => {
      reached++;
      return { status: 200, data: { cards: [], status: "filled" } };
    };
    for (const name of CARD_TOOL_NAMES) {
      const r = await callTool(name, { url: "https://shop.example.com/checkout" }, counting);
      expect(r.isError, name).toBe(true);
      expect(r.content[0]!.text, name).toBe(`unknown tool ${name}`);
    }
    expect(reached).toBe(0);
  });

  test("every tool, end to end, without leaking a password", async () => {
    const saved = await run("vault_save", { name: "billing.example.com/ops", login: "ops@example.com", url: "https://billing.example.com/login", password: PASSWORD, note: "invoices" });
    expect(saved.content[0]!.text).toBe("saved billing.example.com/ops");
    expect(passShowExitCode(store, "billing.example.com/ops")).toBe(0);

    const signup = await run("vault_save", { name: "new.example.com/bot", login: "bot@example.com", url: "https://new.example.com/join" });
    expect(signup.content[0]!.text).toBe("generated and stored as new.example.com/bot");

    const gen = await run("vault_generate", { length: 30 });
    expect(gen.structuredContent).toMatchObject({ stored: false, length: 30 });
    const gen2 = await run("vault_generate", { name: "other.example.org/admin", login: "admin", url: "https://other.example.org" });
    expect(gen2.content[0]!.text).toBe("generated and stored as other.example.org/admin");
    const refused = await run("vault_generate", { name: "other.example.org/admin" });
    expect(refused.isError).toBe(true);

    const list = await run("vault_list", {});
    expect((list.structuredContent!.entries as unknown[]).length).toBe(3);
    const match = await run("vault_match", { url: "https://billing.example.com/invoices" });
    expect((match.structuredContent!.entries as Array<{ name: string }>)[0]!.name).toBe("billing.example.com/ops");

    const [fill] = await Promise.all([run("vault_fill", { url: "https://billing.example.com/login", submit: true }), extensionAnswers("filled")]);
    expect(fill.structuredContent).toEqual({ status: "filled", name: "billing.example.com/ops" });
    const [noForm] = await Promise.all([run("vault_fill", { url: "https://billing.example.com/login", name: "billing.example.com/ops" }), extensionAnswers("no_form")]);
    expect(noForm.structuredContent).toMatchObject({ status: "no_form" });
    const mismatch = await run("vault_fill", { url: "https://evil.example.net/login", name: "billing.example.com/ops" });
    expect(mismatch.structuredContent).toMatchObject({ status: "origin_mismatch" });

    const noConfirm = await run("vault_delete", { name: "other.example.org/admin" });
    expect(noConfirm.isError).toBe(true);
    expect(passShowExitCode(store, "other.example.org/admin")).toBe(0);
    const del = await run("vault_delete", { name: "other.example.org/admin", confirm: true });
    expect(del.content[0]!.text).toBe("deleted other.example.org/admin");

    const audit = await run("vault_audit", { limit: 50 });
    expect((audit.structuredContent!.records as unknown[]).length).toBeGreaterThan(5);

    // The secrets: the given password and both generated ones.
    const generated = [(await v.catalog.read("new.example.com/bot")).password];
    const all = outputs.join("\n");
    for (const secret of [PASSWORD, ...generated]) expect(all.includes(secret)).toBe(false);
    expect(all).not.toContain("password\":\"");
  });

  test("listings are rebuilt field by field: a password a service added to an entry is dropped", async () => {
    const STORED = "Zs4%someone-elses-stored-pw";
    const leaky: VaultCall = async (_method, path) => ({
      status: 200,
      data: path.startsWith("/api/agent/audit")
        ? { records: [{ ts: "2026-11-01T10:00:00Z", actor: "agent", action: "fill", name: "a.example/b", status: "filled", password: STORED, secret: STORED }] }
        : { entries: [{ name: "a.example/b", login: "b", url: "https://a.example", updated: "2026-11-01", match: "exact", password: STORED, extra: { deep: STORED } }], fillAllowed: true },
    });
    for (const [name, args] of [["vault_list", {}], ["vault_match", { url: "https://a.example/login" }], ["vault_audit", {}]] as const) {
      const r = await callTool(name, args, leaky);
      expect(JSON.stringify(r), name).not.toContain(STORED);
      expect(JSON.stringify(r), name).toContain("a.example/b");
    }
    const list = await callTool("vault_list", {}, leaky);
    expect(list.structuredContent).toEqual({ entries: [{ name: "a.example/b", login: "b", url: "https://a.example", updated: "2026-11-01", match: "exact" }] });
  });

  test("a password echoed by a misbehaving service is still scrubbed", async () => {
    const leaky: VaultCall = async () => ({ status: 200, data: { name: `x ${PASSWORD} y`, created: true, generated: false } });
    const r = await callTool("vault_save", { name: "a.example/b", login: "b", url: "https://a.example", password: PASSWORD }, leaky);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(r.content[0]!.text).toContain("[redacted]");
  });
});

/**
 * The real thing: ClawBox's own MCP server (mcp/clawbox-mcp.ts), the process
 * both runtimes start, spoken to over stdio, against a live vault service.
 */
const MCP_ENTRY = join(import.meta.dir, "../../mcp/clawbox-mcp.ts");
const VAULT_TOOLS = ["vault_list", "vault_match", "vault_fill", "vault_save", "vault_generate", "vault_delete", "vault_audit"];

interface Reply {
  id: number;
  result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }>; serverInfo?: { name: string } };
  error?: { code: number };
}

async function mcpSession(
  edition: "openclaw" | "hermes",
  env: Record<string, string>,
  requests: Array<Record<string, unknown>>,
  during: (id: number) => Promise<void> = async () => undefined,
): Promise<{ byId: Map<number, Reply>; stdout: string; stderr: string }> {
  const editionFile = join(store.root, `edition-${edition}.env`);
  await Bun.write(editionFile, `CLAWBOX_EDITION=${edition}\n`);
  const proc = Bun.spawn([process.execPath, "run", MCP_ENTRY], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: store.root,
      CLAWBOX_EDITION_FILE: editionFile,
      // Nothing answers here: the server starts without the web app, as the vault tools need none of it.
      CLAWBOX_API_BASE: "http://127.0.0.1:9",
      CLAWBOX_MCP_TOKEN: "not-a-real-bearer-0123456789",
      CLAWBOX_MCP_PROFILE: "full",
      CLAWBOX_MCP_IDLE_EXIT_MS: "0",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let stdout = "";
  let lines = 0;
  const all = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...requests,
  ];
  // Like a real client: send a request, wait for its reply, then the next.
  for (const r of all) {
    proc.stdin.write(`${JSON.stringify(r)}\n`);
    await proc.stdin.flush();
    if (!("id" in r)) continue;
    lines++;
    const side = during(r.id as number);
    const deadline = Date.now() + 25_000;
    while ((stdout.match(/\n/g)?.length ?? 0) < lines && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value);
    }
    await side;
  }
  proc.stdin.end();
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  const replies = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Reply);
  return { byId: new Map(replies.map((r) => [r.id, r])), stdout, stderr };
}

const textOf = (r: Reply | undefined) => r?.result?.content?.map((c) => c.text).join("\n") ?? "";

describe("ClawBox's MCP server over stdio against a live vault", () => {
  for (const edition of ["openclaw", "hermes"] as const) {
    test(`${edition}: the seven password tools, a login filled, and no password in anything the server wrote`, async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => v.app.fetch(req) });
      const site = `${edition}.example.com`;
      try {
        const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
        const { byId, stdout, stderr } = await mcpSession(
          edition,
          { CLAWBOX_VAULT_URL: `http://127.0.0.1:${server.port}`, CLAWBOX_VAULT_TOKEN_FILE: v.auth.mcpTokenFile },
          [
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            call(3, "vault_save", { name: `${site}/x`, login: "x", url: `https://${site}/login`, password: PASSWORD }),
            call(4, "vault_list", { query: site }),
            call(5, "vault_match", { url: `https://${site}/login` }),
            call(6, "vault_fill", { url: `https://${site}/login`, submit: true }),
            call(7, "vault_save", { name: `${site}/new`, login: "new", url: `https://${site}/join` }),
            call(8, "vault_generate", { name: `${site}/gen`, login: "gen", url: `https://${site}` }),
            call(9, "vault_audit", { limit: 50 }),
            call(10, "vault_cards_list", {}),
            call(11, "vault_delete", { name: `${site}/x`, confirm: true }),
          ],
          // The extension's half of the fill: it takes the command and reports back.
          (id) => (id === 6 ? extensionAnswers("filled") : Promise.resolve()),
        );
        expect(byId.get(1)!.result!.serverInfo!.name).toBe("clawbox");
        const names = byId.get(2)!.result!.tools!.map((t) => t.name);
        expect(names.filter((n) => n.startsWith("vault_"))).toEqual(VAULT_TOOLS);
        expect(textOf(byId.get(3))).toContain(`saved ${site}/x`);
        expect(textOf(byId.get(4))).toContain(`${site}/x`);
        expect(textOf(byId.get(5))).toContain("exact");
        expect(textOf(byId.get(6))).toContain(`filled (${site}/x)`);
        expect(textOf(byId.get(7))).toContain(`generated and stored as ${site}/new`);
        expect(textOf(byId.get(8))).toContain(`generated and stored as ${site}/gen`);
        expect(textOf(byId.get(9))).toContain("secret_released");
        // Cards are off: the tool is not there to call.
        expect(byId.get(10)!.error ?? byId.get(10)!.result!.isError).toBeTruthy();
        expect(textOf(byId.get(11))).toContain(`deleted ${site}/x`);

        // Every secret this session touched: the one given and the two the vault made.
        const made = [(await v.catalog.read(`${site}/new`)).password, (await v.catalog.read(`${site}/gen`)).password];
        expect(made.every((p) => p.length >= 20)).toBe(true);
        for (const secret of [PASSWORD, ...made, v.mcpToken]) {
          expect(stdout.includes(secret)).toBe(false);
          expect(stderr.includes(secret)).toBe(false);
        }
        expect(stdout).not.toContain('password\\":\\"');
      } finally {
        server.stop(true);
      }
    }, 90_000);
  }

  test("refuses a token file that others can read", async () => {
    const loose = join(store.root, "loose-token");
    await Bun.write(loose, `${v.mcpToken}\n`);
    Bun.spawnSync(["chmod", "644", loose]);
    const { byId, stdout } = await mcpSession("openclaw", { CLAWBOX_VAULT_URL: "http://127.0.0.1:9", CLAWBOX_VAULT_TOKEN_FILE: loose }, [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_list", arguments: {} } },
    ]);
    expect(byId.get(2)!.result!.isError).toBe(true);
    expect(textOf(byId.get(2))).toContain("readable by other users");
    expect(stdout).not.toContain(v.mcpToken);
  }, 60_000);

  test("sends the token to a loopback address only", async () => {
    const { byId } = await mcpSession("openclaw", { CLAWBOX_VAULT_URL: "http://vault.example.com:4796", CLAWBOX_VAULT_TOKEN_FILE: v.auth.mcpTokenFile }, [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_list", arguments: {} } },
    ]);
    expect(byId.get(2)!.result!.isError).toBe(true);
    expect(textOf(byId.get(2))).toContain("loopback");
  }, 60_000);
});
