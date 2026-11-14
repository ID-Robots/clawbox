// Background service worker: the only part of the extension that talks to the
// vault service (http://127.0.0.1:4796). It holds the pairing token, keeps a
// long-poll open for agent fill commands, fills tabs through the content
// script, carries captured logins to the save bar, and copies passwords to the
// clipboard (cleared after 30 s). Captured passwords and cards live in
// chrome.storage.session (memory only) until saved or dismissed.
//
// Cards are filled only on an explicit user action: a click in the popup, a
// pick in the in-page picker (opened from the chip), or the human's Confirm in
// the confirmation window of an agent card fill. Nothing is filled on load.
import { defaultEntryName, isFillAllowedUrl, matchUrl, originOf, parseWebUrl } from "../shared/domain";
import type { FillCommand, SaveCheck } from "../shared/types";
import type { CardData, CardFieldKind, GuardedCardOutcome } from "./cardforms";
import { CARDS_ENABLED } from "./flags";
import { chipAllowed, chooseFillFrame, pickCardTab, pickTab, planCardFill, type CardFrameProbe, type CardPlan, type FrameProbe } from "./frames";
import type {
  CardFillReply,
  CardSavePrompt,
  CardView,
  ConfirmDetails,
  ConfirmMessage,
  ContentMessage,
  EntryView,
  PopupMessage,
  PopupState,
  SavePrompt,
} from "./messages";

// The service that built this extension (src/server/extensiondir.ts) names itself here.
declare const __VAULT_SERVICE__: string | undefined;
const SERVICE = typeof __VAULT_SERVICE__ === "string" ? __VAULT_SERVICE__ : "http://127.0.0.1:4796";
const POLL_WAIT_MS = 25_000;
const CLIPBOARD_CLEAR_MS = 30_000;
const CAPTURE_TTL_MS = 3 * 60_000;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---- service client -------------------------------------------------------------

async function token(): Promise<string | null> {
  const { token } = await chrome.storage.local.get("token");
  return typeof token === "string" ? token : null;
}

async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const t = await token();
  if (!t) throw new ApiError(401, "not paired");
  const res = await fetch(`${SERVICE}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { authorization: `Bearer ${t}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
    cache: "no-store",
    credentials: "omit",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (res.status === 401) await chrome.storage.local.remove("token");
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

// ---- agent fill commands -----------------------------------------------------------

let polling = false;

async function pollLoop(): Promise<void> {
  if (polling) return;
  polling = true;
  let backoff = 1_000;
  try {
    while (await token()) {
      try {
        const r = await api<{ commands: FillCommand[] }>(`/api/ext/commands?wait=${POLL_WAIT_MS}`);
        backoff = 1_000;
        for (const cmd of r.commands) void handleCommand(cmd);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  } finally {
    polling = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function report(id: string, status: string, detail?: string): Promise<void> {
  await api("/api/ext/result", { body: { id, status, ...(detail ? { detail } : {}) } }).catch(() => undefined);
}

async function handleCommand(cmd: FillCommand): Promise<void> {
  if (cmd.kind === "card") return CARDS_ENABLED ? handleCardCommand(cmd) : report(cmd.id, "error", "cards are off");
  try {
    const tabs = await chrome.tabs.query({});
    const tab = pickTab(tabs, cmd.entryUrl, cmd.url);
    if (tab.status !== "ok") return report(cmd.id, tab.status, tab.detail);
    const secret = await api<{ login: string; password: string; entryUrl: string; submit: boolean }>("/api/ext/secret", {
      body: { commandId: cmd.id },
    });
    const result = await fillTab(tab.tabId, tab.url, secret.entryUrl, secret.login, secret.password, cmd.submit);
    await report(cmd.id, result.status, result.detail);
  } catch (err) {
    await report(cmd.id, "error", err instanceof ApiError ? err.message : "fill failed");
  }
}

type InjectedProbe = Omit<FrameProbe, "frameId"> | null;

async function probeFrames(tabId: number): Promise<FrameProbe[]> {
  const run = () =>
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (): InjectedProbe => globalThis.__clawboxVault?.probe() ?? null,
    });
  let results = await run();
  if (results.some((r) => r.result == null)) {
    // Tabs opened before the extension was loaded have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["build/content.js"] }).catch(() => undefined);
    results = await run();
  }
  return results
    .filter((r) => r.result)
    .map((r) => ({ frameId: r.frameId, ...(r.result as Omit<FrameProbe, "frameId">) }));
}

interface TabFillResult {
  status: string;
  detail?: string;
}

async function fillFrame(
  tabId: number,
  frameId: number,
  allowedOrigin: string,
  login: string,
  password: string,
  submit: boolean,
): Promise<{ status: string; step?: string; detail?: string; submitted?: boolean }> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (l: string, p: string, o: string, s: boolean) =>
      globalThis.__clawboxVault
        ? globalThis.__clawboxVault.fill({ login: l, password: p, allowedOrigin: o, submit: s })
        : { status: "no_form" },
    args: [login, password, allowedOrigin, submit],
  });
  return (res?.result as { status: string; step?: string; detail?: string }) ?? { status: "error" };
}

