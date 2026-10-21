"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { dispatchOpenSettingsSection } from "@/lib/ui-events";
import { ClawKeepModalPortal } from "./clawkeep-ui";
import { BTN_PRIMARY, BTN_SECONDARY } from "./coding-agent-ui";

/**
 * "Publish to ClawBox Store" for a Coding Agent project that carries
 * clawbox.json (POST /setup-api/apps/publish, src/lib/store-publish.ts).
 *
 * The dialog asks the box first (GET) and shows ONE of four faces:
 *   - connect: the box holds no ClawBox account sign-in (or the portal no
 *     longer accepts it) — publishing goes out under that account, so the
 *     owner is sent to Settings → AI to sign in first;
 *   - coming soon: the portal says this owner cannot publish yet (the
 *     Developer plan) — its own message, and a button to the website;
 *   - the form: the name from the manifest (read-only — it is the app's),
 *     the slug, the version (1.0.0, or the next one after what the Store has),
 *     a description and an icon URL;
 *   - done: the app is in the Store, with a link to it.
 * A publish the portal refuses as `coming_soon` turns into the coming-soon
 * face; any other refusal stays on the form with the box's sentence, next to
 * the field it is about when it names one.
 */

type Face =
  | { kind: "loading" }
  | { kind: "connect"; message: string | null }
  | { kind: "comingSoon"; message: string | null; upgradeUrl: string }
  | { kind: "form" }
  | { kind: "done"; name: string; version: string; storeUrl: string; created: boolean }
  /** `message` null: the box gave no sentence, so the dialog's own is shown. */
  | { kind: "error"; message: string | null };

interface PublishProjectInfo {
  name: string;
  slug: string | null;
  description: string;
  suggestedVersion: string;
  published: { version: string } | null;
}

interface StatusAnswer {
  ok?: boolean;
  linked?: boolean;
  canPublish?: boolean | null;
  code?: string;
  message?: string;
  upgradeUrl?: string;
  project?: PublishProjectInfo;
}

interface PublishAnswer {
  ok?: boolean;
  code?: string;
  message?: string;
  field?: string;
  upgradeUrl?: string;
  storeUrl?: string;
  created?: boolean;
  app?: { name?: unknown; version?: unknown };
}

const FIELD_CLASS = "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--coral-bright,#f97316)] disabled:opacity-60";

