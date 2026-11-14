// Content script (every https page, localhost, all frames). It detects login
// and checkout forms, fills them when the background worker asks, notices
// logins and cards the user types, shows the card chip next to a card number
// field, and shows the save bars and the card picker in the top frame. It
// never asks for secrets and never fills anything on its own.
import { isSecureOrLocal } from "../shared/hosts";
import {
  cardNumberField,
  guardedCardFill,
  probeCardFrame,
  readTypedCard,
  type CardData,
  type CardFrameReport,
  type GuardedCardOutcome,
} from "./cardforms";
import { mountCardChip, showCardPicker, showCardSaveBar, type PickerCard } from "./cardui";
import { CARDS_ENABLED } from "./flags";
import { framedBySameOrigin, guardedFill, probeFrame, readTypedCredentials, type FrameReport, type GuardedOutcome } from "./forms";
import type { CardFillReply, CardSavePrompt, ContentMessage, SavePrompt } from "./messages";
import { showSaveBar } from "./savebar";

interface CardFillArgs {
  data: CardData;
  allowedOrigin: string;
  topOrigin: string;
  paymentFrame: boolean;
}

interface VaultContentApi {
  probe(): FrameReport;
  fill(args: { login: string; password: string; allowedOrigin: string; submit: boolean }): Promise<GuardedOutcome>;
  probeCard(): CardFrameReport;
  fillCard(args: CardFillArgs): GuardedCardOutcome;
}

declare global {
  // Lives in the extension's isolated world: page scripts cannot see it.
  var __clawboxVault: VaultContentApi | undefined;
}

const VAULT_PATH = "/apps/clawbox-vault/";

const probe = () => probeFrame(window);
// Second line of defence: the background already chose this frame.
const fill = (args: { login: string; password: string; allowedOrigin: string; submit: boolean }) => guardedFill(window, args);
const probeCard = () => probeCardFrame(window);
const fillCard = (args: CardFillArgs) => guardedCardFill(window, args);

