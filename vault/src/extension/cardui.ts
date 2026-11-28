// In-page card UI, each in a closed shadow root so page CSS cannot restyle it
// and page scripts cannot reach into it:
//
//   chip       a small button inside the card number field; a click opens the picker
//   picker     "Fill a card on <host>": label, brand, last 4 and expiry per card
//   save bar   "Save card to ClawBox Vault?" after a card was typed at checkout
//
// None of them ever holds a card number or security code. Every action needs
// a real (isTrusted) click or key press: a page cannot click them for the user.

export interface PickerCard {
  name: string;
  label: string;
  brand: string;
  last4: string;
  exp: string;
  expired: boolean;
}

const BRAND_SHORT: Record<string, string> = {
  visa: "VISA",
  mastercard: "MC",
  amex: "AMEX",
  discover: "DISC",
  diners: "DINERS",
  jcb: "JCB",
  unionpay: "UPAY",
  maestro: "MAESTRO",
  mir: "MIR",
};

const BRAND_FULL: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  maestro: "Maestro",
  mir: "Mir",
};

const BASE_CSS = `
:host { all: initial; }
.panel {
  position: fixed; top: 14px; right: 14px; z-index: 2147483647;
  width: min(380px, calc(100vw - 28px)); box-sizing: border-box;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e7ecf3; background: #141821; border: 1px solid #2a3140; border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0,0,0,.45); padding: 14px 14px 12px;
}
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.logo { width: 26px; height: 26px; border-radius: 8px; flex: none;
  background: linear-gradient(135deg, #ff8a3d, #ff4f5e); display: grid; place-items: center;
  color: #141821; font-weight: 800; font-size: 14px; }
.title { font-weight: 650; font-size: 14px; flex: 1; }
.x { all: unset; cursor: pointer; color: #8b95a7; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.x:hover, .x:focus-visible { background: #222938; color: #e7ecf3; }
.sub { color: #9aa4b5; margin: 0 0 10px; overflow-wrap: anywhere; }
label.f { display: block; color: #9aa4b5; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
input.t { all: unset; box-sizing: border-box; width: 100%; background: #0d1017; border: 1px solid #2a3140;
  border-radius: 9px; padding: 8px 10px; color: #e7ecf3; font: inherit; }
input.t:focus { border-color: #ff8a3d; }
label.c { display: flex; gap: 8px; align-items: center; color: #c5cddb; margin-top: 10px; cursor: pointer; }
label.c input { accent-color: #ff8a3d; margin: 0; }
.row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
button.b { all: unset; cursor: pointer; padding: 7px 14px; border-radius: 9px; font-weight: 600; }
button.b:focus-visible { outline: 2px solid #ff8a3d; outline-offset: 1px; }
.primary { background: #ff8a3d; color: #141821; }
.primary:hover { background: #ff9d5c; }
.ghost { color: #c5cddb; }
.ghost:hover { background: #222938; }
.msg { margin-top: 8px; display: none; }
.msg.bad { color: #ff7b86; display: block; }
.msg.ok { color: #3ccf91; display: block; }
.cards { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
button.card { all: unset; box-sizing: border-box; width: 100%; cursor: pointer; display: flex; align-items: center; gap: 10px;
  background: #0d1017; border: 1px solid #2a3140; border-radius: 10px; padding: 9px 10px; }
button.card:hover, button.card:focus-visible { border-color: #ff8a3d; }
button.card[disabled] { opacity: .5; cursor: default; }
.brand { font-size: 10px; font-weight: 800; letter-spacing: .06em; color: #141821; background: #c5cddb; border-radius: 5px; padding: 2px 5px; flex: none; }
.brand.visa { background: #8fb3ff; } .brand.mastercard { background: #ffb36b; } .brand.amex { background: #7fd6c2; }
.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.num { font-variant-numeric: tabular-nums; color: #c5cddb; }
.exp { color: #8b95a7; font-size: 12px; font-variant-numeric: tabular-nums; }
`;

function shadowHost(doc: Document, tag: string, css: string): { host: HTMLElement; root: ShadowRoot } {
  doc.querySelector(tag)?.remove();
  const host = doc.createElement(tag);
  const root = host.attachShadow({ mode: "closed" });
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  try {
    const sheet = new (win?.CSSStyleSheet ?? CSSStyleSheet)();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = doc.createElement("style");
    style.textContent = css;
    root.append(style);
  }
  return { host, root };
}

