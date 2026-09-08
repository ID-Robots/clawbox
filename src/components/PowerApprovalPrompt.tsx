"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { DESKTOP_LAYERS } from "@/lib/window-snap";

interface Prompt { id: string; action: "restart" | "shutdown"; reason: string; expiresAt: number }

/** Human-only confirmation. Rendering or fetching a request never authorizes it. */
export default function PowerApprovalPrompt() {
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
    const refresh = async () => {
      if (inFlight || decisionPending.current) return;
      inFlight = true;
      try {
        const res = await fetch("/setup-api/system/power/approval", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!stopped && !decisionPending.current) setPrompt(data.pending?.expiresAt > Date.now() ? data.pending : null);
      } catch { /* A network outage is not a confirmation. */ }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { stopped = true; clearInterval(timer); };
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
}
