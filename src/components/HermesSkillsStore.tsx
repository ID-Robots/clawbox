"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type HermesSkill,
  type InstalledHermesSkill,
  HERMES_SKILL_SOURCES,
} from "@/lib/hermes-skills";

// Hermes-flavored skills store. Fully self-contained: unlike the OpenClaw
// AppStore it manages its own installed list, creates no desktop icons, and
// drives Hermes' own CLI (~/.hermes/skills) through /setup-api/hermes/skills/*.
// No parent props required.

type ProgressState = { status: "working" | "success" | "error"; message?: string };

const SEARCH_LIMIT = 50;

// Friendly labels for the source filter. Values must match the route allowlist.
const SOURCE_LABELS: Record<string, string> = {
  all: "All sources",
  official: "Official",
  "skills-sh": "skills.sh",
  "well-known": "Well-known",
  github: "GitHub",
  clawhub: "ClawHub",
  lobehub: "LobeHub",
  "browse-sh": "browse.sh",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  anthropic: "Anthropic",
  huggingface: "Hugging Face",
  voltagent: "VoltAgent",
  gstack: "gstack",
  minimax: "MiniMax",
};

function trustBadgeClass(trust?: string): string {
  switch (trust) {
    case "builtin":
    case "official":
      return "bg-[var(--coral-bright)]/15 text-[var(--coral-bright)]";
    case "trusted":
      return "text-emerald-400 bg-emerald-400/10";
    default:
      return "text-[var(--text-secondary)] bg-[var(--surface-card)]";
  }
}

function SkillTile({ name, category }: { name: string; category?: string }) {
  // Category-tinted generated tile (no icon CDN for skills). Deterministic hue
  // from the category/name so the same skill always gets the same color.
  const seed = (category || name || "?");
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return (
    <div
      className="w-11 h-11 shrink-0 rounded-xl flex items-center justify-center text-white font-semibold text-lg"
      style={{ backgroundColor: `hsl(${h} 45% 32%)` }}
      aria-hidden="true"
    >
      {(name[0] || "?").toUpperCase()}
    </div>
  );
}