/** Fill a tab; on a two-step login with submit, follow up on the password page. */
async function fillTab(tabId: number, tabUrl: string, entryUrl: string, login: string, password: string, submit: boolean): Promise<TabFillResult> {
  const frames = await probeFrames(tabId);
  const choice = chooseFillFrame(frames, tabUrl, entryUrl);
  if (choice.status !== "ok") return choice;
  const first = await fillFrame(tabId, choice.frameId, choice.origin, login, password, submit);
  if (first.status !== "filled") return first;
  if (first.step !== "username" || !submit) {
    return { status: "filled", detail: first.step === "password" ? "password step" : first.submitted ? "submitted" : undefined };
  }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) break;
    const next = chooseFillFrame(await probeFrames(tabId).catch(() => []), tab.url, entryUrl, { needPassword: true });
    if (next.status === "ok") {
      const second = await fillFrame(tabId, next.frameId, next.origin, login, password, submit);
      return second.status === "filled" ? { status: "filled", detail: "two-step login" } : second;
    }
    if (next.status === "origin_mismatch" && next.detail?.includes("another origin")) return next;
  }
  return { status: "filled", detail: "username step submitted; no password page appeared" };
}

// ---- clipboard (offscreen document) ------------------------------------------------

let clearTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.CLIPBOARD],
    justification: "Copy a password to the clipboard and clear it after 30 seconds",
  });
}

// Copies and clears run one at a time, and each clear belongs to the copy that
// set it: a clear that comes due after a newer copy leaves that copy alone.
// The offscreen document stays open for the next copy (Chrome allows one).
let clipboardQueue: Promise<unknown> = Promise.resolve();
let clipboardCopy = 0;

function onClipboard<T>(op: () => Promise<T>): Promise<T> {
  const next = clipboardQueue.then(op, op);
  clipboardQueue = next.catch(() => undefined);
  return next;
}

function copyToClipboard(text: string, clearAfter: boolean): Promise<void> {
  return onClipboard(async () => {
    await ensureOffscreen();
    const res = (await chrome.runtime.sendMessage({ target: "offscreen", type: "copy", text })) as { ok?: boolean } | undefined;
    if (res?.ok !== true) throw new Error("The browser did not let the vault write the clipboard.");
    const copy = ++clipboardCopy;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
    if (clearAfter) {
      clearTimer = setTimeout(() => void clearClipboard(copy), CLIPBOARD_CLEAR_MS);
      // Backup in case the worker is stopped before the timer fires.
      await chrome.alarms.create("clipboard-clear", { delayInMinutes: CLIPBOARD_CLEAR_MS / 60_000 });
    } else {
      await chrome.alarms.clear("clipboard-clear");
    }
  });
}

/** Clears the clipboard; with `copy`, only while that copy is still the latest. */
function clearClipboard(copy?: number): Promise<void> {
  return onClipboard(async () => {
    if (copy !== undefined && copy !== clipboardCopy) return;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
    await chrome.alarms.clear("clipboard-clear");
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "clear" }).catch(() => undefined);
  });
}

// ---- captured logins (save bar) -------------------------------------------------------

interface Capture {
  url: string;
  login: string;
  password: string;
  at: number;
  check: SaveCheck;
}

interface PendingLogin {
  url: string;
  login: string;
  at: number;
}

async function getSession<T>(key: string): Promise<Record<string, T>> {
  const data = await chrome.storage.session.get(key);
  return (data[key] as Record<string, T> | undefined) ?? {};
}

async function setSession<T>(key: string, value: Record<string, T>): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

// Every change to a session map is a read, a change and a write of the whole
// map; two at once would lose one of them (two tabs' captures, say). They run
// one at a time per map. `change` must not wait on the network.
const sessionQueues = new Map<string, Promise<unknown>>();
function updateSession<T, R = void>(key: string, change: (map: Record<string, T>) => R): Promise<R> {
  const run = async () => {
    const map = await getSession<T>(key);
    const out = change(map);
    await setSession(key, map);
    return out;
  };
  const next = (sessionQueues.get(key) ?? Promise.resolve()).then(run, run);
  sessionQueues.set(key, next.catch(() => undefined));
  return next;
}

/** The matching rule fills use: one site, and on localhost or an IP the same host and port. */
function sameSite(a: string, b: string): boolean {
  return matchUrl(a, b) !== null;
}

function isVaultUrl(url: string): boolean {
  const u = parseWebUrl(url);
  return !u || u.origin === SERVICE || u.pathname.startsWith("/apps/clawbox-vault/");
}

