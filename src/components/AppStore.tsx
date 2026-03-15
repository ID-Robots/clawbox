"use client";

import { useState, useEffect, useCallback } from "react";

const STORE_API = "/setup-api/apps/store";
const STORE_ICONS_BASE = "https://openclawhardware.dev/store/icons";

// Brand orange from openclawhardware.dev
const BRAND_ORANGE = "#fe6e00";
const BRAND_ORANGE_LIGHT = "#ff8b1a";

const CATEGORY_COLORS: Record<string, string> = {
  "smart-home": "#3b82f6",
  "productivity": "#8b5cf6",
  "social-media": "#ec4899",
  "finance": "#22c55e",
  "developer": "#a78bfa",
  "security": "#ef4444",
  "health": "#10b981",
  "shopping": "#f97316",
  "entertainment": "#8b5cf6",
  "weather-travel": "#06b6d4",
  "writing": "#6366f1",
  "ai-automation": "#eab308",
};

interface StoreApp {
  id: string;
  name: string;
  description: string;
  rating: number;
  color: string;
  category: string;
  iconUrl: string;
  developer?: string;
  installs?: string;
  version?: string;
  url?: string;
  tags?: string[];
}

interface ApiApp {
  name: string;
  slug: string;
  summary: string;
  category: string;
  rating: number;
  installs: string;
  developer?: string;
  version?: string;
  url?: string;
  tags?: string[];
}

interface ApiCategory {
  id: string;
  name: string;
  count: number;
}

interface ApiResponse {
  total: number;
  categories: ApiCategory[];
  apps: ApiApp[];
}

function apiToStoreApp(app: ApiApp): StoreApp {
  return {
    id: app.slug,
    name: app.name,
    description: app.summary,
    rating: app.rating,
    color: CATEGORY_COLORS[app.category] || "#6b7280",
    category: app.category,
    iconUrl: `${STORE_ICONS_BASE}/${app.slug}.png`,
    developer: app.developer,
    installs: app.installs,
    version: app.version,
    url: app.url,
    tags: app.tags,
  };
}

function StoreAppIcon({ appId, name, color, size = "w-12 h-12" }: { appId: string; name: string; color: string; size?: string }) {
  const sources = [`/setup-api/apps/icon/${appId}`];
  const [srcIdx, setSrcIdx] = useState(0);
  const [failed, setFailed] = useState(false);

  const src = sources[srcIdx];
  if (!failed) {
    return (
      <div className={`${size} shrink-0 rounded-xl flex items-center justify-center text-white font-bold text-lg overflow-hidden`} style={{ backgroundColor: color }}>
        <img
          src={src}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => {
            if (srcIdx + 1 < sources.length) {
              setSrcIdx(srcIdx + 1);
            } else {
              setFailed(true);
            }
          }}
        />
      </div>
    );
  }
  return (
    <div className={`${size} shrink-0 rounded-xl flex items-center justify-center text-white font-bold text-lg`} style={{ backgroundColor: color }}>
      {name[0]}
    </div>
  );
}

interface InstallProgress {
  appId: string;
  status: "installing" | "success" | "error";
  message?: string;
}

interface AppStoreProps {
  installedAppIds: string[];
  onInstall: (app: StoreApp) => void;
  onUninstall: (appId: string) => void;
}

