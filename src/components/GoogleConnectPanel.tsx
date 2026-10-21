"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The route's shape, declared here rather than imported: the server module
// behind it reads token files and spawns processes, and a client component must
// not stand one import away from that graph (the PathGuardPanel precedent).
interface GoogleConnectStatus {
  configured: boolean;
  hermes: boolean;
  connected: boolean;
  ownClient: boolean;
  scopes: string[];
  pending: boolean;
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// "Connect Google": the owner's Google account for the assistant's Calendar and
// Drive, through ClawBox's own Google client. Behind CLAWBOX_GOOGLE_CONNECT —
// with it off the route answers 404 and this card draws nothing.
//
// SHAPE-CHECKED, not cast: a body without the fields hides the card.
function isStatus(body: unknown): body is GoogleConnectStatus {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.configured === "boolean" && typeof b.hermes === "boolean"
    && typeof b.connected === "boolean" && typeof b.ownClient === "boolean"
    && Array.isArray(b.scopes) && typeof b.pending === "boolean";
}

function errorOf(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : "";
}

export default function GoogleConnectPanel() {
  const { t } = useT();
  const [status, setStatus] = useState<GoogleConnectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // The consent URL of the sign-in this card started; null when none is open.
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  // The route's own sentence for a refusal; "" for a failure without one.
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/google/connect", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // Nothing to draw: the card stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function post(route: string, payload?: unknown): Promise<{ ok: boolean; body: unknown }> {
    const r = await fetch(`/setup-api/google/connect/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    return { ok: r.ok, body: await r.json().catch(() => null) };
  }

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setFailed(null);
    try {
      await step();
    } catch {
      setFailed("");
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => {
    const { ok, body } = await post("start");
    const url = (body as { url?: unknown } | null)?.url;
    if (!ok || typeof url !== "string") {
      setFailed(errorOf(body));
      return;
    }
    setPasted("");
    setAuthUrl(url);
  });

  const finish = () => run(async () => {
    const { ok, body } = await post("exchange", { redirect: pasted });
    // A 502 after a stored grant still carries the new status: draw it.
    if (isStatus(body)) setStatus(body);
    if (isStatus(body) && body.connected) {
      setAuthUrl(null);
      setPasted("");
    }
    if (!ok) setFailed(errorOf(body));
  });

  const disconnect = () => run(async () => {
    const { ok, body } = await post("disconnect");
    if (isStatus(body)) setStatus(body);
    if (!ok) setFailed(errorOf(body));
  });

  if (!status) return null;

  const usable = status.configured && status.hermes;
  const scopeLabels = [
    status.scopes.includes(CALENDAR_SCOPE) ? t("settings.googleConnect.scopeCalendar") : null,
    status.scopes.includes(DRIVE_SCOPE) ? t("settings.googleConnect.scopeDrive") : null,
  ].filter((s): s is string => s !== null);

  const buttonClass = "shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50";

  return (
    <div className="max-w-xl" data-testid="google-connect-panel">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          event_available
        </span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.googleConnect.title")}
        </h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">{t("settings.googleConnect.hint")}</p>

      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
        <div className="flex items-start gap-3 px-3 py-3">
          <span className="flex-1 min-w-0">
            <span
              className={`block text-sm font-medium ${status.connected ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}
              data-testid="google-connect-state"
            >
              {t(status.connected ? "settings.googleConnect.connected" : "settings.googleConnect.disconnected")}
            </span>
            {status.connected && scopeLabels.length > 0 && (
              <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid="google-connect-scopes">
                {scopeLabels.join(" · ")}
              </span>
            )}
            {status.connected && status.ownClient && (
              <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid="google-connect-own-client">
                {t("settings.googleConnect.ownClient")}
              </span>
            )}
            {!status.configured && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="google-connect-not-configured">
                {t("settings.googleConnect.notConfigured")}
              </span>
            )}
            {status.configured && !status.hermes && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid="google-connect-no-hermes">
                {t("settings.googleConnect.noHermes")}
              </span>
            )}
            {busy && (
              <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid="google-connect-busy">
                {t("settings.googleConnect.working")}
              </span>
            )}
            {failed !== null && (
              <span className="block text-[11px] text-[var(--amber-ink)] mt-1" role="alert" data-testid="google-connect-failed">
                {t("settings.googleConnect.failed")}
                {failed ? ` ${failed}` : ""}
              </span>
            )}
          </span>
          {usable && status.connected && !status.ownClient && (
            <button
              type="button"
              disabled={busy}
              data-testid="google-connect-disconnect"
              onClick={() => void disconnect()}
              className={`${buttonClass} bg-white/10 text-[var(--text-primary)] hover:bg-white/15`}
            >
              {t("settings.googleConnect.disconnect")}
            </button>
          )}
          {usable && !status.connected && authUrl === null && (
            <button
              type="button"
              disabled={busy}
              data-testid="google-connect-start"
              onClick={() => void start()}
              className={`${buttonClass} bg-[var(--coral-bright)] text-white hover:opacity-90`}
            >
              {t("settings.googleConnect.connect")}
            </button>
          )}
        </div>

        {usable && authUrl !== null && (
          <div className="border-t border-white/[0.08] px-3 py-3 space-y-3" data-testid="google-connect-steps">
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="google-connect-open"
              className={`${buttonClass} inline-flex items-center gap-1 bg-[var(--coral-bright)] text-white hover:opacity-90`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">open_in_new</span>
              {t("settings.googleConnect.open")}
            </a>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t("settings.googleConnect.pasteStep")}</p>
            <label className="block">
              <span className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">
                {t("settings.googleConnect.pasteLabel")}
              </span>
              <input
                type="text"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                data-testid="google-connect-paste"
                className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--coral-bright)]"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                data-testid="google-connect-cancel"
                onClick={() => { setAuthUrl(null); setPasted(""); setFailed(null); }}
                className={`${buttonClass} bg-white/10 text-[var(--text-primary)] hover:bg-white/15`}
              >
                {t("settings.googleConnect.cancel")}
              </button>
              <button
                type="button"
                disabled={busy || !pasted.trim()}
                data-testid="google-connect-finish"
                onClick={() => void finish()}
                className={`${buttonClass} bg-[var(--coral-bright)] text-white hover:opacity-90`}
              >
                {t("settings.googleConnect.finish")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
