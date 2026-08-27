"use client";

import { useEffect, useState } from "react";

/**
 * The desktop's toast surface.
 *
 * Every server-side "tell the owner" path ends in a `clawbox:toast` window
 * event: the MCP `ui_notify` tool, `clawbox notify`, notifyOwner() in
 * src/lib/email-notify.ts and the coding agent's finish notice all write the
 * `ui:pending-action` slot that src/app/page.tsx polls, and page.tsx turns a
 * `notify` action into this event. Until this component existed nothing
 * LISTENED — the event fired into the void and every one of those notices was
 * invisible. Keep this mounted once, on the desktop.
 *
 * Text is shown as text. It may have been authored by the agent (ui_notify),
 * so it is never rendered as markup.
 */

export const TOAST_EVENT = "clawbox:toast";
const TOAST_MS = 8_000;
const MAX_TOASTS = 4;
const MAX_CHARS = 280;

interface Toast {
  id: number;
  message: string;
}

export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    let seq = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      const message = typeof detail?.message === "string" ? detail.message.trim() : "";
      if (!message) return;
      seq += 1;
      const id = seq;
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, message: message.slice(0, MAX_CHARS) }]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, TOAST_MS);
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
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          aria-live="polite"
          className="pointer-events-auto flex items-start gap-3 rounded-xl bg-[#1e2030] border border-white/10 shadow-2xl px-4 py-3 animate-in slide-in-from-bottom-2 fade-in duration-300"
        >
          <span className="material-symbols-rounded text-[var(--coral-bright)] shrink-0" style={{ fontSize: 20 }} aria-hidden="true">
            notifications
          </span>
          <div className="flex-1 min-w-0 text-sm text-white break-words">{toast.message}</div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
            className="shrink-0 text-white/50 hover:text-white"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
          </button>
        </div>
      ))}
    </div>
  );
}
