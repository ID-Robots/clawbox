"use client";

/**
 * "Import a project" on the Coding Agent home: one of the owner's GitHub
 * repositories, cloned into the project folder, or a folder already on the
 * box, copied there. Both end in a project the list shows at once
 * (POST /setup-api/coding-agent/projects/import answers the row).
 *
 * The GitHub half reads GET /setup-api/coding-agent/github-repos when it
 * opens — never on a poll, a listing is a `gh api` call — and says in words
 * when there is no account to read (with the way to Settings, where the
 * account is connected). A repository carrying a clawbox.json is marked as
 * a ClawBox app before it is cloned, which is what the manifest is for.
 *
 * The folder half is a path the owner types, the way the default project
 * folder is typed in Settings: there is no folder picker on the box, and
 * the Files app browses the home directory only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_PRIMARY, BTN_SECONDARY, CARD_SURFACE, FIELD, INSET_SURFACE, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";

/** One repository, as the github-repos route describes it. */
export interface ImportableRepo {
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  pushedAt: string | null;
  clawboxApp: boolean | null;
  folder: string;
}

/** What the import route answers on success. */
export interface ImportResult {
  project: { directory: string; folder: string; name: string } | null;
  directory: string;
  folder: string;
  initialized: boolean;
  skipped: string[];
}

interface Props {
  /** Called with the new project's folder once the import is done. */
  onImported: (result: ImportResult) => void;
  onClose: () => void;
  /** Opens the settings page, where the GitHub account is connected. Absent on the standalone page. */
  onOpenSettings?: () => void;
  /** Which half opens first. */
  initialTab?: "github" | "folder";
}

type ReposState =
  | { kind: "loading" }
  | { kind: "ready"; login: string; repos: ImportableRepo[]; truncated: boolean }
  | { kind: "not_connected" }
  | { kind: "error"; message: string };

/** The largest listing drawn; the filter box is how the rest is reached. */
const MAX_ROWS = 60;

