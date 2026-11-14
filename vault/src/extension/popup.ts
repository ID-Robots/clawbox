// Popup: pairing, lock/unlock, entries for the current site (fill / copy
// username / copy password), search, add/edit, the password generator, and the
// payment cards (label, brand, last 4, expiry; Fill into this tab's checkout).
// Passwords and card numbers never come to the popup: fills and copies run in
// the background.
import { parseWebUrl } from "../shared/domain";
import { clampLength, entropyBits, generatePassword } from "../shared/generator";
import type { CardFillReply, CardView, EntryView, PopupMessage, PopupState } from "./messages";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Reply<T> = T & { error?: string; status?: number };

async function ask<T>(msg: PopupMessage): Promise<Reply<T>> {
  try {
    return ((await chrome.runtime.sendMessage(msg)) ?? {}) as Reply<T>;
  } catch {
    return { error: "The extension background is not running." } as Reply<T>;
  }
}

const SCREENS = ["loading", "offline", "pair", "locked", "main", "edit", "gen"] as const;
type Screen = (typeof SCREENS)[number];

let state: PopupState | null = null;
let editing: { mode: "create" | "update"; original?: EntryView } | null = null;
let returnTo: Screen = "main";

function show(screen: Screen): void {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== screen;
  const unlocked = state?.paired && !state.locked && !state.error;
  $("btn-lock").hidden = !unlocked;
  $("btn-unpair").hidden = !state?.paired;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, kind: "ok" | "bad" = "ok"): void {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function hostLabel(url: string | null): string {
  return parseWebUrl(url)?.host ?? "no website in this tab";
}

async function refresh(): Promise<void> {
  show("loading");
  state = await ask<PopupState>({ type: "popup:state" });
  $("service-url").textContent = state.serviceUrl ?? "http://127.0.0.1:4796";
  $("site-label").textContent = hostLabel(state.tabUrl ?? null);
  $("footer-text").textContent = state.paired ? "Paired with this ClawBox" : "Not paired";
  if (!state.paired) return show(state.online ? "pair" : "offline");
  if (state.error) return show("offline");
  if (state.locked) return show("locked");
  // Without cards there is one list and no tab bar to choose between two.
  $("tabs").hidden = !state.cards;
  if (!state.cards && activeTab === "cards") showTab("logins");
  show("main");
  await (activeTab === "cards" ? loadCards() : loadSite());
}

// ---- tabs: logins / cards ------------------------------------------------------------

let activeTab: "logins" | "cards" = "logins";

function showTab(tab: "logins" | "cards"): void {
  activeTab = tab;
  for (const t of ["logins", "cards"] as const) {
    $(`tab-${t}`).hidden = t !== tab;
    $(`tab-btn-${t}`).classList.toggle("active", t === tab);
    $(`tab-btn-${t}`).setAttribute("aria-selected", String(t === tab));
  }
  void (tab === "cards" ? loadCards() : loadSite());
}

const BRAND_SHORT: Record<string, string> = { visa: "VISA", mastercard: "MC", amex: "AMEX", discover: "DISC", diners: "DINERS", jcb: "JCB", unionpay: "UPAY", maestro: "MAESTRO", mir: "MIR" };

async function loadCards(): Promise<void> {
  const res = await ask<{ cards: CardView[]; fillAllowed: boolean }>({ type: "popup:cards" });
  if (res.status === 423) return void refresh();
  const list = $("card-list");
  list.replaceChildren();
  if (res.error) {
    $("cards-note").textContent = res.error;
    return;
  }
  const allowFill = Boolean(res.fillAllowed);
  $("cards-note").textContent = allowFill ? "" : "Open the checkout page (https://) to fill a card.";
  const cards = res.cards ?? [];
  if (!cards.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No cards yet. Add one in the ClawBox Vault app, or save one when you pay.";
    list.append(li);
    return;
  }
  for (const c of cards) {
    const li = document.createElement("li");
    li.className = "entry";
    const head = document.createElement("div");
    head.className = "entry-head card-row";
    const pill = document.createElement("span");
    pill.className = `brand-pill ${c.brand}`;
    pill.textContent = BRAND_SHORT[c.brand] ?? "CARD";
    const name = document.createElement("span");
    name.className = "entry-name";
    name.textContent = c.label;
    name.title = c.label;
    head.append(pill, name);
    if (c.expired) {
      const badge = document.createElement("span");
      badge.className = "badge bad";
      badge.textContent = "expired";
      head.append(badge);
    }
    const sub = document.createElement("div");
    sub.className = "entry-login digits";
    sub.textContent = [`•••• ${c.last4}`, c.exp, c.cardholder].filter(Boolean).join(" · ");
    li.append(head, sub);
    if (allowFill && !c.expired) {
      const actions = document.createElement("div");
      actions.className = "entry-actions";
      actions.append(button("Fill", () => void fillCard(c), "btn small primary"));
      li.append(actions);
    }
    list.append(li);
  }
}

const CARD_STATUS: Record<string, string> = {
  no_form: "No card fields found on this page.",
  no_tab: "No tab to fill.",
  origin_mismatch: "Refused: the card fields are in a frame from another site.",
  error: "Fill failed.",
};

async function fillCard(c: CardView): Promise<void> {
  const res = await ask<CardFillReply>({ type: "popup:card-fill", name: c.name });
  if (res.error) return toast(res.error, "bad");
  if (res.status !== "filled") return toast(res.detail ?? CARD_STATUS[res.status] ?? res.status, "bad");
  toast(res.missing?.includes("cvc") ? "Card filled. Type the security code yourself (none stored)." : "Card filled.");
  setTimeout(() => window.close(), 900);
}

// ---- entry list -------------------------------------------------------------------

function button(label: string, onClick: () => void, cls = "btn small"): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderList(list: HTMLElement, entries: EntryView[], { allowFill }: { allowFill: boolean }): void {
  list.replaceChildren();
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No entries.";
    list.append(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "entry";
    const head = document.createElement("div");
    head.className = "entry-head";
    const name = document.createElement("span");
    name.className = "entry-name";
    name.textContent = e.name;
    name.title = e.name;
    head.append(name);
    if (e.match === "exact") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "exact";
      head.append(badge);
    }
    const login = document.createElement("div");
    login.className = "entry-login";
    login.textContent = [e.login, parseWebUrl(e.url)?.host].filter(Boolean).join(" · ") || "—";
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    if (allowFill) actions.append(button("Fill", () => void fill(e), "btn small primary"));
    if (e.login) actions.append(button("Copy user", () => void copyLogin(e)));
    actions.append(button("Copy password", () => void copyPassword(e)));
    actions.append(button("Edit", () => openEdit("update", e), "btn small ghost"));
    li.append(head, login, actions);
    list.append(li);
  }
}