function promptOf(c: Capture): SavePrompt | null {
  const host = parseWebUrl(c.url)?.host ?? "";
  if (c.check.kind === "new") return { kind: "new", name: c.check.suggestedName, login: c.login, host };
  if (c.check.kind === "update") return { kind: "update", name: c.check.name, login: c.login, host };
  return null;
}

/** False when the vault could not be asked (locked, unpaired, offline): the page may offer the same login again. */
async function onCapture(tabId: number, url: string, login: string, password: string): Promise<boolean> {
  if (isVaultUrl(url) || !isFillAllowedUrl(url)) return true;
  if (!(await token())) return false;
  if (!login) {
    const pending = (await getSession<PendingLogin>("pendingLogins"))[tabId];
    if (pending && Date.now() - pending.at < 5 * 60_000 && sameSite(pending.url, url)) login = pending.login;
  }
  let check: SaveCheck | { kind: "ignore" };
  try {
    check = await api<SaveCheck | { kind: "ignore" }>("/api/ext/check", { body: { url, login, password } });
  } catch {
    return false; // locked, unpaired or offline: nothing to offer
  }
  if (check.kind === "ignore" || check.kind === "same") return true;
  const capture: Capture = { url, login, password, at: Date.now(), check };
  await updateSession<Capture>("captures", (captures) => {
    captures[tabId] = capture;
  });
  const prompt = promptOf(capture);
  if (prompt) await chrome.tabs.sendMessage(tabId, { type: "show-save", prompt }, { frameId: 0 }).catch(() => undefined);
  return true;
}

async function pendingPrompt(tabId: number): Promise<SavePrompt | null> {
  const c = (await getSession<Capture>("captures"))[tabId];
  if (!c) return null;
  if (Date.now() - c.at > CAPTURE_TTL_MS) {
    await updateSession<Capture>("captures", (captures) => {
      if (captures[tabId]?.at === c.at) delete captures[tabId];
    });
    return null;
  }
  return promptOf(c);
}

async function saveCapture(tabId: number, name: string): Promise<{ ok: boolean; error?: string; name?: string }> {
  const captures = await getSession<Capture>("captures");
  const c = captures[tabId];
  if (!c) return { ok: false, error: "Nothing to save any more." };
  const isNew = c.check.kind === "new";
  try {
    const out = await api<{ name: string }>("/api/ext/save", {
      body: {
        name: isNew ? name || defaultEntryName(c.url, c.login) : (c.check as { name: string }).name,
        login: c.login,
        url: isNew ? (parseWebUrl(c.url)?.origin ?? c.url) : undefined,
        password: c.password,
        mode: isNew ? "create" : "update",
      },
    });
    await updateSession<Capture>("captures", (map) => {
      if (map[tabId]?.at === c.at) delete map[tabId];
    });
    return { ok: true, name: out.name };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : "Could not save." };
  }
}

async function dropCapture(tabId: number): Promise<void> {
  await updateSession<Capture>("captures", (captures) => {
    delete captures[tabId];
  });
}

// ---- cards ------------------------------------------------------------------------------

interface CardSecret {
  name: string;
  number: string;
  cardholder: string;
  exp: string;
  cvv: string;
  brand: string;
}

type InjectedCardProbe = Omit<CardFrameProbe, "frameId"> | null;

async function probeCardFrames(tabId: number): Promise<CardFrameProbe[]> {
  const run = () =>
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (): InjectedCardProbe => globalThis.__clawboxVault?.probeCard?.() ?? null,
    });
  let results = await run();
  if (results.some((r) => r.result == null)) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["build/content.js"] }).catch(() => undefined);
    results = await run();
  }
  return results.filter((r) => r.result).map((r) => ({ frameId: r.frameId, ...(r.result as Omit<CardFrameProbe, "frameId">) }));
}

/** Only the parts of the card a frame has fields for. */
function cardDataFor(kinds: CardFieldKind[], s: CardSecret): CardData {
  const has = (...k: CardFieldKind[]) => k.some((x) => kinds.includes(x));
  const d: CardData = { brand: s.brand };
  if (has("number")) d.number = s.number;
  if (has("name", "givenName", "familyName") && s.cardholder) d.cardholder = s.cardholder;
  if (has("exp", "expMonth", "expYear")) d.exp = s.exp;
  if (has("cvc") && s.cvv) d.cvv = s.cvv;
  return d;
}

const KIND_TEXT: Partial<Record<string, string>> = { number: "number", exp: "expiry", expMonth: "expiry", expYear: "expiry", name: "name", givenName: "name", familyName: "name", cvc: "security code", type: "card type" };

