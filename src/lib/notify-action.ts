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
 * Each label says where the click goes; ToastHost puts it after the notice's
 * own text in the button's accessible name. In English, like ToastHost's own
 * "Dismiss": the desktop shell's aria labels are not translated today, and a
 * label that lied would be worse than one that is untranslated.
 */
export const NOTIFY_ACTION_TARGETS = {
  settings: { email: "Open Settings → Email" },
} as const;

type NotifyActionApp = keyof typeof NOTIFY_ACTION_TARGETS;

/** One allowlisted destination: which app, and which section of it. */
export type NotifyAction = {
  [App in NotifyActionApp]: { open: App; section: keyof (typeof NOTIFY_ACTION_TARGETS)[App] };
}[NotifyActionApp];

/** The email queue's destination — the one producer that has a use for this today. */
export const OPEN_EMAIL_SETTINGS: NotifyAction = { open: "settings", section: "email" };

/**
 * The allowlisted pair this value names, or null.
 *
 * Answers with the TABLE's pair rather than the caller's object: a valid pair
 * arriving with an `href`, a draft id or any other field loses them here.
 */
export function parseNotifyAction(value: unknown): NotifyAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { open, section } = value as { open?: unknown; section?: unknown };
  if (typeof open !== "string" || typeof section !== "string") return null;
  // hasOwn, not `in`: these strings come from JSON on disk, and `constructor`
  // or `toString` would otherwise resolve against the prototype.
  if (!Object.hasOwn(NOTIFY_ACTION_TARGETS, open)) return null;
  const sections: Record<string, string> = NOTIFY_ACTION_TARGETS[open as NotifyActionApp];
  if (!Object.hasOwn(sections, section)) return null;
  return { open, section } as NotifyAction;
}

/** The phrase that says where clicking such a notice goes. */
export function notifyActionLabel(action: NotifyAction): string {
  const sections: Record<string, string> = NOTIFY_ACTION_TARGETS[action.open];
  return sections[action.section];
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