async function loadSite(): Promise<void> {
  const res = await ask<{ entries: EntryView[]; fillAllowed: boolean }>({ type: "popup:match" });
  if (res.status === 423) return void refresh();
  const allowFill = Boolean(res.fillAllowed);
  $("site-note").textContent = !state?.tabUrl
    ? "Open a website to see its logins."
    : allowFill
      ? ""
      : "This page is not https://, so the vault will not fill it.";
  renderList($("site-list"), res.entries ?? [], { allowFill });
}

let searchSeq = 0;
async function search(query: string): Promise<void> {
  const seq = ++searchSeq;
  const q = query.trim();
  $("search-block").hidden = !q;
  $("site-block").hidden = Boolean(q);
  if (!q) return;
  const res = await ask<{ entries: EntryView[] }>({ type: "popup:search", query: q });
  if (seq !== searchSeq) return;
  renderList($("search-list"), res.entries ?? [], { allowFill: false });
}

// ---- actions --------------------------------------------------------------------------

const STATUS_TEXT: Record<string, string> = {
  filled: "Filled.",
  no_form: "No login form found on this page.",
  no_tab: "No matching tab.",
  origin_mismatch: "Refused: the form is on a different origin than the entry.",
  error: "Fill failed.",
};

async function fill(e: EntryView): Promise<void> {
  const res = await ask<{ status: string; detail?: string }>({ type: "popup:fill", name: e.name });
  if (res.error) return toast(res.error, "bad");
  toast(STATUS_TEXT[res.status] ?? res.status, res.status === "filled" ? "ok" : "bad");
  if (res.status === "filled") setTimeout(() => window.close(), 700);
}

async function copyLogin(e: EntryView): Promise<void> {
  await navigator.clipboard.writeText(e.login);
  toast("Username copied.");
}

async function copyPassword(e: EntryView): Promise<void> {
  const res = await ask<{ ok: boolean; clearsInSeconds: number }>({ type: "popup:copy-password", name: e.name });
  if (res.error) return toast(res.error, "bad");
  toast(`Password copied. Clipboard clears in ${res.clearsInSeconds} s.`);
}

// ---- add / edit -------------------------------------------------------------------------

