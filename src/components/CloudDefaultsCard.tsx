"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { dispatchOpenSettingsSection, onStandaloneAppPage } from "@/lib/ui-events";
import {
  CLOUD_CAPABILITIES,
  type CapabilitySource,
  type CloudCapability,
  type CloudUnavailableReason,
} from "@/lib/clawai-cloud-defaults-state";

/**
 * Settings → Local AI, the card that says which of the three engines this box
 * runs in the ClawBox AI cloud and which on its own disk.
 *
 * It belongs on this page rather than beside each capability's own tab for the
 * reason the rest of the page exists: the owner's question is "what is this box
 * doing on its own, and what is it sending away", and answering it in three
 * different tabs is how the Voice tab came to say one thing while the Local AI
 * inventory said another.
 *
 * Every row's verdict comes from the server (`/setup-api/ai-cloud-defaults`),
 * which derives it from the one pure rule in `clawai-cloud-defaults-state.ts`.
 * Nothing here decides anything — a second opinion in the browser is exactly
 * how a panel ends up disagreeing with the box it is describing.
 */

const CAPABILITY_LABEL: Record<CloudCapability, string> = {
  tts: "localModels.cloud.capability.tts",
  stt: "localModels.cloud.capability.stt",
  embeddings: "localModels.cloud.capability.embeddings",
};

/**
 * "Use the engine on this box" per capability: the routes that already do it,
 * each of which records the owner's pin on the way through. Deliberately not a
 * verb on the cloud-defaults route — see that file's docblock.
 */
const USE_LOCAL: Record<CloudCapability, { url: string; body: unknown }> = {
  tts: { url: "/setup-api/tts", body: { action: "select", choice: "local" } },
  stt: { url: "/setup-api/stt", body: { primary: "local" } },
  embeddings: { url: "/setup-api/clawkeep/memory/provider", body: {} },
};

const REASON_KEY: Record<CloudUnavailableReason, string> = {
  not_linked: "localModels.cloud.reason.notLinked",
  plan: "localModels.cloud.reason.plan",
  route_unavailable: "localModels.cloud.reason.routeUnavailable",
  edition: "localModels.cloud.reason.edition",
  owner: "localModels.cloud.reason.owner",
};

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--coral-ring)]";

interface CapabilityState {
  source: CapabilitySource;
  target: CapabilitySource;
  ownerChoice: boolean;
  reason: CloudUnavailableReason | null;
}

interface CloudDefaultsStatus {
  linked: boolean;
  plan: string | null;
  capabilities: Record<CloudCapability, CapabilityState>;
}

/**
 * Every field the render reads, checked before the payload is trusted — the
 * same bar `isSnapshot` holds the inventory to on this page. A server that
 * predates this route answers 404 and the card is simply not drawn.
 */
function isStatus(value: unknown): value is CloudDefaultsStatus {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.linked !== "boolean") return false;
  const caps = body.capabilities;
  if (!caps || typeof caps !== "object") return false;
  return CLOUD_CAPABILITIES.every((capability) => {
    const row = (caps as Record<string, unknown>)[capability];
    if (!row || typeof row !== "object") return false;
    const state = row as Record<string, unknown>;
    return (state.source === "cloud" || state.source === "local")
      && (state.target === "cloud" || state.target === "local")
      && typeof state.ownerChoice === "boolean";
  });
}

function reasonOf(state: CapabilityState): CloudUnavailableReason | null {
  return state.reason && state.reason in REASON_KEY ? state.reason : null;
}

export default function CloudDefaultsCard({ active }: { active: boolean }) {
  const { t } = useT();
  const [status, setStatus] = useState<CloudDefaultsStatus | null>(null);
  const [pending, setPending] = useState<CloudCapability | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/ai-cloud-defaults", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (isStatus(data)) setStatus(data);
    } catch {
      // Keep the last good reading. The rest of this page has its own banner
      // for a box that cannot be reached at all; a second one here would say
      // the same thing twice.
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  const move = useCallback(async (capability: CloudCapability, to: CapabilitySource) => {
    setPending(capability);
    setError(null);
    try {
      const target = to === "local"
        ? USE_LOCAL[capability]
        : { url: "/setup-api/ai-cloud-defaults", body: { capability } };
      const res = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data?.error === "string" ? data.error : t("localModels.error.changeFailed"));
      }
    } catch {
      setError(t("localModels.error.unreachable"));
    } finally {
      setPending(null);
      await refresh();
    }
  }, [refresh, t]);

  if (!status) return null;

  return (
    <section data-testid="cloud-defaults-card">
      <h3 className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2 px-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">cloud</span>
        {t("localModels.cloud.title")}
      </h3>
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
        <p className="px-4 pt-3 text-xs text-[var(--text-secondary)]">{t("localModels.cloud.intro")}</p>
        {error && (
          <div role="alert" className="mx-4 mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {!status.linked && (
          // One sentence and the way to act on it. A box with no subscription
          // is not broken and gets no amber: it runs everything on its own
          // disk, which is what it was sold able to do.
          <div className="mx-4 mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[var(--text-secondary)]" data-testid="cloud-defaults-unlinked">
            {t("localModels.cloud.notConnected")}{" "}
            <button
              type="button"
              onClick={() => {
                if (onStandaloneAppPage()) window.location.assign("/app/settings");
                else dispatchOpenSettingsSection("ai");
              }}
              data-testid="cloud-defaults-connect"
              className={`underline text-[var(--coral-bright)] ${FOCUS_RING}`}
            >
              {t("localModels.cloud.connect")}
            </button>
          </div>
        )}
        <ul className="mt-3 divide-y divide-white/[0.06]">
          {CLOUD_CAPABILITIES.map((capability) => {
            const state = status.capabilities[capability];
            const onCloud = state.source === "cloud";
            const reason = reasonOf(state);
            const busy = pending === capability;
            // The button offers the OTHER engine, and only when the box can
            // actually serve it: a box that cannot reach the cloud for this
            // capability is told why instead of being given a button that
            // would answer its own refusal.
            const canOfferCloud = !onCloud && (state.target === "cloud" || state.ownerChoice);
            return (
              <li key={capability} className="flex items-center gap-3 px-4 py-3" aria-busy={busy} data-testid={`cloud-default-${capability}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{t(CAPABILITY_LABEL[capability])}</span>
                    <span
                      data-testid={`cloud-default-source-${capability}`}
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        onCloud
                          ? "bg-cyan-500/10 text-cyan-300 border-cyan-400/20"
                          : "bg-white/[0.06] text-[var(--text-secondary)] border-white/10"
                      }`}
                    >
                      {t(onCloud ? "localModels.cloud.onCloud" : "localModels.cloud.onBox")}
                    </span>
                  </div>
                  {reason && (
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5" data-testid={`cloud-default-reason-${capability}`}>
                      {t(REASON_KEY[reason])}
                    </p>
                  )}
                </div>
                {busy && (
                  <span className="material-symbols-rounded motion-safe:animate-spin text-[var(--text-secondary)]" style={{ fontSize: 18 }} aria-hidden="true">
                    progress_activity
                  </span>
                )}
                {(onCloud || canOfferCloud) && (
                  <button
                    type="button"
                    aria-disabled={busy}
                    onClick={() => { if (!busy) void move(capability, onCloud ? "local" : "cloud"); }}
                    data-testid={`cloud-default-switch-${capability}`}
                    className={`text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 shrink-0 aria-disabled:opacity-50 ${FOCUS_RING}`}
                  >
                    {t(onCloud ? "localModels.cloud.useLocal" : "localModels.cloud.useCloud")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
