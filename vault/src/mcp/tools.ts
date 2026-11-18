// The agent's ClawBox Vault tools. They call the vault service's agent API,
// which never returns a password, a card number or a security code; cards come
// back as label, brand, last 4 and expiry. As a second guard every response is
// scrubbed of any password the model itself passed in (vault_save), of every
// Luhn-valid 13–19 digit sequence and of every CVV next to its keyword.
//
// ClawBox's MCP server (mcp/tools/vault.ts) registers these for both runtimes
// and runs them through callTool. The two card tools are registered only when
// cards are switched on (CLAWBOX_VAULT_CARDS=1); they are off by default.
import { scrubCardData, scrubDeep } from "../shared/card";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Calls the vault service: returns HTTP status and parsed JSON. */
export type VaultCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; data: Record<string, unknown> }>;

const str = { type: "string" } as const;

export const TOOLS: ToolDef[] = [
  {
    name: "vault_list",
    title: "List vault entries",
    description: "List ClawBox Vault entries (name, login, url, updated date). Never returns passwords.",
    inputSchema: {
      type: "object",
      properties: { query: { ...str, description: "Optional filter on name, login or URL" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vault_match",
    title: "Match entries for a URL",
    description: "Entries whose site matches a page URL (same registrable domain; exact host first). Never returns passwords.",
    inputSchema: {
      type: "object",
      properties: { url: { ...str, description: "Page URL, e.g. https://billing.example.com/login" } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vault_fill",
    title: "Fill a login in Chrome",
    description:
      "Ask the ClawBox Vault Chrome extension to fill the saved login into the open tab for this URL. Open the login page first. " +
      "Returns only a status: filled, no_form, no_tab, origin_mismatch, no_entry, locked, extension_offline or timeout. " +
      "With submit=true the form is submitted; two-step logins (username page, then password page) are followed automatically.",
    inputSchema: {
      type: "object",
      properties: {
        url: { ...str, description: "URL of the login page open in Chrome" },
        name: { ...str, description: "Entry name; default: best match for the URL" },
        submit: { type: "boolean", description: "Click the form's submit button after filling", default: false },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "vault_save",
    title: "Save a login",
    description:
      "Create or update an entry. If password is omitted for a new entry, a strong password is generated and stored " +
      "(use this for new sign-ups, then vault_fill to type it). An existing entry keeps its password unless one is given " +
      "or regenerate=true. Returns the entry name only, never the password.",
    inputSchema: {
      type: "object",
      properties: {
        name: { ...str, description: "Entry name, '<site>/<account>', e.g. example.com/billing" },
        login: { ...str, description: "Username or email" },
        url: { ...str, description: "Login page URL" },
        password: { ...str, description: "Only if the user gave you one; otherwise omit" },
        note: { ...str, description: "Single-line note" },
        regenerate: { type: "boolean", description: "Replace an existing entry's password with a generated one" },
        length: { type: "integer", minimum: 8, maximum: 128, description: "Generated password length (default 24)" },
        symbols: { type: "boolean", description: "Use symbols in a generated password (default true)" },
      },
      required: ["name", "login", "url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "vault_generate",
    title: "Generate a password",
    description:
      "Generate a strong password without ever showing it. With name, it is stored in that entry and the result is " +
      "'generated and stored as <name>' (an existing entry needs overwrite=true). Without name nothing is saved and nothing secret is returned.",
    inputSchema: {
      type: "object",
      properties: {
        length: { type: "integer", minimum: 8, maximum: 128, description: "Length (default 24)" },
        symbols: { type: "boolean", description: "Include symbols (default true)" },
        name: { ...str, description: "Entry to store the new password in" },
        login: { ...str, description: "Login for a new entry" },
        url: { ...str, description: "URL for a new entry" },
        overwrite: { type: "boolean", description: "Replace the password of an existing entry (old one stays in pass git history)" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "vault_delete",
    title: "Delete an entry",
    description: "Delete a vault entry. Requires confirm=true. The pass git history still keeps it.",
    inputSchema: {
      type: "object",
      properties: { name: { ...str, description: "Entry name" }, confirm: { type: "boolean", description: "Must be true" } },
      required: ["name", "confirm"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "vault_audit",
    title: "Recent vault activity",
    description: "Recent vault actions (who, what, which entry, which site, result). Contains no secrets.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "How many records (default 20)" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vault_cards_list",
    title: "List payment cards",
    description:
      "List the payment cards in ClawBox Vault as label, brand, last 4 digits and expiry (MM/YY). " +
      "Never returns a card number, security code or cardholder.",
    inputSchema: {
      type: "object",
      properties: { query: { ...str, description: "Optional filter on label, brand or last 4" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vault_card_fill",
    title: "Fill a payment card in Chrome",
    description:
      "Ask the ClawBox Vault Chrome extension to fill a stored card into the checkout form of the open tab on this URL's origin " +
      "(https only). The human sees a confirmation window in the browser (site, card label, last 4) and the card is filled only " +
      "after they click Confirm. Returns only a status: filled, declined, timeout (nobody confirmed), no_form, no_tab, " +
      "origin_mismatch, no_entry, locked or extension_offline. It never submits or pays: click the pay button yourself afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        url: { ...str, description: "URL of the checkout page open in Chrome" },
        card: { ...str, description: "Card label or last 4 digits from vault_cards_list; default: the only valid card" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

export const CARD_TOOL_NAMES: readonly string[] = ["vault_cards_list", "vault_card_fill"];

/** The tools to register: the seven password tools, plus the two card tools when cards are on. */
export function toolsFor(cards: boolean): ToolDef[] {
  return cards ? TOOLS : TOOLS.filter((t) => !CARD_TOOL_NAMES.includes(t.name));
}

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function s(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Secrets the model itself passed in: a password, and any card number or code. */
function secretsOf(args: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const pw = s(args?.password);
  if (pw && pw.length >= 4) out.push(pw);
  for (const k of ["number", "cardNumber", "card_number", "pan", "cvv", "cvc", "csc", "securityCode", "security_code"]) {
    const v = args?.[k];
    if (typeof v === "string" || typeof v === "number") {
      const t = String(v).trim();
      if (t.length >= 3) out.push(t);
    }
  }
  return out;
}

export function scrub(result: ToolResult, secrets: string[]): ToolResult {
  const clean = (t: string) => scrubCardData(t, secrets);
  return {
    ...result,
    content: result.content.map((c) => ({ ...c, text: clean(c.text) })),
    ...(result.structuredContent ? { structuredContent: scrubDeep(result.structuredContent, clean) } : {}),
  };
}

/**
 * A login as the agent sees it, rebuilt field by field: whatever else a
 * service might send (the real one sends nothing else) is dropped here, so a
 * password field can never ride along in a listing.
 */
function entryView(e: unknown): Record<string, string> {
  const src = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ["name", "login", "url", "updated", "match"]) {
    if (typeof src[k] === "string" && src[k] !== "") out[k] = src[k] as string;
  }
  return out;
}

/** An activity record, the same way: the audit log's own fields and nothing else. */
function auditView(r: unknown): Record<string, string> {
  const src = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ["ts", "actor", "action", "name", "host", "status", "detail"]) {
    if (typeof src[k] === "string" && src[k] !== "") out[k] = src[k] as string;
  }
  return out;
}

function listOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function apiError(status: number, data: Record<string, unknown>): ToolResult {
  const msg = typeof data.error === "string" ? data.error : `HTTP ${status}`;
  if (status === 401) return fail(`ClawBox Vault rejected the agent token (${msg}). Restarting the vault service makes a new one.`);
  return fail(`ClawBox Vault: ${msg}`);
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  call: VaultCall,
  opts: { cards?: boolean } = {},
): Promise<ToolResult> {
  if (!opts.cards && CARD_TOOL_NAMES.includes(name)) return fail(`unknown tool ${name}`);
  const result = await runTool(name, args ?? {}, call);
  return scrub(result, secretsOf(args));
}

async function runTool(name: string, a: Record<string, unknown>, call: VaultCall): Promise<ToolResult> {
  switch (name) {
    case "vault_list": {
      const q = s(a.query);
      const r = await call("GET", `/api/agent/entries${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      if (r.status !== 200) return apiError(r.status, r.data);
      const entries = listOf(r.data.entries).map(entryView);
      return ok(entries.length ? JSON.stringify(entries, null, 2) : "No entries.", { entries });
    }
    case "vault_match": {
      const url = s(a.url);
      if (!url) return fail("url is required");
      const r = await call("GET", `/api/agent/match?url=${encodeURIComponent(url)}`);
      if (r.status !== 200) return apiError(r.status, r.data);
      const entries = listOf(r.data.entries).map(entryView);
      const note = r.data.fillAllowed ? "" : "\nNote: this URL is not https:// (or localhost), so it will not be filled.";
      return ok((entries.length ? JSON.stringify(entries, null, 2) : "No entry matches this URL.") + note, {
        entries,
        fillAllowed: Boolean(r.data.fillAllowed),
      });
    }
    case "vault_fill": {
      const url = s(a.url);
      if (!url) return fail("url is required");
      const r = await call("POST", "/api/agent/fill", { url, ...(s(a.name) ? { name: a.name } : {}), submit: a.submit === true });
      if (r.status !== 200) return apiError(r.status, r.data);
      const { status, name: entry, detail } = r.data as { status: string; name?: string; detail?: string };
      const text = `${status}${entry ? ` (${entry})` : ""}${detail ? `: ${detail}` : ""}`;
      return { ...ok(text, { status, ...(entry ? { name: entry } : {}), ...(detail ? { detail } : {}) }), isError: status === "error" };
    }
    case "vault_save": {
      // Omitted fields stay as they are on an existing entry.
      const body: Record<string, unknown> = { name: a.name };
      for (const k of ["login", "url", "password", "note", "regenerate", "length", "symbols"]) if (a[k] !== undefined) body[k] = a[k];
      const r = await call("POST", "/api/agent/save", body);
      if (r.status !== 200) return apiError(r.status, r.data);
      const d = r.data as { name: string; created: boolean; generated: boolean };
      const text = d.generated ? `generated and stored as ${d.name}` : `${d.created ? "saved" : "updated"} ${d.name}`;
      return ok(text, { name: d.name, created: d.created, generated: d.generated });
    }
    case "vault_generate": {
      const body: Record<string, unknown> = {};
      for (const k of ["length", "symbols", "name", "login", "url", "overwrite"]) if (a[k] !== undefined) body[k] = a[k];
      const r = await call("POST", "/api/agent/generate", body);
      if (r.status !== 200) return apiError(r.status, r.data);
      const d = r.data as { stored: boolean; name?: string; length: number; symbols: boolean; entropyBits?: number };
      if (d.stored) return ok(`generated and stored as ${d.name}`, { stored: true, name: d.name });
      return ok(
        `Nothing was generated or stored: passwords are never shown to the agent. A ${d.length}-character password ` +
          `(${d.entropyBits} bits) is generated when you call vault_generate with name, or vault_save without password.`,
        { stored: false, length: d.length, symbols: d.symbols },
      );
    }
    case "vault_delete": {
      if (a.confirm !== true) return fail("Refusing to delete without confirm: true.");
      const r = await call("POST", "/api/agent/delete", { name: a.name, confirm: true });
      if (r.status !== 200) return apiError(r.status, r.data);
      return ok(`deleted ${String(a.name)}`, { deleted: String(a.name) });
    }
    case "vault_audit": {
      const limit = typeof a.limit === "number" ? Math.min(200, Math.max(1, Math.floor(a.limit))) : 20;
      const r = await call("GET", `/api/agent/audit?limit=${limit}`);
      if (r.status !== 200) return apiError(r.status, r.data);
      const records = listOf(r.data.records).map(auditView);
      return ok(records.length ? JSON.stringify(records, null, 2) : "No activity yet.", { records });
    }
    case "vault_cards_list": {
      const q = s(a.query);
      const r = await call("GET", `/api/agent/cards${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      if (r.status !== 200) return apiError(r.status, r.data);
      // Rebuilt field by field: whatever else a service might send is dropped.
      const cards = ((r.data.cards as Array<Record<string, unknown>>) ?? []).map((c) => ({
        label: String(c.label ?? ""),
        brand: String(c.brand ?? ""),
        last4: String(c.last4 ?? "").slice(-4),
        exp: String(c.exp ?? ""),
      }));
      const text = cards.length ? cards.map((c) => `${c.label}: ${c.brand} •••• ${c.last4}, exp ${c.exp}`).join("\n") : "No cards stored.";
      return ok(text, { cards });
    }
    case "vault_card_fill": {
      const url = s(a.url);
      if (!url) return fail("url is required");
      const r = await call("POST", "/api/agent/card-fill", { url, ...(s(a.card) ? { card: a.card } : {}) });
      if (r.status !== 200) return apiError(r.status, r.data);
      const d = r.data as { status: string; detail?: string; card?: Record<string, unknown> };
      const card = d.card
        ? { label: String(d.card.label ?? ""), brand: String(d.card.brand ?? ""), last4: String(d.card.last4 ?? "").slice(-4), exp: String(d.card.exp ?? "") }
        : undefined;
      const text = `${d.status}${card ? ` (${card.label} •••• ${card.last4})` : ""}${d.detail ? `: ${d.detail}` : ""}`;
      return {
        ...ok(text, { status: d.status, ...(card ? { card } : {}), ...(d.detail ? { detail: d.detail } : {}) }),
        isError: d.status === "error",
      };
    }
  }
  return fail(`unknown tool ${name}`);
}
