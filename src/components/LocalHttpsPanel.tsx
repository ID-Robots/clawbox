"use client";

import { useCallback, useEffect, useState } from "react";

import { useT } from "@/lib/i18n";
import { probeLocalHttps } from "@/lib/local-https-client";

// The route's shape, declared here rather than imported: the server module
// behind it talks to the portal and writes keys, and a client component must
// not stand one import away from that graph (the ClawboxMcpPanel precedent).
interface LocalHttpsStatus {
  enabled: boolean;
  hostname: string | null;
  url: string | null;
  lanIp: string | null;
  serving: boolean;
  certNotAfter: number | null;
  issuing: boolean;
  problem: { code: string; detail?: string } | null;
  dns: string | null;
  portal: "portal" | "stub";
}

// SHAPE-CHECKED, not cast: a body without the fields (an older server, the
// e2e mock's `{}`, a 403 for a user who is not the owner) hides the card.
function isStatus(body: unknown): body is LocalHttpsStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.enabled === "boolean" && typeof b.serving === "boolean" && typeof b.issuing === "boolean";
}

// The route's problem codes → their sentences (keys are camelCase).
const PROBLEM_KEYS: Record<string, string> = {
  not_paired: "settings.localHttps.problemNotPaired",
  portal_unavailable: "settings.localHttps.problemPortalUnavailable",
  portal_error: "settings.localHttps.problemPortalError",
  rate_limited: "settings.localHttps.problemRateLimited",
  no_lan_ip: "settings.localHttps.problemNoLanIp",
  order_failed: "settings.localHttps.problemOrderFailed",
  bad_certificate: "settings.localHttps.problemBadCertificate",
  write_failed: "settings.localHttps.problemWriteFailed",
};

const DNS_KEYS: Record<string, string> = {
  rebind_blocked: "settings.localHttps.dnsRebind",
  stale: "settings.localHttps.dnsStale",
  pending: "settings.localHttps.dnsPending",
};

const POLL_MS = 4_000;

type BrowserCheck = "checking" | "ok" | "blocked" | "here" | null;

/**
 * Settings → Network → Secure local address (docs/design/local-https.md).
 * The owner's opt-in: the privacy note stands above the switch, always, so
 * the disclosure is read before the address ever leaves the box.
 */