async function fillCardFrames(tabId: number, plan: Extract<CardPlan, { status: "ok" }>, secret: CardSecret): Promise<CardFillReply> {
  const filled = new Set<string>();
  const missing = new Set<string>();
  const rejected = new Set<string>();
  let refused = 0;
  for (const t of plan.targets) {
    let r: GuardedCardOutcome | undefined;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [t.frameId] },
        func: (d: CardData, o: string, top: string, pay: boolean) =>
          globalThis.__clawboxVault ? globalThis.__clawboxVault.fillCard({ data: d, allowedOrigin: o, topOrigin: top, paymentFrame: pay }) : { status: "no_form" as const },
        args: [cardDataFor(t.kinds, secret), t.origin, plan.topOrigin, t.paymentFrame],
      });
      r = res?.result as GuardedCardOutcome | undefined;
    } catch {
      r = undefined;
    }
    if (!r) continue;
    if (r.status === "origin_mismatch") {
      refused++;
      continue;
    }
    for (const k of r.filled ?? []) filled.add(k);
    for (const k of r.missing ?? []) missing.add(k);
    for (const k of r.rejected ?? []) rejected.add(k);
  }
  for (const k of filled) {
    missing.delete(k);
    rejected.delete(k);
  }
  const textOf = (kinds: Set<string>) => [...new Set([...kinds].map((k) => KIND_TEXT[k] ?? k))].join(", ");
  if (!filled.size) {
    if (refused) return { status: "origin_mismatch", detail: "the frame refused the card" };
    if (rejected.size) return { status: "error", detail: `the page's card fields did not take the ${textOf(rejected)}` };
    return { status: "no_form" };
  }
  const notes = [`filled ${textOf(filled)}`];
  if (rejected.size) notes.push(`the page did not take the ${textOf(rejected)}: check it`);
  if (missing.has("cvc")) notes.push("no security code stored: type it");
  if (plan.skipped) notes.push(`${plan.skipped} frame(s) from other sites left alone`);
  return { status: "filled", filled: [...filled], missing: [...missing], detail: notes.join("; ") };
}

/** A fill the human started in this tab (popup click or picker pick). */
async function userCardFill(tabId: number, tabUrl: string, name: string, via: "popup" | "chip"): Promise<CardFillReply> {
  const plan = planCardFill(await probeCardFrames(tabId), tabUrl, { allowPaymentFrames: true });
  if (plan.status !== "ok") return plan;
  const secret = await api<CardSecret>("/api/ext/card-secret", { body: { name, pageUrl: tabUrl, via } });
  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (!now?.url || originOf(now.url) !== plan.topOrigin) return { status: "origin_mismatch", detail: "the tab left the checkout page" };
  return fillCardFrames(tabId, plan, secret);
}

async function cardList(): Promise<CardView[]> {
  return (await api<{ cards: CardView[] }>("/api/ext/cards")).cards ?? [];
}

const pickerView = (c: CardView) => ({ name: c.name, label: c.label, brand: c.brand, last4: c.last4, exp: c.exp, expired: c.expired });

// Agent card fills: a confirmation window per command; nothing runs without Confirm.

type Decision = "confirm" | "decline" | "timeout";

interface PendingConfirm {
  cmd: FillCommand;
  host: string;
  paymentHosts: string[];
  via: "agent" | "chip";
  windowId?: number;
  resolve: (d: Decision) => void;
}

const confirms = new Map<string, PendingConfirm>();
const CONFIRM_URL = chrome.runtime.getURL("confirm.html");

/**
 * The human's Confirm is what starts an agent card fill in that tab: only then
 * may it reach the tab's payment provider frames, which the window names.
 */
function askHuman(cmd: FillCommand, host: string, paymentHosts: string[], via: "agent" | "chip" = "agent"): Promise<Decision> {
  return new Promise((resolve) => {
    let done = false;
    const left = Date.parse(cmd.confirmBy ?? "") - Date.now();
    const pending: PendingConfirm = { cmd, host, paymentHosts, via, resolve: (d) => finish(d) };
    const finish = (d: Decision) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      confirms.delete(cmd.id);
      if (pending.windowId !== undefined) void chrome.windows.remove(pending.windowId).catch(() => undefined);
      resolve(d);
    };
    const timer = setTimeout(() => finish("timeout"), Number.isFinite(left) ? Math.max(1_000, left) : 60_000);
    confirms.set(cmd.id, pending);
    chrome.windows
      .create({ url: `${CONFIRM_URL}#${encodeURIComponent(cmd.id)}`, type: "popup", width: 460, height: 440, focused: true })
      .then((w) => {
        pending.windowId = w?.id;
        if (done && w?.id !== undefined) void chrome.windows.remove(w.id).catch(() => undefined);
      })
      .catch(() => finish("decline"));
  });
}