export default function ImportProjectPanel({ onImported, onClose, onOpenSettings, initialTab = "github" }: Props) {
  const { t } = useT();
  const [tab, setTab] = useState<"github" | "folder">(initialTab);
  const [repos, setRepos] = useState<ReposState>({ kind: "loading" });
  const [filter, setFilter] = useState("");
  const [folderPath, setFolderPath] = useState("");
  /** The repository (or "folder") an import is running for; null when none is. */
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    setRepos({ kind: "loading" });
    try {
      const res = await fetch("/setup-api/coding-agent/github-repos", { cache: "no-store" });
      const data = await res.json().catch(() => ({})) as { login?: string; repos?: ImportableRepo[]; truncated?: boolean; error?: string; kind?: string };
      if (res.ok) {
        setRepos({ kind: "ready", login: data.login ?? "", repos: Array.isArray(data.repos) ? data.repos : [], truncated: data.truncated === true });
      } else if (data.kind === "not_connected" || data.kind === "no_gh") {
        setRepos({ kind: "not_connected" });
      } else {
        setRepos({ kind: "error", message: data.error || t("codingAgent.importFailed") });
      }
    } catch {
      setRepos({ kind: "error", message: t("codingAgent.importFailed") });
    }
    // `t` changes with the language; the listing does not depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void loadRepos(); }, [loadRepos]);

  const shown = useMemo(() => {
    if (repos.kind !== "ready") return [];
    const q = filter.trim().toLowerCase();
    const rows = q ? repos.repos.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)) : repos.repos;
    return rows.slice(0, MAX_ROWS);
  }, [repos, filter]);

  const runImport = async (body: Record<string, string>, key: string) => {
    setImporting(key);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/projects/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as Partial<ImportResult> & { error?: string };
      if (!res.ok || typeof data.directory !== "string") {
        setError(data.error || t("codingAgent.importFailed"));
        return;
      }
      onImported({
        project: data.project ?? null,
        directory: data.directory,
        folder: typeof data.folder === "string" ? data.folder : data.directory.split("/").pop() ?? data.directory,
        initialized: data.initialized === true,
        skipped: Array.isArray(data.skipped) ? data.skipped : [],
      });
    } catch {
      setError(t("codingAgent.importFailed"));
    } finally {
      setImporting(null);
    }
  };

  const pushedLabel = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
  };

  return (
    <div className={`${CARD_SURFACE} mt-2 p-3`} data-testid="coding-agent-import-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">download</span>
          {t("codingAgent.importTitle")}
        </h3>
        <button type="button" onClick={onClose} className={BTN_SECONDARY} data-testid="coding-agent-import-close">
          {t("cancel")}
        </button>
      </div>

      <div className={`${SEGMENTED_TRACK} mt-3`} role="tablist">
        <button type="button" role="tab" aria-selected={tab === "github"} onClick={() => setTab("github")} className={tab === "github" ? SEGMENT_ON : SEGMENT_OFF} data-testid="coding-agent-import-tab-github">
          {t("codingAgent.importFromGitHub")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "folder"} onClick={() => setTab("folder")} className={tab === "folder" ? SEGMENT_ON : SEGMENT_OFF} data-testid="coding-agent-import-tab-folder">
          {t("codingAgent.importFromFolder")}
        </button>
      </div>

      {error && (
        <p className="mt-2 text-[11px] text-red-400" role="alert" data-testid="coding-agent-import-error">{error}</p>
      )}

      {tab === "github" && (
        <div className="mt-3" data-testid="coding-agent-import-github">
          {repos.kind === "loading" && (
            <p className="text-[11px] text-[var(--text-muted)]">{t("codingAgent.importReposLoading")}</p>
          )}
          {repos.kind === "not_connected" && (
            <div className={`${INSET_SURFACE} px-3 py-2 flex flex-wrap items-center justify-between gap-2`} data-testid="coding-agent-import-not-connected">
              <p className="text-[11px] text-[var(--text-secondary)]">{t("codingAgent.importNotConnected")}</p>
              {onOpenSettings && (
                <button type="button" onClick={onOpenSettings} className={BTN_SECONDARY}>{t("codingAgent.openSettings")}</button>
              )}
            </div>
          )}
          {repos.kind === "error" && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] text-red-400" role="alert">{repos.message}</p>
              <button type="button" onClick={() => void loadRepos()} className={BTN_SECONDARY}>{t("retry")}</button>
            </div>
          )}
          {repos.kind === "ready" && (
            <>
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("codingAgent.importFilterPlaceholder")}
                aria-label={t("codingAgent.importFilterPlaceholder")}
                className={`${FIELD} w-full text-xs`}
                data-testid="coding-agent-import-filter"
              />
              {repos.repos.length === 0 ? (
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t("codingAgent.importNoRepos")}</p>
              ) : shown.length === 0 ? (
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t("codingAgent.importNoMatches")}</p>
              ) : (
                <ul className="mt-2 space-y-1 max-h-72 overflow-y-auto pr-0.5" data-testid="coding-agent-import-repos">
                  {shown.map((repo) => (
                    <li key={repo.fullName} className={`${INSET_SURFACE} px-3 py-1.5 flex items-center justify-between gap-3`} data-testid="coding-agent-import-repo" data-repo={repo.fullName}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-medium text-[var(--text-primary)] truncate">{repo.fullName}</span>
                          {repo.private && (
                            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 13 }} aria-label={t("codingAgent.importPrivate")} title={t("codingAgent.importPrivate")}>lock</span>
                          )}
                          {repo.clawboxApp === true && (
                            <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--coral-bright)] border-[var(--coral-bright)]/40" data-testid="coding-agent-import-app-chip">
                              {t("codingAgent.clawboxApp")}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--text-muted)] truncate">
                          {[repo.description, pushedLabel(repo.pushedAt)].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={importing !== null}
                        onClick={() => void runImport({ source: "github", repo: repo.fullName }, repo.fullName)}
                        className={BTN_PRIMARY}
                        data-testid="coding-agent-import-repo-import"
                      >
                        {importing === repo.fullName ? t("codingAgent.importImporting") : t("codingAgent.importRepoImport")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {repos.truncated && (
                <p className="mt-1 text-[10px] text-[var(--text-muted)]">{t("codingAgent.importTruncated", { n: repos.repos.length })}</p>
              )}
            </>
          )}
        </div>
      )}

      {tab === "folder" && (
        <form
          className="mt-3"
          data-testid="coding-agent-import-folder"
          onSubmit={(e) => {
            e.preventDefault();
            if (!folderPath.trim() || importing) return;
            void runImport({ source: "folder", path: folderPath.trim() }, "folder");
          }}
        >
          <label className="block text-[11px] text-[var(--text-secondary)]" htmlFor="coding-agent-import-path">{t("codingAgent.importPathLabel")}</label>
          <input
            id="coding-agent-import-path"
            type="text"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder={t("codingAgent.importPathPlaceholder")}
            className={`${FIELD} mt-1 w-full text-xs font-mono`}
            data-testid="coding-agent-import-path"
            spellCheck={false}
          />
          <p className="mt-1 text-[10px] text-[var(--text-muted)] leading-relaxed">{t("codingAgent.importFolderHint")}</p>
          <button type="submit" disabled={!folderPath.trim() || importing !== null} className={`${BTN_PRIMARY} mt-2`} data-testid="coding-agent-import-folder-submit">
            {importing === "folder" ? t("codingAgent.importImporting") : t("codingAgent.importFolderSubmit")}
          </button>
        </form>
      )}
    </div>
  );
}
