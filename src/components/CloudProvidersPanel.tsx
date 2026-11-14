"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { localAiFirst, type CloudProvidersView } from "@/lib/cloud-providers";
import { notifyProvidersChanged } from "@/lib/ui-events";
import { CloudRecommendContext } from "./cloud-recommend-context";

// Settings → AI providers and the setup wizard's AI step on a box whose AI is
// the owner's own (TASK-2497; the rule is src/lib/cloud-providers.ts):
//
//   * an external engine is the AI, or Local-only mode is on → the local
//     choice leads, marked Recommended and Default, and the cloud providers
//     fold away under a closed "Cloud providers (optional, …)" disclosure,
//     none of them marked Recommended;
//   * "Hide cloud AI providers" is on → the cloud providers are not drawn at
//     all;
//   * otherwise → exactly what was there before, plus the owner's switch.
//
// Nothing cloud is drawn until the box has answered, so a box that hides them
// never flashes them; a box that cannot answer (an older server, a refusal)
// gets the screen it always had.

export const CLOUD_PROVIDERS_URL = "/setup-api/settings/cloud-providers";

function isView(body: unknown): body is CloudProvidersView {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<Record<keyof CloudProvidersView, unknown>>;
  return typeof b.hidden === "boolean" && typeof b.localOnly === "boolean"
    && (b.externalEngine === null || typeof b.externalEngine === "object");
}

/** The view, `undefined` while the first read is out, `null` when the box gave none. */
export function useCloudProvidersView() {
  const [view, setView] = useState<CloudProvidersView | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(CLOUD_PROVIDERS_URL, { cache: "no-store" });
        const body: unknown = r.ok ? await r.json() : null;
        if (alive) setView(isView(body) ? body : null);
      } catch {
        if (alive) setView(null);
      }
    })();
    return () => { alive = false; };
  }, []);
  return { view, setView };
}