async function handleCardCommand(cmd: FillCommand): Promise<void> {
  try {
    const tab = pickCardTab(await chrome.tabs.query({}), cmd.url);
    if (tab.status !== "ok") return report(cmd.id, tab.status, tab.detail);
    // No point asking the human about a tab without a fillable card form.
    const plan = planCardFill(await probeCardFrames(tab.tabId), tab.url, { allowPaymentFrames: true });
    if (plan.status !== "ok") return report(cmd.id, plan.status, plan.detail);
    await chrome.tabs.update(tab.tabId, { active: true }).catch(() => undefined);
    const paymentHosts = [...new Set(plan.targets.filter((t) => t.paymentFrame).map((t) => new URL(t.origin).host))];
    const decision = await askHuman(cmd, parseWebUrl(tab.url)?.host ?? "", paymentHosts);
    if (decision === "timeout") return; // the service answers the agent with "timeout"
    await api("/api/ext/card-decision", { body: { id: cmd.id, decision } });
    if (decision !== "confirm") return;
    const now = await chrome.tabs.get(tab.tabId).catch(() => null);
    if (!now?.url || originOf(now.url) !== plan.topOrigin) return report(cmd.id, "origin_mismatch", "the tab left the checkout page");
    const fresh = planCardFill(await probeCardFrames(tab.tabId), now.url, { allowPaymentFrames: true });
    if (fresh.status !== "ok") return report(cmd.id, fresh.status, fresh.detail);
    const secret = await api<CardSecret>("/api/ext/card-secret", { body: { commandId: cmd.id } });
    const result = await fillCardFrames(tab.tabId, fresh, secret);
    await report(cmd.id, result.status, result.detail);
  } catch (err) {
    await report(cmd.id, "error", err instanceof ApiError ? err.message : "card fill failed");
  }
}

function handleConfirm(msg: ConfirmMessage): unknown {
  const p = confirms.get(String(msg.id ?? ""));
  if (!p) return { error: "This request is no longer open." };
  if (msg.type === "confirm:details") {
    const c = p.cmd.card;
    const details: ConfirmDetails = {
      host: p.host,
      label: c?.label ?? "",
      brand: c?.brand ?? "",
      last4: c?.last4 ?? "",
      exp: c?.exp ?? "",
      paymentHosts: p.paymentHosts,
      remainingMs: Math.max(0, Date.parse(p.cmd.confirmBy ?? "") - Date.now() || 0),
      via: p.via,
    };
    return details;
  }
  p.resolve(msg.decision === "confirm" ? "confirm" : "decline");
  return { ok: true };
}

// Cards typed at checkout (card save bar).

type CardCheck =
  | { kind: "new"; suggestedLabel: string; brand: string; last4: string; exp: string }
  | { kind: "update"; name: string; label: string; brand: string; last4: string; exp: string }
  | { kind: "same" | "ignore" };

interface CardCapture {
  url: string;
  number: string;
  exp: string;
  cardholder: string;
  cvv: string;
  at: number;
  check: Extract<CardCheck, { kind: "new" | "update" }>;
}

function cardPromptOf(c: CardCapture): CardSavePrompt {
  const host = parseWebUrl(c.url)?.host ?? "";
  const label = c.check.kind === "new" ? c.check.suggestedLabel : c.check.label;
  return { kind: c.check.kind, label, brand: c.check.brand, last4: c.check.last4, exp: c.check.exp, host, hasCvv: Boolean(c.cvv) };
}

/** False when the vault could not be asked (locked, unpaired, offline): the page may offer the same card again. */
async function onCardCapture(tabId: number, frameOrigin: string | null, tabUrl: string | undefined, msg: Extract<ContentMessage, { type: "content:card-capture" }>): Promise<boolean> {
  const url = String(msg.url ?? "");
  if (isVaultUrl(url) || !isFillAllowedUrl(url)) return true;
  if (!(await token())) return false;
  // Only the page's own frames (top or same-origin) report typed cards.
  const top = originOf(tabUrl);
  if (!top || originOf(url) !== top || frameOrigin !== top) return true;
  const typed = { number: String(msg.number ?? "").slice(0, 32), exp: String(msg.exp ?? "").slice(0, 10), cardholder: String(msg.cardholder ?? "").slice(0, 100), cvv: String(msg.cvv ?? "").slice(0, 4) };
  let check: CardCheck;
  try {
    check = await api<CardCheck>("/api/ext/card-check", { body: { url, number: typed.number, exp: typed.exp, cardholder: typed.cardholder } });
  } catch {
    return false;
  }
  if (check.kind !== "new" && check.kind !== "update") return true;
  const capture: CardCapture = { url, ...typed, at: Date.now(), check };
  await updateSession<CardCapture>("cardCaptures", (captures) => {
    captures[tabId] = capture;
  });
  await chrome.tabs.sendMessage(tabId, { type: "show-card-save", prompt: cardPromptOf(capture) }, { frameId: 0 }).catch(() => undefined);
  return true;
}

async function pendingCardPrompt(tabId: number): Promise<CardSavePrompt | null> {
  const c = (await getSession<CardCapture>("cardCaptures"))[tabId];
  if (!c) return null;
  if (Date.now() - c.at > CAPTURE_TTL_MS) {
    await updateSession<CardCapture>("cardCaptures", (captures) => {
      if (captures[tabId]?.at === c.at) delete captures[tabId];
    });
    return null;
  }
  return cardPromptOf(c);
}