function maker(doc: Document) {
  return <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
}

/** Run `fn` only for a real user click (or key press) — never for a page's synthetic event. */
function trusted(fn: () => void) {
  return (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.isTrusted) fn();
  };
}

function head(doc: Document, title: string, onClose: () => void): HTMLElement {
  const el = maker(doc);
  const h = el("div", "head");
  const close = el("button", "x", "×");
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", trusted(onClose));
  h.append(el("div", "logo", "V"), el("div", "title", title), close);
  return h;
}

function cardLine(doc: Document, c: { brand: string; label: string; last4: string; exp: string }): HTMLElement[] {
  const el = maker(doc);
  return [el("span", `brand ${c.brand}`, BRAND_SHORT[c.brand] ?? "CARD"), el("span", "label", c.label), el("span", "num", `•••• ${c.last4}`), el("span", "exp", c.exp)];
}

// ---- chip -------------------------------------------------------------------------------

const CHIP_CSS = `
:host { all: initial; position: fixed; z-index: 2147483646; width: 30px; height: 22px; }
button { all: unset; box-sizing: border-box; width: 30px; height: 22px; cursor: pointer; border-radius: 6px;
  background: linear-gradient(135deg, #ff8a3d, #ff4f5e); color: #141821; font: 800 11px/22px system-ui, sans-serif;
  text-align: center; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
button:hover, button:focus-visible { filter: brightness(1.08); outline: 2px solid #141821; outline-offset: 1px; }
`;

/** A chip at the right edge of the card number field. Returns its remover. */
export function mountCardChip(doc: Document, anchor: HTMLInputElement, onClick: () => void): () => void {
  const { host, root } = shadowHost(doc, "clawbox-vault-chip", CHIP_CSS);
  const win = doc.defaultView;
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "V";
  button.title = "Fill a card from ClawBox Vault";
  button.setAttribute("aria-label", "Fill a card from ClawBox Vault");
  // Keep the page's focus where it is until the click lands.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", trusted(onClick));
  root.append(button);
  (doc.body ?? doc.documentElement).append(host);

  const place = () => {
    if (!anchor.isConnected) return remove();
    const r = anchor.getBoundingClientRect();
    const hidden = r.width < 40 || r.height < 12;
    host.style.display = hidden ? "none" : "block";
    host.style.top = `${Math.round(r.top + (r.height - 22) / 2)}px`;
    host.style.left = `${Math.round(r.right - 30 - 6)}px`;
  };
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = (win?.requestAnimationFrame ?? setTimeout)(() => {
      frame = 0;
      place();
    }) as unknown as number;
  };
  win?.addEventListener("scroll", schedule, { capture: true, passive: true });
  win?.addEventListener("resize", schedule, { passive: true });
  const timer = setInterval(place, 700);
  place();

  function remove(): void {
    clearInterval(timer);
    win?.removeEventListener("scroll", schedule, { capture: true });
    win?.removeEventListener("resize", schedule);
    host.remove();
  }
  return remove;
}

// ---- picker ------------------------------------------------------------------------------

export interface PickerOptions {
  host: string;
  cards: PickerCard[];
  onPick: (name: string) => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
}

