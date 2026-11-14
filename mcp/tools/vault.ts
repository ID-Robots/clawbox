// ClawBox Vault: the box's password manager, as the agent sees it.
//
// THE RULE: NO PASSWORD EVER REACHES THE AGENT. Not in a result, not in an
// error, not in a log. The tools talk to the vault service's agent API
// (vault/src/server/app.ts, /api/agent/*), which has no route that returns a
// password: listing answers names, logins and sites; a fill is carried out by
// the browser extension, which fetches the password for that one fill and
// types it into the page, and the tool gets a status word back. What each tool
// says is built in vault/src/mcp/tools.ts, which also scrubs any password the
// model itself passed in (vault_save) out of the reply, whatever a service
// answered. The registrar's own credential pass runs after that.
//
// BOTH EDITIONS, FULL PROFILE ONLY. The vault is ClawBox's own service, the
// same on OpenClaw and Hermes. It is not on the trimmed `core` surface, and
// not in a delegated coding run's servers: a run is handed the assets it
// needs, never the owner's list of accounts. That is why NO tool here declares
// `readOnly`, the three that only read included: a run's `run-read` server
// registers every tool that declares it (src/lib/clawbox-run-read-tools.ts),
// and "a tool that declares nothing is a write as far as a run is concerned"
// is exactly the treatment the vault wants.
//
// CARDS ARE OFF. The two card tools exist in the vault module and are
// registered only when CLAWBOX_VAULT_CARDS=1, which no install sets; the
// service answers 404 on every card route without it.
//
// THE TOKEN. The service writes a random token to <vault home>/agent-token
// (mode 600) and accepts it only without a browser Origin. It is read on every
// call, so a rotated token needs no restart here, and it is refused when group
// or others can read it. It is only ever sent to a loopback address.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { callTool, type VaultCall } from "../../vault/src/mcp/tools";
import { ToolError } from "../lib/errors";
import { LIST_MAX_CHARS, type Registrar, type ToolResult } from "../lib/register";
import { zBool, zConfirm, zInt, zOptText, zText, type Shape } from "../lib/schema";

const DEFAULT_PORT = 4796;
/** A fill waits for the browser (20 s in the service); a card fill also for the human's click. */
const FILL_TIMEOUT_MS = 45_000;
const CARD_FILL_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 15_000;

const SET_UP_NEXT =
  "Tell the user to open ClawBox Vault on the ClawBox desktop and choose a vault PIN. Do not retry until they say it is done.";

/** Is the card half switched on for this install? Off unless the owner's unit says otherwise. */
type Env = Record<string, string | undefined>;

export function vaultCardsEnabled(env: Env = process.env): boolean {
  return env.CLAWBOX_VAULT_CARDS === "1";
}

/** The vault service's address. Loopback only: the token must never leave the box. */
export function vaultServiceUrl(env: Env = process.env): string {
  const raw = (env.CLAWBOX_VAULT_URL || `http://127.0.0.1:${env.CLAWBOX_VAULT_PORT || DEFAULT_PORT}`).replace(/\/+$/, "");
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(raw)) {
    throw new ToolError("INTERNAL", "ClawBox Vault's address is not a loopback address.", "Tell the user; do not retry.");
  }
  return raw;
}

export function vaultTokenFile(env: Env = process.env): string {
  if (env.CLAWBOX_VAULT_TOKEN_FILE) return env.CLAWBOX_VAULT_TOKEN_FILE;
  const home = env.CLAWBOX_VAULT_CONFIG_DIR || env.CLAWBOX_VAULT_HOME || path.join(env.HOME || homedir(), ".clawbox-vault");
  return path.join(home, "agent-token");
}

function readToken(): string {
  const file = vaultTokenFile();
  let token: string;
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      throw new ToolError("AUTH_FAILED", "ClawBox Vault's agent token is readable by other users, so it is not used.", "Tell the user; do not retry.");
    }
    token = readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err instanceof ToolError) throw err;
    // No file: the service has never started on this box.
    throw new ToolError("ENDPOINT_DOWN", "ClawBox Vault is not running on this box.", "Tell the user the vault service is not running. Do not retry in a loop.");
  }
  if (token.length < 16) {
    throw new ToolError("AUTH_FAILED", "ClawBox Vault's agent token is empty.", "Tell the user; restarting the vault service makes a new one.");
  }
  return token;
}

/**
 * One request to the vault's agent API. The answers every tool would word the
 * same way are turned into the server's error envelope here; everything else
 * goes back to the vault module, which knows what its own statuses mean.
 */