export default function LocalHttpsPanel() {
  const { t } = useT();
  const [status, setStatus] = useState<LocalHttpsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [browser, setBrowser] = useState<BrowserCheck>(null);

  const read = useCallback(async (): Promise<LocalHttpsStatus | null> => {
    try {
      const r = await fetch("/setup-api/local-https", { cache: "no-store" });
      if (!r.ok) return null;
      const body: unknown = await r.json();
      return isStatus(body) ? body : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void read().then((s) => {
      if (alive && s) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [read]);

  // Poll while the box is still getting there: an order in flight, or on
  // with nothing served and nothing wrong yet.
  const settling = !!status?.enabled && (status.issuing || (!status.serving && !status.problem));
  useEffect(() => {
    if (!settling) return;
    let alive = true;
    const timer = setInterval(() => {
      void read().then((s) => {
        if (alive && s) setStatus(s);
      });
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [settling, read]);

  // Does THIS browser reach the address? What its resolver says is what
  // counts — the box's own DNS check cannot speak for a phone on mobile DNS.
  const url = status?.enabled && status.serving ? status.url : null;
  const hostname = status?.hostname ?? null;
  useEffect(() => {
    if (!url) {
      setBrowser(null);
      return;
    }
    if (window.location.protocol === "https:" && window.location.hostname === hostname) {
      setBrowser("here");
      return;
    }
    let alive = true;
    setBrowser("checking");
    void probeLocalHttps(url).then((ok) => {
      if (alive) setBrowser(ok ? "ok" : "blocked");
    });
    return () => {
      alive = false;
    };
  }, [url, hostname]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setFailed(false);
    const leavingHere = !enabled && browser === "here" && status?.lanIp;
    try {
      const r = await fetch("/setup-api/local-https", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body: unknown = await r.json().catch(() => null);
      if (!r.ok) {
        setFailed(true);
        return;
      }
      if (leavingHere) {
        // This page's own name has just stopped being the box's.
        window.location.assign(`http://${status!.lanIp}/`);
        return;
      }
      if (isStatus(body)) setStatus(body);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  const ip = status.lanIp ?? "";
  const dnsKey = status.dns ? DNS_KEYS[status.dns] : undefined;
  const problemKey = status.problem ? PROBLEM_KEYS[status.problem.code] : undefined;
  // A blocked browser on a router that blocks the name is the DNS line's to explain.
  const browserText =
    browser === "here" ? t("settings.localHttps.youAreHere")
    : browser === "checking" ? t("settings.localHttps.browserChecking")
    : browser === "ok" ? t("settings.localHttps.browserOk")
    : browser === "blocked" && status.dns !== "rebind_blocked" ? t("settings.localHttps.browserBlocked", { ip })
    : null;

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="local-https-panel">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          lock
        </span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.localHttps.title")}
        </h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-2 leading-relaxed">{t("settings.localHttps.intro")}</p>
      <p className="text-[11px] text-[var(--text-secondary)] mb-3 leading-relaxed" data-testid="local-https-privacy">
        {t("settings.localHttps.privacy")}
      </p>

      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
        <div className="flex items-start gap-3 px-3 py-3">
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-[var(--text-primary)] font-medium">{t("settings.localHttps.switchLabel")}</span>
            <span className="block text-[11px] text-[var(--text-secondary)] mt-0.5" data-testid="local-https-state">
              {busy ? t("settings.localHttps.saving") : t(status.enabled ? "settings.localHttps.on" : "settings.localHttps.off")}
            </span>
            {failed && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="local-https-failed">
                {t("settings.localHttps.failed")}
              </span>
            )}
            {status.enabled && browser === "here" && ip && (
              <span className="block text-[11px] text-[var(--text-muted)] mt-1" data-testid="local-https-leaving">
                {t("settings.localHttps.leavingWarning", { ip })}
              </span>
            )}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={status.enabled}
            aria-label={t("settings.localHttps.switchLabel")}
            aria-busy={busy}
            disabled={busy}
            data-testid="local-https-switch"
            onClick={() => void toggle(!status.enabled)}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${status.enabled ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${status.enabled ? "left-[22px]" : "left-0.5"}`}
              aria-hidden="true"
            />
          </button>
        </div>

        {status.enabled && (
          <div className="border-t border-white/[0.06] px-3 py-3 space-y-1.5 text-[11px] leading-relaxed">
            {status.url && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-muted)] shrink-0">{t("settings.localHttps.address")}</span>
                <span className="flex-1 min-w-0 font-mono text-[var(--text-primary)] truncate" data-testid="local-https-url">
                  {status.url}
                </span>
                {status.serving && browser !== "here" && (
                  <a
                    href={status.url}
                    className="px-2.5 py-1 bg-white/[0.06] hover:bg-white/[0.12] text-[var(--text-primary)] rounded-lg no-underline"
                    data-testid="local-https-open"
                  >
                    {t("settings.localHttps.open")}
                  </a>
                )}
              </div>
            )}
            <div className="text-[var(--text-secondary)]" data-testid="local-https-cert">
              {status.issuing
                ? t("settings.localHttps.preparing")
                : status.serving && status.certNotAfter
                  ? t("settings.localHttps.ready", { date: new Date(status.certNotAfter).toLocaleDateString() })
                  : !status.problem
                    ? t("settings.localHttps.notServing")
                    : null}
            </div>
            {browserText && (
              <div
                className={browser === "blocked" ? "text-[var(--amber-ink)]" : "text-[var(--text-secondary)]"}
                data-testid="local-https-browser"
                data-state={browser ?? ""}
              >
                {browserText}
              </div>
            )}
            {dnsKey && (
              <div className="text-[var(--amber-ink)]" data-testid="local-https-dns" data-state={status.dns ?? ""}>
                {t(dnsKey, { ip })}
              </div>
            )}
            {problemKey && (
              <div className="text-[var(--amber-ink)]" data-testid="local-https-problem" data-code={status.problem?.code}>
                {t(problemKey)}
              </div>
            )}
            {status.portal === "stub" && (
              <div className="text-[var(--text-muted)]" data-testid="local-https-stub">
                {t("settings.localHttps.stubMode")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