export function showCardPicker(doc: Document, opts: PickerOptions): () => void {
  const { host, root } = shadowHost(doc, "clawbox-vault-cards", BASE_CSS);
  const el = maker(doc);
  const panel = el("div", "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "ClawBox Vault: fill a card");
  const remove = () => host.remove();
  const close = () => {
    remove();
    opts.onClose();
  };
  panel.append(head(doc, "Fill a card", close), el("p", "sub", `Choose the card to fill into the checkout on ${opts.host}.`));
  const list = el("ul", "cards");
  const msg = el("div", "msg");
  let busy = false;
  for (const c of opts.cards) {
    const li = el("li");
    const b = el("button", "card");
    b.type = "button";
    b.append(...cardLine(doc, c));
    b.setAttribute("aria-label", `${c.label}, ${c.brand} ending ${c.last4}, expires ${c.exp}${c.expired ? " (expired)" : ""}`);
    if (c.expired) {
      b.disabled = true;
      b.title = "This card has expired";
    }
    b.addEventListener(
      "click",
      trusted(async () => {
        if (busy || c.expired) return;
        busy = true;
        msg.className = "msg";
        const r = await opts.onPick(c.name);
        msg.textContent = r.message;
        msg.className = `msg ${r.ok ? "ok" : "bad"}`;
        busy = false;
        if (r.ok) setTimeout(remove, 1400);
      }),
    );
    li.append(b);
    list.append(li);
  }
  if (!opts.cards.length) list.append(el("li", "sub", "No cards in the vault yet. Add one in the ClawBox Vault app."));
  const row = el("div", "row");
  const cancel = el("button", "b ghost", "Cancel");
  cancel.addEventListener("click", trusted(close));
  row.append(cancel);
  panel.append(list, msg, row);
  panel.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && e.isTrusted) close();
  });
  root.append(panel);
  (doc.body ?? doc.documentElement).append(host);
  // Focus the first usable card, so Enter picks it.
  (root.querySelector("button.card:not([disabled])") as HTMLButtonElement | null)?.focus();
  return remove;
}

// ---- save bar ---------------------------------------------------------------------------------

export interface CardSaveBarOptions {
  kind: "new" | "update";
  label: string;
  brand: string;
  last4: string;
  exp: string;
  host: string;
  hasCvv: boolean;
  onSave: (label: string, saveCvv: boolean) => Promise<{ ok: boolean; error?: string }>;
  onDismiss: () => void;
}

export function showCardSaveBar(doc: Document, opts: CardSaveBarOptions): () => void {
  const { host, root } = shadowHost(doc, "clawbox-vault-card-bar", BASE_CSS);
  const el = maker(doc);
  const bar = el("div", "panel");
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", "ClawBox Vault");
  const remove = () => host.remove();
  const dismiss = () => {
    remove();
    opts.onDismiss();
  };
  bar.append(head(doc, opts.kind === "new" ? "Save card to ClawBox Vault?" : "Update card?", dismiss));
  const brandName = BRAND_FULL[opts.brand] ?? "Card";
  bar.append(
    el(
      "p",
      "sub",
      opts.kind === "new"
        ? `${brandName} •••• ${opts.last4}, valid through ${opts.exp}, typed on ${opts.host}. It is stored only if you click Save.`
        : `Store the new expiry ${opts.exp} for ${opts.label} (•••• ${opts.last4}).`,
    ),
  );
  let labelInput: HTMLInputElement | null = null;
  if (opts.kind === "new") {
    labelInput = el("input", "t");
    labelInput.value = opts.label;
    labelInput.spellcheck = false;
    labelInput.setAttribute("autocomplete", "off");
    labelInput.setAttribute("aria-label", "Card label");
    labelInput.addEventListener("keydown", (e) => e.stopPropagation());
    bar.append(el("label", "f", "Label"), labelInput);
  }
  let cvvBox: HTMLInputElement | null = null;
  if (opts.hasCvv) {
    const lab = el("label", "c");
    cvvBox = el("input");
    cvvBox.type = "checkbox";
    lab.append(cvvBox, doc.createTextNode("Also store the security code (CVV)"));
    bar.append(lab);
  }
  const msg = el("div", "msg");
  const row = el("div", "row");
  const later = el("button", "b ghost", "Not now");
  const save = el("button", "b primary", opts.kind === "new" ? "Save" : "Update");
  later.addEventListener("click", trusted(dismiss));
  save.addEventListener(
    "click",
    trusted(async () => {
      save.textContent = "Saving…";
      const r = await opts.onSave(labelInput ? labelInput.value.trim() : opts.label, Boolean(cvvBox?.checked));
      if (r.ok) {
        save.textContent = "Saved";
        setTimeout(remove, 900);
      } else {
        save.textContent = opts.kind === "new" ? "Save" : "Update";
        msg.textContent = r.error ?? "Could not save.";
        msg.className = "msg bad";
      }
    }),
  );
  row.append(later, save);
  bar.append(msg, row);
  root.append(bar);
  (doc.body ?? doc.documentElement).append(host);
  return remove;
}
