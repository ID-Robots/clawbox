"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The route's shape, declared here rather than imported, like PathGuardPanel:
// a client component stays a fetch away from the server graph behind it.
interface SharingStatus {
  shared: boolean;
  canChange: boolean;
  available: boolean;
}

// The owner's "Share OpenClaw with all users" switch (Settings → Users). Off
// unless the owner turns it on; src/lib/non-owner-scope.ts is what it opens.
//
// SHAPE-CHECKED, not cast: a body without the fields hides the card.
function isStatus(body: unknown): body is SharingStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<Record<keyof SharingStatus, unknown>>;
  return typeof b.shared === "boolean" && typeof b.canChange === "boolean" && typeof b.available === "boolean";
}

export default function OpenClawSharingCard() {
  const { t } = useT();
  const [status, setStatus] = useState<SharingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The route's own sentence for a refusal; "" for a failure that had none.
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/settings/openclaw-sharing", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // Nothing to draw: the card stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function toggle(shared: boolean) {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch("/setup-api/settings/openclaw-sharing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared }),
      });
      const body: unknown = await r.json().catch(() => null);
      if (r.ok && isStatus(body)) {
        setStatus(body);
      } else {
        const error = (body as { error?: unknown } | null)?.error;
        setFailed(typeof error === "string" ? error : "");
      }
    } catch {
      setFailed("");
    } finally {
      setBusy(false);
    }
  }

  // The owner's decision alone, and only where there is an OpenClaw to share.
  if (!status || !status.canChange || !status.available) return null;

  return (
    <div className="rounded-xl border border-white/10 p-4" data-testid="openclaw-sharing">
      <div className="flex items-start gap-3">
        <span className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-white">{t("users.shareOpenclaw.title")}</h4>
          <p className="text-xs text-white/60 mt-1 leading-relaxed">{t("users.shareOpenclaw.hint")}</p>
          <span
            className={`block text-xs font-medium mt-2 ${status.shared ? "text-[var(--amber-ink)]" : "text-white/70"}`}
            data-testid="openclaw-sharing-state"
          >
            {t(status.shared ? "users.shareOpenclaw.on" : "users.shareOpenclaw.off")}
          </span>
          <span className="block text-[11px] text-white/45 mt-1 leading-relaxed">{t("users.shareOpenclaw.applies")}</span>
          {failed !== null && (
            <span className="block text-[11px] text-[var(--amber-ink)] mt-1" role="alert" data-testid="openclaw-sharing-failed">
              {t("users.shareOpenclaw.failed")}
              {failed ? ` ${failed}` : ""}
            </span>
          )}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={status.shared}
          aria-label={t("users.shareOpenclaw.title")}
          aria-busy={busy}
          disabled={busy}
          data-testid="openclaw-sharing-switch"
          onClick={() => void toggle(!status.shared)}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${status.shared ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${status.shared ? "left-[22px]" : "left-0.5"}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}