export default function AppStore({ installedAppIds, onInstall, onUninstall }: AppStoreProps) {
  const [search, setSearch] = useState("");
  const [installProgress, setInstallProgress] = useState<Record<string, InstallProgress>>({});
  const [category, setCategory] = useState<string>("All");
  const [apps, setApps] = useState<StoreApp[]>([]);
  const [categories, setCategories] = useState<ApiCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalApps, setTotalApps] = useState(0);
  const [selectedApp, setSelectedApp] = useState<StoreApp | null>(null);

  useEffect(() => {
    if (category === "Installed") return;
    const controller = new AbortController();
    const doFetch = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (category && category !== "All") params.set("category", category);
        if (search) params.set("q", search);
        const res = await fetch(`${STORE_API}?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ApiResponse = await res.json();
        setApps(data.apps.map(apiToStoreApp));
        if (data.categories.length > 0) setCategories(data.categories);
        setTotalApps(data.total);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[AppStore] fetch failed:", err);
        }
      } finally {
        setLoading(false);
      }
    };
    const timer = setTimeout(doFetch, search ? 300 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [category, search]);

  const handleInstall = useCallback(async (app: StoreApp) => {
    setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "installing" } }));
    try {
      const res = await fetch("/setup-api/apps/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id }),
      });
      const data = await res.json();
      if (!res.ok || (data.clawhub && !data.clawhub.success)) {
        const errMsg = data.clawhub?.error || data.error || "Install failed";
        setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "error", message: errMsg } }));
        setTimeout(() => setInstallProgress(prev => { const n = { ...prev }; delete n[app.id]; return n; }), 6000);
        return;
      }
      setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "success" } }));
      onInstall(app);
      setTimeout(() => setInstallProgress(prev => { const n = { ...prev }; delete n[app.id]; return n; }), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setInstallProgress(prev => ({ ...prev, [app.id]: { appId: app.id, status: "error", message: msg } }));
      setTimeout(() => setInstallProgress(prev => { const n = { ...prev }; delete n[app.id]; return n; }), 6000);
    }
  }, [onInstall]);

  const categoryTabs = ["All", ...categories.map(c => c.name)];
  const categoryIdMap: Record<string, string> = {};
  categories.forEach(c => { categoryIdMap[c.name] = c.id; });

  const handleCategoryClick = (cat: string) => {
    if (cat === "All" || cat === "Installed") {
      setCategory(cat);
    } else {
      setCategory(categoryIdMap[cat] || cat);
    }
  };

  const activeCategoryLabel = category === "All" || category === "Installed" ? category : categories.find(c => c.id === category)?.name || category;

  const displayApps = category === "Installed"
    ? apps.filter(app => installedAppIds.includes(app.id)).filter(app => !search || app.name.toLowerCase().includes(search.toLowerCase()))
    : apps;

  const renderInstallButton = (app: StoreApp, compact = false) => {
    const isInstalled = installedAppIds.includes(app.id);
    const progress = installProgress[app.id];
    const isInstalling = progress?.status === "installing";
    const isError = progress?.status === "error";
    const isSuccess = progress?.status === "success";

    if (isInstalled && !progress) {
      return (
        <button onClick={(e) => { e.stopPropagation(); onUninstall(app.id); }}
          className="px-3 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer">
          Uninstall
        </button>
      );
    }
    if (isInstalling) {
      return (
        <div className="flex items-center gap-2 flex-1">
          <span className="text-xs text-white/50 shrink-0">Installing...</span>
          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden min-w-[60px]">
            <div className="h-full rounded-full" style={{ backgroundColor: BRAND_ORANGE, animation: "indeterminate 1.5s ease-in-out infinite" }} />
          </div>
        </div>
      );
    }
    if (isSuccess) {
      return (
        <span className="flex items-center gap-1 text-xs font-medium" style={{ color: BRAND_ORANGE_LIGHT }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
          Installed
        </span>
      );
    }
    if (isError) {
      return (
        <div className={`flex items-center gap-2 ${compact ? "" : "flex-wrap"}`}>
          <span className="text-xs text-red-400 line-clamp-1" title={progress.message}>
            {progress.message}
          </span>
          <button onClick={(e) => { e.stopPropagation(); handleInstall(app); }}
            className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer shrink-0">
            Retry
          </button>
        </div>
      );
    }
    return (
      <button onClick={(e) => { e.stopPropagation(); handleInstall(app); }}
        className={`rounded-md font-medium transition-colors cursor-pointer ${compact ? "px-3 py-1 text-xs" : "px-6 py-2 text-sm"}`}
        style={{ backgroundColor: `${BRAND_ORANGE}1a`, color: BRAND_ORANGE_LIGHT }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${BRAND_ORANGE}33`)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = `${BRAND_ORANGE}1a`)}>
        Install
      </button>
    );
  };

  // Detail view
  if (selectedApp) {
    const isInstalled = installedAppIds.includes(selectedApp.id);
    const catName = categories.find(c => c.id === selectedApp.category)?.name || selectedApp.category;
    return (
      <div className="h-full flex flex-col bg-[#0f1219] text-white">
        {/* Back header */}
        <div className="shrink-0 px-4 py-3 border-b border-white/10 flex items-center gap-3">
          <button onClick={() => setSelectedApp(null)}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors cursor-pointer">
            <span className="material-symbols-rounded text-white/70" style={{ fontSize: 20 }}>arrow_back</span>
          </button>
          <span className="text-sm font-medium text-white/70">App Store</span>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* App header */}
          <div className="flex gap-4 mb-6">
            <StoreAppIcon appId={selectedApp.id} name={selectedApp.name} color={selectedApp.color} size="w-20 h-20" />
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold">{selectedApp.name}</h2>
              <p className="text-sm text-white/50">{selectedApp.developer || "Unknown developer"}</p>
              <div className="flex items-center gap-3 mt-2">
                <div className="flex items-center gap-1 text-yellow-400 text-sm">
                  <span>★</span>
                  <span className="font-semibold">{selectedApp.rating}</span>
                </div>
                {selectedApp.installs && (
                  <span className="text-xs text-white/40">{selectedApp.installs} installs</span>
                )}
                {selectedApp.version && (
                  <span className="text-xs text-white/30">v{selectedApp.version}</span>
                )}
              </div>
              <div className="mt-3 flex items-center gap-2">
                {renderInstallButton(selectedApp)}
                {isInstalled && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: BRAND_ORANGE_LIGHT }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
                    Installed
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">About</h3>
            <p className="text-sm text-white/70 leading-relaxed whitespace-pre-line">{selectedApp.description}</p>
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">Category</span>
              <div className="text-sm text-white/80 mt-0.5">{catName}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">Developer</span>
              <div className="text-sm text-white/80 mt-0.5">{selectedApp.developer || "—"}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">Downloads</span>
              <div className="text-sm text-white/80 mt-0.5">{selectedApp.installs || "—"}</div>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <span className="text-xs text-white/40">Version</span>
              <div className="text-sm text-white/80 mt-0.5">{selectedApp.version || "—"}</div>
            </div>
          </div>

          {/* Tags */}
          {selectedApp.tags && selectedApp.tags.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {selectedApp.tags.map(tag => (
                  <span key={tag} className="px-2.5 py-1 rounded-full text-xs bg-white/5 text-white/60">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Store link */}
          {selectedApp.url && (
            <a href={selectedApp.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs transition-colors"
              style={{ color: BRAND_ORANGE_LIGHT }}>
              View on ClawHub
              <span className="material-symbols-rounded" style={{ fontSize: 12 }}>open_in_new</span>
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#0f1219] text-white">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: BRAND_ORANGE }}>
            <span className="material-symbols-rounded text-white" style={{ fontSize: 20 }}>storefront</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold">ClawBox App Store</h1>
            <p className="text-xs text-white/50">Powered by ClawHub — {totalApps || "500+"}  AI Skills</p>
          </div>
        </div>

        <div className="relative mb-3">
          <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-white/40" style={{ fontSize: 16 }}>search</span>
          <input
            type="text"
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-3 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/40 focus:outline-none"
            style={{ ["--tw-ring-color" as string]: BRAND_ORANGE }}
            onFocus={(e) => (e.currentTarget.style.borderColor = `${BRAND_ORANGE}80`)}
            onBlur={(e) => (e.currentTarget.style.borderColor = "")}
          />
        </div>

        <div className="flex flex-wrap gap-1.5 pb-1">
          {["Installed", ...categoryTabs].map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryClick(cat)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                activeCategoryLabel === cat
                  ? "text-white"
                  : "bg-white/5 text-white/60 hover:bg-white/10"
              }`}
              style={activeCategoryLabel === cat ? { backgroundColor: BRAND_ORANGE } : undefined}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* App Grid */}
      <div className="flex-1 overflow-y-auto p-4 @container">
        {loading && apps.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: BRAND_ORANGE }} />
          </div>
        ) : (
          <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4 gap-3">
            {displayApps.map((app) => {
              const progress = installProgress[app.id];
              const isInstalling = progress?.status === "installing";
              const isInstalled = installedAppIds.includes(app.id);
              const isError = progress?.status === "error";
              const isSuccess = progress?.status === "success";
              return (
                <div
                  key={app.id}
                  onClick={() => setSelectedApp(app)}
                  className={`rounded-xl border p-3 transition-all duration-300 cursor-pointer ${
                    isInstalling ? "scale-[0.98]" : ""
                  } ${
                    isError
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                  }`}
                  style={
                    (isInstalled || isSuccess) && !isError
                      ? { borderColor: `${BRAND_ORANGE}4d`, backgroundColor: `${BRAND_ORANGE}0d` }
                      : undefined
                  }
                >
                  <div className="flex gap-3">
                    <StoreAppIcon appId={app.id} name={app.name} color={app.color} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-medium text-sm truncate">{app.name}</h3>
                          <span className="text-xs text-white/40">{categories.find(c => c.id === app.category)?.name || app.category}</span>
                        </div>
                        <div className="flex items-center gap-0.5 text-yellow-400 text-xs shrink-0">
                          <span>★</span>
                          <span>{app.rating}</span>
                        </div>
                      </div>
                      <p className="text-xs text-white/50 mt-1 line-clamp-2">{app.description}</p>
                      <div className="mt-2 flex items-center gap-2">
                        {renderInstallButton(app, true)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loading && displayApps.length === 0 && (
          <div className="text-center py-12 text-white/40">
            <p className="text-sm">No apps found</p>
          </div>
        )}
      </div>
    </div>
  );
}

export type { StoreApp };
