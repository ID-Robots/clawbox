// Messages between the content script, the popup, the card confirmation page,
// the offscreen document and the background worker. Content scripts can never
// ask for a secret: they only send what the user typed (for the save bars) and
// the user's clicks on the chip and the picker; the background does the fills.

export type ContentMessage =
  | { type: "content:capture"; url: string; login: string; password: string }
  | { type: "content:capture-login"; url: string; login: string }
  | { type: "content:pending-save" }
  | { type: "content:save"; name: string }
  | { type: "content:dismiss" }
  | { type: "content:card-chip" }
  | { type: "content:card-chip-click" }
  | { type: "content:card-pick"; name: string; nonce: string }
  | { type: "content:card-capture"; url: string; number: string; exp: string; cardholder: string; cvv: string }
  | { type: "content:pending-card-save" }
  | { type: "content:card-save"; label: string; saveCvv: boolean }
  | { type: "content:card-dismiss" };

export type PopupMessage =
  | { type: "popup:state" }
  | { type: "popup:pair"; code: string }
  | { type: "popup:unpair" }
  | { type: "popup:lock" }
  | { type: "popup:unlock"; pin: string }
  | { type: "popup:match" }
  | { type: "popup:search"; query: string }
  | { type: "popup:fill"; name: string }
  | { type: "popup:copy-password"; name: string }
  | { type: "popup:copy-text"; text: string }
  | { type: "popup:cards" }
  | { type: "popup:card-fill"; name: string }
  | {
      type: "popup:save";
      entry: { name: string; login: string; url: string; password?: string; note?: string };
      mode: "create" | "update";
    };

/** From confirm.html, the window that asks the human about an agent card fill. */
export type ConfirmMessage = { type: "confirm:details"; id: string } | { type: "confirm:decision"; id: string; decision: "confirm" | "decline" };

export interface ConfirmDetails {
  host: string;
  label: string;
  brand: string;
  last4: string;
  exp: string;
  /** Payment provider frames (hosts) the fill would type into, e.g. js.stripe.com. */
  paymentHosts: string[];
  /** Milliseconds until the request lapses. */
  remainingMs: number;
}

export type OffscreenMessage =
  | { target: "offscreen"; type: "copy"; text: string }
  | { target: "offscreen"; type: "clear" };

/** Shown by the content script in the top frame; never contains the password. */
export interface SavePrompt {
  kind: "new" | "update";
  name: string;
  login: string;
  host: string;
}

export interface EntryView {
  name: string;
  login: string;
  url: string;
  updated: string;
  match?: "exact" | "domain";
}

export interface PopupState {
  paired: boolean;
  locked: boolean;
  online: boolean;
  serviceUrl: string;
  tabUrl: string | null;
  fillAllowed: boolean;
  /** Payment cards are part of this build (off by default). */
  cards: boolean;
  error?: string;
}

/** A card as the popup, the picker and the confirmation show it: no number, no code. */
export interface CardView {
  name: string;
  label: string;
  brand: string;
  last4: string;
  exp: string;
  expired: boolean;
  cardholder?: string;
}

/** The card save bar's prompt; the typed card itself stays in the background. */
export interface CardSavePrompt {
  kind: "new" | "update";
  label: string;
  brand: string;
  last4: string;
  exp: string;
  host: string;
  hasCvv: boolean;
}

export interface CardFillReply {
  status: string;
  detail?: string;
  filled?: string[];
  missing?: string[];
}
