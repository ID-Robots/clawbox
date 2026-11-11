"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The route's shape, declared here rather than imported, like OpenClawSharingCard:
// a client component stays a fetch away from the server graph behind it.
interface OrgModeStatus {
  orgMode: boolean;
  canChange: boolean;
}

// The owner's "Organisation mode" switch (Settings → System → Users). Off
// unless the owner turns it on; src/lib/org-mode.ts is what it narrows.
//
// SHAPE-CHECKED, not cast: a body without the fields hides the card.
function isStatus(body: unknown): body is OrgModeStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<Record<keyof OrgModeStatus, unknown>>;
  return typeof b.orgMode === "boolean" && typeof b.canChange === "boolean";
}

const URL_ = "/setup-api/settings/org-mode";

export default function OrgModeCard() {
  const { t } = useT();
  const [status, setStatus] = useState<OrgModeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The route's own sentence for a refusal; "" for a failure that had none.
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(URL_, { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // Nothing to draw: the card stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function toggle(orgMode: boolean) {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgMode }),
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

  // The owner's decision alone.
  if (!status || !status.canChange) return null;

  return (
    <div className="rounded-xl border border-white/10 p-4" data-testid="org-mode">
      <div className="flex items-start gap-3">
        <span className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-white">{t("users.orgMode.title")}</h4>
          <p className="text-xs text-white/60 mt-1 leading-relaxed">{t("users.orgMode.hint")}</p>
          <span
            className={`block text-xs font-medium mt-2 ${status.orgMode ? "text-[var(--amber-ink)]" : "text-white/70"}`}
            data-testid="org-mode-state"
          >
            {t(status.orgMode ? "users.orgMode.on" : "users.orgMode.off")}
          </span>
          <span className="block text-[11px] text-white/45 mt-1 leading-relaxed">{t("users.orgMode.applies")}</span>
          {failed !== null && (
            <span className="block text-[11px] text-[var(--amber-ink)] mt-1" role="alert" data-testid="org-mode-failed">
              {t("users.orgMode.failed")}
              {failed ? ` ${failed}` : ""}
            </span>
          )}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={status.orgMode}
          aria-label={t("users.orgMode.title")}
          aria-busy={busy}
          disabled={busy}
          data-testid="org-mode-switch"
          onClick={() => void toggle(!status.orgMode)}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${status.orgMode ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${status.orgMode ? "left-[22px]" : "left-0.5"}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}
