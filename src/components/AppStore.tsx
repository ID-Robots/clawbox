"use client";

import { useState, useEffect } from "react";

const STORE_API = "/setup-api/apps/store";
const STORE_ICONS_BASE = "https://openclawhardware.dev/store/icons";

// Category color mapping based on store website
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
}

interface ApiApp {
  name: string;
  slug: string;
  summary: string;
  category: string;
  rating: number;
  installs: string;
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
  };
}

function StoreAppIcon({ appId, name, color }: { appId: string; name: string; color: string }) {
  const sources = [`/setup-api/apps/icon/${appId}`];
  const [srcIdx, setSrcIdx] = useState(0);
  const [failed, setFailed] = useState(false);

  const src = sources[srcIdx];
  if (!failed) {
    return (
      <div className="w-12 h-12 shrink-0 rounded-xl flex items-center justify-center text-white font-bold text-lg overflow-hidden" style={{ backgroundColor: color }}>
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
    <div className="w-12 h-12 shrink-0 rounded-xl flex items-center justify-center text-white font-bold text-lg" style={{ backgroundColor: color }}>
      {name[0]}
    </div>
  );
}

interface AppStoreProps {
  installedAppIds: string[];
  onInstall: (app: StoreApp) => void;
  onUninstall: (appId: string) => void;
}

export default function AppStore({ installedAppIds, onInstall, onUninstall }: AppStoreProps) {
  const [search, setSearch] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("All");
  const [apps, setApps] = useState<StoreApp[]>([]);
  const [categories, setCategories] = useState<ApiCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalApps, setTotalApps] = useState(0);

  // Fetch apps from store API
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

  const handleInstall = (app: StoreApp) => {
    setInstallingId(app.id);
    setTimeout(() => {
      onInstall(app);
      setInstallingId(null);
    }, 600);
  };

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

  // Filter for "Installed" view
  const displayApps = category === "Installed"
    ? apps.filter(app => installedAppIds.includes(app.id)).filter(app => !search || app.name.toLowerCase().includes(search.toLowerCase()))
    : apps;

  return (
    <div className="h-full flex flex-col bg-[#0f1219] text-white">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-[#22c55e] flex items-center justify-center">
            <span className="material-symbols-rounded text-white" style={{ fontSize: 20 }}>storefront</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold">ClawBox App Store</h1>
            <p className="text-xs text-white/50">Powered by ClawHub — {totalApps || "500+"}  AI Skills</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-white/40" style={{ fontSize: 16 }}>search</span>
          <input
            type="text"
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-3 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/20"
          />
        </div>

        {/* Categories */}
        <div className="flex flex-wrap gap-1.5 pb-1">
          {["Installed", ...categoryTabs].map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryClick(cat)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                activeCategoryLabel === cat
                  ? "bg-[#22c55e] text-white"
                  : "bg-white/5 text-white/60 hover:bg-white/10"
              }`}
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
            <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4 gap-3">
            {displayApps.map((app) => {
              const isInstalled = installedAppIds.includes(app.id);
              const isInstalling = installingId === app.id;
              return (
                <div
                  key={app.id}
                  className={`rounded-xl border p-3 transition-all duration-300 ${
                    isInstalling ? "scale-95 opacity-70" : ""
                  } ${
                    isInstalled
                      ? "border-[#22c55e]/30 bg-[#22c55e]/5"
                      : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                  }`}
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
                      <div className="mt-2">
                        {isInstalled ? (
                          <button
                            onClick={() => onUninstall(app.id)}
                            className="px-3 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
                          >
                            Uninstall
                          </button>
                        ) : (
                          <button
                            onClick={() => handleInstall(app)}
                            disabled={isInstalling}
                            className="px-3 py-1 rounded-md text-xs font-medium bg-[#22c55e]/10 text-[#22c55e] hover:bg-[#22c55e]/20 transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {isInstalling ? "Installing..." : "Install"}
                          </button>
                        )}
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