async function dropCardCapture(tabId: number): Promise<void> {
  await updateSession<CardCapture>("cardCaptures", (captures) => {
    delete captures[tabId];
  });
}

/** Stored only now, after the human clicked Save in the card save bar. */
async function saveCardCapture(tabId: number, label: string, saveCvv: boolean): Promise<{ ok: boolean; error?: string; name?: string }> {
  const captures = await getSession<CardCapture>("cardCaptures");
  const c = captures[tabId];
  if (!c) return { ok: false, error: "Nothing to save any more." };
  const common = { number: c.number, exp: c.exp, cardholder: c.cardholder, url: parseWebUrl(c.url)?.origin, ...(saveCvv && c.cvv ? { cvv: c.cvv } : {}) };
  const body = c.check.kind === "new" ? { ...common, mode: "create", label: label.slice(0, 60) || c.check.suggestedLabel } : { ...common, mode: "update", name: c.check.name };
  try {
    const out = await api<{ name: string }>("/api/ext/card-save", { body });
    await dropCardCapture(tabId);
    return { ok: true, name: out.name };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : "Could not save." };
  }
}

// The picker opens only from a chip click; the pick must come back from the
// top frame of the same tab with the ticket handed out for that click.
const PICKER_TTL_MS = 2 * 60_000;
// How long the confirmation of a chip pick stays open.
const CHIP_CONFIRM_MS = 60_000;

async function handleCardContent(msg: ContentMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab!.id!;
  const tabUrl = sender.tab?.url;
  const frameId = sender.frameId ?? 0;
  const frameOrigin = sender.origin ?? originOf(sender.url);
  switch (msg.type) {
    case "content:card-chip": {
      if (!(await token()) || !chipAllowed(frameId, frameOrigin ?? undefined, tabUrl) || isVaultUrl(tabUrl ?? "")) return { show: false };
      const cards = await cardList().catch(() => []);
      return { show: cards.length > 0 };
    }
    case "content:card-chip-click": {
      if (!chipAllowed(frameId, frameOrigin ?? undefined, tabUrl) || isVaultUrl(tabUrl ?? "")) return null;
      const cards = (await cardList()).map(pickerView);
      const nonce = crypto.randomUUID();
      await updateSession<{ nonce: string; at: number }>("pickers", (pickers) => {
        pickers[tabId] = { nonce, at: Date.now() };
      });
      await chrome.tabs.sendMessage(tabId, { type: "show-card-picker", host: parseWebUrl(tabUrl)?.host ?? "", cards, nonce }, { frameId: 0 });
      return null;
    }
    case "content:card-pick": {
      const pickers = await getSession<{ nonce: string; at: number }>("pickers");
      const ticket = pickers[tabId];
      if (frameId !== 0 || !ticket || ticket.nonce !== msg.nonce || Date.now() - ticket.at > PICKER_TTL_MS) {
        return { status: "error", detail: "Click the card chip again." };
      }
      if (!tabUrl) return { status: "no_tab" };
      const name = String(msg.name ?? "");
      // The pick happened on the page, which can stage a click on the picker:
      // the card is released only after Confirm in the extension's own window.
      const card = (await cardList()).find((c) => c.name === name);
      if (!card) return { status: "error", detail: "That card is not in the vault any more." };
      const plan = planCardFill(await probeCardFrames(tabId), tabUrl, { allowPaymentFrames: true });
      if (plan.status !== "ok") return plan;
      const paymentHosts = [...new Set(plan.targets.filter((t) => t.paymentFrame).map((t) => new URL(t.origin).host))];
      const pick: FillCommand = {
        id: crypto.randomUUID(),
        kind: "card",
        url: tabUrl,
        name,
        entryUrl: plan.topOrigin,
        submit: false,
        createdAt: new Date().toISOString(),
        card: { label: card.label, brand: card.brand, last4: card.last4, exp: card.exp },
        confirmBy: new Date(Date.now() + CHIP_CONFIRM_MS).toISOString(),
      };
      const decision = await askHuman(pick, parseWebUrl(tabUrl)?.host ?? "", paymentHosts, "chip");
      if (decision !== "confirm") return { status: "declined", detail: decision === "timeout" ? "Nobody confirmed: nothing was filled." : "Declined: nothing was filled." };
      const reply = await userCardFill(tabId, tabUrl, name, "chip");
      if (reply.status === "filled") {
        await updateSession<{ nonce: string; at: number }>("pickers", (p) => {
          if (p[tabId]?.nonce === ticket.nonce) delete p[tabId];
        });
      }
      return reply;
    }
    case "content:card-capture":
      return { accepted: await onCardCapture(tabId, frameOrigin, tabUrl, msg) };
    case "content:pending-card-save":
      return frameId === 0 ? pendingCardPrompt(tabId) : null;
    case "content:card-save":
      return frameId === 0 ? saveCardCapture(tabId, String(msg.label ?? ""), msg.saveCvv === true) : { ok: false };
    case "content:card-dismiss":
      await dropCardCapture(tabId);
      return null;
  }
  return null;
}

