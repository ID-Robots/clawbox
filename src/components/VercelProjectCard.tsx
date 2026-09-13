"use client";

/**
 * The owner's Vercel attachment for one coding-agent project — the settings
 * half of the deploy feature, on the project's own page.
 *
 * WHY IT IS HERE AND NOT IN THE CODING AGENT'S SETTINGS PAGE. A Vercel link is
 * per PROJECT, not per box: one folder deploys to one Vercel project and the
 * next one does not deploy at all. A switch belongs beside the thing it
 * governs, which is the reasoning the Memory Shard's embedded settings page and
 * the Coding Agent's own are written from.
 *
 * THE TOKEN IS NEVER TYPED HERE. The form asks for the NAME of a secret the
 * owner has already saved (Settings → Coding Agent → Secrets), so this card
 * never holds a credential, never posts one and cannot show one. That is the
 * secret store's contract and this is the surface that has to honour it most
 * visibly.
 */

import { useCallback, useEffect, useState } from "react";
import { BTN_PRIMARY, BTN_SECONDARY, CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import type { VercelLink } from "@/lib/vercel-state";

/** The readiness the route answers, as this card reads it. */
export interface VercelReadinessView {
  linked: boolean;
  /** Null is "this box could not read its own secret store" — see the route. */
  tokenPresent: boolean | null;
  tokenValid: boolean | null;
  username: string | null;
  projectResolves: boolean | null;
  projectName: string | null;
  ready: boolean;
  problems: string[];
}

export interface VercelProjectCardProps {
  /** `?projectId=…` or `?directory=…` — the project this card is about. */
  query: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const INPUT =
  "w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-white/25";

export default function VercelProjectCard({ query, t }: VercelProjectCardProps) {
  const [link, setLink] = useState<VercelLink | null>(null);
  const [readiness, setReadiness] = useState<VercelReadinessView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [secretName, setSecretName] = useState("");
  /**
   * The names of the box's stored secrets, for the picker.
   *
   * Read HERE and only when the form opens, from the narrow door that answers
   * names and never values (`secrets/names`). Fetched by the card rather than
   * passed in, so the one page that shows this is not made to know about the
   * secret store in order to render a project.
   */
  const [secretNames, setSecretNames] = useState<string[]>([]);

  /**
   * The link alone, with no `check=1`.
   *
   * The plain read is a config read and costs nothing; the CHECK is two calls
   * to another company's API, so it is asked for once after the first load and
   * after every write, never on the poll that keeps the rest of the page fresh.
   */
  const load = useCallback(async (check: boolean) => {
    try {
      if (check) setChecking(true);
      const res = await fetch(`/setup-api/coding-agent/vercel?${query}${check ? "&check=1" : ""}`);
      if (!res.ok) {
        // A project this box cannot attach a link to (a folder outside the
        // project folder) is not an error to shout about: the card simply has
        // nothing to offer, and the page around it is fine.
        setLink(null);
        setReadiness(null);
        return;
      }
      const data = await res.json() as { link: VercelLink | null; readiness: VercelReadinessView | null };
      setLink(data.link ?? null);
      if (check || data.readiness) setReadiness(data.readiness ?? null);
    } catch {
      /* offline: the card keeps what it has */
    } finally {
      setChecking(false);
      setLoaded(true);
    }
  }, [query]);

  // The card is KEYED by the project query at its call site, so a different
  // project is a fresh mount with nothing held over — which is why this does
  // not reset that state itself. (Resetting here was redundant and tripped
  // react-hooks/set-state-in-effect; found in review. A future host that does
  // not key the card must add the key rather than have this effect paper over
  // it.)
  useEffect(() => {
    void load(true);
  }, [load]);

  const openForm = async () => {
    setProjectId(link?.projectId ?? "");
    setTeamId(link?.teamId ?? "");
    setError(null);
    setEditing(true);
    let names: string[] = [];
    try {
      const res = await fetch("/setup-api/coding-agent/secrets/names");
      if (res.ok) {
        const data = await res.json() as { names?: { name: string }[] };
        // De-duplicated: one NAME can exist in two scopes (this project's and
        // the box's), and the link names the name — the store's own precedence
        // decides which entry a call then opens.
        names = [...new Set((data.names ?? []).map((n) => n.name))].sort();
      }
    } catch {
      /* offline: the picker says there are none, which is what the box knows */
    }
    setSecretNames(names);
    setSecretName(link?.tokenSecretName ?? names[0] ?? "");
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/setup-api/coding-agent/vercel?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(new URLSearchParams(query)),
          vercelProjectId: projectId.trim(),
          teamId: teamId.trim(),
          tokenSecretName: secretName.trim(),
        }),
      });
      const data = await res.json().catch(() => null) as
        { link?: VercelLink | null; readiness?: VercelReadinessView | null; error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? t("codingAgent.vercelProblem", { reason: String(res.status) }));
        return;
      }
      setLink(data?.link ?? null);
      setReadiness(data?.readiness ?? null);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const detach = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/setup-api/coding-agent/vercel?${query}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        setError(data?.error ?? t("codingAgent.vercelProblem", { reason: String(res.status) }));
        return;
      }
      setLink(null);
      setReadiness(null);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * What the box can say about the link right now.
   *
   * The tri-state is honoured exactly as the route means it: `null` is "could
   * not ask", which is said as such and never as "your token is wrong". An
   * owner sent to rotate a working credential because their house internet was
   * down is the failure this sentence exists to avoid.
   */
  const verdict = (): { text: string; tone: string } | null => {
    if (!link) return null;
    if (checking) return { text: t("codingAgent.vercelChecking"), tone: "text-[var(--text-muted)]" };
    if (!readiness) return null;
    if (readiness.ready) {
      return readiness.username
        ? { text: t("codingAgent.vercelConnected", { user: readiness.username }), tone: "text-emerald-300/90" }
        : { text: t("codingAgent.vercelConnectedPlain"), tone: "text-emerald-300/90" };
    }
    if (readiness.tokenValid === null || readiness.projectResolves === null) {
      return { text: t("codingAgent.vercelUnreachable"), tone: "text-amber-300/90" };
    }
    return {
      text: t("codingAgent.vercelProblem", { reason: readiness.problems[0] ?? "" }),
      tone: "text-red-300/90",
    };
  };

  if (!loaded && !link) return null;
  const said = verdict();

  return (
    <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-vercel-card" data-linked={link ? "true" : "false"}>
      <p className={SECTION_LABEL}>{t("codingAgent.vercelTitle")}</p>

      {!editing && (
        <>
          {link ? (
            <p className="mt-1.5 text-xs text-[var(--text-secondary)] break-all" data-testid="coding-agent-vercel-project">
              {link.projectId}
              {link.teamId && <span className="text-[var(--text-muted)]"> · {link.teamId}</span>}
              <span className="text-[var(--text-muted)]"> · {link.tokenSecretName}</span>
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-[var(--text-secondary)]" data-testid="coding-agent-vercel-none">
              {t("codingAgent.vercelNone")}
            </p>
          )}
          {said && (
            <p className={`mt-1.5 text-[11px] break-words ${said.tone}`} data-testid="coding-agent-vercel-verdict">
              {said.text}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => void openForm()} disabled={busy} data-testid="coding-agent-vercel-attach" className={BTN_SECONDARY}>
              {link ? t("codingAgent.vercelChange") : t("codingAgent.vercelAttach")}
            </button>
            {link && (
              <button type="button" onClick={() => void detach()} disabled={busy} data-testid="coding-agent-vercel-detach" className={BTN_SECONDARY}>
                {t("codingAgent.vercelDetach")}
              </button>
            )}
          </div>
        </>
      )}

      {editing && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-[11px] text-[var(--text-secondary)]">
            {t("codingAgent.vercelProjectLabel")}
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              data-testid="coding-agent-vercel-project-input"
              className={`mt-1 ${INPUT}`}
              placeholder="prj_…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="text-[11px] text-[var(--text-secondary)]">
            {t("codingAgent.vercelTeamLabel")}
            <input
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              data-testid="coding-agent-vercel-team-input"
              className={`mt-1 ${INPUT}`}
              placeholder="team_…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="text-[11px] text-[var(--text-secondary)]">
            {t("codingAgent.vercelTokenLabel")}
            {secretNames.length > 0 ? (
              <select
                value={secretName}
                onChange={(e) => setSecretName(e.target.value)}
                data-testid="coding-agent-vercel-secret-input"
                className={`mt-1 ${INPUT}`}
              >
                {secretNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            ) : (
              <p className="mt-1 text-[11px] text-amber-300/90" data-testid="coding-agent-vercel-no-secrets">
                {t("codingAgent.vercelNoSecrets")}
              </p>
            )}
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.vercelTokenHint")}</p>
          {error && (
            <p role="alert" className="text-[11px] text-red-300/90 break-words" data-testid="coding-agent-vercel-error">{error}</p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !projectId.trim() || !secretName.trim()}
              data-testid="coding-agent-vercel-save"
              className={BTN_PRIMARY}
            >
              {t("save")}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy} data-testid="coding-agent-vercel-cancel" className={BTN_SECONDARY}>
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {!editing && error && (
        <p role="alert" className="mt-1.5 text-[11px] text-red-300/90 break-words" data-testid="coding-agent-vercel-error">{error}</p>
      )}
    </div>
  );
}