function openEdit(mode: "create" | "update", entry?: EntryView): void {
  editing = { mode, original: entry };
  $("edit-title").textContent = mode === "create" ? "New entry" : "Edit entry";
  const name = $<HTMLInputElement>("edit-name");
  name.value = entry?.name ?? "";
  name.readOnly = mode === "update";
  $<HTMLInputElement>("edit-login").value = entry?.login ?? "";
  const tabOrigin = parseWebUrl(state?.tabUrl)?.origin ?? "";
  $<HTMLInputElement>("edit-url").value = entry?.url ?? (mode === "create" ? tabOrigin : "");
  const pw = $<HTMLInputElement>("edit-password");
  pw.value = "";
  pw.type = "password";
  pw.required = mode === "create";
  $("edit-pw-hint").textContent = mode === "update" ? "Leave the password empty to keep the current one." : "";
  $<HTMLInputElement>("edit-note").value = "";
  $<HTMLInputElement>("edit-note").placeholder = mode === "update" ? "unchanged" : "";
  show("edit");
}

async function submitEdit(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  if (!editing) return;
  const entry = {
    name: $<HTMLInputElement>("edit-name").value.trim(),
    login: $<HTMLInputElement>("edit-login").value.trim(),
    url: $<HTMLInputElement>("edit-url").value.trim(),
    password: $<HTMLInputElement>("edit-password").value || undefined,
    note: $<HTMLInputElement>("edit-note").value.trim() || undefined,
  };
  const res = await ask<{ name: string }>({ type: "popup:save", entry, mode: editing.mode });
  if (res.error) return toast(res.error, "bad");
  $<HTMLInputElement>("edit-password").value = "";
  toast(`Saved ${res.name}.`);
  editing = null;
  show("main");
  await loadSite();
}

// ---- generator -----------------------------------------------------------------------------

function genOptions() {
  return {
    length: clampLength(Number($<HTMLInputElement>("gen-length").value)),
    symbols: $<HTMLInputElement>("gen-symbols").checked,
  };
}

function regenerate(): void {
  const opts = genOptions();
  $("gen-length-value").textContent = String(opts.length);
  $("gen-output").textContent = generatePassword(opts);
  $("gen-entropy").textContent = `About ${entropyBits(opts)} bits of entropy.`;
}

// ---- wiring --------------------------------------------------------------------------------

$("btn-retry").addEventListener("click", () => void refresh());
for (const t of ["logins", "cards"] as const) $(`tab-btn-${t}`).addEventListener("click", () => showTab(t));
$("form-pair").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const code = $<HTMLInputElement>("pair-code").value.replace(/\D/g, "");
  if (code.length !== 6) return toast("The pairing code has 6 digits.", "bad");
  const res = await ask<{ ok: boolean }>({ type: "popup:pair", code });
  if (!res.ok) return toast(res.error ?? "Pairing failed.", "bad");
  toast("Paired.");
  await refresh();
});
$("form-unlock").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $<HTMLInputElement>("unlock-pin");
  const res = await ask<{ ok: boolean }>({ type: "popup:unlock", pin: input.value });
  input.value = "";
  if (res.error) return toast(res.error, "bad");
  await refresh();
});
$("btn-lock").addEventListener("click", async () => {
  const res = await ask<{ ok: boolean }>({ type: "popup:lock" });
  if (res.error) return toast(res.error, "bad");
  await refresh();
});
$("btn-unpair").addEventListener("click", async () => {
  if (!confirm("Unpair this browser from ClawBox Vault? You will need a new pairing code.")) return;
  await ask({ type: "popup:unpair" });
  await refresh();
});
$<HTMLInputElement>("search").addEventListener("input", (ev) => void search((ev.target as HTMLInputElement).value));
$("btn-new").addEventListener("click", () => openEdit("create"));
$("btn-gen").addEventListener("click", () => {
  returnTo = "main";
  regenerate();
  show("gen");
});
$("form-edit").addEventListener("submit", (ev) => void submitEdit(ev as SubmitEvent));
$("edit-cancel").addEventListener("click", () => {
  editing = null;
  show("main");
});
$("edit-show").addEventListener("click", () => {
  const pw = $<HTMLInputElement>("edit-password");
  pw.type = pw.type === "password" ? "text" : "password";
  $("edit-show").textContent = pw.type === "password" ? "Show" : "Hide";
});
$("edit-generate").addEventListener("click", () => {
  const pw = $<HTMLInputElement>("edit-password");
  pw.value = generatePassword({ length: 24, symbols: true });
  pw.type = "text";
  $("edit-show").textContent = "Hide";
});
$("gen-length").addEventListener("input", regenerate);
$("gen-symbols").addEventListener("change", regenerate);
$("gen-again").addEventListener("click", regenerate);
$("gen-back").addEventListener("click", () => show(returnTo));
$("gen-copy").addEventListener("click", async () => {
  const res = await ask<{ ok: boolean; clearsInSeconds: number }>({ type: "popup:copy-text", text: $("gen-output").textContent ?? "" });
  if (res.error) return toast(res.error, "bad");
  toast(`Copied. Clipboard clears in ${res.clearsInSeconds} s.`);
});

void refresh();