function send(message: ContentMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

function isVaultPage(): boolean {
  return location.pathname.startsWith(VAULT_PATH) || (location.hostname === "127.0.0.1" && location.port === "4796");
}

// ---- capture typed logins ---------------------------------------------------

let lastCapture = "";

function capture(scope: ParentNode): void {
  if (isVaultPage() || !isSecureOrLocal(location.protocol, location.hostname)) return;
  const creds = readTypedCredentials(scope);
  if (!creds) return;
  const key = `${creds.login}\u0000${creds.password}`;
  if (key === lastCapture) return;
  lastCapture = key;
  if (creds.password) {
    void send({ type: "content:capture", url: location.href, login: creds.login, password: creds.password });
  } else {
    void send({ type: "content:capture-login", url: location.href, login: creds.login });
  }
}

function scopeOf(el: Element | null): ParentNode {
  return (el?.closest("form") as HTMLFormElement | null) ?? document;
}

function looksLikeSubmit(el: Element | null): Element | null {
  const target = el?.closest('button, input[type="submit"], input[type="button"], [role="button"]') ?? null;
  if (!target) return null;
  if (target.matches('button[type="submit"], input[type="submit"]')) return target;
  if (target.closest("form") && target.matches("button:not([type])")) return target;
  const text = (target.textContent || (target as HTMLInputElement).value || "").trim();
  return /log\s?-?in|sign\s?-?in|sign\s?on|continue|next|submit|anmelden|weiter|вход|войти/i.test(text) ? target : null;
}

// ---- capture typed cards ---------------------------------------------------------

let lastCardCapture = "";

/** A card typed at checkout, read when the user submits or clicks a pay/order button. */
function captureCard(scope: ParentNode): void {
  // With cards off no card field is ever read.
  if (!CARDS_ENABLED) return;
  // Only where the page itself owns the form: the top frame or a same-origin iframe.
  if (isVaultPage() || !isSecureOrLocal(location.protocol, location.hostname) || !framedBySameOrigin(window)) return;
  const card = readTypedCard(document, scope);
  if (!card || !card.exp) return;
  const key = `${card.number.slice(-4)}\u0000${card.exp}\u0000${card.number.length}`;
  if (key === lastCardCapture) return;
  lastCardCapture = key;
  void send({ type: "content:card-capture", url: location.href, ...card });
}

function buttonLike(el: Element | null): Element | null {
  return el?.closest('button, input[type="submit"], input[type="button"], [role="button"]') ?? null;
}

function installCapture(): void {
  document.addEventListener(
    "submit",
    (e) => {
      capture(e.target as HTMLFormElement);
      captureCard(e.target as HTMLFormElement);
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      const btn = looksLikeSubmit(e.target as Element | null);
      if (btn) capture(scopeOf(btn));
      const any = buttonLike(e.target as Element | null);
      if (any) captureCard(scopeOf(any));
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      const t = e.target as HTMLInputElement | null;
      if (e.key === "Enter" && t?.tagName === "INPUT") {
        capture(scopeOf(t));
        captureCard(scopeOf(t));
      }
    },
    true,
  );
  // Navigation away right after typing (JS logins without a form submit).
  window.addEventListener("pagehide", () => {
    const pw = Array.from(document.querySelectorAll('input[type="password"]')).find((i) => (i as HTMLInputElement).value);
    if (pw) capture(scopeOf(pw));
  });
}

// ---- save bar (top frame) ------------------------------------------------------

let removeBar: (() => void) | null = null;

function presentSave(prompt: SavePrompt): void {
  removeBar?.();
  removeBar = showSaveBar(document, {
    ...prompt,
    onSave: async (name) => {
      const res = (await send({ type: "content:save", name })) as { ok: boolean; error?: string } | undefined;
      return res ?? { ok: false, error: "ClawBox Vault is not reachable." };
    },
    onDismiss: () => void send({ type: "content:dismiss" }),
  });
}

// ---- card chip (any frame with a card number field) ----------------------------------

let chipFor: HTMLInputElement | null = null;
let removeChip: (() => void) | null = null;

async function updateChip(): Promise<void> {
  if (!CARDS_ENABLED) return;
  if (isVaultPage() || !isSecureOrLocal(location.protocol, location.hostname)) return;
  const field = cardNumberField(document);
  if (field === chipFor) return;
  removeChip?.();
  removeChip = null;
  chipFor = field;
  if (!field) return;
  // The background shows it only when paired, unlocked, with a card, in a frame a fill may reach.
  const ok = (await send({ type: "content:card-chip" })) as { show?: boolean } | undefined;
  if (!ok?.show || chipFor !== field) return;
  removeChip = mountCardChip(document, field, () => void send({ type: "content:card-chip-click" }));
}

// Throttled, not debounced: pages that animate all the time still get checked.
let chipTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleChip(): void {
  if (chipTimer) return;
  chipTimer = setTimeout(() => {
    chipTimer = undefined;
    void updateChip();
  }, 400);
}

function watchForCardFields(): void {
  const ours = (n: Node) => n.nodeType === 1 && (n as Element).tagName.startsWith("CLAWBOX-VAULT");
  new MutationObserver((records) => {
    if (records.some((r) => !ours(r.target) && !Array.from(r.addedNodes).every(ours))) scheduleChip();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["autocomplete", "hidden", "style", "class", "type"] });
  scheduleChip();
}

// ---- card picker and card save bar (top frame) --------------------------------------------

let removePicker: (() => void) | null = null;

const CARD_STATUS: Record<string, string> = {
  no_form: "No card fields found on this page.",
  origin_mismatch: "Refused: the card fields are in a frame from another site.",
  locked: "ClawBox Vault is locked.",
  error: "The fill failed.",
};

function cardReplyText(r: CardFillReply | { error?: string } | undefined): { ok: boolean; message: string } {
  if (!r || "error" in r) return { ok: false, message: (r as { error?: string } | undefined)?.error ?? "ClawBox Vault is not reachable." };
  const reply = r as CardFillReply;
  if (reply.status !== "filled") return { ok: false, message: reply.detail ?? CARD_STATUS[reply.status] ?? reply.status };
  const missing = reply.missing ?? [];
  const extra = missing.includes("cvc") ? " Type the security code yourself (none is stored)." : "";
  return { ok: true, message: `Filled.${extra}` };
}

function presentPicker(msg: { host: string; cards: PickerCard[]; nonce: string }): void {
  removePicker?.();
  removePicker = showCardPicker(document, {
    host: msg.host,
    cards: msg.cards,
    onPick: async (name) => cardReplyText((await send({ type: "content:card-pick", name, nonce: msg.nonce })) as CardFillReply | undefined),
    onClose: () => (removePicker = null),
  });
}

let removeCardBar: (() => void) | null = null;

function presentCardSave(prompt: CardSavePrompt): void {
  removeCardBar?.();
  removeCardBar = showCardSaveBar(document, {
    ...prompt,
    onSave: async (label, saveCvv) => {
      const res = (await send({ type: "content:card-save", label, saveCvv })) as { ok: boolean; error?: string } | undefined;
      return res ?? { ok: false, error: "ClawBox Vault is not reachable." };
    },
    onDismiss: () => void send({ type: "content:card-dismiss" }),
  });
}

if (!globalThis.__clawboxVault) {
  globalThis.__clawboxVault = { probe, fill, probeCard, fillCard };
  installCapture();
  watchForCardFields();
  if (window === window.top) {
    chrome.runtime.onMessage.addListener(
      (msg: { type?: string; prompt?: SavePrompt & CardSavePrompt; host?: string; cards?: PickerCard[]; nonce?: string }, sender) => {
        if (sender.id !== chrome.runtime.id) return;
        if (msg.type === "show-save" && msg.prompt) presentSave(msg.prompt);
        if (!CARDS_ENABLED) return;
        if (msg.type === "show-card-save" && msg.prompt) presentCardSave(msg.prompt);
        if (msg.type === "show-card-picker" && msg.cards && msg.nonce) presentPicker({ host: msg.host ?? location.host, cards: msg.cards, nonce: msg.nonce });
      },
    );
    void send({ type: "content:pending-save" }).then((prompt) => {
      if (prompt && typeof prompt === "object" && "kind" in prompt) presentSave(prompt as SavePrompt);
    });
    if (CARDS_ENABLED) {
      void send({ type: "content:pending-card-save" }).then((prompt) => {
        if (prompt && typeof prompt === "object" && "kind" in prompt) presentCardSave(prompt as CardSavePrompt);
      });
    }
  }
}
