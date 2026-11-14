// The vault service's HTTP API and desktop app, as a plain fetch handler so the
// tests can drive it without a socket.
//
//   /api/ui/*     desktop app, unlocked with the vault PIN (session token)
//   /api/pair     extension pairing with the 6-digit code
//   /api/pair/auto  the box's own browser, with the secret from the extension
//                 folder the service built; open only once a PIN is set
//   /api/ext/*    the paired extension: its token, plus its chrome-extension://
//                 origin whenever an Origin header is sent (GETs carry none)
//   /api/agent/*  the MCP server: token from the mode-600 file, no browser Origin
//
// Plaintext passwords are returned only by /api/ext/secret (to the paired,
// unlocked extension, for a fill/copy or a delivered fill command) and by
// /api/ui/reveal (to the PIN-unlocked desktop app, on an explicit click).
// Card numbers and security codes likewise only by /api/ext/card-secret (one
// fill into an https page, or a card fill command the human confirmed) and by
// /api/ui/card-reveal. The agent API returns cards as label, brand, last 4 and
// expiry. Request logs carry method, path, status and time only.
//
// Cards are off unless the service runs with CLAWBOX_VAULT_CARDS=1: every card
// route then answers 404, as if it were not there.
import {
  cardBrand,
  cardTag,
  defaultLabel,
  redactCardNumbers,
  scrubCardData,
  validateCardNumber,
  validateCardText,
  validateExpiry,
  type CardMeta,
  type ParsedCard,
} from "../shared/card";
import {
  defaultEntryName,
  entryMatchUrl,
  hostOf,
  isFillAllowedUrl,
  matchUrl,
  originOf,
  parseWebUrl,
} from "../shared/domain";
import { validateLine, validateName, validatePassword, ValidationError } from "../shared/entry";
import { clampLength, entropyBits, generatePassword } from "../shared/generator";
import { EXTENSION_STATUSES, type CardSummary, type FillResult, type SaveCheck } from "../shared/types";
import type { AuditLog } from "./audit";
import { Auth, bearer } from "./auth";
import { validateCardName, type CardCatalog } from "./cards";
import type { Catalog } from "./catalog";
import type { VaultConfig } from "./config";
import type { FillQueue } from "./fillqueue";
import { hostAllowed, HttpError, json, readJson, SECURITY_HEADERS, UI_CSP } from "./http";
import { PassError } from "./pass";
import type { StoreSetup } from "./storeinit";
import type { UiAssets } from "./ui";

export interface AppDeps {
  config: VaultConfig;
  catalog: Catalog;
  cards: CardCatalog;
  auth: Auth;
  audit: AuditLog;
  queue: FillQueue;
  ui: UiAssets | null;
  log: (line: string) => void;
  version: string;
  /** First-run store setup. Absent in tests that bring a ready store. */
  setup?: StoreSetup;
}

/** Every card route of the three APIs starts with one of these. */
const CARD_ROUTE_RE = /^\/api\/(ui|ext|agent)\/card(s|-[a-z]+)?$/;

/** Routes that read or write the store: they wait for it and answer 503 without it. */
const STORE_ROUTE_RE = /^\/api\/(ui\/(entries|entry|reveal|cards|card|card-reveal)|ext\/(entries|match|secret|check|save|cards|card-[a-z]+)|agent\/(entries|match|fill|save|generate|delete|cards|card-fill))$/;

export const NOT_SET_UP = "ClawBox Vault is not set up yet: the owner opens ClawBox Vault on the desktop and chooses a PIN first";

