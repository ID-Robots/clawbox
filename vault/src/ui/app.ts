// Desktop app for ClawBox Vault. Talks only to its own service with relative
// URLs (works at /apps/clawbox-vault/ behind ClawBox and on 127.0.0.1:4796).
// The PIN session token lives in memory only: a reload locks the vault again.
// Card numbers and security codes are shown only after an explicit Reveal (or
// copied on Copy) in the unlocked session, and hidden again after 30 s.
import { BRAND_NAMES, cardBrand, digitsOf, formatNumber, luhnValid, type CardBrand } from "../shared/card";
import { entropyBits, generatePassword } from "../shared/generator";

interface EntryMeta {
  name: string;
  login: string;
  url: string;
  updated: string;
}

interface EntryDetail extends EntryMeta {
  note: string;
  has2fa: boolean;
  extraLines: number;
}

interface CardMeta {
  name: string;
  label: string;
  brand: CardBrand;
  last4: string;
  exp: string;
  expired: boolean;
  cardholder: string;
  updated: string;
}

interface CardDetail extends CardMeta {
  note: string;
  hasCvv: boolean;
  extraLines: number;
}

interface AuditRecord {
  ts: string;
  actor: string;
  action: string;
  name?: string;
  host?: string;
  status?: string;
  detail?: string;
}

interface Info {
  version: string;
  extensionDir: string;
  storeDir: string;
  serviceUrl: string;
  cards: boolean;
}