/** "llamacpp/gemma4-e2b-it" → "gemma4-e2b-it": the name a person reads. */
function modelName(ref: string): string {
  const slash = ref.indexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

/** The local choice's name: the engine's, else the Local AI model's, else null. */
function localChoiceName(view: CloudProvidersView): string | null {
  if (view.externalEngine) return view.externalEngine.displayName;
  return view.localModel ? modelName(view.localModel) : null;
}

function LocalChoiceCard({ view, onOpenLocalAi }: { view: CloudProvidersView; onOpenLocalAi?: () => void }) {
  const { t } = useT();
  const name = localChoiceName(view);
  return (
    <div
      className="rounded-xl border border-[var(--coral-bright)]/40 bg-[var(--coral-tint)]/30 p-4"
      data-testid="cloud-providers-local-choice"
    >
      <div className="flex items-start gap-3">
        <span className="material-symbols-rounded text-[var(--coral-bright)] shrink-0" style={{ fontSize: 22 }} aria-hidden="true">
          {view.externalEngine ? "lan" : "memory"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
              {name ?? t("cloudProviders.localAi")}
            </span>
            {name && (
              <>
                <span className="px-1.5 py-0.5 text-[length:var(--t-1)] font-bold uppercase tracking-[0.06em] rounded-[var(--r-1)] bg-[var(--coral-tint)] text-[var(--coral-bright)] leading-none">
                  {t("recommended")}
                </span>
                <span className="px-1.5 py-0.5 text-[length:var(--t-1)] font-semibold rounded-[var(--r-1)] bg-white/10 text-[var(--text-secondary)] leading-none">
                  {t("cloudProviders.default")}
                </span>
              </>
            )}
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
            {name
              ? t(view.externalEngine ? "cloudProviders.externalEngineHint" : "cloudProviders.localModelHint")
              : t("cloudProviders.noLocalAi")}
          </p>
          {onOpenLocalAi && (
            <button
              type="button"
              onClick={onOpenLocalAi}
              className="mt-2 text-xs text-[var(--coral-bright)] hover:text-orange-300 bg-transparent border-none cursor-pointer underline underline-offset-2 p-0"
              data-testid="cloud-providers-open-local-ai"
            >
              {t("cloudProviders.openLocalAi")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function HideCloudSwitch({ view, onChange }: { view: CloudProvidersView; onChange: (next: CloudProvidersView) => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function toggle(hide: boolean) {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch(CLOUD_PROVIDERS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hide }),
      });
      const body: unknown = await r.json().catch(() => null);
      if (r.ok && isView(body)) {
        onChange(body);
        // The chat's model picker re-asks the box.
        notifyProvidersChanged();
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

  return (
    <div className="rounded-xl border border-white/10 p-4" data-testid="cloud-providers-hide">
      <div className="flex items-start gap-3">
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-[var(--text-primary)]">{t("cloudProviders.hideTitle")}</span>
          <span className="block text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">{t("cloudProviders.hideHint")}</span>
          {view.setting === "auto" && view.autoHidden && (
            <span className="block text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed" data-testid="cloud-providers-auto">
              {t("cloudProviders.autoOn")}
            </span>
          )}
          {failed !== null && (
            <span className="block text-[11px] text-[var(--amber-ink)] mt-1" role="alert" data-testid="cloud-providers-failed">
              {t("cloudProviders.failed")}
              {failed ? ` ${failed}` : ""}
            </span>
          )}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={view.hidden}
          aria-label={t("cloudProviders.hideTitle")}
          aria-busy={busy}
          disabled={busy}
          data-testid="cloud-providers-hide-switch"
          onClick={() => void toggle(!view.hidden)}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${view.hidden ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${view.hidden ? "left-[22px]" : "left-0.5"}`}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}

/**
 * Settings → AI providers. `children` are the cloud provider cards (the
 * signed-in list and the connect panel), `pitch` the ClawBox AI offer card;
 * `openRequest` going up (a deep link to a cloud provider) opens the fold.
 */
export function CloudProvidersSettings({
  children,
  pitch,
  onOpenLocalAi,
  openRequest = 0,
  openRequestSeen = 0,
  onOpenRequestSeen,
}: {
  children: ReactNode;
  pitch?: ReactNode;
  onOpenLocalAi?: () => void;
  openRequest?: number;
  /** The last request this section acted on, kept by the page so that leaving and coming back is not the same link again. */
  openRequestSeen?: number;
  onOpenRequestSeen?: (request: number) => void;
}) {
  const { t } = useT();
  const { view, setView } = useCloudProvidersView();
  // Open when a deep link asked for a cloud provider this section has not yet
  // shown: one raised in the same breath as the section mounts (Settings opens
  // the section and raises it together) or while it is on screen. Decided
  // while rendering, so the section is open on its first paint. The page
  // keeps the last request acted on, so coming back to the section later —
  // which remounts it — is not taken for the same link again.
  const [open, setOpen] = useState(false);
  const [handled, setHandled] = useState(openRequestSeen);
  if (openRequest > handled) {
    setHandled(openRequest);
    setOpen(true);
  }
  useEffect(() => {
    onOpenRequestSeen?.(handled);
  }, [handled, onOpenRequestSeen]);
  const onChange = useCallback((next: CloudProvidersView) => setView(next), [setView]);

  if (view === undefined) return <div data-testid="cloud-providers-loading" aria-busy="true" />;
  if (view === null) return <>{pitch}{children}</>;

  // The switch is the owner's; another user signed in on a home box sees the
  // page as the owner set it, without it.
  const hideSwitch = view.canChange === false ? null : <HideCloudSwitch view={view} onChange={onChange} />;
  if (!view.hidden && !localAiFirst(view)) {
    return <>{pitch}{children}{hideSwitch}</>;
  }
  return (
    <>
      <LocalChoiceCard view={view} onOpenLocalAi={onOpenLocalAi} />
      {view.hidden ? (
        <p className="text-xs text-[var(--text-muted)] leading-relaxed" data-testid="cloud-providers-hidden-note">
          {t("cloudProviders.hiddenNote")}
        </p>
      ) : (
        <div className="rounded-xl border border-white/10" data-testid="cloud-providers-optional">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="cloud-providers-optional-body"
            onClick={() => setOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-3 bg-transparent border-none cursor-pointer text-left"
            data-testid="cloud-providers-optional-toggle"
          >
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 20 }} aria-hidden="true">
              {open ? "expand_less" : "expand_more"}
            </span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{t("cloudProviders.optionalSection")}</span>
          </button>
          {/* Mounted only while open: the cards poll the box and the portal. */}
          {open && (
            <div id="cloud-providers-optional-body" className="px-4 pb-4 space-y-5">
              <CloudRecommendContext.Provider value={false}>{children}</CloudRecommendContext.Provider>
            </div>
          )}
        </div>
      )}
      {hideSwitch}
    </>
  );
}

/**
 * The setup wizard's AI step. The step itself (`children`) unless the cloud
 * providers are hidden — then the box's own AI and a Continue, since there is
 * nothing to connect (with an engine, Continue makes it the chat's model, as
 * the step's own engine card does). With an engine selected and the cloud not
 * hidden the step stays, its cloud rows not marked Recommended.
 */
export function CloudProvidersWizardGate({ children, onNext }: { children: ReactNode; onNext: () => void }) {
  const { t } = useT();
  const { view } = useCloudProvidersView();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null | false>(false);

  const engine = view?.externalEngine ?? null;
  const continueLocal = useCallback(async () => {
    if (!engine) { onNext(); return; }
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/setup-api/local-ai/external/select", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: unknown } | null;
        setError(typeof data?.error === "string" && data.error.trim() ? data.error.trim().slice(0, 300) : null);
        return;
      }
      notifyProvidersChanged();
      onNext();
    } catch {
      setError(null);
    } finally {
      setBusy(false);
    }
  }, [engine, onNext]);

  if (view === undefined) return <div data-testid="cloud-providers-loading" aria-busy="true" />;
  if (!view) return <>{children}</>;
  if (!view.hidden) {
    return localAiFirst(view)
      ? <CloudRecommendContext.Provider value={false}>{children}</CloudRecommendContext.Provider>
      : <>{children}</>;
  }
  return (
    <div className="w-full max-w-[520px]" data-testid="cloud-providers-wizard-local">
      <div className="card-surface rounded-[var(--r-3)] p-5 sm:p-8 space-y-5">
        <div>
          <h2 className="text-[length:var(--t-6)] leading-[1.15] font-bold font-display mb-2">{t("cloudProviders.wizardTitle")}</h2>
          <p className="text-[length:var(--t-4)] leading-[1.6] text-[var(--text-secondary)]">{t("cloudProviders.wizardBody")}</p>
        </div>
        <LocalChoiceCard view={view} />
        {error !== false && (
          <p role="alert" data-testid="cloud-providers-wizard-error" className="text-[length:var(--t-3)] text-red-300">
            {t("cloudProviders.failed")}
            {error && <span className="block mt-1 text-[var(--text-secondary)]">{error}</span>}
          </p>
        )}
        <button
          type="button"
          onClick={() => void continueLocal()}
          disabled={busy}
          className="w-full min-h-[48px] px-6 btn-gradient text-white rounded-[var(--r-1)] font-semibold text-[length:var(--t-5)] cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          data-testid="cloud-providers-wizard-continue"
        >
          {t("cloudProviders.continue")}
        </button>
      </div>
    </div>
  );
}
