"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type HermesSkill,
  type HermesSkillDetail,
  type InstalledHermesSkill,
  HERMES_SKILL_SOURCES,
} from "@/lib/hermes-skills";
import { renderText } from "@/lib/chat-markdown";

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
  "skills.sh": "skills.sh",
  "well-known": "Well-known",
  github: "GitHub",
  clawhub: "ClawHub",
  lobehub: "LobeHub",
  "browse-sh": "browse.sh",
  builtin: "Built-in",
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

// Best-effort, confidence-gated source link derived purely from the identifier.
// https-only so it passes any safe-href check; returns null when unsure — never
// fabricates a URL for official/skills-sh/clawhub/bare ids.
function deriveSourceUrl(id?: string): { href: string; label: string } | null {
  if (!id) return null;
  const [head, ...rest] = id.split("/");
  if (head === "github" && rest.length >= 2) {
    return { href: `https://github.com/${rest[0]}/${rest[1]}`, label: "View on GitHub" };
  }
  if (head === "browse-sh" && rest.length >= 1) {
    const host = rest[0];
    if (host === "github.com" && rest.length >= 3) {
      return { href: `https://github.com/${rest[1]}/${rest[2]}`, label: "View on GitHub" };
    }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) {
      return { href: `https://${host}`, label: `Source: ${host}` };
    }
  }
  return null;
}