interface Status {
  pinSet: boolean;
  /** Payment cards are off unless the service was started with them on. */
  cards?: boolean;
  store?: { ready: boolean; error?: string };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let session: string | null = null;
let entries: EntryMeta[] = [];
let selected: string | null = null;
let info: Info | null = null;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`./api/${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    credentials: "omit",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; retryAfterMs?: number };
  if (!res.ok) {
    if (res.status === 401 && session && path.startsWith("ui/") && !path.startsWith("ui/pin")) lockScreen("The vault locked itself after a period of inactivity.");
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.retryAfterMs ?? 0);
  }
  return data;
}

// ---- small helpers ------------------------------------------------------------------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, kind: "ok" | "bad" = "ok"): void {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; title?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  el.append(...children);
  return el;
}

function btn(label: string, onClick: () => void, cls = "btn small"): HTMLButtonElement {
  const b = h("button", { class: cls, text: label });
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return "";
  }
}

function avatar(name: string): HTMLElement {
  const letter = (name.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  let sum = 0;
  for (const ch of name) sum = (sum + ch.charCodeAt(0)) % 4;
  return h("div", { class: `avatar${sum ? ` alt${sum}` : ""}`, text: letter });
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Clipboard that also works on plain-http LAN origins (no async clipboard there). */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // e.g. an embedding frame without clipboard-write permission: try the copy event below
    }
  }
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy, { once: true });
  const ok = document.execCommand("copy");
  document.removeEventListener("copy", onCopy);
  if (!ok) throw new Error("The browser blocked the clipboard. Select the text and copy it by hand.");
}

/** Copy and say so, or say why not. */
function copyWithToast(text: string, done: string): void {
  copyText(text).then(
    () => toast(done),
    (err) => toast((err as Error).message, "bad"),
  );
}

let clipboardTimer: ReturnType<typeof setTimeout> | undefined;
async function copySecret(text: string): Promise<void> {
  await copyText(text);
  clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(() => void copyText("").catch(() => undefined), 30_000);
}

// ---- lock screen ------------------------------------------------------------------------

let gateMode: "setup" | "unlock" = "unlock";

function lockScreen(message?: string): void {
  session = null;
  entries = [];
  selected = null;
  // Nothing typed or generated may stay on screen above the lock gate.
  stopPairingTimer();
  for (const id of ["dlg-edit", "dlg-confirm", "dlg-pin", "dlg-card"]) {
    const dialog = $<HTMLDialogElement>(id);
    if (dialog.open) dialog.close();
  }
  for (const id of ["edit-password", "edit-2fa", "pin-current", "pin-next", "pin-next2", "card-number", "card-cvv"]) $<HTMLInputElement>(id).value = "";
  cards = [];
  selectedCard = null;
  $("card-list").replaceChildren();
  resetCardDetail();
  $("gen-output").textContent = "";
  $("pair-code-box").hidden = true;
  $("shell").hidden = true;
  $("gate").hidden = false;
  $("entry-list").replaceChildren();
  resetDetail();
  $("gate-error").textContent = message ?? "";
  $<HTMLInputElement>("gate-pin").value = "";
  $<HTMLInputElement>("gate-pin2").value = "";
  $<HTMLInputElement>("gate-pin").focus();
}

/** Card screens exist only when the service has cards on; everything else is the password manager. */
function applyCards(on: boolean): void {
  $("nav-cards").hidden = !on;
  $("agent-card-tools").hidden = !on;
  $("agent-card-note").hidden = !on;
}

async function boot(): Promise<void> {
  const status = await api<Status>("ui/status").catch(() => null);
  if (!status) {
    $("gate").hidden = false;
    $("gate-error").textContent = "The vault service is not reachable.";
    return;
  }
  applyCards(status.cards === true);
  setGateMode(status.pinSet ? "unlock" : "setup");
  lockScreen(status.store && !status.store.ready ? `The password store is not ready: ${status.store.error ?? "it is still being prepared"}.` : undefined);
}

function setGateMode(mode: "setup" | "unlock"): void {
  gateMode = mode;
  const unlock = mode === "unlock";
  $("gate-text").textContent = unlock ? "Unlock with your vault PIN." : "Choose a vault PIN. You will need it to open this app and to unlock the browser extension. Nothing is saved or filled until you do.";
  $("gate-submit").textContent = unlock ? "Unlock" : "Set PIN and open";
  $("gate-pin2").hidden = unlock;
  $<HTMLInputElement>("gate-pin2").required = !unlock;
  $("gate-hint").textContent = unlock ? "" : "At least 6 characters. The assistant never needs this PIN.";
}

async function submitGate(ev: Event): Promise<void> {
  ev.preventDefault();
  const pin = $<HTMLInputElement>("gate-pin").value;
  $("gate-error").textContent = "";
  try {
    if (gateMode === "setup") {
      if (pin !== $<HTMLInputElement>("gate-pin2").value) {
        $("gate-error").textContent = "The two PINs differ.";
        return;
      }
      session = (await api<{ token: string }>("ui/setup", { body: { pin } })).token;
      // From now on the lock screen asks for this PIN instead of a new one.
      setGateMode("unlock");
    } else {
      session = (await api<{ token: string }>("ui/unlock", { body: { pin } })).token;
    }
  } catch (err) {
    const e = err as ApiError;
    $("gate-error").textContent = e.retryAfterMs ? `Too many attempts. Try again in ${Math.ceil(e.retryAfterMs / 1000)} s.` : e.message;
    $<HTMLInputElement>("gate-pin").select();
    return;
  }
  $<HTMLInputElement>("gate-pin").value = "";
  $<HTMLInputElement>("gate-pin2").value = "";
  $("gate").hidden = true;
  $("shell").hidden = false;
  await Promise.all([loadInfo(), loadEntries()]);
  showView("entries");
}

// ---- views --------------------------------------------------------------------------------

type View = "entries" | "cards" | "generator" | "extension" | "agent" | "activity";

function showView(view: View): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".nav-item")) b.classList.toggle("active", b.dataset.view === view);
  for (const v of ["entries", "cards", "generator", "extension", "agent", "activity"]) $(`view-${v}`).hidden = v !== view;
  if (view === "cards") void loadCards().catch((err) => toast((err as Error).message, "bad"));
  else if (selectedCard) {
    // Leaving the view hides any revealed number or code.
    selectedCard = null;
    resetCardDetail();
  }
  if (view === "generator") regenerate();
  if (view === "extension") void loadPairing();
  if (view === "activity") void loadAudit();
  if (view !== "extension") stopPairingTimer();
}

async function loadInfo(): Promise<void> {
  info = await api<Info>("ui/info");
  $("version").textContent = `v${info.version}`;
  applyCards(info.cards === true);
}

// ---- entries ---------------------------------------------------------------------------------

async function loadEntries(): Promise<void> {
  const q = $<HTMLInputElement>("search").value.trim();
  const res = await api<{ entries: EntryMeta[] }>(`ui/entries${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  entries = res.entries;
  renderEntries();
}

function renderEntries(): void {
  const list = $("entry-list");
  list.replaceChildren();
  const q = $<HTMLInputElement>("search").value.trim();
  $("entries-count").textContent = q
    ? `${entries.length} matching ${entries.length === 1 ? "entry" : "entries"}.`
    : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} in the vault.`;
  if (!entries.length) {
    list.append(h("li", { class: "empty", text: q ? "Nothing matches." : "No entries yet. Add one, or save a login from the browser." }));
    if (!selected && !q) {
      $("detail").replaceChildren(h("div", { class: "placeholder" }, h("p", { class: "muted", text: "Entry details show up here once the vault holds a login." })));
    }
    return;
  }
  for (const e of entries) {
    const li = h(
      "li",
      { class: `entry-item${e.name === selected ? " selected" : ""}`, title: e.name },
      avatar(e.name),
      h("div", { class: "entry-text" }, h("div", { class: "entry-name", text: e.name }), h("div", { class: "entry-sub", text: [e.login, hostOf(e.url)].filter(Boolean).join(" · ") || "—" })),
    );
    li.tabIndex = 0;
    li.addEventListener("click", () => void selectEntry(e.name));
    li.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void selectEntry(e.name);
    });
    list.append(li);
  }
}

let revealTimer: ReturnType<typeof setTimeout> | undefined;

function resetDetail(): void {
  clearTimeout(revealTimer);
  $("detail").replaceChildren(h("div", { class: "placeholder" }, h("p", { class: "muted", text: "Select an entry to see its details." })));
}

async function selectEntry(name: string): Promise<void> {
  selected = name;
  renderEntries();
  clearTimeout(revealTimer);
  let d: EntryDetail;
  try {
    d = await api<EntryDetail>(`ui/entry?name=${encodeURIComponent(name)}`);
  } catch (err) {
    toast((err as Error).message, "bad");
    return;
  }
  const secret = h("span", { class: "secret", text: "••••••••••••" });
  const revealBtn = btn("Reveal", () => void toggleReveal());
  let shown = false;
  async function toggleReveal(): Promise<void> {
    if (shown) {
      hide();
      return;
    }
    try {
      const { password } = await api<{ password: string }>("ui/reveal", { body: { name } });
      secret.textContent = password;
      secret.classList.add("revealed");
      revealBtn.textContent = "Hide";
      shown = true;
      clearTimeout(revealTimer);
      revealTimer = setTimeout(hide, 30_000);
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }
  function hide(): void {
    secret.textContent = "••••••••••••";
    secret.classList.remove("revealed");
    revealBtn.textContent = "Reveal";
    shown = false;
  }

  const kv = h("dl", { class: "kv" });
  const row = (label: string, ...value: Node[]) => kv.append(h("dt", { text: label }), h("dd", {}, ...value));
  row("Login", h("span", { class: "val", text: d.login || "—" }), ...(d.login ? [btn("Copy", () => copyWithToast(d.login, "Login copied."))] : []));
  row("URL", h("span", { class: "val", text: d.url || "—" }));
  row(
    "Password",
    secret,
    revealBtn,
    btn("Copy", async () => {
      try {
        const { password } = await api<{ password: string }>("ui/reveal", { body: { name } });
        await copySecret(password);
        toast("Password copied. The clipboard clears in 30 s while this page stays open.");
      } catch (err) {
        toast((err as Error).message, "bad");
      }
    }),
  );
  row("2FA", h("span", { class: "val", text: d.has2fa ? "stored" : "—" }));
  if (d.note) row("Note", h("span", { class: "val", text: d.note }));
  row("Updated", h("span", { class: "val muted", text: when(d.updated) }));
  if (d.extraLines) row("Other lines", h("span", { class: "val muted", text: `${d.extraLines} kept as they are` }));

  const actions = h(
    "div",
    { class: "row" },
    btn("Edit", () => openEdit(d), "btn"),
    btn("Delete", () => confirmDelete(d.name), "btn danger"),
  );
  $("detail").replaceChildren(
    h("div", { class: "detail-head" }, avatar(d.name), h("div", {}, h("div", { class: "detail-title", text: d.name }), h("div", { class: "muted small", text: hostOf(d.url) }))),
    kv,
    actions,
  );
}

// ---- add / edit / delete ----------------------------------------------------------------------

let editOriginal: EntryDetail | null = null;

function openEdit(entry: EntryDetail | null, presetPassword?: string): void {
  editOriginal = entry;
  $("edit-title").textContent = entry ? "Edit entry" : "New entry";
  $<HTMLInputElement>("edit-name").value = entry?.name ?? "";
  $<HTMLInputElement>("edit-login").value = entry?.login ?? "";
  $<HTMLInputElement>("edit-url").value = entry?.url ?? "";
  const pw = $<HTMLInputElement>("edit-password");
  pw.value = presetPassword ?? "";
  pw.type = presetPassword ? "text" : "password";
  pw.required = !entry;
  $("edit-show").textContent = pw.type === "password" ? "Show" : "Hide";
  $("edit-pw-hint").textContent = entry ? "Leave empty to keep the current password." : "";
  $<HTMLInputElement>("edit-2fa").value = "";
  $<HTMLInputElement>("edit-2fa").placeholder = entry?.has2fa ? "stored — type to replace" : "otpauth://… (optional)";
  $("edit-clear2fa-row").hidden = !entry?.has2fa;
  $<HTMLInputElement>("edit-clear2fa").checked = false;
  $<HTMLInputElement>("edit-note").value = entry?.note ?? "";
  $("edit-error").textContent = "";
  $<HTMLDialogElement>("dlg-edit").showModal();
  $<HTMLInputElement>(entry ? "edit-login" : "edit-name").focus();
}

async function submitEdit(ev: Event): Promise<void> {
  ev.preventDefault();
  const body = {
    name: $<HTMLInputElement>("edit-name").value.trim(),
    login: $<HTMLInputElement>("edit-login").value.trim(),
    url: $<HTMLInputElement>("edit-url").value.trim(),
    password: $<HTMLInputElement>("edit-password").value || undefined,
    twofa: $<HTMLInputElement>("edit-2fa").value.trim() || undefined,
    clearTwofa: $<HTMLInputElement>("edit-clear2fa").checked,
    note: $<HTMLInputElement>("edit-note").value.trim(),
    originalName: editOriginal?.name,
    create: !editOriginal,
  };
  try {
    const out = await api<{ name: string }>("ui/entries", { body });
    $<HTMLInputElement>("edit-password").value = "";
    $<HTMLDialogElement>("dlg-edit").close();
    toast(`Saved ${out.name}.`);
    await loadEntries();
    await selectEntry(out.name);
  } catch (err) {
    $("edit-error").textContent = (err as Error).message;
  }
}

let pendingDelete: { name: string; kind: "entry" | "card"; label: string } | null = null;

function confirmDelete(name: string, kind: "entry" | "card" = "entry", label = name): void {
  pendingDelete = { name, kind, label };
  $("confirm-title").textContent = kind === "card" ? "Delete card?" : "Delete entry?";
  $("confirm-text").textContent = `“${label}” will be removed. The vault's history still keeps it.`;
  $<HTMLDialogElement>("dlg-confirm").showModal();
}