interface Ctx {
  req: Request;
  url: URL;
  path: string;
  origin: string | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Card number / CVV from a JSON body: strings, or small JSON numbers. */
function digitsInput(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return "invalid";
}

function cardSummary(meta: Pick<CardMeta, "label" | "brand" | "last4" | "exp">): CardSummary {
  return { label: meta.label, brand: meta.brand, last4: meta.last4, exp: meta.exp };
}

/** The one secret-bearing card shape: to the paired extension, for one fill. */
function cardSecret(name: string, card: ParsedCard) {
  return { name, number: card.number, cardholder: card.cardholder, exp: card.exp, cvv: card.cvv, brand: cardBrand(card.number) };
}

export function createApp(deps: AppDeps) {
  const { config, catalog, cards, auth, audit, queue } = deps;
  const base = config.basePath.replace(/\/$/, "");

  // ---- guards -------------------------------------------------------------

  function requireUi(ctx: Ctx): void {
    if (!auth.checkSession(bearer(ctx.req))) throw new HttpError(401, "vault is locked: unlock with the PIN");
  }

  function requireExt(ctx: Ctx, { unlocked = true } = {}): void {
    const check = auth.checkExtension(bearer(ctx.req), ctx.origin);
    if (check === "unauthorized") throw new HttpError(401, "extension is not paired");
    if (check === "forbidden_origin") throw new HttpError(403, "origin is not the paired extension");
    if (unlocked && auth.extensionLocked()) throw new HttpError(423, "extension is locked");
  }

  function requireAgent(ctx: Ctx): void {
    if (ctx.origin) throw new HttpError(403, "browser origins may not use the agent API");
    if (!auth.checkMcp(bearer(ctx.req))) throw new HttpError(401, "invalid agent token");
    // The owner opts in by choosing the PIN. Until then the assistant can
    // neither store a login nor look for one.
    if (!auth.pinSet()) throw new HttpError(409, NOT_SET_UP, { code: "not_set_up" });
  }

  async function requireStore(): Promise<void> {
    if (!deps.setup) return;
    const status = await deps.setup.ensure();
    if (!status.ready) throw new HttpError(503, `the password store is not available: ${status.error ?? "it is still being prepared"}`, { code: "store_unavailable" });
  }

  // ---- shared operations -----------------------------------------------------

  async function uniqueName(name: string): Promise<string> {
    if (!(await catalog.exists(name))) return name;
    for (let i = 2; i < 100; i++) {
      const candidate = `${name}-${i}`;
      if (!(await catalog.exists(candidate))) return candidate;
    }
    throw new ValidationError("could not find a free entry name");
  }

  async function agentFill(body: Record<string, unknown>): Promise<FillResult> {
    const url = str(body.url) ?? "";
    if (!parseWebUrl(url)) throw new ValidationError("url must be an http(s) URL");
    const submit = body.submit === true;
    if (!isFillAllowedUrl(url)) {
      return { status: "origin_mismatch", detail: "plain http:// is only filled on localhost" };
    }
    let name: string;
    let entryUrl: string | null;
    let detail: string | undefined;
    if (body.name !== undefined && body.name !== null && body.name !== "") {
      name = validateName(body.name);
      if (!(await catalog.exists(name))) return { status: "no_entry", name };
      entryUrl = await catalog.matchUrlFor(name);
      if (!entryUrl || !matchUrl(entryUrl, url)) {
        return { status: "origin_mismatch", name, detail: "the entry's URL does not match this page" };
      }
    } else {
      const prefix = str(body.prefix);
      const matches = await catalog.match(url, prefix ? { prefix } : {});
      if (!matches.length) return { status: "no_entry" };
      name = matches[0]!.name;
      entryUrl = entryMatchUrl(matches[0]!);
      const equallyGood = matches.filter((e) => e.match === matches[0]!.match).length;
      if (equallyGood > 1) detail = `${equallyGood} entries match equally; used ${name} (pass name to choose)`;
    }
    if (!auth.extension()) return { status: "extension_offline", name, detail: "no extension is paired" };
    if (auth.extensionLocked()) return { status: "locked", name };
    const result = await withoutSecret(await queue.submit({ url, name, entryUrl: entryUrl!, submit }), name);
    return detail && result.status === "filled" ? { ...result, detail } : result;
  }

  /**
   * The extension words the detail of a fill, and it held the password for a
   * moment. Whatever it reports, the entry's password does not travel on to
   * the agent in it: a detail that contains it is dropped whole.
   */
  async function withoutSecret(result: FillResult, name: string): Promise<FillResult> {
    if (!result.detail) return result;
    let password = "";
    try {
      password = (await catalog.read(name)).password;
    } catch {
      password = "";
    }
    if (!password || !result.detail.includes(password)) return result;
    deps.log(`fill detail for ${name} held a secret and was dropped`);
    const { detail: _dropped, ...rest } = result;
    return rest;
  }

  /**
   * Queue an agent card fill. The extension shows the human a confirmation
   * (host, label, last 4); the card is released only after Confirm.
   */
  async function agentCardFill(body: Record<string, unknown>): Promise<FillResult> {
    const url = str(body.url) ?? "";
    if (!parseWebUrl(url)) throw new ValidationError("url must be an http(s) URL");
    if (!isFillAllowedUrl(url)) {
      return { status: "origin_mismatch", detail: "cards are filled only into https:// pages (plain http:// only on localhost)" };
    }
    const ref = str(body.card)?.trim();
    let meta: CardMeta;
    if (ref) {
      const found = await cards.resolve(ref);
      if (!found.length) return { status: "no_entry", detail: "no card matches (use a label or the last 4 digits from vault_cards_list)" };
      if (found.length > 1) throw new ValidationError(`${found.length} cards match; pass the label: ${found.map((c) => cardTag(c)).join(", ")}`);
      meta = found[0]!;
    } else {
      const usable = (await cards.list()).filter((c) => !c.expired);
      if (!usable.length) return { status: "no_entry", detail: "no valid card is stored" };
      if (usable.length > 1) throw new ValidationError(`${usable.length} cards are stored; pass card (label or last 4): ${usable.map((c) => cardTag(c)).join(", ")}`);
      meta = usable[0]!;
    }
    const card = cardSummary(meta);
    if (meta.expired) return { status: "no_entry", name: meta.name, detail: "that card has expired", card };
    if (!auth.extension()) return { status: "extension_offline", name: meta.name, detail: "no extension is paired", card };
    if (auth.extensionLocked()) return { status: "locked", name: meta.name, card };
    return queue.submit(
      { kind: "card", url, name: meta.name, entryUrl: originOf(url)!, submit: false, card },
      { confirmMs: config.cardConfirmMs, timeoutMs: config.fillTimeoutMs },
    );
  }

  // ---- route handlers ------------------------------------------------------------

  async function route(ctx: Ctx): Promise<Response> {
    const { req, url, path } = ctx;
    const m = req.method;
    const q = (k: string) => url.searchParams.get(k) ?? undefined;

    if (!config.cards && CARD_ROUTE_RE.test(path)) throw new HttpError(404, "not found");
    if (STORE_ROUTE_RE.test(path)) await requireStore();

    // public
    if (m === "GET" && path === "/api/health") {
      return json(200, { ok: true, app: "clawbox-vault", version: deps.version });
    }
    if (m === "GET" && path === "/api/ui/status") {
      const store = deps.setup ? await deps.setup.ensure() : { ready: true };
      return json(200, { pinSet: auth.pinSet(), unlocked: auth.checkSession(bearer(req)), cards: config.cards, store });
    }
    if (m === "POST" && path === "/api/ui/setup") {
      if (auth.pinSet()) throw new HttpError(409, "PIN is already set");
      const body = await readJson(req);
      try {
        auth.setupPin(Auth.validatePin(body.pin));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      audit.record({ actor: "ui", action: "pin_set" });
      return json(200, auth.createSession());
    }
    if (m === "POST" && path === "/api/ui/unlock") {
      const body = await readJson(req);
      if (!auth.pinSet()) throw new HttpError(409, "set a PIN first");
      const check = auth.verifyPin(body.pin);
      if (!check.ok) {
        audit.record({ actor: "ui", action: "unlock_failed" });
        if (check.retryAfterMs > 0) throw new HttpError(429, "too many attempts", { retryAfterMs: check.retryAfterMs });
        throw new HttpError(401, "wrong PIN");
      }
      audit.record({ actor: "ui", action: "unlock" });
      return json(200, auth.createSession());
    }
    if (m === "POST" && path === "/api/pair") {
      const body = await readJson(req);
      const claim = auth.claimPairing(body.code, ctx.origin);
      if (!claim.ok) {
        audit.record({ actor: "extension", action: "pair_failed", detail: claim.reason });
        if (claim.reason === "bad_origin") throw new HttpError(403, "pairing is only open to a Chrome extension");
        throw new HttpError(401, claim.reason === "invalid_code" ? "wrong pairing code" : "no pairing code is active");
      }
      queue.cancelAll("extension_offline");
      audit.record({ actor: "extension", action: "paired", detail: ctx.origin ?? undefined });
      return json(200, { token: claim.token }, corsFor(ctx.origin));
    }
    if (m === "POST" && path === "/api/pair/auto") {
      const body = await readJson(req);
      const claim = auth.claimAutoPairing(body.secret, ctx.origin);
      if (!claim.ok) {
        // "Not yet" is the normal answer on a box whose owner has not opened
        // the vault: the browser asks again later, and it is not worth a record.
        if (claim.reason === "not_set_up") throw new HttpError(409, NOT_SET_UP, { code: "not_set_up" });
        if (claim.reason === "off") throw new HttpError(409, "this browser was unpaired in ClawBox Vault", { code: "auto_pair_off" });
        audit.record({ actor: "extension", action: "pair_failed", detail: claim.reason });
        if (claim.reason === "bad_origin") throw new HttpError(403, "pairing is only open to a Chrome extension");
        throw new HttpError(401, "wrong pairing secret");
      }
      queue.cancelAll("extension_offline");
      audit.record({ actor: "extension", action: "paired", detail: `${ctx.origin ?? ""} (this box's browser)` });
      return json(200, { token: claim.token }, corsFor(ctx.origin));
    }

    // desktop app (PIN session)
    if (path.startsWith("/api/ui/")) {
      requireUi(ctx);
      return uiRoute(ctx, m, path, q);
    }
    if (path.startsWith("/api/ext/")) return extRoute(ctx, m, path, q);
    if (path.startsWith("/api/agent/")) {
      requireAgent(ctx);
      return agentRoute(ctx, m, path, q);
    }
    throw new HttpError(404, "not found");
  }

  async function uiRoute(ctx: Ctx, m: string, path: string, q: (k: string) => string | undefined): Promise<Response> {
    const { req } = ctx;
    if (m === "POST" && path === "/api/ui/lock") {
      auth.endSession(bearer(req));
      return json(200, { ok: true });
    }
    if (m === "POST" && path === "/api/ui/pin") {
      const body = await readJson(req);
      let check;
      try {
        check = auth.changePin(body.current, body.next);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      if (!check.ok) {
        audit.record({ actor: "ui", action: "pin_change_failed" });
        throw new HttpError(check.retryAfterMs ? 429 : 401, "wrong PIN", { retryAfterMs: check.retryAfterMs });
      }
      audit.record({ actor: "ui", action: "pin_changed" });
      return json(200, auth.createSession());
    }
    if (m === "GET" && path === "/api/ui/entries") {
      return json(200, { entries: await catalog.list({ query: q("q") }) });
    }
    if (m === "GET" && path === "/api/ui/entry") {
      const name = validateName(q("name"));
      const [entry, meta] = await Promise.all([catalog.read(name), catalog.metaFor(name)]);
      return json(200, {
        name,
        login: entry.login,
        url: entry.url,
        note: entry.note,
        has2fa: Boolean(entry.twofa),
        extraLines: entry.extra.length,
        updated: meta.updated,
      });
    }
    if (m === "POST" && path === "/api/ui/reveal") {
      const body = await readJson(req);
      const name = validateName(body.name);
      const entry = await catalog.read(name);
      audit.record({ actor: "ui", action: "reveal", name });
      return json(200, { password: entry.password });
    }
    if (m === "POST" && path === "/api/ui/entries") {
      const body = await readJson(req);
      const originalName = str(body.originalName);
      const out = await catalog.save(
        {
          name: str(body.name) ?? "",
          login: str(body.login),
          url: str(body.url),
          password: str(body.password),
          note: str(body.note),
          twofa: str(body.twofa),
          clearTwofa: body.clearTwofa === true,
        },
        { mustBeNew: body.create === true, renameFrom: originalName || undefined },
      );
      if (originalName && originalName !== out.name) {
        audit.record({ actor: "ui", action: "rename", name: out.name, detail: `from ${originalName}` });
      }
      audit.record({ actor: "ui", action: out.created ? "create" : "update", name: out.name });
      return json(200, out);
    }
    if (m === "GET" && path === "/api/ui/cards") {
      return json(200, { cards: await cards.list({ query: q("q") }) });
    }
    if (m === "GET" && path === "/api/ui/card") {
      const name = validateCardName(q("name"));
      const [card, meta] = await Promise.all([cards.read(name), cards.metaFor(name)]);
      return json(200, { ...meta, note: card.note, hasCvv: Boolean(card.cvv), extraLines: card.extra.length });
    }
    if (m === "POST" && path === "/api/ui/cards") {
      const body = await readJson(req);
      const originalName = str(body.originalName) || undefined;
      const out = await cards.save(
        {
          label: str(body.label),
          number: digitsInput(body.number),
          cardholder: str(body.cardholder),
          exp: str(body.exp),
          cvv: digitsInput(body.cvv),
          clearCvv: body.clearCvv === true,
          note: str(body.note),
        },
        { name: originalName },
      );
      if (originalName && originalName !== out.name) {
        audit.record({ actor: "ui", action: "card_rename", name: out.name, detail: `from ${originalName}` });
      }
      audit.record({ actor: "ui", action: out.created ? "card_add" : "card_edit", name: out.name, detail: cardTag(out.meta) });
      return json(200, { name: out.name, created: out.created, card: out.meta });
    }
    if (m === "DELETE" && path === "/api/ui/card") {
      const meta = await cards.remove(validateCardName(q("name")));
      audit.record({ actor: "ui", action: "card_delete", name: meta.name, detail: cardTag(meta) });
      return json(200, { ok: true });
    }
    if (m === "POST" && path === "/api/ui/card-reveal") {
      const body = await readJson(req);
      const name = validateCardName(body.name);
      const field = body.field === "cvv" || body.field === "number" ? body.field : null;
      if (!field) throw new ValidationError("field must be number or cvv");
      const copy = body.purpose === "copy";
      const [card, meta] = await Promise.all([cards.read(name), cards.metaFor(name)]);
      if (field === "cvv" && !card.cvv) throw new HttpError(404, "no security code is stored for this card");
      const what = field === "cvv" ? "security code" : "number";
      audit.record({ actor: "ui", action: copy ? "card_copy" : "card_reveal", name, detail: `${cardTag(meta)} (${what})` });
      return json(200, { value: field === "cvv" ? card.cvv : card.number });
    }
    if (m === "DELETE" && path === "/api/ui/entry") {
      const name = validateName(q("name"));
      await catalog.remove(name);
      audit.record({ actor: "ui", action: "delete", name });
      return json(200, { ok: true });
    }
    if (m === "GET" && path === "/api/ui/pairing") {
      return json(200, { extension: auth.extension(), pending: auth.pendingPairing(), connected: queue.online(), auto: auth.autoPairEnabled() });
    }
    if (m === "POST" && path === "/api/ui/pairing/auto") {
      // Lets the box's own browser pair by itself again after an unpair.
      auth.setAutoPair(true);
      audit.record({ actor: "ui", action: "auto_pairing_on" });
      return json(200, { auto: true });
    }
    if (m === "POST" && path === "/api/ui/pairing") {
      const p = auth.startPairing();
      audit.record({ actor: "ui", action: "pairing_started" });
      return json(200, p);
    }
    if (m === "DELETE" && path === "/api/ui/pairing") {
      auth.cancelPairing();
      // An unpair that the browser undid half a minute later would be no unpair.
      auth.setAutoPair(false);
      if (auth.extension()) {
        auth.unpair();
        queue.cancelAll("extension_offline");
        queue.disconnect();
        audit.record({ actor: "ui", action: "unpaired" });
      }
      return json(200, { ok: true });
    }
    if (m === "POST" && path === "/api/ui/extension-lock") {
      const body = await readJson(req);
      const locked = body.locked === true;
      auth.setExtensionLocked(locked);
      if (locked) queue.cancelAll("locked");
      audit.record({ actor: "ui", action: locked ? "extension_locked" : "extension_unlocked" });
      return json(200, { locked });
    }
    if (m === "GET" && path === "/api/ui/audit") {
      return json(200, { records: audit.recent(Number(q("limit") ?? 100)) });
    }
    if (m === "GET" && path === "/api/ui/info") {
      return json(200, {
        version: deps.version,
        extensionDir: config.extensionDir,
        storeDir: catalog.store.storeDir,
        configDir: config.configDir,
        auditFile: audit.file,
        serviceUrl: `http://127.0.0.1:${config.port}`,
        cards: config.cards,
      });
    }
    throw new HttpError(404, "not found");
  }

  async function extRoute(ctx: Ctx, m: string, path: string, q: (k: string) => string | undefined): Promise<Response> {
    const { req } = ctx;
    const cors = corsFor(ctx.origin);

    // available while locked
    if (m === "GET" && path === "/api/ext/status") {
      requireExt(ctx, { unlocked: false });
      return json(200, { paired: true, locked: auth.extensionLocked(), cards: config.cards }, cors);
    }
    if (m === "POST" && path === "/api/ext/lock") {
      requireExt(ctx, { unlocked: false });
      auth.setExtensionLocked(true);
      queue.cancelAll("locked");
      audit.record({ actor: "extension", action: "extension_locked" });
      return json(200, { locked: true }, cors);
    }
    if (m === "POST" && path === "/api/ext/unlock") {
      requireExt(ctx, { unlocked: false });
      const body = await readJson(req);
      const check = auth.verifyPin(body.pin);
      if (!check.ok) {
        audit.record({ actor: "extension", action: "unlock_failed" });
        // 403, not 401: the extension treats 401 as "unpaired" and drops its token.
        throw new HttpError(check.retryAfterMs ? 429 : 403, check.retryAfterMs ? "too many attempts" : "wrong PIN", {
          retryAfterMs: check.retryAfterMs,
        });
      }
      auth.setExtensionLocked(false);
      audit.record({ actor: "extension", action: "extension_unlocked" });
      return json(200, { locked: false }, cors);
    }
    if (m === "POST" && path === "/api/ext/unpair") {
      requireExt(ctx, { unlocked: false });
      auth.unpair();
      queue.cancelAll("extension_offline");
      audit.record({ actor: "extension", action: "unpaired" });
      return json(200, { ok: true }, cors);
    }
    if (m === "GET" && path === "/api/ext/commands") {
      requireExt(ctx, { unlocked: false });
      if (auth.extensionLocked()) {
        // Keep the connection alive but hand out nothing while locked.
        await new Promise((r) => setTimeout(r, Math.min(config.pollWaitMs, 5_000)));
        return json(200, { commands: [], locked: true }, cors);
      }
      const wait = Math.min(config.pollWaitMs, Math.max(0, Number(q("wait") ?? config.pollWaitMs)));
      const commands = await queue.poll(wait, req.signal);
      return json(200, { commands }, cors);
    }

    requireExt(ctx);
    if (m === "POST" && path === "/api/ext/result") {
      const body = await readJson(req);
      const status = str(body.status) as (typeof EXTENSION_STATUSES)[number] | undefined;
      if (!status || !EXTENSION_STATUSES.includes(status)) throw new ValidationError("unknown status");
      const detail = validateLine(body.detail, "detail", { max: 200 }) || undefined;
      const ok = queue.report(str(body.id) ?? "", status, detail);
      if (!ok) throw new HttpError(404, "unknown command");
      return json(200, { ok: true }, cors);
    }
    if (m === "GET" && path === "/api/ext/entries") {
      return json(200, { entries: await catalog.list({ query: q("q") }) }, cors);
    }
    if (m === "GET" && path === "/api/ext/match") {
      const pageUrl = q("url") ?? "";
      if (!parseWebUrl(pageUrl)) throw new ValidationError("url must be an http(s) URL");
      return json(200, { entries: await catalog.match(pageUrl), fillAllowed: isFillAllowedUrl(pageUrl) }, cors);
    }
    if (m === "POST" && path === "/api/ext/secret") {
      const body = await readJson(req);
      if (body.commandId !== undefined) {
        const cmd = queue.releaseSecret(str(body.commandId) ?? "");
        if (!cmd) throw new HttpError(404, "no such pending fill command");
        const entry = await catalog.read(cmd.name);
        audit.record({ actor: "extension", action: "secret_released", name: cmd.name, host: hostOf(cmd.url) ?? undefined, detail: "agent fill" });
        return json(200, { name: cmd.name, login: entry.login, password: entry.password, entryUrl: cmd.entryUrl, submit: cmd.submit }, cors);
      }
      const name = validateName(body.name);
      const purpose = body.purpose;
      if (purpose === "fill") {
        const pageUrl = str(body.pageUrl) ?? "";
        const entryUrl = await catalog.matchUrlFor(name);
        if (!entryUrl || !matchUrl(entryUrl, pageUrl)) throw new HttpError(403, "entry does not match this page");
        const entry = await catalog.read(name);
        audit.record({ actor: "extension", action: "secret_released", name, host: hostOf(pageUrl) ?? undefined, detail: "fill" });
        return json(200, { name, login: entry.login, password: entry.password, entryUrl }, cors);
      }
      if (purpose === "copy") {
        const entry = await catalog.read(name);
        audit.record({ actor: "extension", action: "secret_released", name, detail: "copy" });
        return json(200, { name, password: entry.password }, cors);
      }
      throw new ValidationError("purpose must be fill or copy");
    }
    if (m === "GET" && path === "/api/ext/cards") {
      return json(200, { cards: await cards.list({ query: q("q") }) }, cors);
    }
    if (m === "POST" && path === "/api/ext/card-secret") {
      const body = await readJson(req);
      if (body.commandId !== undefined) {
        const cmd = queue.releaseSecret(str(body.commandId) ?? "", "card");
        if (!cmd) throw new HttpError(404, "no confirmed card fill command");
        const card = await cards.read(cmd.name);
        audit.record({
          actor: "extension",
          action: "card_secret_released",
          name: cmd.name,
          host: hostOf(cmd.url) ?? undefined,
          detail: `${cmd.card ? cardTag(cmd.card) : cmd.name} (agent fill)`,
        });
        return json(200, cardSecret(cmd.name, card), cors);
      }
      const name = validateCardName(body.name);
      const pageUrl = str(body.pageUrl) ?? "";
      if (!parseWebUrl(pageUrl) || !isFillAllowedUrl(pageUrl)) {
        throw new HttpError(403, "cards are filled only into https:// pages (plain http:// only on localhost)");
      }
      const via = body.via === "chip" ? "chip" : "popup";
      const [card, meta] = await Promise.all([cards.read(name), cards.metaFor(name)]);
      audit.record({ actor: "extension", action: "card_fill", name, host: hostOf(pageUrl) ?? undefined, detail: `${cardTag(meta)} (${via})` });
      return json(200, cardSecret(name, card), cors);
    }
    if (m === "POST" && path === "/api/ext/card-decision") {
      const body = await readJson(req);
      const decision = body.decision === "confirm" || body.decision === "decline" ? body.decision : null;
      if (!decision) throw new ValidationError("decision must be confirm or decline");
      const cmd = queue.decide(str(body.id) ?? "", decision);
      if (!cmd) throw new HttpError(404, "unknown or already decided card fill");
      audit.record({
        actor: "extension",
        action: "card_agent_fill",
        name: cmd.name,
        host: hostOf(cmd.url) ?? undefined,
        status: decision === "confirm" ? "confirmed" : "declined",
        detail: cmd.card ? cardTag(cmd.card) : undefined,
      });
      return json(200, { ok: true }, cors);
    }
    if (m === "POST" && path === "/api/ext/card-check") {
      // A card typed at checkout: new, a changed expiry/cardholder, or already saved.
      const body = await readJson(req);
      const ignore = () => json(200, { kind: "ignore" }, cors);
      if (!isFillAllowedUrl(str(body.url) ?? "")) return ignore();
      let number: string;
      let exp: string;
      try {
        number = validateCardNumber(digitsInput(body.number));
        exp = validateExpiry(str(body.exp) ?? "");
      } catch {
        return ignore();
      }
      let holder = "";
      try {
        holder = validateCardText(body.cardholder, "cardholder", 100);
      } catch {
        holder = "";
      }
      const brand = cardBrand(number);
      const last4 = number.slice(-4);
      const same = await cards.findByNumber(number);
      if (same.length) {
        const meta = await cards.metaFor(same[0]!);
        if (meta.exp === exp && (!holder || meta.cardholder === holder)) return json(200, { kind: "same", name: meta.name }, cors);
        return json(200, { kind: "update", name: meta.name, label: meta.label, brand, last4, exp }, cors);
      }
      return json(200, { kind: "new", suggestedLabel: defaultLabel(number), brand, last4, exp }, cors);
    }
    if (m === "POST" && path === "/api/ext/card-save") {
      const body = await readJson(req);
      const host = hostOf(str(body.url)) ?? undefined;
      let out;
      if (body.mode === "update") {
        const name = validateCardName(body.name);
        const number = validateCardNumber(digitsInput(body.number));
        if ((await cards.read(name)).number !== number) throw new HttpError(409, "that card holds a different number");
        out = await cards.save({ exp: str(body.exp), cardholder: str(body.cardholder) || undefined, cvv: digitsInput(body.cvv) }, { name });
      } else {
        out = await cards.save({
          label: str(body.label),
          number: digitsInput(body.number),
          cardholder: str(body.cardholder),
          exp: str(body.exp),
          cvv: digitsInput(body.cvv),
        });
      }
      audit.record({ actor: "extension", action: out.created ? "card_add" : "card_edit", name: out.name, host, detail: cardTag(out.meta) });
      return json(200, { name: out.name, created: out.created, card: out.meta }, cors);
    }
    if (m === "POST" && path === "/api/ext/check") {
      const body = await readJson(req);
      const pageUrl = str(body.url) ?? "";
      const login = validateLine(body.login, "login", { max: 500 });
      const password = validatePassword(body.password);
      let check: SaveCheck | { kind: "ignore" };
      if (!isFillAllowedUrl(pageUrl)) {
        check = { kind: "ignore" };
      } else {
        const matches = await catalog.match(pageUrl);
        const sameLogin = login ? matches.filter((e) => e.login.toLowerCase() === login.toLowerCase()) : matches;
        check = { kind: "new", suggestedName: await uniqueName(defaultEntryName(pageUrl, login)) };
        for (const e of sameLogin) {
          const entry = await catalog.read(e.name);
          if (entry.password === password) {
            check = { kind: "same", name: e.name };
            break;
          }
        }
        if (check.kind === "new" && sameLogin.length && login) check = { kind: "update", name: sameLogin[0]!.name };
      }
      return json(200, check, cors);
    }
    if (m === "POST" && path === "/api/ext/save") {
      const body = await readJson(req);
      const out = await catalog.save(
        { name: str(body.name) ?? "", login: str(body.login), url: str(body.url), password: str(body.password), note: str(body.note) },
        { mustBeNew: body.mode === "create" },
      );
      audit.record({ actor: "extension", action: out.created ? "create" : "update", name: out.name, host: hostOf(str(body.url)) ?? undefined });
      return json(200, out, cors);
    }
    throw new HttpError(404, "not found");
  }

  async function agentRoute(ctx: Ctx, m: string, path: string, q: (k: string) => string | undefined): Promise<Response> {
    const { req } = ctx;
    if (m === "GET" && path === "/api/agent/entries") {
      const prefix = q("prefix");
      return json(200, { entries: await catalog.list({ query: q("q"), ...(prefix ? { prefix } : {}) }) });
    }
    if (m === "GET" && path === "/api/agent/match") {
      const pageUrl = q("url") ?? "";
      if (!parseWebUrl(pageUrl)) throw new ValidationError("url must be an http(s) URL");
      const prefix = q("prefix");
      return json(200, { entries: await catalog.match(pageUrl, prefix ? { prefix } : {}), fillAllowed: isFillAllowedUrl(pageUrl) });
    }
    if (m === "POST" && path === "/api/agent/fill") {
      const body = await readJson(req);
      const result = await agentFill(body);
      audit.record({ actor: "agent", action: "fill", name: result.name, host: hostOf(str(body.url)) ?? undefined, status: result.status });
      return json(200, result);
    }
    if (m === "POST" && path === "/api/agent/save") {
      const body = await readJson(req);
      const name = validateName(body.name);
      const exists = await catalog.exists(name);
      let password = str(body.password) || undefined;
      let generated = false;
      if (password === undefined && (!exists || body.regenerate === true)) {
        password = generatePassword({ length: clampLength(body.length ?? 24), symbols: body.symbols !== false });
        generated = true;
      }
      const out = await catalog.save({ name, login: str(body.login), url: str(body.url), password, note: str(body.note) });
      audit.record({
        actor: "agent",
        action: out.created ? "create" : "update",
        name: out.name,
        host: hostOf(str(body.url)) ?? undefined,
        detail: generated ? "generated password" : undefined,
      });
      return json(200, { name: out.name, created: out.created, generated });
    }
    if (m === "POST" && path === "/api/agent/generate") {
      const body = await readJson(req);
      const length = clampLength(body.length ?? 24);
      const symbols = body.symbols !== false;
      if (body.name === undefined || body.name === null || body.name === "") {
        return json(200, { stored: false, length, symbols, entropyBits: entropyBits({ length, symbols }) });
      }
      const name = validateName(body.name);
      if ((await catalog.exists(name)) && body.overwrite !== true) {
        throw new HttpError(409, "entry exists: pass overwrite=true to replace its password (pass git history keeps the old one)");
      }
      const out = await catalog.save({
        name,
        login: str(body.login),
        url: str(body.url),
        password: generatePassword({ length, symbols }),
      });
      audit.record({ actor: "agent", action: out.created ? "create" : "update", name, host: hostOf(str(body.url)) ?? undefined, detail: "generated password" });
      return json(200, { stored: true, name, created: out.created, length, symbols });
    }
    if (m === "POST" && path === "/api/agent/delete") {
      const body = await readJson(req);
      const name = validateName(body.name);
      if (body.confirm !== true) throw new ValidationError("confirm must be true to delete");
      await catalog.remove(name);
      audit.record({ actor: "agent", action: "delete", name });
      return json(200, { ok: true, name });
    }
    if (m === "GET" && path === "/api/agent/cards") {
      // Label, brand, last 4 and expiry: nothing else of a card reaches the agent.
      return json(200, { cards: (await cards.list({ query: q("q") })).map(cardSummary) });
    }
    if (m === "POST" && path === "/api/agent/card-fill") {
      const body = await readJson(req);
      const result = await agentCardFill(body);
      audit.record({
        actor: "agent",
        action: "card_agent_fill",
        name: result.name,
        host: hostOf(str(body.url)) ?? undefined,
        status: result.status,
        detail: result.card ? cardTag(result.card) : undefined,
      });
      const { name: _name, ...visible } = result;
      return json(200, visible);
    }
    if (m === "GET" && path === "/api/agent/audit") {
      return json(200, { records: audit.recent(Number(q("limit") ?? 20)) });
    }
    throw new HttpError(404, "not found");
  }

  function corsFor(origin: string | null): Record<string, string> {
    const paired = auth.pairedOrigin();
    if (origin && paired && origin === paired) {
      return { "access-control-allow-origin": origin, vary: "Origin" };
    }
    return { vary: "Origin" };
  }

  function staticAsset(path: string): Response {
    const asset = deps.ui?.get(path);
    if (!asset) throw new HttpError(404, "not found");
    const headers: Record<string, string> = { "content-type": asset.type, "cache-control": "no-cache" };
    if (asset.type.startsWith("text/html")) headers["content-security-policy"] = UI_CSP;
    // The desktop opens the app in a sandboxed frame (opaque origin), so its own
    // stylesheet and icon arrive as cross-origin no-cors loads that a
    // same-origin resource policy blocks. These bundled files hold no secrets;
    // the API keeps same-origin.
    else headers["cross-origin-resource-policy"] = "cross-origin";
    return new Response(asset.body, { status: 200, headers });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Bun builds req.url from the Host header; fall back to it if the header is absent.
    if (!hostAllowed(req.headers.get("host") ?? url.host, config.allowedHosts)) {
      throw new HttpError(421, "unexpected Host header");
    }
    let path = url.pathname;
    if (path === base) return new Response(null, { status: 308, headers: { location: `${config.basePath}${url.search}` } });
    if (base && path.startsWith(`${base}/`)) path = path.slice(base.length);
    const origin = req.headers.get("origin");
    const ctx: Ctx = { req, url, path, origin };

    if (req.method === "OPTIONS") {
      const paired = auth.pairedOrigin();
      if (!origin || origin !== paired) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, DELETE",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "600",
          vary: "Origin",
        },
      });
    }
    if (path.startsWith("/api/")) return route(ctx);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    return staticAsset(path);
  }

  function errorResponse(err: unknown, origin: string | null): Response {
    const cors = corsFor(origin);
    if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra }, cors);
    if (err instanceof ValidationError) return json(400, { error: err.message }, cors);
    if (err instanceof PassError) {
      if (err.code === "not_found") return json(404, { error: "entry not found" }, cors);
      if (err.code === "exists") return json(409, { error: "entry already exists" }, cors);
      return json(502, { error: "the pass store refused the operation (see service log)" }, cors);
    }
    deps.log(`internal error: ${(err as Error)?.name ?? "Error"}: ${scrubCardData(String((err as Error)?.message ?? "")).slice(0, 200)}`);
    return json(500, { error: "internal error" }, cors);
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const started = performance.now();
      let res: Response;
      try {
        res = await handle(req);
      } catch (err) {
        res = errorResponse(err, req.headers.get("origin"));
      }
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
      const path = redactCardNumbers(new URL(req.url).pathname);
      deps.log(`${req.method} ${path} ${res.status} ${Math.round(performance.now() - started)}ms`);
      return res;
    },
  };
}