function vaultCall(timeoutMs: number): VaultCall {
  return async (method, apiPath, body) => {
    const service = vaultServiceUrl();
    const token = readToken();
    let res: Response;
    try {
      res = await fetch(`${service}${apiPath}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ToolError("TIMEOUT", "ClawBox Vault did not answer in time.", "Try once more; if it times out again, tell the user.");
      }
      throw new ToolError("ENDPOINT_DOWN", "ClawBox Vault is not answering on this box.", "Tell the user the vault service is not running. Do not retry in a loop.");
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 409 && data.code === "not_set_up") {
      throw new ToolError("CONFLICT", "ClawBox Vault is not set up yet: the owner has not chosen a vault PIN.", SET_UP_NEXT);
    }
    if (res.status === 503) {
      throw new ToolError("ENDPOINT_DOWN", "ClawBox Vault's password store is not available on this box.", "Tell the user to open ClawBox Vault on the desktop: it says what is missing.");
    }
    return { status: res.status, data };
  };
}

/** The vault module's result as this server returns it: the text and whether it is an error. */
async function run(name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<ToolResult> {
  const result = await callTool(name, args, vaultCall(timeoutMs), { cards: vaultCardsEnabled() });
  return { content: result.content, ...(result.isError ? { isError: true } : {}) };
}

const ENTRY_NAME = "Entry name, '<site>/<account>', e.g. example.com/billing";

export function registerVaultTools(reg: Registrar): void {
  reg.tool(
    "vault_list",
    "List the logins saved in ClawBox Vault, the password manager on this box: entry name, username, site and last change. Never returns a password.",
    { query: zOptText(200, "Optional filter on name, username or site") },
    { maxChars: LIST_MAX_CHARS },
    (a: { query?: string }) => run("vault_list", { ...(a.query ? { query: a.query } : {}) }),
  );

  reg.tool(
    "vault_match",
    "Which saved logins belong to a page: give the page's URL and get the matching ClawBox Vault entries, the exact site first. Never returns a password.",
    { url: zText(2000, "Page URL, e.g. https://billing.example.com/login") },
    {},
    (a: { url: string }) => run("vault_match", { url: a.url }),
  );

  reg.tool(
    "vault_fill",
    "Log in with a saved login: ClawBox Vault types it into the page open in this box's browser. Open the login page with browser_open first, then call this with its URL. The password goes straight from the vault into the form and you get a status only: filled, no_form, no_tab, origin_mismatch, no_entry, locked, extension_offline or timeout.",
    {
      url: zText(2000, "URL of the login page open in the box's browser"),
      name: zOptText(300, "Entry name when several match; default: the best match for the URL"),
      submit: zBool(false, "Also press the form's submit button (two-step logins are followed)"),
    },
    { openWorld: true },
    (a: { url: string; name?: string; submit?: boolean }) =>
      run("vault_fill", { url: a.url, ...(a.name ? { name: a.name } : {}), submit: a.submit === true }, FILL_TIMEOUT_MS),
  );

  reg.tool(
    "vault_save",
    "Save or update a login in ClawBox Vault. For a new account leave password out: a strong one is generated and stored, and vault_fill then types it into the sign-up form. Pass password only when the user gave you one. Returns the entry name, never a password.",
    {
      name: zText(300, ENTRY_NAME),
      login: zText(500, "Username or email"),
      url: zText(2000, "Login page URL"),
      password: zOptText(1000, "Only a password the user gave you; otherwise leave out"),
      note: zOptText(500, "Single-line note"),
      regenerate: z.boolean().optional().describe("Replace an existing entry's password with a newly generated one"),
      length: z.number().int().min(8).max(128).optional().describe("Length of a generated password (default 24)"),
      symbols: z.boolean().optional().describe("Symbols in a generated password (default true)"),
    },
    {},
    (a: Record<string, unknown>) => run("vault_save", a),
  );

  reg.tool(
    "vault_generate",
    "Make a strong password without seeing it. With name it is stored in that ClawBox Vault entry (an existing entry needs overwrite=true). Without name nothing is made or stored; the answer only says what would be.",
    {
      name: zOptText(300, "Entry to store the new password in"),
      login: zOptText(500, "Username for a new entry"),
      url: zOptText(2000, "Login page URL for a new entry"),
      length: z.number().int().min(8).max(128).optional().describe("Length (default 24)"),
      symbols: z.boolean().optional().describe("Include symbols (default true)"),
      overwrite: z.boolean().optional().describe("Replace the password of an existing entry (its history keeps the old one)"),
    },
    {},
    (a: Record<string, unknown>) => run("vault_generate", a),
  );

  reg.tool(
    "vault_delete",
    "Delete a saved login from ClawBox Vault. Ask the user first, then pass confirm=true.",
    { name: zText(300, ENTRY_NAME), confirm: zConfirm("Must be true: the user agreed to delete this entry") },
    { destructive: true },
    (a: { name: string; confirm?: boolean }) => run("vault_delete", { name: a.name, confirm: a.confirm === true }),
  );

  reg.tool(
    "vault_audit",
    "Recent ClawBox Vault activity: who did what to which entry on which site, and how it ended. Holds no secrets.",
    { limit: zInt(1, 200, 20, "How many records, newest last") },
    { maxChars: LIST_MAX_CHARS },
    (a: { limit?: number }) => run("vault_audit", { limit: a.limit ?? 20 }),
  );

  if (!vaultCardsEnabled()) return;

  const cardShape: Shape = { query: zOptText(200, "Optional filter on label, brand or last 4") };
  reg.tool(
    "vault_cards_list",
    "List the payment cards in ClawBox Vault as label, brand, last 4 digits and expiry. Never returns a card number, a security code or the cardholder.",
    cardShape,
    {},
    (a: { query?: string }) => run("vault_cards_list", { ...(a.query ? { query: a.query } : {}) }),
  );
  reg.tool(
    "vault_card_fill",
    "Fill a stored card into the checkout page open in this box's browser. The user sees a confirmation window in the browser and the card is typed only after they click Confirm. Returns a status only (filled, declined, timeout, no_form, no_tab, origin_mismatch, no_entry, locked, extension_offline). It never pays: press the pay button yourself afterwards.",
    {
      url: zText(2000, "URL of the checkout page open in the box's browser"),
      card: zOptText(200, "Card label or last 4 digits from vault_cards_list; default: the only valid card"),
    },
    { openWorld: true },
    (a: { url: string; card?: string }) => run("vault_card_fill", { url: a.url, ...(a.card ? { card: a.card } : {}) }, CARD_FILL_TIMEOUT_MS),
  );
}