async function doDelete(): Promise<void> {
  const target = pendingDelete;
  $<HTMLDialogElement>("dlg-confirm").close();
  if (!target) return;
  try {
    if (target.kind === "card") {
      await api(`ui/card?name=${encodeURIComponent(target.name)}`, { method: "DELETE" });
      toast(`Deleted ${target.label}.`);
      selectedCard = null;
      resetCardDetail();
      await loadCards();
      return;
    }
    await api(`ui/entry?name=${encodeURIComponent(target.name)}`, { method: "DELETE" });
    toast(`Deleted ${target.name}.`);
    selected = null;
    resetDetail();
    await loadEntries();
  } catch (err) {
    toast((err as Error).message, "bad");
  }
}

// ---- cards ---------------------------------------------------------------------------------------------

let cards: CardMeta[] = [];
let selectedCard: string | null = null;
const cardTimers: Array<ReturnType<typeof setTimeout>> = [];

const BRAND_SHORT: Record<string, string> = { visa: "VISA", mastercard: "MC", amex: "AMEX", discover: "DISC", diners: "DINERS", jcb: "JCB", unionpay: "UPAY", maestro: "MAESTRO", mir: "MIR" };

function cardBadge(brand: string): HTMLElement {
  return h("div", { class: `card-badge ${brand}`, text: BRAND_SHORT[brand] ?? "CARD", title: BRAND_NAMES[brand as CardBrand] ?? "Card" });
}