function SkillTile({
  name,
  category,
  large,
}: {
  name: string;
  category?: string;
  large?: boolean;
}) {
  // Category-tinted generated tile (no icon CDN for skills). Deterministic hue
  // from the category/name so the same skill always gets the same color.
  const seed = category || name || "?";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return (
    <div
      className={`shrink-0 flex items-center justify-center text-white font-semibold ${
        large ? "w-14 h-14 rounded-2xl text-2xl" : "w-11 h-11 rounded-xl text-lg"
      }`}
      style={{ backgroundColor: `hsl(${h} 45% 32%)` }}
      aria-hidden="true"
    >
      {(name[0] || "?").toUpperCase()}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

function TrustChip({ trust }: { trust: string }) {
  const verified = trust === "builtin" || trust === "official" || trust === "trusted";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${trustBadgeClass(
        trust,
      )}`}
    >
      {verified && (
        <span className="material-symbols-rounded" style={{ fontSize: 12 }}>
          verified
        </span>
      )}
      {trust}
    </span>
  );
}

function MetaChip({ icon, text }: { icon: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-[var(--surface-card)] text-[var(--text-secondary)] max-w-full">
      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 12 }}>
        {icon}
      </span>
      <span className="truncate">{text}</span>
    </span>
  );
}

function SkillCard({
  skill,
  onOpen,
  action,
}: {
  skill: HermesSkill | InstalledHermesSkill;
  onOpen: () => void;
  action: ReactNode;
}) {
  const scanVerdict = "scanVerdict" in skill ? skill.scanVerdict : undefined;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`View ${skill.name}`}
      className="card-surface rounded-2xl p-3 min-h-[7.5rem] flex cursor-pointer border border-[var(--border-subtle)]
                 hover:border-[var(--coral-bright)]/40 hover:-translate-y-0.5 hover:shadow-lg
                 focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)] outline-none transition-all"
    >
      <div className="flex gap-3 w-full">
        <SkillTile name={skill.name} category={skill.category} />
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="font-medium text-sm truncate">{skill.name}</h3>
            {skill.trust && (
              <span className="shrink-0">
                <TrustChip trust={skill.trust} />
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-wrap mt-1 min-w-0">
            {skill.source && (
              <MetaChip icon="hub" text={SOURCE_LABELS[skill.source] || skill.source} />
            )}
            {skill.category && <MetaChip icon="category" text={skill.category} />}
            {scanVerdict && (
              <span
                className={`px-1.5 py-0.5 rounded-full text-[9px] ${
                  scanVerdict === "safe"
                    ? "text-emerald-400 bg-emerald-400/10"
                    : "text-amber-400 bg-amber-400/10"
                }`}
              >
                scan: {scanVerdict}
              </span>
            )}
          </div>
          {skill.description && (
            <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
              {skill.description}
            </p>
          )}
          <div className="mt-auto pt-2" onClick={(e) => e.stopPropagation()}>
            {action}
          </div>
        </div>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div
      className="card-surface rounded-2xl p-3 min-h-[7.5rem] border border-[var(--border-subtle)] animate-pulse"
      aria-hidden="true"
    >
      <div className="flex gap-3">
        <div className="w-11 h-11 rounded-xl bg-[var(--surface-card)]" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-3 w-1/2 rounded bg-[var(--surface-card)]" />
          <div className="h-2 w-1/3 rounded bg-[var(--surface-card)]" />
          <div className="h-2 w-full rounded bg-[var(--surface-card)]" />
        </div>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-2 animate-pulse mb-6" aria-hidden="true">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-[var(--surface-card)]"
          style={{ width: `${90 - i * 8}%` }}
        />
      ))}
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
  const [reloadKey, setReloadKey] = useState(0);
  const [progress, setProgress] = useState<Record<string, ProgressState>>({});
  const [selected, setSelected] = useState<HermesSkill | InstalledHermesSkill | null>(null);
  const [detail, setDetail] = useState<HermesSkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmInstall, setConfirmInstall] = useState<HermesSkill | null>(null);
  const detailCache = useRef<Map<string, HermesSkillDetail>>(new Map());
  // Tracks the in-flight inspect request so a stale response for a
  // previously-selected skill can't overwrite the current detail.
  const detailReq = useRef<{ controller: AbortController; id: string } | null>(null);

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

  // Browse tab: an empty query shows a default listing (`browse`); typing runs
  // a search. Both honor the source filter. Debounce search; load browse eagerly.
  useEffect(() => {
    if (tab !== "browse") return;
    const q = query.trim();
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setSearchError(null);
      try {
        let url: string;
        if (q) {
          const params = new URLSearchParams({ q, limit: String(SEARCH_LIMIT) });
          if (source && source !== "all") params.set("source", source);
          url = `/setup-api/hermes/skills/search?${params}`;
        } else {
          const params = new URLSearchParams({ size: String(SEARCH_LIMIT) });
          if (source && source !== "all") params.set("source", source);
          url = `/setup-api/hermes/skills/browse?${params}`;
        }
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setResults(Array.isArray(data.skills) ? (data.skills as HermesSkill[]) : []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setSearchError(err instanceof Error ? err.message : "Couldn't load skills");
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    };
    const timer = setTimeout(load, q ? 300 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, source, tab, reloadKey]);

  // Open the detail view: paint the header from the card payload immediately,
  // then fetch inspect depth lazily (cached by id).
  const openDetail = useCallback((skill: HermesSkill | InstalledHermesSkill) => {
    // Cancel any prior in-flight inspect so its late response can't clobber this.
    detailReq.current?.controller.abort();
    detailReq.current = null;
    setSelected(skill);
    const idForInspect =
      "identifier" in skill && skill.identifier ? skill.identifier : skill.id;
    const cached = detailCache.current.get(idForInspect);
    if (cached) {
      setDetail(cached);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const controller = new AbortController();
    const req = { controller, id: idForInspect };
    detailReq.current = req;
    (async () => {
      try {
        const res = await fetch(
          `/setup-api/hermes/skills/inspect?id=${encodeURIComponent(idForInspect)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const d = data.skill as HermesSkillDetail;
        detailCache.current.set(idForInspect, d);
        // Ignore if a newer request superseded this one.
        if (detailReq.current !== req) return;
        setDetail(d);
      } catch (err) {
        if ((err as Error).name !== "AbortError" && detailReq.current === req) {
          setDetailError(err instanceof Error ? err.message : "Couldn't load details");
        }
      } finally {
        if (detailReq.current === req) {
          detailReq.current = null;
          setDetailLoading(false);
        }
      }
    })();
  }, []);

  const closeDetail = useCallback(() => {
    detailReq.current?.controller.abort();
    detailReq.current = null;
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

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
      const match = installedList.find((s) => s.identifier === skill.id || s.id === skill.id);
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

  // ── Action for an installed-tab card (builtin skills are not removable) ──
  const renderInstalledAction = (skill: InstalledHermesSkill) => {
    const st = progress[skill.id];
    if (st?.status === "working") {
      return <span className="text-xs text-[var(--text-secondary)]">Removing…</span>;
    }
    if (st?.status === "error") {
      return (
        <span className="text-xs text-red-400 line-clamp-1" title={st.message}>
          {st.message}
        </span>
      );
    }
    if (skill.source === "builtin") {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>
            lock
          </span>
          Built-in
        </span>
      );
    }
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          doUninstall(skill.id, skill.id);
        }}
        className="px-3 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
      >
        Uninstall
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

  // ── Detail view ──
  if (selected) {
    const installed = isInstalled(selected);
    const uninstallName = installedNameFor(selected);
    const isBuiltin = "source" in selected && selected.source === "builtin";
    const idForDerive =
      ("identifier" in selected && selected.identifier) || selected.id;
    const src = detail?.sourceUrl
      ? { href: detail.sourceUrl, label: "View source" }
      : deriveSourceUrl(idForDerive);
    const tags = detail?.tags ?? [];
    const description = selected.description || detail?.description;
    const meta = [
      detail?.version && { label: "Version", value: detail.version },
      detail?.author && { label: "Author", value: detail.author },
      detail?.license && { label: "License", value: detail.license },
      (detail?.category || selected.category) && {
        label: "Category",
        value: (detail?.category || selected.category) as string,
      },
    ].filter(Boolean) as { label: string; value: string }[];
    const hasSetup =
      !!detail?.setupHelpUrl || !!detail?.detailUrl || (detail?.secrets?.length ?? 0) > 0;

    return (
      <div
        className="h-full flex flex-col bg-[var(--bg-deep)] text-[var(--text-primary)]"
        data-testid={testId || "hermes-skills-store"}
      >
        {confirmModal}
        {/* Back bar */}
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border-subtle)] flex items-center gap-3">
          <button
            onClick={closeDetail}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--surface-card)] transition-colors"
            aria-label="Back to skills"
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

        <div className="flex-1 overflow-y-auto @container">
          <div className="p-6 max-w-3xl w-full mx-auto">
            {/* Header */}
            <div className="flex gap-4 mb-5">
              <SkillTile name={selected.name} category={detail?.category || selected.category} large />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold">{selected.name}</h2>
                  {selected.trust && <TrustChip trust={selected.trust} />}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                  {selected.source && (
                    <MetaChip icon="hub" text={SOURCE_LABELS[selected.source] || selected.source} />
                  )}
                  {tags.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 rounded-full text-[10px] bg-[var(--surface-card)] text-[var(--text-secondary)]"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-2 break-all font-mono">
                  {selected.id}
                </p>
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  {isBuiltin ? (
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>
                        lock
                      </span>
                      Built-in
                    </span>
                  ) : (
                    renderResultAction(selected as HermesSkill)
                  )}
                  {src && (
                    <a
                      href={src.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-[var(--coral-bright)] hover:underline"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>
                        open_in_new
                      </span>
                      {src.label}
                    </a>
                  )}
                </div>
                {installed && uninstallName && !isBuiltin && (
                  <p className="text-xs text-[var(--text-secondary)] mt-2">
                    Installed as <span className="font-mono">{uninstallName}</span>
                  </p>
                )}
              </div>
            </div>

            {/* Metadata strip */}
            {meta.length > 0 && (
              <div className="grid grid-cols-2 @sm:grid-cols-4 gap-2 mb-5">
                {meta.map((m) => (
                  <div
                    key={m.label}
                    className="card-surface rounded-xl px-3 py-2 border border-[var(--border-subtle)]"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
                      {m.label}
                    </div>
                    <div className="text-sm truncate" title={m.value}>
                      {m.value}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* About — from the card payload, always instant */}
            {description && (
              <Section title="About">
                <p className="text-sm leading-relaxed text-[var(--text-primary)]/80 whitespace-pre-line">
                  {description}
                </p>
              </Section>
            )}

            {/* Detail depth: skeleton / error / SKILL.md body */}
            {detailLoading && <DetailSkeleton />}
            {detailError && !detailLoading && (
              <div className="rounded-lg p-3 mb-6 bg-[var(--surface-card)] border border-[var(--border-subtle)] text-sm text-[var(--text-secondary)]">
                Couldn’t load the full skill details. {detailError}
              </div>
            )}
            {detail?.body && !detailLoading && (
              <Section title="Skill details">
                <div className="text-sm leading-relaxed text-[var(--text-primary)]/85 [&_a]:text-[var(--coral-bright)] [&_a]:underline">
                  {renderText(detail.body)}
                </div>
                {detail.markdownTruncated && (
                  <p className="text-[11px] text-[var(--text-secondary)] mt-2 italic">
                    Preview — install the skill to read the full SKILL.md.
                  </p>
                )}
              </Section>
            )}

            {/* Setup & requirements */}
            {hasSetup && !detailLoading && (
              <Section title="Setup & requirements">
                <div className="flex flex-col gap-2">
                  {detail?.setupHelpUrl && (
                    <a
                      href={detail.setupHelpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-[var(--coral-bright)] hover:underline w-fit"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                        menu_book
                      </span>
                      Setup guide
                    </a>
                  )}
                  {detail?.detailUrl && (
                    <a
                      href={detail.detailUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-[var(--coral-bright)] hover:underline w-fit"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                        description
                      </span>
                      Detail page
                    </a>
                  )}
                  {detail?.secrets?.map((s, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"
                    >
                      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 16 }}>
                        key
                      </span>
                      <span>Requires {s.provider || "an API key"}</span>
                      {s.providerUrl && (
                        <a
                          href={s.providerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--coral-bright)] hover:underline"
                        >
                          Get one
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
      </div>
    );
  }

  const showResults = tab === "browse";
  const emptyBrowse = showResults && !loading && !searchError && results.length === 0;
  const q = query.trim();

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
        <div className="flex gap-1.5 mb-3" role="tablist" aria-label="Skills view">
          {(["installed", "browse"] as const).map((tk) => (
            <button
              key={tk}
              role="tab"
              id={`hs-tab-${tk}`}
              aria-selected={tab === tk}
              aria-controls="hs-tabpanel"
              onClick={() => setTab(tk)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                tab === tk
                  ? "bg-[var(--coral-bright)] text-white"
                  : "bg-[var(--surface-card)] text-[var(--text-secondary)] hover:opacity-90"
              }`}
            >
              {tk === "installed"
                ? `Installed${installedList.length ? ` (${installedList.length})` : ""}`
                : "Browse"}
            </button>
          ))}
        </div>

        {showResults && (
          <>
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
                  aria-label="Search skills"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full h-10 pl-9 pr-9 rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--coral-bright)]"
                />
                {loading && (
                  <div
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-[var(--border-subtle)] rounded-full animate-spin"
                    style={{ borderTopColor: "var(--coral-bright)" }}
                    role="status"
                    aria-label="Loading"
                  />
                )}
                {!loading && query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-card)] transition-colors"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                      close
                    </span>
                  </button>
                )}
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
            {source !== "all" && (
              <button
                onClick={() => setSource("all")}
                className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-[var(--coral-bright)]/10 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/20 transition-colors"
              >
                Filtered: {SOURCE_LABELS[source] || source}
                <span className="material-symbols-rounded" style={{ fontSize: 13 }}>
                  close
                </span>
              </button>
            )}
          </>
        )}
      </div>

      {/* Body */}
      <div
        id="hs-tabpanel"
        role="tabpanel"
        aria-labelledby={`hs-tab-${tab}`}
        className="flex-1 overflow-y-auto p-4 @container"
      >
        {showResults ? (
          <>
            {loading && results.length === 0 && (
              <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 gap-3">
                {[...Array(6)].map((_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            )}
            {searchError && !loading && (
              <div className="flex flex-col items-center text-center py-12 gap-2">
                <span
                  className="material-symbols-rounded text-red-400"
                  style={{ fontSize: 40 }}
                  aria-hidden="true"
                >
                  error
                </span>
                <p className="text-sm text-red-400">{searchError}</p>
                <button
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="mt-1 px-4 py-1.5 rounded-md text-xs font-semibold bg-[var(--coral-bright)] text-white hover:opacity-90 transition-opacity"
                >
                  Retry
                </button>
              </div>
            )}
            {emptyBrowse && (
              <div className="flex flex-col items-center text-center py-12 gap-2 text-[var(--text-secondary)]">
                <span className="material-symbols-rounded" style={{ fontSize: 40 }} aria-hidden="true">
                  search_off
                </span>
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {q ? `No skills match “${q}”` : "No skills found"}
                </p>
                <p className="text-xs">Try a different term or source.</p>
              </div>
            )}
            {!searchError && results.length > 0 && (
              <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 gap-3">
                {results.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onOpen={() => openDetail(skill)}
                    action={renderResultAction(skill)}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {loadingInstalled && installedList.length === 0 && (
              <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 gap-3">
                {[...Array(4)].map((_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            )}
            {!loadingInstalled && installedList.length === 0 && (
              <div className="flex flex-col items-center text-center py-12 gap-2 text-[var(--text-secondary)]">
                <span className="material-symbols-rounded" style={{ fontSize: 40 }} aria-hidden="true">
                  extension
                </span>
                <p className="text-sm font-medium text-[var(--text-primary)]">No skills installed</p>
                <p className="text-xs">Browse the registry to add capabilities.</p>
                <button
                  onClick={() => setTab("browse")}
                  className="mt-1 px-4 py-1.5 rounded-md text-xs font-semibold bg-[var(--coral-bright)] text-white hover:opacity-90 transition-opacity"
                >
                  Browse skills
                </button>
              </div>
            )}
            {installedList.length > 0 && (
              <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 gap-3">
                {installedList.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onOpen={() => openDetail(skill)}
                    action={renderInstalledAction(skill)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