async function handleContent(msg: ContentMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab!.id!;
  if (msg.type.startsWith("content:card") || msg.type === "content:pending-card-save") {
    // A build with cards off sends none of these; one that arrives anyway is dropped unread.
    if (!CARDS_ENABLED) return msg.type === "content:card-chip" ? { show: false } : null;
    return handleCardContent(msg, sender);
  }
  switch (msg.type) {
    case "content:capture":
      return { accepted: await onCapture(tabId, msg.url, String(msg.login ?? ""), String(msg.password ?? "")) };
    case "content:capture-login": {
      if (isVaultUrl(msg.url)) return null;
      await updateSession<PendingLogin>("pendingLogins", (pending) => {
        pending[tabId] = { url: msg.url, login: String(msg.login ?? "").slice(0, 500), at: Date.now() };
      });
      return null;
    }
    case "content:pending-save":
      return pendingPrompt(tabId);
    case "content:save":
      return saveCapture(tabId, String(msg.name ?? ""));
    case "content:dismiss":
      await dropCapture(tabId);
      return null;
  }
  return null;
}

// ---- popup ---------------------------------------------------------------------------

const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("/")).origin;

/** The page the user is looking at; when popup.html runs in a window of its own, the most recent normal tab. */
async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.url && !tab.url.startsWith(EXTENSION_ORIGIN)) return tab;
  const tabs = await chrome.tabs.query({ active: true, windowType: "normal" });
  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return tabs.find((t) => t.url && !t.url.startsWith(EXTENSION_ORIGIN)) ?? null;
}

async function popupState(): Promise<PopupState> {
  const tab = await activeTab();
  const tabUrl = tab?.url && parseWebUrl(tab.url) ? tab.url : null;
  const base: PopupState = { paired: false, locked: false, online: false, serviceUrl: SERVICE, tabUrl, fillAllowed: isFillAllowedUrl(tabUrl), cards: CARDS_ENABLED };
  // On the box's own browser the popup never has to ask for a code.
  if (!(await token())) await autoPair();
  if (!(await token())) {
    const online = await fetch(`${SERVICE}/api/health`, { cache: "no-store" }).then((r) => r.ok, () => false);
    return { ...base, online };
  }
  try {
    const s = await api<{ locked: boolean }>("/api/ext/status");
    void pollLoop();
    return { ...base, paired: true, online: true, locked: s.locked };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { ...base, online: true };
    return { ...base, paired: true, error: "The vault service is not reachable on this machine." };
  }
}

async function pair(code: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${SERVICE}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.replace(/\D/g, "") }),
    cache: "no-store",
    credentials: "omit",
  }).catch(() => null);
  if (!res) return { ok: false, error: "The vault service is not reachable." };
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !data.token) return { ok: false, error: data.error ?? "Pairing failed." };
  await chrome.storage.local.set({ token: data.token });
  void pollLoop();
  return { ok: true };
}

/**
 * Pair without a code, on the box's own browser. The vault service built this
 * extension's folder and left pairing.json in it: a secret no web page can
 * read (it is not web-accessible) and that only this run of the service
 * accepts. The service says "not yet" until the owner has chosen a PIN, and
 * "off" after the owner unpaired this browser; both simply leave it unpaired.
 */
let autoPairing: Promise<boolean> | null = null;

function autoPair(): Promise<boolean> {
  autoPairing ??= (async () => {
    try {
      const file = await fetch(chrome.runtime.getURL("pairing.json"), { cache: "no-store" });
      if (!file.ok) return false;
      const { secret } = (await file.json()) as { secret?: unknown };
      if (typeof secret !== "string" || !secret) return false;
      const res = await fetch(`${SERVICE}/api/pair/auto`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
        cache: "no-store",
        credentials: "omit",
      });
      const data = (await res.json().catch(() => ({}))) as { token?: string };
      if (!res.ok || !data.token) return false;
      await chrome.storage.local.set({ token: data.token });
      return true;
    } catch {
      return false; // no pairing file (a browser paired by code) or the service is down
    } finally {
      autoPairing = null;
    }
  })();
  return autoPairing;
}

/** Keep the fill connection open; pair first where this browser can do that by itself. */
async function connect(): Promise<void> {
  if (!(await token())) await autoPair();
  void pollLoop();
}