/** Open a portal page in a new tab — only an absolute http(s) URL the box itself answered with. */
function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function StorePublishDialog({ projectId, onClose }: {
  /** The project's folder name, as the Coding Agent lists it. */
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const titleId = useId();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose });
  const [face, setFace] = useState<Face>({ kind: "loading" });
  const [info, setInfo] = useState<PublishProjectInfo | null>(null);
  const [slug, setSlug] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [description, setDescription] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; field: string | null } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/setup-api/apps/publish?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as StatusAnswer;
        if (cancelled) return;
        if (!res.ok || data.ok === false) {
          setFace({ kind: "error", message: data.message || null });
          return;
        }
        if (!data.linked) {
          setFace({ kind: "connect", message: data.code === "token_rejected" ? data.message ?? null : null });
          return;
        }
        if (data.canPublish === false) {
          setFace({ kind: "comingSoon", message: data.message ?? null, upgradeUrl: data.upgradeUrl ?? "" });
          return;
        }
        if (data.project) {
          setInfo(data.project);
          setSlug(data.project.slug ?? "");
          setVersion(data.project.suggestedVersion || "1.0.0");
          setDescription(data.project.description ?? "");
        }
        setFace({ kind: "form" });
      } catch {
        if (!cancelled) setFace({ kind: "error", message: null });
      }
    })();
    return () => { cancelled = true; };
    // Asked once per project: `t` is not a dependency, the answer is stored untranslated.
  }, [projectId]);

  const publish = useCallback(async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch("/setup-api/apps/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, version: version.trim(), slug: slug.trim(), description, iconUrl: iconUrl.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as PublishAnswer;
      if (!alive.current) return;
      if (res.ok && data.ok) {
        const name = typeof data.app?.name === "string" ? data.app.name : info?.name ?? projectId;
        const published = typeof data.app?.version === "string" ? data.app.version : version.trim();
        setFace({ kind: "done", name, version: published, storeUrl: data.storeUrl ?? "", created: data.created === true });
        window.dispatchEvent(new CustomEvent("clawbox:toast", {
          detail: { message: t("codingAgent.publishDone", { name, version: published }), type: "success" },
        }));
        return;
      }
      if (data.code === "coming_soon") {
        setFace({ kind: "comingSoon", message: data.message ?? null, upgradeUrl: data.upgradeUrl ?? "" });
        return;
      }
      if (data.code === "not_linked" || data.code === "token_rejected") {
        setFace({ kind: "connect", message: data.message ?? null });
        return;
      }
      setRefusal({ message: data.message || t("codingAgent.publishFailed"), field: data.field ?? null });
    } catch {
      if (alive.current) setRefusal({ message: t("codingAgent.publishFailed"), field: null });
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [description, iconUrl, info?.name, projectId, slug, t, version]);

  const fieldError = (field: string) => refusal?.field === field
    ? <p className="mt-1 text-[11px] text-red-300" data-testid={`store-publish-error-${field}`}>{refusal.message}</p>
    : null;

  const titleKey = face.kind === "comingSoon"
    ? "codingAgent.publishComingSoonTitle"
    : face.kind === "connect"
      ? "codingAgent.publishConnectTitle"
      : "codingAgent.publishTitle";

  return (
    <ClawKeepModalPortal>
      <div
        className="main-screen-scrim fixed inset-0 z-[200] flex items-center justify-center p-4"
        style={{ background: "rgba(0, 0, 0, 0.67)" }}
        onClick={onClose}
        data-testid="store-publish-dialog"
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-lg max-h-[85%] flex flex-col rounded-2xl border border-white/[0.08] bg-[var(--surface-1,#16171b)] shadow-2xl overflow-hidden"
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-white/[0.06]">
            <span className="material-symbols-rounded mt-0.5 text-[var(--coral-bright,#f97316)]" style={{ fontSize: 20 }} aria-hidden="true">
              {face.kind === "comingSoon" ? "rocket_launch" : face.kind === "connect" ? "link" : "storefront"}
            </span>
            <h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)] break-words">{t(titleKey)}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("codingAgent.publishClose")}
              data-testid="store-publish-close"
              className="shrink-0 rounded-md p-1 text-[var(--text-muted)] hover:text-white hover:bg-white/[0.06]"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 text-[13px] text-[var(--text-secondary)] leading-relaxed">
            {face.kind === "loading" && (
              <p data-testid="store-publish-loading">{t("codingAgent.publishLoading")}</p>
            )}

            {face.kind === "error" && (
              <p className="text-red-300" data-testid="store-publish-failed">{face.message ?? t("codingAgent.publishFailed")}</p>
            )}

            {face.kind === "connect" && (
              <div data-testid="store-publish-connect" className="space-y-2">
                <p>{t("codingAgent.publishConnectBody")}</p>
                {face.message && <p className="text-[var(--text-muted)]">{face.message}</p>}
              </div>
            )}

            {face.kind === "comingSoon" && (
              <div data-testid="store-publish-coming-soon" className="space-y-2">
                <p>{face.message || t("codingAgent.publishComingSoonBody")}</p>
              </div>
            )}

            {face.kind === "done" && (
              <div data-testid="store-publish-done" className="space-y-2">
                <p className="text-[var(--text-primary)]">{t("codingAgent.publishDone", { name: face.name, version: face.version })}</p>
              </div>
            )}

            {face.kind === "form" && (
              <form
                className="space-y-3"
                onSubmit={(e) => { e.preventDefault(); if (!busy) void publish(); }}
                data-testid="store-publish-form"
              >
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.publishName")}</span>
                  <input className={FIELD_CLASS} value={info?.name ?? projectId} readOnly aria-readonly="true" data-testid="store-publish-name" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.publishSlug")}</span>
                  <input className={FIELD_CLASS} value={slug} onChange={(e) => setSlug(e.target.value)} disabled={busy} spellCheck={false} autoCapitalize="off" data-testid="store-publish-slug" />
                  {fieldError("slug")}
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.publishVersion")}</span>
                  <input className={FIELD_CLASS} value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy} spellCheck={false} data-testid="store-publish-version" />
                  {info?.published && (
                    <p className="mt-1 text-[11px] text-[var(--text-muted)]" data-testid="store-publish-published">{t("codingAgent.publishPublishedAs", { version: info.published.version })}</p>
                  )}
                  {fieldError("version")}
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.publishDescription")}</span>
                  <textarea className={`${FIELD_CLASS} min-h-[4.5rem] resize-y`} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} maxLength={300} data-testid="store-publish-description" />
                  {fieldError("description")}
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t("codingAgent.publishIconUrl")}</span>
                  <input className={FIELD_CLASS} value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} disabled={busy} spellCheck={false} inputMode="url" data-testid="store-publish-icon-url" />
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t("codingAgent.publishIconUrlHint")}</p>
                  {fieldError("iconUrl")}
                </label>
                {refusal && !["slug", "version", "description", "iconUrl"].includes(refusal.field ?? "") && (
                  <p className="text-[12px] text-red-300" role="alert" data-testid="store-publish-refusal">{refusal.message}</p>
                )}
              </form>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
            {face.kind === "form" ? (
              <>
                <button type="button" onClick={onClose} className={BTN_SECONDARY} disabled={busy}>{t("codingAgent.publishCancel")}</button>
                <button type="button" onClick={() => void publish()} className={BTN_PRIMARY} disabled={busy || !version.trim()} data-testid="store-publish-submit">
                  {busy ? t("codingAgent.publishing") : t("codingAgent.publishSubmit")}
                </button>
              </>
            ) : face.kind === "comingSoon" ? (
              <>
                <button type="button" onClick={onClose} className={BTN_SECONDARY}>{t("codingAgent.publishClose")}</button>
                <button type="button" onClick={() => openExternal(face.upgradeUrl)} className={BTN_PRIMARY} disabled={!face.upgradeUrl} data-testid="store-publish-open-website">
                  {t("codingAgent.publishOpenWebsite")}
                </button>
              </>
            ) : face.kind === "connect" ? (
              <>
                <button type="button" onClick={onClose} className={BTN_SECONDARY}>{t("codingAgent.publishClose")}</button>
                <button type="button" onClick={() => { dispatchOpenSettingsSection("ai"); onClose(); }} className={BTN_PRIMARY} data-testid="store-publish-open-settings">
                  {t("codingAgent.publishOpenSettings")}
                </button>
              </>
            ) : face.kind === "done" ? (
              <>
                <button type="button" onClick={onClose} className={BTN_SECONDARY}>{t("codingAgent.publishClose")}</button>
                <button type="button" onClick={() => openExternal(face.storeUrl)} className={BTN_PRIMARY} disabled={!face.storeUrl} data-testid="store-publish-view">
                  {t("codingAgent.publishView")}
                </button>
              </>
            ) : (
              <button type="button" onClick={onClose} className={BTN_SECONDARY}>{t("codingAgent.publishClose")}</button>
            )}
          </div>
        </div>
      </div>
    </ClawKeepModalPortal>
  );
}
