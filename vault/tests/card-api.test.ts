// Cards through the API and the MCP tools, on a temporary pass store and
// GnuPG home: metadata never carries the number or the CVV, reveal needs the
// PIN session, cards never show up as logins, agent card fills run only after
// the human's confirmation, and nothing secret reaches the MCP replies, the
// audit log, the request log, the state files or the catalog cache.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { callTool, type VaultCall } from "../src/mcp/tools";
import { createTempStore, passShow, passShowExitCode, type TempStore } from "./helpers/tempstore";
import { createTestVault, EXT_ORIGIN, pairExtension, type TestVault } from "./helpers/vault";

const NUMBER = "4242424242424242";
const CVV = "737";
const AMEX = "378282246310005";
const AMEX_CVV = "8491";
const SECRETS = [NUMBER, AMEX, "4242 4242 4242 4242"];

let store: TempStore;
let v: TestVault;
let ui = "";
let ext = "";
/** Every response body except the two that legitimately carry a card (reveal, card-secret). */
const plainReplies: string[] = [];
const consoleLines: string[] = [];
const originalLog = console.log;
const originalError = console.error;

async function req(path: string, init: Parameters<TestVault["request"]>[1] = {}, opts: { secret?: boolean } = {}) {
  const res = await v.request(path, init);
  const text = await res.text();
  if (!opts.secret) plainReplies.push(text);
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const asUi = (path: string, init: Parameters<TestVault["request"]>[1] = {}, opts: { secret?: boolean } = {}) => req(path, { ...init, token: ui }, opts);
const asExt = (path: string, init: Parameters<TestVault["request"]>[1] = {}, opts: { secret?: boolean } = {}) =>
  req(path, { ...init, token: ext, origin: EXT_ORIGIN }, opts);
const asAgent = (path: string, init: Parameters<TestVault["request"]>[1] = {}) => req(path, { ...init, token: v.mcpToken });

const mcpCall: VaultCall = async (method, path, body) => {
  const r = await asAgent(path, { method, ...(body !== undefined ? { body } : {}) });
  return { status: r.status, data: r.body };
};

/** Plays the extension and the human for the next card command. */
async function humanAnswers(decision: "confirm" | "decline" | "ignore"): Promise<{ command: Record<string, any> | undefined; secretStatusBeforeConfirm?: number }> {
  const polled = await asExt("/api/ext/commands?wait=2000");
  const command = (polled.body.commands as Array<Record<string, any>>)[0];
  if (!command) return { command };
  const early = await asExt("/api/ext/card-secret", { body: { commandId: command.id } }, { secret: true });
  const earlyReport = await asExt("/api/ext/result", { body: { id: command.id, status: "filled" } });
  expect(earlyReport.status).toBe(404); // cannot claim "filled" before the human confirmed
  if (decision === "ignore") return { command, secretStatusBeforeConfirm: early.status };
  const d = await asExt("/api/ext/card-decision", { body: { id: command.id, decision } });
  expect(d.status).toBe(200);
  if (decision === "confirm") {
    const secret = await asExt("/api/ext/card-secret", { body: { commandId: command.id } }, { secret: true });
    expect(secret.status).toBe(200);
    expect(secret.body.number).toBe(NUMBER);
    const again = await asExt("/api/ext/card-secret", { body: { commandId: command.id } }, { secret: true });
    expect(again.status).toBe(404); // released once
    await asExt("/api/ext/result", { body: { id: command.id, status: "filled", detail: "filled number, expiry, name" } });
  }
  return { command, secretStatusBeforeConfirm: early.status };
}

beforeAll(async () => {
  console.log = (...a: unknown[]) => consoleLines.push(a.join(" "));
  console.error = (...a: unknown[]) => consoleLines.push(a.join(" "));
  store = createTempStore();
  v = await createTestVault(store, { cardConfirmMs: 1_500, fillTimeoutMs: 3_000, cards: true });
  ({ ui, ext } = await pairExtension(v));
  // A login, to show cards and logins stay apart.
  await asUi("/api/ui/entries", { body: { name: "shop.example.com/jane", login: "jane@example.com", url: "https://shop.example.com/login", password: "Login-Pw-31!x", create: true } });
}, 60_000);

afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
  store?.cleanup();
});