function clearCardTimers(): void {
  for (const t of cardTimers.splice(0)) clearTimeout(t);
}

function resetCardDetail(): void {
  clearCardTimers();
  $("card-detail").replaceChildren(h("div", { class: "placeholder" }, h("p", { class: "muted", text: "Select a card to see its details." })));
}

async function loadCards(): Promise<void> {
  const q = $<HTMLInputElement>("card-search").value.trim();
  const res = await api<{ cards: CardMeta[] }>(`ui/cards${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  cards = res.cards;
  renderCards();
}

function renderCards(): void {
  const list = $("card-list");
  list.replaceChildren();
  const q = $<HTMLInputElement>("card-search").value.trim();
  $("cards-count").textContent = q
    ? `${cards.length} matching ${cards.length === 1 ? "card" : "cards"}.`
    : `${cards.length} ${cards.length === 1 ? "card" : "cards"} in the pass store (cards/).`;
  if (!cards.length) {
    list.append(h("li", { class: "empty", text: q ? "Nothing matches." : "No cards yet. Add one, or save one when you pay in Chrome." }));
    return;
  }
  for (const c of cards) {
    const sub = [`•••• ${c.last4}`, c.exp].join(" · ");
    const li = h(
      "li",
      { class: `entry-item${c.name === selectedCard ? " selected" : ""}`, title: c.label },
      cardBadge(c.brand),
      h(
        "div",
        { class: "entry-text" },
        h("div", { class: "entry-name", text: c.label }),
        h("div", { class: "entry-sub digits", text: c.expired ? `${sub} · expired` : sub }),
      ),
    );
    li.tabIndex = 0;
    li.addEventListener("click", () => void selectCard(c.name));
    li.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void selectCard(c.name);
    });
    list.append(li);
  }
}

/** A masked value with Reveal (hidden again after 30 s) and Copy (clipboard cleared after 30 s). */
function secretRow(name: string, field: "number" | "cvv", masked: string, show: (v: string) => string): Node[] {
  const span = h("span", { class: "secret digits", text: masked });
  const reveal = btn("Reveal", () => void toggle());
  let shown = false;
  const hide = () => {
    span.textContent = masked;
    span.classList.remove("revealed");
    reveal.textContent = "Reveal";
    shown = false;
  };
  async function toggle(): Promise<void> {
    if (shown) return hide();
    try {
      const { value } = await api<{ value: string }>("ui/card-reveal", { body: { name, field, purpose: "reveal" } });
      span.textContent = show(value);
      span.classList.add("revealed");
      reveal.textContent = "Hide";
      shown = true;
      cardTimers.push(setTimeout(hide, 30_000));
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  }
  const copy = btn("Copy", async () => {
    try {
      const { value } = await api<{ value: string }>("ui/card-reveal", { body: { name, field, purpose: "copy" } });
      await copySecret(value);
      toast(`${field === "cvv" ? "Security code" : "Card number"} copied. The clipboard clears in 30 s while this page stays open.`);
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  });
  return [span, reveal, copy];
}

async function selectCard(name: string): Promise<void> {
  selectedCard = name;
  renderCards();
  clearCardTimers();
  let d: CardDetail;
  try {
    d = await api<CardDetail>(`ui/card?name=${encodeURIComponent(name)}`);
  } catch (err) {
    toast((err as Error).message, "bad");
    return;
  }
  const kv = h("dl", { class: "kv" });
  const row = (label: string, ...value: Node[]) => kv.append(h("dt", { text: label }), h("dd", {}, ...value));
  const groups = d.brand === "amex" ? "•••• •••••• •" : "•••• •••• ••••";
  row("Number", ...secretRow(d.name, "number", `${groups} ${d.last4}`, (v) => formatNumber(v)));
  row("Expires", h("span", { class: "val digits", text: d.exp || "—" }), ...(d.expired ? [h("span", { class: "tag bad", text: "expired" })] : []));
  row("Cardholder", h("span", { class: "val", text: d.cardholder || "—" }));
  if (d.hasCvv) row("Security code", ...secretRow(d.name, "cvv", d.brand === "amex" ? "••••" : "•••", (v) => v));
  else row("Security code", h("span", { class: "val muted", text: "not stored" }));
  row("Brand", h("span", { class: "val", text: BRAND_NAMES[d.brand] ?? "Card" }));
  if (d.note) row("Note", h("span", { class: "val", text: d.note }));
  row("Updated", h("span", { class: "val muted", text: when(d.updated) }));
  row("Entry", h("span", { class: "val muted", text: d.name }));
  if (d.extraLines) row("Other lines", h("span", { class: "val muted", text: `${d.extraLines} kept as they are` }));
  const actions = h("div", { class: "row" }, btn("Edit", () => openCardEdit(d), "btn"), btn("Delete", () => confirmDelete(d.name, "card", d.label), "btn danger"));
  $("card-detail").replaceChildren(
    h("div", { class: "detail-head" }, cardBadge(d.brand), h("div", {}, h("div", { class: "detail-title", text: d.label }), h("div", { class: "muted small digits", text: `•••• ${d.last4} · ${d.exp}` }))),
    kv,
    actions,
  );
}

let cardOriginal: CardDetail | null = null;

function setMasked(inputId: string, buttonId: string, masked: boolean): void {
  $(inputId).classList.toggle("masked", masked);
  $(buttonId).textContent = masked ? "Show" : "Hide";
}

function numberHint(): void {
  const digits = digitsOf($<HTMLInputElement>("card-number").value);
  const hint = $("card-number-hint");
  hint.className = "small";
  if (!digits) {
    hint.className = "muted small";
    hint.textContent = cardOriginal ? `Leave empty to keep •••• ${cardOriginal.last4}.` : "";
    return;
  }
  const brand = BRAND_NAMES[cardBrand(digits)];
  if (digits.length < 13) hint.textContent = `${brand} · ${digits.length} digits so far`;
  else if (luhnValid(digits)) {
    hint.textContent = `${brand} · number checks out`;
    hint.classList.add("hint-ok");
  } else {
    hint.textContent = `${brand} · this number fails the Luhn check (typo?)`;
    hint.classList.add("hint-bad");
  }
}

function openCardEdit(card: CardDetail | null): void {
  cardOriginal = card;
  $("card-title").textContent = card ? "Edit card" : "New card";
  $<HTMLInputElement>("card-label").value = card?.label ?? "";
  const number = $<HTMLInputElement>("card-number");
  number.value = "";
  number.required = !card;
  number.placeholder = card ? `•••• ${card.last4} (unchanged)` : "1234 5678 9012 3456";
  setMasked("card-number", "card-number-show", true);
  $<HTMLInputElement>("card-holder").value = card?.cardholder ?? "";
  $<HTMLInputElement>("card-exp").value = card?.exp ?? "";
  const cvv = $<HTMLInputElement>("card-cvv");
  cvv.value = "";
  cvv.placeholder = card?.hasCvv ? "stored — type to replace" : "optional";
  setMasked("card-cvv", "card-cvv-show", true);
  $("card-clearcvv-row").hidden = !card?.hasCvv;
  $<HTMLInputElement>("card-clearcvv").checked = false;
  $<HTMLInputElement>("card-note").value = card?.note ?? "";
  $("card-error").textContent = "";
  numberHint();
  $<HTMLDialogElement>("dlg-card").showModal();
  $<HTMLInputElement>(card ? "card-label" : "card-number").focus();
}

function closeCardEdit(): void {
  $<HTMLInputElement>("card-number").value = "";
  $<HTMLInputElement>("card-cvv").value = "";
  $<HTMLDialogElement>("dlg-card").close();
}

async function submitCard(ev: Event): Promise<void> {
  ev.preventDefault();
  const number = digitsOf($<HTMLInputElement>("card-number").value);
  const body = {
    originalName: cardOriginal?.name,
    label: $<HTMLInputElement>("card-label").value.trim(),
    number: number || undefined,
    cardholder: $<HTMLInputElement>("card-holder").value.trim(),
    exp: $<HTMLInputElement>("card-exp").value.trim(),
    cvv: $<HTMLInputElement>("card-cvv").value.trim() || undefined,
    clearCvv: $<HTMLInputElement>("card-clearcvv").checked,
    note: $<HTMLInputElement>("card-note").value.trim(),
  };
  try {
    const out = await api<{ name: string; card: CardMeta }>("ui/cards", { body });
    closeCardEdit();
    toast(`Saved ${out.card.label} (•••• ${out.card.last4}).`);
    await loadCards();
    await selectCard(out.name);
  } catch (err) {
    $("card-error").textContent = (err as Error).message;
  }
}

// ---- generator ------------------------------------------------------------------------------------

function genOptions() {
  return {
    length: Number($<HTMLInputElement>("gen-length").value),
    symbols: $<HTMLInputElement>("gen-symbols").checked,
    digits: $<HTMLInputElement>("gen-digits").checked,
    upper: $<HTMLInputElement>("gen-upper").checked,
  };
}

function regenerate(): void {
  const opts = genOptions();
  $("gen-length-value").textContent = String(opts.length);
  $("gen-output").textContent = generatePassword(opts);
  const bits = entropyBits(opts);
  $("gen-entropy").textContent = `About ${bits} bits of entropy${bits >= 100 ? " — excellent" : bits >= 70 ? " — strong" : " — consider a longer password"}.`;
  $("gen-bar").style.width = `${Math.min(100, Math.round((bits / 128) * 100))}%`;
}

// ---- extension pairing --------------------------------------------------------------------------------

let pairingTimer: ReturnType<typeof setInterval> | undefined;

function stopPairingTimer(): void {
  clearInterval(pairingTimer);
  pairingTimer = undefined;
}

interface PairingInfo {
  extension: { origin: string; pairedAt: string; locked: boolean } | null;
  pending: { expiresAt: string } | null;
  connected: boolean;
  /** false after an unpair: the box's browser stays out until the owner pairs it again. */
  auto: boolean;
}

async function loadPairing(): Promise<void> {
  const p = await api<PairingInfo>("ui/pairing");
  const box = $("pair-status");
  box.replaceChildren();
  const line = (dot: string, text: string) => box.append(h("div", { class: "status-line" }, h("span", { class: `dot ${dot}` }), h("span", { text })));
  if (p.extension) {
    line("ok", `Paired since ${when(p.extension.pairedAt)}`);
    line(p.connected ? "ok" : "warn", p.connected ? "Extension connected (the assistant can fill logins)" : "Extension not connected right now (is the browser open?)");
    line(p.extension.locked ? "bad" : "ok", p.extension.locked ? "Extension is locked" : "Extension is unlocked");
    box.append(h("div", { class: "muted small", text: p.extension.origin }));
  } else if (p.auto) {
    line("warn", "Waiting for this box's browser: it pairs by itself within a minute of starting");
  } else {
    line("bad", "Unpaired. The browser stays out until you pair it again.");
  }
  $("btn-auto-pair").hidden = p.auto;
  $("btn-unpair").hidden = !p.extension;
  $("btn-ext-lock").hidden = !p.extension;
  $("btn-ext-lock").textContent = p.extension?.locked ? "Unlock extension" : "Lock extension";
  $("btn-ext-lock").dataset.locked = p.extension?.locked ? "1" : "";
  if (!p.pending) {
    $("pair-code-box").hidden = true;
    $("btn-pair").textContent = "Show pairing code";
    stopPairingTimer();
  }
}

async function startPairing(): Promise<void> {
  const { code, expiresAt } = await api<{ code: string; expiresAt: string }>("ui/pairing", { body: {} });
  $("pair-code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  $("pair-code-box").hidden = false;
  $("btn-pair").textContent = "New pairing code";
  stopPairingTimer();
  const end = new Date(expiresAt).getTime();
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    $("pair-countdown").textContent = left ? `Type this code in the extension popup. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.` : "Expired.";
    if (!left) {
      stopPairingTimer();
      $("pair-code-box").hidden = true;
    }
  };
  tick();
  pairingTimer = setInterval(() => {
    tick();
    // Notice when the extension has claimed the code.
    void api<PairingInfo>("ui/pairing").then((p) => {
      if (!p.pending && p.extension) {
        stopPairingTimer();
        $("pair-code-box").hidden = true;
        toast("Browser paired.");
        void loadPairing();
      }
    }, () => undefined);
  }, 1000);
}

// ---- activity ----------------------------------------------------------------------------------------------

async function loadAudit(): Promise<void> {
  const { records } = await api<{ records: AuditRecord[] }>("ui/audit?limit=200");
  const body = $("audit-body");
  body.replaceChildren();
  if (!records.length) {
    const td = h("td", { class: "empty", text: "Nothing yet." });
    td.colSpan = 6;
    body.append(h("tr", {}, td));
    return;
  }
  for (const r of records) {
    body.append(
      h(
        "tr",
        {},
        h("td", { class: "muted", text: when(r.ts) }),
        h("td", {}, h("span", { class: `tag ${r.actor}`, text: r.actor })),
        h("td", { text: r.action.replace(/_/g, " ") + (r.detail ? ` (${r.detail})` : "") }),
        h("td", { text: r.name ?? "" }),
        h("td", { class: "muted", text: r.host ?? "" }),
        h("td", { text: r.status ?? "" }),
      ),
    );
  }
}

// ---- wiring --------------------------------------------------------------------------------------------------

$("gate-form").addEventListener("submit", (ev) => void submitGate(ev));
for (const b of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
  b.addEventListener("click", () => showView(b.dataset.view as View));
}
$("btn-lock").addEventListener("click", async () => {
  await api("ui/lock", { body: {} }).catch(() => undefined);
  stopPairingTimer();
  lockScreen("Locked.");
});
let searchTimer: ReturnType<typeof setTimeout> | undefined;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadEntries(), 180);
});
$("btn-new").addEventListener("click", () => openEdit(null));
$("edit-form").addEventListener("submit", (ev) => void submitEdit(ev));
$("edit-cancel").addEventListener("click", () => {
  $<HTMLInputElement>("edit-password").value = "";
  $<HTMLDialogElement>("dlg-edit").close();
});
$("edit-show").addEventListener("click", () => {
  const pw = $<HTMLInputElement>("edit-password");
  pw.type = pw.type === "password" ? "text" : "password";
  $("edit-show").textContent = pw.type === "password" ? "Show" : "Hide";
});
$("edit-generate").addEventListener("click", () => {
  const pw = $<HTMLInputElement>("edit-password");
  pw.value = generatePassword({ length: 24 });
  pw.type = "text";
  $("edit-show").textContent = "Hide";
});
let cardSearchTimer: ReturnType<typeof setTimeout> | undefined;
$("card-search").addEventListener("input", () => {
  clearTimeout(cardSearchTimer);
  cardSearchTimer = setTimeout(() => void loadCards().catch(() => undefined), 180);
});
$("btn-new-card").addEventListener("click", () => openCardEdit(null));
$("card-form").addEventListener("submit", (ev) => void submitCard(ev));
$("card-cancel").addEventListener("click", closeCardEdit);
$("dlg-card").addEventListener("close", () => {
  $<HTMLInputElement>("card-number").value = "";
  $<HTMLInputElement>("card-cvv").value = "";
});
$("card-number").addEventListener("input", numberHint);
$("card-number-show").addEventListener("click", () => setMasked("card-number", "card-number-show", !$("card-number").classList.contains("masked")));
$("card-cvv-show").addEventListener("click", () => setMasked("card-cvv", "card-cvv-show", !$("card-cvv").classList.contains("masked")));
$("confirm-no").addEventListener("click", () => $<HTMLDialogElement>("dlg-confirm").close());
$("confirm-yes").addEventListener("click", () => void doDelete());
$("gen-length").addEventListener("input", regenerate);
for (const id of ["gen-symbols", "gen-digits", "gen-upper"]) $(id).addEventListener("change", regenerate);
$("gen-again").addEventListener("click", regenerate);
$("gen-copy").addEventListener("click", async () => {
  try {
    await copySecret($("gen-output").textContent ?? "");
    toast("Copied. The clipboard clears in 30 s while this page stays open.");
  } catch (err) {
    toast((err as Error).message, "bad");
  }
});
$("gen-use").addEventListener("click", () => openEdit(null, $("gen-output").textContent ?? ""));
$("btn-pair").addEventListener("click", () => void startPairing().catch((err) => toast((err as Error).message, "bad")));
$("btn-unpair").addEventListener("click", async () => {
  if (!confirm("Unpair the browser extension? Fills and saves stop until you pair the browser again.")) return;
  await api("ui/pairing", { method: "DELETE" });
  toast("Extension unpaired.");
  await loadPairing();
});
$("btn-ext-lock").addEventListener("click", async () => {
  const locked = !$("btn-ext-lock").dataset.locked;
  await api("ui/extension-lock", { body: { locked } });
  toast(locked ? "Extension locked: no fills until it is unlocked." : "Extension unlocked.");
  await loadPairing();
});
$("btn-auto-pair").addEventListener("click", async () => {
  await api("ui/pairing/auto", { body: {} });
  toast("The browser pairs by itself within a minute.");
  await loadPairing();
});
$("btn-audit-refresh").addEventListener("click", () => void loadAudit());
$("btn-change-pin").addEventListener("click", () => {
  for (const id of ["pin-current", "pin-next", "pin-next2"]) $<HTMLInputElement>(id).value = "";
  $("pin-error").textContent = "";
  $<HTMLDialogElement>("dlg-pin").showModal();
});
$("pin-cancel").addEventListener("click", () => $<HTMLDialogElement>("dlg-pin").close());
$("pin-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const next = $<HTMLInputElement>("pin-next").value;
  if (next !== $<HTMLInputElement>("pin-next2").value) {
    $("pin-error").textContent = "The new PINs differ.";
    return;
  }
  try {
    session = (await api<{ token: string }>("ui/pin", { body: { current: $<HTMLInputElement>("pin-current").value, next } })).token;
    $<HTMLDialogElement>("dlg-pin").close();
    toast("PIN changed.");
  } catch (err) {
    $("pin-error").textContent = (err as Error).message;
  }
});

void boot();
