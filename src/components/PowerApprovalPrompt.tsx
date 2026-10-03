"use client";
import { memo, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { DESKTOP_LAYERS } from "@/lib/window-snap";
import { setVisibleInterval } from "@/lib/visible-interval";

interface Prompt { id: string; action: "restart" | "shutdown"; reason: string; expiresAt: number }

/**
 * Fired on `window` by the desktop when the owner-notice ring says a power
 * request was raised, answered or ran out (a `power_approval` notice, pushed by
 * src/lib/power-approval.ts). The prompt then asks the approval route what is
 * pending: the notice only says WHEN to ask, never what to show.
 */
export const POWER_APPROVAL_EVENT = "clawbox:power-approval";

/**
 * How often the prompt asks on its own, as a SAFETY net under the ring: a
 * notice the desktop could not read (the box's store refused the write, the
 * ring poll failed at the wrong moment) still reaches the screen within a
 * minute. It used to be the only way the prompt learned anything, every 5 s
 * on every owner desktop, all day, for a request that almost never exists —
 * the ring now brings a request to the screen within its own 2 s instead.
 */
const SAFETY_POLL_MS = 60_000;

/**
 * Human-only confirmation. Rendering or fetching a request never authorizes it.
 *
 * Memoized: it takes no props, and the desktop re-renders for a hundred things
 * this prompt does not show — it re-renders for its own state alone.
 */
const PowerApprovalPrompt = memo(function PowerApprovalPrompt() {
  const { t } = useT();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const decisionPending = useRef(false);
  const denyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (prompt?.id) denyButton.current?.focus(); }, [prompt?.id]);
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    // Asked for while a request was already in flight: that answer may predate
    // what the ask was for (a request raised just after the server answered),
    // so it is asked once more when the first lands rather than dropped.
    let askAgain = false;
    const refresh = async () => {
      if (decisionPending.current) return;
      if (inFlight) { askAgain = true; return; }
      inFlight = true;
      try {
        const res = await fetch("/setup-api/system/power/approval", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!stopped && !decisionPending.current) setPrompt(data.pending?.expiresAt > Date.now() ? data.pending : null);
      } catch { /* A network outage is not a confirmation. */ }
      finally {
        inFlight = false;
        if (askAgain && !stopped) {
          askAgain = false;
          void refresh();
        }
      }
    };
    void refresh();
    // The ring's word: something about a power request changed.
    const onNotice = () => { void refresh(); };
    window.addEventListener(POWER_APPROVAL_EVENT, onNotice);
    // The safety poll waits while the page is HIDDEN (a phone or a laptop tab
    // in the background), where the prompt could not be seen, and asks at once
    // on the way back if a tick fell due meanwhile (src/lib/visible-interval.ts).
    // The ring keeps reading behind a hidden tab, so a request raised while
    // away is already known when the owner is back.
    const stopPoll = setVisibleInterval(() => { void refresh(); }, SAFETY_POLL_MS);
    return () => {
      stopped = true;
      window.removeEventListener(POWER_APPROVAL_EVENT, onNotice);
      stopPoll();
    };
  }, []);
  const decide = async (approve: boolean) => {
    if (!prompt || decisionPending.current) return;
    decisionPending.current = true;
    setBusy(true); setError(false);
    try {
      const res = await fetch("/setup-api/system/power/approval", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: prompt.id, action: prompt.action, approve }),
      });
      if (!res.ok) {
        if (res.status === 409 || res.status === 500) setPrompt(null);
        throw new Error("Confirmation failed");
      }
      setPrompt(null);
    } catch { setError(true); }
    finally { decisionPending.current = false; setBusy(false); }
  };
  if (!prompt && !error) return null;
  return <section role="alertdialog" aria-modal="false" aria-labelledby="power-approval-title"
    className="fixed bottom-20 right-5 max-w-sm rounded-xl border border-white/20 bg-[var(--bg-elevated)] p-5 text-white shadow-xl"
    style={{ zIndex: DESKTOP_LAYERS.notice }}>
    <h2 id="power-approval-title" className="font-semibold">{t("chat.approval.title")}</h2>
    {prompt && <p className="mt-2 text-lg">{t(prompt.action === "restart" ? "tray.restart" : "tray.shutDown")}</p>}
    <p className="mt-2 text-sm text-white/70">{t("chat.approval.summary")}</p>
    {prompt && <blockquote className="my-3 max-h-24 overflow-auto whitespace-pre-wrap break-words border-l-2 border-white/30 pl-3 text-sm">{prompt.reason}</blockquote>}
    {error && <p role="alert" className="mb-2 text-sm text-red-300">{t("chat.approval.failed")}</p>}
    {!prompt && error && <button onClick={() => setError(false)} className="rounded-lg border border-white/20 px-3 py-2">{t("window.close")}</button>}
    {prompt && <div className="flex gap-3">
      <button ref={denyButton} disabled={busy || !prompt} onClick={() => void decide(false)} className="rounded-lg border border-white/20 px-3 py-2">{t("chat.approval.deny")}</button>
      <button disabled={busy || !prompt} onClick={() => void decide(true)} className="rounded-lg bg-red-600 px-3 py-2">{t("chat.approval.allowOnce")}</button>
    </div>}
  </section>;
});

export default PowerApprovalPrompt;