describe("storage and validation", () => {
  test("the desktop app adds a card; the pass entry has the documented format", async () => {
    const r = await asUi("/api/ui/cards", { body: { label: "Company Visa", number: "4242 4242 4242 4242", cardholder: "Jane Q Doe", exp: "12/34", cvv: CVV, note: "travel" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "cards/company-visa", created: true, card: { label: "Company Visa", brand: "visa", last4: "4242", exp: "12/34", cardholder: "Jane Q Doe" } });
    expect(passShow(store, "cards/company-visa")).toBe(`${NUMBER}\nname: Jane Q Doe\nexp: 12/34\ncvv: ${CVV}\nlabel: Company Visa\nnote: travel\n`);
    const amex = await asUi("/api/ui/cards", { body: { number: AMEX, exp: "01/30", cvv: AMEX_CVV, cardholder: "J Doe" } });
    expect(amex.body).toMatchObject({ name: "cards/american-express-0005", card: { label: "American Express 0005", brand: "amex" } });
  });

  test("Luhn, expiry and CVV are checked on save; errors never quote the input", async () => {
    const bad = [
      { number: "4242424242424241", exp: "12/34" },
      { number: NUMBER, exp: "01/20" },
      { number: NUMBER, exp: "13/34" },
      { number: NUMBER, exp: "12/34", cvv: "12345" },
      { number: AMEX, exp: "12/34", cvv: "123" },
      { number: NUMBER, exp: "12/34", label: `card ${NUMBER}` },
    ];
    for (const body of bad) {
      const r = await asUi("/api/ui/cards", { body });
      expect({ body: body.number.slice(-4), status: r.status }).toEqual({ body: body.number.slice(-4), status: 400 });
      expect(JSON.stringify(r.body)).not.toContain(body.number);
    }
  });

  test("an edit keeps the number and the unknown lines; a label change renames the entry", async () => {
    await v.cards.store.insert("cards/company-visa", `${passShow(store, "cards/company-visa")}pin-hint: ask finance\n`);
    const r = await asUi("/api/ui/cards", { body: { originalName: "cards/company-visa", label: "Travel Visa", exp: "11/33" } });
    expect(r.body).toMatchObject({ name: "cards/travel-visa", created: false, card: { last4: "4242", exp: "11/33" } });
    expect(passShowExitCode(store, "cards/company-visa")).not.toBe(0);
    const text = passShow(store, "cards/travel-visa");
    expect(text.split("\n")[0]).toBe(NUMBER);
    expect(text).toContain(`cvv: ${CVV}`);
    expect(text).toContain("pin-hint: ask finance");
  });

  test("a card whose name has a collision suffix keeps its name when edited", async () => {
    const a = await asUi("/api/ui/cards", { body: { label: "Dup Card", number: "4000056655665556", exp: "12/34" } });
    const b = await asUi("/api/ui/cards", { body: { label: "Dup Card", number: "2223003122003222", exp: "12/34" } });
    expect([a.body.name, b.body.name]).toEqual(["cards/dup-card", "cards/dup-card-2"]);
    const edited = await asUi("/api/ui/cards", { body: { originalName: "cards/dup-card-2", label: "Dup Card", note: "edited" } });
    expect(edited.body.name).toBe("cards/dup-card-2");
    expect(passShowExitCode(store, "cards/dup-card-2")).toBe(0);
    expect(passShowExitCode(store, "cards/dup-card-3")).not.toBe(0);
    for (const name of ["cards/dup-card", "cards/dup-card-2"]) expect((await asUi(`/api/ui/card?name=${name}`, { method: "DELETE" })).status).toBe(200);
  });
});

describe("metadata only", () => {
  test("lists and details carry label, brand, last 4, expiry and cardholder; never the number or CVV", async () => {
    const lists = [await asUi("/api/ui/cards"), await asExt("/api/ext/cards"), await asUi("/api/ui/card?name=cards/travel-visa")];
    for (const l of lists) {
      expect(l.status).toBe(200);
      const raw = JSON.stringify(l.body);
      for (const s of [...SECRETS, CVV, AMEX_CVV]) expect(raw.includes(s)).toBe(false);
      expect(raw).not.toMatch(/"(number|cvv)"/);
    }
    expect(lists[2]!.body).toMatchObject({ label: "Travel Visa", last4: "4242", hasCvv: true, extraLines: 1 });
  });

  test("the agent gets exactly label, brand, last 4 and expiry", async () => {
    const r = await asAgent("/api/agent/cards");
    expect(r.body.cards).toEqual([
      { label: "American Express 0005", brand: "amex", last4: "0005", exp: "01/30" },
      { label: "Travel Visa", brand: "visa", last4: "4242", exp: "11/33" },
    ]);
  });

  test("the card cache holds no number and no CVV", async () => {
    const cache = (v.cards as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBeGreaterThan(0);
    const snapshot = JSON.stringify([...cache.entries()]);
    for (const s of [NUMBER, AMEX, CVV, AMEX_CVV]) expect(snapshot.includes(s)).toBe(false);
  });

  test("cards never appear in login lists, matches or fills, and login routes refuse card names", async () => {
    for (const path of ["/api/ui/entries"]) expect(JSON.stringify((await asUi(path)).body)).not.toContain("cards/");
    for (const path of ["/api/ext/entries", "/api/ext/match?url=https%3A%2F%2Fshop.example.com%2F"]) expect(JSON.stringify((await asExt(path)).body)).not.toContain("cards/");
    expect(JSON.stringify((await asAgent("/api/agent/entries")).body)).not.toContain("cards/");
    expect((await asExt("/api/ext/secret", { body: { name: "cards/travel-visa", purpose: "copy" } })).status).toBe(400);
    expect((await asExt("/api/ext/secret", { body: { name: "cards/travel-visa", purpose: "fill", pageUrl: "https://shop.example.com/" } })).status).toBe(400);
    expect((await asUi("/api/ui/reveal", { body: { name: "cards/travel-visa" } })).status).toBe(400);
    expect((await asUi("/api/ui/entry?name=cards/travel-visa")).status).toBe(400);
    expect((await asAgent("/api/agent/delete", { body: { name: "cards/travel-visa", confirm: true } })).status).toBe(400);
    expect((await asAgent("/api/agent/fill", { body: { url: "https://shop.example.com/", name: "cards/travel-visa" } })).status).toBe(400);
    expect((await asExt("/api/ext/save", { body: { name: "cards/x", login: "a", password: NUMBER } })).status).toBe(400);
    expect(passShowExitCode(store, "cards/travel-visa")).toBe(0);
    expect((await v.catalog.list()).map((e) => e.name)).toEqual(["shop.example.com/jane"]);
  });
});

describe("reveal and fill need their session", () => {
  test("reveal needs the PIN session: no token, the extension token or the agent token get 401", async () => {
    const body = { name: "cards/travel-visa", field: "number" };
    expect((await req("/api/ui/card-reveal", { body })).status).toBe(401);
    expect((await req("/api/ui/card-reveal", { body, token: ext, origin: EXT_ORIGIN })).status).toBe(401);
    expect((await req("/api/ui/card-reveal", { body, token: v.mcpToken })).status).toBe(401);
    const number = await asUi("/api/ui/card-reveal", { body }, { secret: true });
    expect(number.body).toEqual({ value: NUMBER });
    const cvv = await asUi("/api/ui/card-reveal", { body: { ...body, field: "cvv", purpose: "copy" } }, { secret: true });
    expect(cvv.body).toEqual({ value: CVV });
    // After the UI session ends, reveal is refused again.
    const fresh = (await req("/api/ui/unlock", { body: { pin: "correct horse 42" } })).body.token as string;
    await req("/api/ui/lock", { body: {}, token: fresh });
    expect((await req("/api/ui/card-reveal", { body, token: fresh })).status).toBe(401);
  });

  test("the extension gets a card only for an https page (http only on localhost), and only while unlocked", async () => {
    expect((await asExt("/api/ext/card-secret", { body: { name: "cards/travel-visa", pageUrl: "http://shop.example.com/checkout" } }, { secret: true })).status).toBe(403);
    const ok = await asExt("/api/ext/card-secret", { body: { name: "cards/travel-visa", pageUrl: "https://shop.example.com/checkout", via: "chip" } }, { secret: true });
    expect(ok.body).toEqual({ name: "cards/travel-visa", number: NUMBER, cardholder: "Jane Q Doe", exp: "11/33", cvv: CVV, brand: "visa" });
    expect((await asExt("/api/ext/card-secret", { body: { name: "cards/travel-visa", pageUrl: "http://localhost:8080/checkout" } }, { secret: true })).status).toBe(200);
    await asExt("/api/ext/lock", { body: {} });
    expect((await asExt("/api/ext/card-secret", { body: { name: "cards/travel-visa", pageUrl: "https://shop.example.com/" } }, { secret: true })).status).toBe(423);
    await asExt("/api/ext/unlock", { body: { pin: "correct horse 42" } });
  });

  test("save bar check: same card, changed expiry, new card; stored only on save", async () => {
    const url = "https://shop.example.com/checkout";
    expect((await asExt("/api/ext/card-check", { body: { url, number: NUMBER, exp: "11/33" } })).body).toEqual({ kind: "same", name: "cards/travel-visa" });
    expect((await asExt("/api/ext/card-check", { body: { url, number: NUMBER, exp: "10/35" } })).body).toMatchObject({ kind: "update", name: "cards/travel-visa", last4: "4242" });
    const fresh = "5555555555554444";
    expect((await asExt("/api/ext/card-check", { body: { url, number: fresh, exp: "05/29" } })).body).toEqual({ kind: "new", suggestedLabel: "Mastercard 4444", brand: "mastercard", last4: "4444", exp: "05/29" });
    expect((await asExt("/api/ext/card-check", { body: { url: "http://shop.example.com/", number: fresh, exp: "05/29" } })).body).toEqual({ kind: "ignore" });
    expect((await asExt("/api/ext/card-check", { body: { url, number: "4242424242424241", exp: "05/29" } })).body).toEqual({ kind: "ignore" });
    expect((await asUi("/api/ui/cards")).body.cards).toHaveLength(2); // checking stores nothing
    const saved = await asExt("/api/ext/card-save", { body: { mode: "create", label: "Shop Mastercard", number: fresh, exp: "05/29", cardholder: "Jane Q Doe", url } });
    expect(saved.body).toMatchObject({ name: "cards/shop-mastercard", created: true });
    expect(passShow(store, "cards/shop-mastercard")).not.toContain("cvv:");
    const wrong = await asExt("/api/ext/card-save", { body: { mode: "update", name: "cards/shop-mastercard", number: NUMBER, exp: "06/30" } });
    expect(wrong.status).toBe(409);
    const upd = await asExt("/api/ext/card-save", { body: { mode: "update", name: "cards/shop-mastercard", number: fresh, exp: "06/30", cvv: "321" } });
    expect(upd.body).toMatchObject({ created: false, card: { exp: "06/30" } });
    await asUi("/api/ui/card?name=cards/shop-mastercard", { method: "DELETE" });
    expect(passShowExitCode(store, "cards/shop-mastercard")).not.toBe(0);
  });
});

describe("agent card fill: only after the human confirms", () => {
  test("declined: the agent gets declined, the card is never released", async () => {
    const [result, human] = await Promise.all([
      asAgent("/api/agent/card-fill", { body: { url: "https://shop.example.com/checkout", card: "Travel Visa" } }),
      humanAnswers("decline"),
    ]);
    expect(human.command).toMatchObject({ kind: "card", card: { label: "Travel Visa", brand: "visa", last4: "4242", exp: "11/33" } });
    expect(JSON.stringify(human.command)).not.toContain(NUMBER);
    expect(human.secretStatusBeforeConfirm).toBe(404);
    expect(result.body).toMatchObject({ status: "declined", card: { label: "Travel Visa", last4: "4242" } });
    expect(result.body.name).toBeUndefined();
  });

  test("confirmed: the extension gets the card once, the agent gets filled", async () => {
    const [result] = await Promise.all([asAgent("/api/agent/card-fill", { body: { url: "https://shop.example.com/checkout", card: "4242" } }), humanAnswers("confirm")]);
    expect(result.body).toEqual({ status: "filled", detail: "filled number, expiry, name", card: { label: "Travel Visa", brand: "visa", last4: "4242", exp: "11/33" } });
  });

  test("nobody answers: timeout", async () => {
    const [result, human] = await Promise.all([asAgent("/api/agent/card-fill", { body: { url: "https://shop.example.com/checkout", card: "Travel Visa" } }), humanAnswers("ignore")]);
    expect(human.secretStatusBeforeConfirm).toBe(404);
    expect(result.body).toMatchObject({ status: "timeout", detail: "nobody confirmed the card fill in the browser" });
  });

  test("statuses without a browser: http, unknown card, ambiguous choice, locked", async () => {
    expect((await asAgent("/api/agent/card-fill", { body: { url: "http://shop.example.com/checkout" } })).body.status).toBe("origin_mismatch");
    expect((await asAgent("/api/agent/card-fill", { body: { url: "https://shop.example.com/", card: "Nope" } })).body.status).toBe("no_entry");
    const ambiguous = await asAgent("/api/agent/card-fill", { body: { url: "https://shop.example.com/" } });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain("2 cards are stored");
    await asExt("/api/ext/lock", { body: {} });
    expect((await asAgent("/api/agent/card-fill", { body: { url: "https://shop.example.com/", card: "Travel Visa" } })).body.status).toBe("locked");
    await asExt("/api/ext/unlock", { body: { pin: "correct horse 42" } });
  });
});

describe("MCP card tools", () => {
  const outputs: string[] = [];
  const run = async (name: string, args: Record<string, unknown> = {}, call: VaultCall = mcpCall) => {
    const r = await callTool(name, args, call, { cards: true });
    outputs.push(JSON.stringify(r));
    return r;
  };

  test("vault_cards_list and vault_card_fill return label, brand, last 4, expiry and a status only", async () => {
    const list = await run("vault_cards_list");
    expect(list.structuredContent).toEqual({
      cards: [
        { label: "American Express 0005", brand: "amex", last4: "0005", exp: "01/30" },
        { label: "Travel Visa", brand: "visa", last4: "4242", exp: "11/33" },
      ],
    });
    expect(list.content[0]!.text).toBe("American Express 0005: amex •••• 0005, exp 01/30\nTravel Visa: visa •••• 4242, exp 11/33");
    const [filled] = await Promise.all([run("vault_card_fill", { url: "https://shop.example.com/checkout", card: "Travel Visa" }), humanAnswers("confirm")]);
    expect(filled.content[0]!.text).toBe("filled (Travel Visa •••• 4242): filled number, expiry, name");
    const [declined] = await Promise.all([run("vault_card_fill", { url: "https://shop.example.com/checkout", card: "0005" }), humanAnswers("decline")]);
    expect(declined.structuredContent).toMatchObject({ status: "declined", card: { label: "American Express 0005", last4: "0005" } });
    for (const s of [...SECRETS, CVV, AMEX_CVV, "Jane Q Doe"]) expect(outputs.join("\n").includes(s)).toBe(false);
  });

  test("a misbehaving service that echoes a card is scrubbed (number, CVV, extra fields dropped)", async () => {
    const leaky: VaultCall = async () => ({
      status: 200,
      data: { cards: [{ label: `Visa ${NUMBER}`, brand: "visa", last4: "4242", exp: "12/34", number: NUMBER, cvv: CVV }], status: "filled", detail: `typed 4242 4242 4242 4242, cvv: ${CVV}` },
    });
    const list = await run("vault_cards_list", {}, leaky);
    expect(JSON.stringify(list)).not.toContain(NUMBER);
    expect(JSON.stringify(list)).not.toContain(CVV);
    expect(list.structuredContent).toEqual({ cards: [{ label: "Visa [redacted]", brand: "visa", last4: "4242", exp: "12/34" }] });
    const fill = await run("vault_card_fill", { url: "https://shop.example.com/" }, leaky);
    expect(fill.content[0]!.text).toBe("filled: typed [redacted], cvv: [redacted]");
    // A number or code the model itself passed in is scrubbed from any tool's reply.
    const echo: VaultCall = async () => ({ status: 200, data: { name: `x ${CVV} y`, created: true, generated: false } });
    const r = await callTool("vault_save", { name: "a.example/b", login: "b", url: "https://a.example", cvv: CVV }, echo);
    expect(JSON.stringify(r)).not.toContain(CVV);
  });
});

describe("audit and logs", () => {
  test("card actions are audited with label and last 4 only", async () => {
    await asUi("/api/ui/card?name=cards/american-express-0005", { method: "DELETE" });
    const records = (await asAgent("/api/agent/audit?limit=200")).body.records as Array<Record<string, string>>;
    const card = records.filter((r) => r.action?.startsWith("card_"));
    const key = (r: Record<string, string>) => [r.actor, r.action, r.status ?? ""].join(":");
    const keys = new Set(card.map(key));
    for (const k of [
      "ui:card_add:",
      "ui:card_edit:",
      "ui:card_delete:",
      "ui:card_reveal:",
      "ui:card_copy:",
      "extension:card_fill:",
      "extension:card_add:",
      "extension:card_agent_fill:confirmed",
      "extension:card_agent_fill:declined",
      "agent:card_agent_fill:filled",
      "agent:card_agent_fill:declined",
      "agent:card_agent_fill:timeout",
    ]) {
      expect({ k, found: keys.has(k) }).toEqual({ k, found: true });
    }
    const reveal = card.find((r) => r.action === "card_reveal")!;
    expect(reveal).toMatchObject({ name: "cards/travel-visa", detail: "Travel Visa •••• 4242 (number)" });
    for (const r of card) {
      const { ts: _ts, ...rest } = r;
      const text = JSON.stringify(rest);
      for (const s of [...SECRETS, "Jane Q Doe"]) expect(text.includes(s)).toBe(false);
      for (const value of Object.values(rest)) expect([CVV, AMEX_CVV, "321"].some((c) => String(value).includes(c))).toBe(false);
    }
  });

  test("the audit log redacts a card number even if a caller passed one", () => {
    v.audit.record({ actor: "system", action: "test", detail: `oops ${NUMBER} cvv: ${CVV}` });
    const last = v.audit.recent(1)[0]!;
    expect(last.detail).toBe("oops [redacted] cvv: [redacted]");
  });

  test("grep: no number or CVV in request logs, console, plain replies, config files or the store", async () => {
    // A card number in a request path is redacted in the request log.
    await req(`/api/ui/card/${NUMBER}`, { token: ui });
    const haystacks: Record<string, string> = { "service log": v.logs.join("\n"), console: consoleLines.join("\n"), "plain replies": plainReplies.join("\n") };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const s of SECRETS) expect({ where, s: s.slice(-4), found: text.includes(s) }).toEqual({ where, s: s.slice(-4), found: false });
      expect({ where, cvv: /cvv"?\s*[:=]\s*"?\d{3,4}/i.test(text) }).toEqual({ where, cvv: false });
    }
    for (const s of [NUMBER, AMEX]) {
      for (const dir of [store.configDir, store.storeDir]) {
        expect(Bun.spawnSync(["grep", "-rF", "--", s, dir]).exitCode).toBe(1);
      }
    }
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [d.name]));
    expect(files(store.configDir).sort()).toEqual(["agent-token", "audit.jsonl", "state.json"]);
  });
});