export default function HermesSkillsStore({ testId }: { testId?: string }) {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [results, setResults] = useState<HermesSkill[]>([]);
  const [installedList, setInstalledList] = useState<InstalledHermesSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressState>>({});
  const [selected, setSelected] = useState<HermesSkill | null>(null);
  const [confirmInstall, setConfirmInstall] = useState<HermesSkill | null>(null);

  // Installed lookups for marking search results. Match on stable ids only —
  // a shared display name (two different 'search' skills) must NOT be treated
  // as the same skill, or Remove would uninstall an unrelated local skill.
  const installedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of installedList) {
      if (s.identifier) ids.add(s.identifier);
      ids.add(s.id);
    }
    return { ids };
  }, [installedList]);

  const isInstalled = useCallback(
    (skill: { id: string }) => installedIds.ids.has(skill.id),
    [installedIds],
  );

  const fetchInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const res = await fetch("/setup-api/hermes/skills/installed", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.skills)) {
        setInstalledList(data.skills as InstalledHermesSkill[]);
      }
    } catch {
      /* best-effort — the installed tab just shows empty */
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  useEffect(() => {
    fetchInstalled();
  }, [fetchInstalled]);

  // Debounced search (browse tab only). Empty query clears results.
  useEffect(() => {
    if (tab !== "browse") return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearchError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams({ q, limit: String(SEARCH_LIMIT) });
        if (source && source !== "all") params.set("source", source);
        const res = await fetch(`/setup-api/hermes/skills/search?${params}`, {
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setResults(Array.isArray(data.skills) ? (data.skills as HermesSkill[]) : []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setSearchError(err instanceof Error ? err.message : "Search failed");
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, source, tab]);

  const setProgressAutoClear = useCallback((key: string, state: ProgressState, ms: number) => {
    setProgress((p) => ({ ...p, [key]: state }));
    setTimeout(() => {
      setProgress((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
    }, ms);
  }, []);

  const doInstall = useCallback(
    async (skill: HermesSkill) => {
      setConfirmInstall(null);
      const key = skill.id;
      setProgress((p) => ({ ...p, [key]: { status: "working" } }));
      try {
        const res = await fetch("/setup-api/hermes/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: skill.id, category: skill.category }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setProgressAutoClear(key, { status: "success" }, 2000);
        await fetchInstalled();
      } catch (err) {
        setProgressAutoClear(
          key,
          { status: "error", message: err instanceof Error ? err.message : "Install failed" },
          6000,
        );
      }
    },
    [fetchInstalled, setProgressAutoClear],
  );

  const doUninstall = useCallback(
    async (name: string, key: string) => {
      setProgress((p) => ({ ...p, [key]: { status: "working" } }));
      try {
        const res = await fetch("/setup-api/hermes/skills/uninstall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: name }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setProgress((p) => {
          const n = { ...p };
          delete n[key];
          return n;
        });
        await fetchInstalled();
      } catch (err) {
        setProgressAutoClear(
          key,
          { status: "error", message: err instanceof Error ? err.message : "Uninstall failed" },
          6000,
        );
      }
    },
    [fetchInstalled, setProgressAutoClear],
  );

  // Resolve the uninstall name (lock.json key) for a search result.
  const installedNameFor = useCallback(
    (skill: { id: string }): string | null => {
      const match = installedList.find(
        (s) => s.identifier === skill.id || s.id === skill.id,
      );
      return match ? match.id : null;
    },
    [installedList],
  );

  const selectCls =
    "w-full rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]";

  // ── Install button for a browse result ──
  const renderResultAction = (skill: HermesSkill) => {
    const installed = isInstalled(skill);
    const st = progress[skill.id];
    if (st?.status === "working") {
      return <span className="text-xs text-[var(--text-secondary)]">Installing…</span>;
    }
    if (st?.status === "error") {
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-red-400 line-clamp-1" title={st.message}>
            {st.message}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirmInstall(skill);
            }}
            className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    if (st?.status === "success" || installed) {
      const name = installedNameFor(skill);
      return (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>
              check_circle
            </span>
            Installed
          </span>
          {name && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                doUninstall(name, skill.id);
              }}
              className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      );
    }
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirmInstall(skill);
        }}
        className="px-4 py-1.5 rounded-md text-xs font-semibold bg-[var(--coral-bright)] text-white hover:opacity-90 transition-opacity"
      >
        Install
      </button>
    );
  };

  // ── Install-confirm modal ──
  const confirmModal = confirmInstall && (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setConfirmInstall(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setConfirmInstall(null);
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="hs-confirm-title"
    >
      <div
        className="card-surface rounded-2xl p-6 max-w-sm mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[var(--coral-bright)]">
            <span className="material-symbols-rounded text-white" style={{ fontSize: 22 }}>
              extension
            </span>
          </div>
          <h3 id="hs-confirm-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Install {confirmInstall.name}?
          </h3>
        </div>
        <div className="rounded-lg p-3 mb-4 bg-yellow-500/10 border border-yellow-500/20">
          <div className="flex gap-2">
            <span
              className="material-symbols-rounded text-yellow-400 shrink-0"
              style={{ fontSize: 18 }}
            >
              warning
            </span>
            <p className="text-sm text-yellow-200/80">
              This skill runs inside your Hermes agent. Hermes scans it for safety before enabling
              it — only install skills you trust.
            </p>
          </div>
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={() => setConfirmInstall(null)}
            className="px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-card)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => doInstall(confirmInstall)}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--coral-bright)] hover:opacity-90 transition-opacity"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );

  // ── Detail view (fed by the search payload) ──
  if (selected) {
    const installed = isInstalled(selected);
    const name = installedNameFor(selected);
    return (
      <div
        className="h-full flex flex-col bg-[var(--bg-deep)] text-[var(--text-primary)]"
        data-testid={testId || "hermes-skills-store"}
      >
        {confirmModal}
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border-subtle)] flex items-center gap-3">
          <button
            onClick={() => setSelected(null)}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--surface-card)] transition-colors"
            aria-label="Back"
          >
            <span
              className="material-symbols-rounded text-[var(--text-secondary)]"
              style={{ fontSize: 20 }}
            >
              arrow_back
            </span>
          </button>
          <span className="text-sm font-medium text-[var(--text-secondary)]">Hermes Skills</span>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex gap-4 mb-6">
            <SkillTile name={selected.name} category={selected.category} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold">{selected.name}</h2>
                {selected.trust && (
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${trustBadgeClass(
                      selected.trust,
                    )}`}
                  >
                    {selected.trust}
                  </span>
                )}
              </div>
              {selected.source && (
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">{selected.source}</p>
              )}
              <p className="text-xs text-[var(--text-secondary)] mt-1 break-all">{selected.id}</p>
              <div className="mt-3">{renderResultAction(selected)}</div>
              {installed && name && (
                <p className="text-xs text-[var(--text-secondary)] mt-2">
                  Installed as <span className="font-mono">{name}</span>
                </p>
              )}
            </div>
          </div>
          {selected.description && (
            <div className="mb-6">
              <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
                About
              </h3>
              <p className="text-sm text-[var(--text-primary)]/80 leading-relaxed whitespace-pre-line">
                {selected.description}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  const showResults = tab === "browse";
  const emptyBrowse = showResults && !loading && !searchError && query.trim() && results.length === 0;

  return (
    <div
      className="h-full flex flex-col bg-[var(--bg-deep)] text-[var(--text-primary)]"
      data-testid={testId || "hermes-skills-store"}
    >
      {confirmModal}
      {/* Header */}
      <div className="@container shrink-0 px-4 py-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--coral-bright)]">
            <span className="material-symbols-rounded text-white" style={{ fontSize: 20 }}>
              extension
            </span>
          </div>
          <div>
            <h1 className="text-lg font-semibold">Hermes Skills</h1>
            <p className="text-xs text-[var(--text-secondary)]">
              Add capabilities to your Hermes agent
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1.5 mb-3">
          {(["installed", "browse"] as const).map((tk) => (
            <button
              key={tk}
              onClick={() => setTab(tk)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                tab === tk
                  ? "bg-[var(--coral-bright)] text-white"
                  : "bg-[var(--surface-card)] text-[var(--text-secondary)] hover:opacity-90"
              }`}
            >
              {tk === "installed" ? `Installed${installedList.length ? ` (${installedList.length})` : ""}` : "Browse"}
            </button>
          ))}
        </div>

        {showResults && (
          <div className="flex flex-col @sm:flex-row gap-2">
            <div className="relative flex-1">
              <span
                className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]"
                style={{ fontSize: 16 }}
              >
                search
              </span>
              <input
                type="text"
                placeholder="Search skills…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full h-10 pl-9 pr-3 rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--coral-bright)]"
              />
            </div>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              aria-label="Source filter"
              className={`${selectCls} @sm:w-44`}
            >
              {HERMES_SKILL_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s] || s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 @container">
        {showResults ? (
          <>
            {loading && results.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <div
                  className="w-6 h-6 border-2 border-[var(--border-subtle)] rounded-full animate-spin"
                  style={{ borderTopColor: "var(--coral-bright)" }}
                />
              </div>
            )}
            {searchError && (
              <div className="text-center py-12 text-red-400 text-sm">{searchError}</div>
            )}
            {!query.trim() && !loading && (
              <div className="text-center py-12 text-[var(--text-secondary)] text-sm">
                Type to search the Hermes skill registries.
              </div>
            )}
            {emptyBrowse && (
              <div className="text-center py-12 text-[var(--text-secondary)] text-sm">
                No skills found.
              </div>
            )}
            <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 gap-3">
              {results.map((skill) => (
                <div
                  key={skill.id}
                  onClick={() => setSelected(skill)}
                  className="card-surface rounded-2xl p-3 cursor-pointer hover:border-[var(--coral-bright)]/40 transition-colors border border-[var(--border-subtle)]"
                >
                  <div className="flex gap-3">
                    <SkillTile name={skill.name} category={skill.category} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h3 className="font-medium text-sm truncate">{skill.name}</h3>
                        {skill.trust && (
                          <span
                            className={`shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${trustBadgeClass(
                              skill.trust,
                            )}`}
                          >
                            {skill.trust}
                          </span>
                        )}
                      </div>
                      {skill.source && (
                        <span className="block text-xs text-[var(--text-secondary)] truncate">
                          {skill.source}
                        </span>
                      )}
                      {skill.description && (
                        <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
                          {skill.description}
                        </p>
                      )}
                      <div className="mt-2">{renderResultAction(skill)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {loadingInstalled && installedList.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <div
                  className="w-6 h-6 border-2 border-[var(--border-subtle)] rounded-full animate-spin"
                  style={{ borderTopColor: "var(--coral-bright)" }}
                />
              </div>
            )}
            {!loadingInstalled && installedList.length === 0 && (
              <div className="text-center py-12 text-[var(--text-secondary)] text-sm">
                No skills installed yet. Switch to Browse to add some.
              </div>
            )}
            <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 gap-3">
              {installedList.map((skill) => {
                const st = progress[skill.id];
                return (
                  <div
                    key={skill.id}
                    className="card-surface rounded-2xl p-3 border border-[var(--border-subtle)]"
                  >
                    <div className="flex gap-3">
                      <SkillTile name={skill.name} category={skill.category} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <h3 className="font-medium text-sm truncate">{skill.name}</h3>
                          {skill.trust && (
                            <span
                              className={`shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${trustBadgeClass(
                                skill.trust,
                              )}`}
                            >
                              {skill.trust}
                            </span>
                          )}
                        </div>
                        <span className="block text-xs text-[var(--text-secondary)] truncate">
                          {skill.category}
                          {skill.source ? ` · ${skill.source}` : ""}
                          {skill.scanVerdict ? ` · scan: ${skill.scanVerdict}` : ""}
                        </span>
                        {skill.description && (
                          <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
                            {skill.description}
                          </p>
                        )}
                        <div className="mt-2">
                          {st?.status === "working" ? (
                            <span className="text-xs text-[var(--text-secondary)]">Removing…</span>
                          ) : st?.status === "error" ? (
                            <span className="text-xs text-red-400 line-clamp-1" title={st.message}>
                              {st.message}
                            </span>
                          ) : skill.source === "builtin" ? (
                            <span className="text-xs text-[var(--text-secondary)]">Built-in</span>
                          ) : (
                            <button
                              onClick={() => doUninstall(skill.id, skill.id)}
                              className="px-3 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                            >
                              Uninstall
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