async function handlePopup(msg: PopupMessage): Promise<unknown> {
  if (!CARDS_ENABLED && (msg.type === "popup:cards" || msg.type === "popup:card-fill")) {
    return msg.type === "popup:cards" ? { cards: [], fillAllowed: false } : { status: "error", detail: "Cards are off." };
  }
  switch (msg.type) {
    case "popup:state":
      return popupState();
    case "popup:pair":
      return pair(String(msg.code ?? ""));
    case "popup:unpair":
      await api("/api/ext/unpair", { body: {} }).catch(() => undefined);
      await chrome.storage.local.remove("token");
      return { ok: true };
    case "popup:lock":
      await api("/api/ext/lock", { body: {} });
      return { ok: true };
    case "popup:unlock":
      await api("/api/ext/unlock", { body: { pin: String(msg.pin ?? "") } });
      return { ok: true };
    case "popup:match": {
      const tab = await activeTab();
      if (!tab?.url || !parseWebUrl(tab.url)) return { entries: [], fillAllowed: false };
      return api<{ entries: EntryView[]; fillAllowed: boolean }>(`/api/ext/match?url=${encodeURIComponent(tab.url)}`);
    }
    case "popup:search":
      return api<{ entries: EntryView[] }>(`/api/ext/entries?q=${encodeURIComponent(String(msg.query ?? ""))}`);
    case "popup:fill": {
      const tab = await activeTab();
      if (!tab?.id || !tab.url) return { status: "no_tab" };
      const secret = await api<{ login: string; password: string; entryUrl: string }>("/api/ext/secret", {
        body: { name: msg.name, purpose: "fill", pageUrl: tab.url },
      });
      return fillTab(tab.id, tab.url, secret.entryUrl, secret.login, secret.password, false);
    }
    case "popup:copy-password": {
      const secret = await api<{ password: string }>("/api/ext/secret", { body: { name: msg.name, purpose: "copy" } });
      await copyToClipboard(secret.password, true);
      return { ok: true, clearsInSeconds: CLIPBOARD_CLEAR_MS / 1000 };
    }
    case "popup:copy-text":
      // Generated passwords (not yet saved) get the same 30 s auto-clear.
      await copyToClipboard(String(msg.text ?? "").slice(0, 1024), true);
      return { ok: true, clearsInSeconds: CLIPBOARD_CLEAR_MS / 1000 };
    case "popup:save":
      return api<{ name: string; created: boolean }>("/api/ext/save", { body: { ...msg.entry, mode: msg.mode } });
    case "popup:cards": {
      const tab = await activeTab();
      const cards = await cardList();
      return { cards, fillAllowed: Boolean(tab?.url && isFillAllowedUrl(tab.url) && !isVaultUrl(tab.url)) };
    }
    case "popup:card-fill": {
      const tab = await activeTab();
      if (!tab?.id || !tab.url) return { status: "no_tab" };
      if (!isFillAllowedUrl(tab.url) || isVaultUrl(tab.url)) return { status: "origin_mismatch", detail: "This page is not https://, so no card is filled." };
      return userCardFill(tab.id, tab.url, String(msg.name ?? ""), "popup");
    }
  }
  return null;
}

// ---- wiring --------------------------------------------------------------------------------

const POPUP_URL = chrome.runtime.getURL("popup.html");

chrome.runtime.onMessage.addListener((msg: { type?: string; target?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg.target === "offscreen") return false;
  let work: Promise<unknown> | null = null;
  const type = typeof msg.type === "string" ? msg.type : "";
  // Extension pages are told apart by URL: web pages cannot load them (no
  // web_accessible_resources), and content scripts report the page's URL.
  if (sender.url?.startsWith(CONFIRM_URL) && type.startsWith("confirm:")) {
    work = Promise.resolve(handleConfirm(msg as ConfirmMessage));
  } else if (sender.url?.startsWith(POPUP_URL) && type.startsWith("popup:")) {
    work = handlePopup(msg as PopupMessage);
  } else if (sender.tab?.id !== undefined && !sender.url?.startsWith(EXTENSION_ORIGIN) && type.startsWith("content:")) {
    work = handleContent(msg as ContentMessage, sender);
  }
  if (!work) return false;
  work.then(
    (value) => sendResponse(value ?? null),
    (err) => sendResponse({ error: err instanceof ApiError ? err.message : "Something went wrong.", status: err?.status }),
  );
  return true;
});

chrome.windows.onRemoved.addListener((windowId) => {
  // Closing the confirmation window is a decline.
  for (const p of confirms.values()) if (p.windowId === windowId) p.resolve("decline");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void dropCapture(tabId);
  void dropCardCapture(tabId);
  void updateSession<{ nonce: string; at: number }>("pickers", (p) => {
    delete p[tabId];
  });
  void updateSession<PendingLogin>("pendingLogins", (p) => {
    delete p[tabId];
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "clipboard-clear") void clearClipboard();
  if (alarm.name === "vault-poll") void connect();
});

chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  void connect();
});
void chrome.alarms.create("vault-poll", { periodInMinutes: 0.5 });
void connect();
