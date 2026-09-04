"use client";

import { useCallback, useEffect, useState } from "react";
import { notifyActionLabel, parseNotifyAction, type NotifyAction } from "@/lib/notify-action";
import { dispatchOpenSettingsSection } from "@/lib/ui-events";
import { NOTICE_AUTO_HIDE_MS } from "@/lib/use-auto-hide";

/**
 * The desktop's toast surface.
 *
 * Every server-side "tell the owner" path goes through the owner-notice ring
 * (`ui:pending-actions`, src/lib/pending-actions.ts) that every open desktop
 * polls: the MCP `ui_notify` tool, `clawbox notify` and notifyOwner() in
 * src/lib/email-notify.ts all push onto it, and src/app/page.tsx turns a
 * `notify` action into a `clawbox:toast` window event. (The coding agent's
 * finish notice rides the same ring but becomes a top-right card, not a
 * toast — only `notify` actions end here.) Until this component existed
 * nothing LISTENED — the event fired into the void and every one of those
 * notices was invisible. Keep this mounted once, on the desktop.
 *
 * Text is shown as text. It may have been authored by the agent (ui_notify),
 * so it is never rendered as markup.
 *
 * A notice may also name WHERE IT TAKES THE OWNER: the email-approval toast
 * carries `{ open: "settings", section: "email" }`, and its body — everything
 * but the X — is then a button that opens Settings there and dismisses itself.
 * The destination is an allowlisted pair (src/lib/notify-action.ts), checked
 * again here: the same ring carries agent-written notices, and a toast that
 * can be clicked must never take the owner somewhere the assistant chose.
 */

export const TOAST_EVENT = "clawbox:toast";
/** A notice that only says something. Long enough to read, short enough to stay out of the way. */
const TOAST_MS = 8_000;
/**
 * A notice the owner can ACT on: the desktop's shared clock
 * (`NOTICE_AUTO_HIDE_MS`, the one the finish card, the update card and the
 * pairing request run on), because eight seconds is the time it takes to read
 * a bubble, not the time it takes to decide to click it — and a toast that
 * vanishes under the pointer leaves the owner back at the walk to Settings
 * this exists to remove.
 */
const ACTIONABLE_TOAST_MS = NOTICE_AUTO_HIDE_MS;
const MAX_TOASTS = 4;
const MAX_CHARS = 280;

interface Toast {
  id: number;
  message: string;
  /** Where clicking the body goes, or null for a notice that only says something. */
  action: NotifyAction | null;
}

/** Take the owner where the notice points. */
function openNotifyAction(action: NotifyAction): void {
  switch (action.open) {
    case "settings":
      // The deep link that already exists: it leaves a handoff on `window` so
      // a COLD open of Settings still lands on the section, and fires the
      // event for a Settings window that is already up.
      dispatchOpenSettingsSection(action.section);
      return;
    default: {
      // `open` is typed from the allowlist table, so adding an app there stops
      // this assignment compiling until it gets an arm above.
      const unhandled: never = action.open;
      return unhandled;
    }
  }
}

export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    let seq = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown; action?: unknown }>).detail;
      const message = typeof detail?.message === "string" ? detail.message.trim() : "";
      if (!message) return;
      const action = parseNotifyAction(detail?.action);
      seq += 1;
      const id = seq;
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, message: message.slice(0, MAX_CHARS), action }]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, action ? ACTIONABLE_TOAST_MS : TOAST_MS);
      timers.add(timer);
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => {
      window.removeEventListener(TOAST_EVENT, handler);
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-[99999] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2" data-testid="toast-host">
      {toasts.map((toast) => {
        const action = toast.action;
        const body = (
          <>
            <span className="material-symbols-rounded text-[var(--coral-bright)] shrink-0" style={{ fontSize: 20 }} aria-hidden="true">
              notifications
            </span>
            <span className="block flex-1 min-w-0 text-sm text-white break-words">{toast.message}</span>
          </>
        );
        // The bubble's own padding sits on these two children rather than on
        // the row, so that on an actionable notice the whole area around the
        // text is inside the button — the owner asked to click "inside the
        // bubble", and padding that did nothing is still bubble to them.
        const bodyClass = "flex flex-1 min-w-0 items-start gap-3 pl-4 pr-1 py-3 text-left";
        return (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex items-start rounded-xl bg-[var(--bg-elevated)] border border-white/10 shadow-2xl animate-in slide-in-from-bottom-2 fade-in duration-300"
          >
            {action ? (
              <button
                type="button"
                // The MESSAGE first, then where the click goes. A bare
                // "Open Settings → Email" would be the whole accessible name
                // of this button — and the toast is a live region, whose
                // announcement is computed from its subtree's accessible
                // names, so a screen reader would hear the destination and
                // never the notice itself.
                aria-label={`${toast.message} — ${notifyActionLabel(action)}`}
                onClick={() => {
                  openNotifyAction(action);
                  dismiss(toast.id);
                }}
                className={`${bodyClass} cursor-pointer rounded-l-xl hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--coral-bright)]`}
              >
                {body}
              </button>
            ) : (
              <div className={bodyClass}>{body}</div>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 cursor-pointer pl-1 pr-4 py-3 text-white/50 hover:text-white"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
