/**
 * Where a desktop notice may take the owner when they click it.
 *
 * The email-approval toast — "The assistant wants to send an email. Open
 * Settings → Email to approve or delete it." — used to be a dead end: it named
 * a place and made the owner walk there. Clicking its body now opens Settings
 * on the Email section, through the deep link that already exists
 * (`dispatchOpenSettingsSection` in src/lib/ui-events.ts).
 *
 * That means a notice on the owner-notice ring can carry a DESTINATION, and
 * the ring is not ClawBox's alone: the `ui_notify` MCP tool and `clawbox
 * notify` push onto it from another process, driven by the AGENT, whose text
 * is untrusted (ToastHost renders it as text for exactly that reason). A
 * free-form destination — a URL, an arbitrary app id — would turn every
 * notification into a click target the assistant chose.
 *
 * So a destination is not data, it is a choice from a CLOSED SET, and this
 * module is that set. `parseNotifyAction` answers with the table's own pair or
 * with null, never with the caller's object, so an unrecognised destination, a
 * prototype key or a field smuggled alongside a valid pair cannot reach a
 * desktop. Two producers check against it — the route that writes the notice
 * and the desktop that renders it — because the value sits on disk in between.
 */

/**
 * Every destination a notice may name: the app, then the sections of it that
 * are offered. Adding a section here is what makes it reachable from a toast;
 * adding an APP also needs an arm in ToastHost's `openNotifyAction`.
 *
 * Each section names its own TRANSLATION KEY — the label the Settings sidebar
 * already draws for it — and `notifyActionLabel` puts it into the app's phrase
 * ("Open Settings → {section}"). ToastHost places that after the notice's own
 * text in the button's accessible name. Keys rather than English because the
 * shell's aria labels were the one part of a German or Japanese desktop a
 * screen reader still heard in English (UI sweep 2026-09-07, shell-7).
 */
export const NOTIFY_ACTION_TARGETS = {
  settings: { email: "settings.email", ai: "settings.providers" },
} as const;

type NotifyActionApp = keyof typeof NOTIFY_ACTION_TARGETS;

/** The phrase that says where a click goes, per app, with the section's name in `{section}`. */
const NOTIFY_ACTION_PHRASE_KEYS: Record<NotifyActionApp, string> = {
  settings: "desktop.toast.openSettings",
};

/** The `t` of `useT()` — handed in rather than imported, so this module stays free of React. */
export type NotifyTranslate = (key: string, params?: Record<string, string | number>) => string;

/**
 * A block INSIDE a section that a notice may also ask to have opened and
 * brought into view once the section lands — and, like the destinations, a
 * closed set. Each one names the single pair it lives on, so a focus can only
 * ever ride on its own section: `parseNotifyAction` drops one that arrives on
 * any other.
 *
 * The receiving end is SettingsApp's deep-link listener, which hands the ask to
 * the component that draws the block. Adding a focus here also needs it there.
 */
export const NOTIFY_ACTION_FOCUS = {
  /** The Anthropic accounts, behind the disclosure on the Providers list's Anthropic row. */
  anthropicAccounts: { open: "settings", section: "ai" },
} as const;

export type NotifyActionFocus = keyof typeof NOTIFY_ACTION_FOCUS;

/** One allowlisted destination: which app, which section of it, and optionally which block in that section. */
export type NotifyAction = {
  [App in NotifyActionApp]: {
    open: App;
    section: keyof (typeof NOTIFY_ACTION_TARGETS)[App];
    focus?: NotifyActionFocus;
  };
}[NotifyActionApp];

/** The email queue's destination. */
export const OPEN_EMAIL_SETTINGS: NotifyAction = { open: "settings", section: "email" };

/**
 * Settings → Providers with the Anthropic accounts open and scrolled into view
 * — for the account-limit notices (TASK-902). The accounts are collapsed behind
 * a button on the Anthropic row by default, so the section alone would land the
 * owner on a list with the one thing the notice is about folded away.
 */
export const OPEN_ANTHROPIC_ACCOUNTS_SETTINGS: NotifyAction = { open: "settings", section: "ai", focus: "anthropicAccounts" };

/**
 * The allowlisted pair this value names, or null.
 *
 * Answers with the TABLE's pair rather than the caller's object: a valid pair
 * arriving with an `href`, a draft id or any other field loses them here. A
 * `focus` survives only when the focus table names it AND names this very
 * pair as its home; any other one is dropped like any other extra field, and
 * the pair still opens its section.
 */
export function parseNotifyAction(value: unknown): NotifyAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { open, section, focus } = value as { open?: unknown; section?: unknown; focus?: unknown };
  if (typeof open !== "string" || typeof section !== "string") return null;
  // hasOwn, not `in`: these strings come from JSON on disk, and `constructor`
  // or `toString` would otherwise resolve against the prototype.
  if (!Object.hasOwn(NOTIFY_ACTION_TARGETS, open)) return null;
  const sections: Record<string, string> = NOTIFY_ACTION_TARGETS[open as NotifyActionApp];
  if (!Object.hasOwn(sections, section)) return null;
  if (typeof focus === "string" && Object.hasOwn(NOTIFY_ACTION_FOCUS, focus)) {
    const home = NOTIFY_ACTION_FOCUS[focus as NotifyActionFocus];
    if (home.open === open && home.section === section) return { open, section, focus } as NotifyAction;
  }
  return { open, section } as NotifyAction;
}

/** The phrase that says where clicking such a notice goes, in the desktop's language. */
export function notifyActionLabel(action: NotifyAction, t: NotifyTranslate): string {
  const sections: Record<string, string> = NOTIFY_ACTION_TARGETS[action.open];
  return t(NOTIFY_ACTION_PHRASE_KEYS[action.open], { section: t(sections[action.section]) });
}

/** What `ToastHost` is handed for one notice: the words, and where clicking goes. */
export interface ToastNoticeDetail {
  message: string;
  action?: NotifyAction;
}

/**
 * The `clawbox:toast` detail for one `notify` entry off the owner-notice ring,
 * or null when there is nothing to show.
 *
 * Lives here rather than inline in the desktop's poll loop so that the one
 * step which carries a destination OUT of the ring is testable: `page.tsx` has
 * no render tests, and a wrong field name there would leave the feature dead
 * on the box with a green suite.
 */
export function toastDetailForNotice(notice: Record<string, unknown>): ToastNoticeDetail | null {
  const message = typeof notice.message === "string" ? notice.message : "";
  if (!message) return null;
  const target = parseNotifyAction(notice.action);
  return { message, ...(target ? { action: target } : {}) };
}
