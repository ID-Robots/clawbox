"use client";

import { useState } from "react";

type IconType = "home" | "chart" | "cloud" | "code" | "shield" | "git" | "brain" | "mail" | "calendar" | "globe" | "box" | "chat";

interface StoreApp {
  id: string;
  name: string;
  description: string;
  rating: number;
  color: string;
  category: string;
  iconType: IconType;
}

const STORE_APPS: StoreApp[] = [
  {
    id: "home-assistant",
    name: "Home Assistant",
    description: "Control Home Assistant smart home devices, run automations, and receive webhook events.",
    rating: 4.9,
    color: "#18bcf2",
    category: "Smart Home",
    iconType: "home",
  },
  {
    id: "binance-pro",
    name: "Binance Pro",
    description: "Complete Binance integration — trade spot, futures with up to 125x leverage, staking, and portfolio.",
    rating: 4.9,
    color: "#f0b90b",
    category: "Finance",
    iconType: "chart",
  },
  {
    id: "weather-forecast",
    name: "Weather",
    description: "Accurate weather forecasts for any location. Current conditions, hourly and daily forecasts, alerts.",
    rating: 4.8,
    color: "#60a5fa",
    category: "Utilities",
    iconType: "cloud",
  },
  {
    id: "developer",
    name: "Developer",
    description: "Write clean, maintainable code with debugging, testing, and architectural best practices.",
    rating: 4.8,
    color: "#a78bfa",
    category: "Development",
    iconType: "code",
  },
  {
    id: "zero-trust",
    name: "Zero Trust",
    description: "Security-first behavioral guidelines for cautious agent operation and external resource handling.",
    rating: 4.9,
    color: "#ef4444",
    category: "Security",
    iconType: "shield",
  },
  {
    id: "github-issues",
    name: "GitHub Issues",
    description: "Fetch issues, spawn sub-agents to implement fixes, open PRs, and monitor review comments.",
    rating: 4.7,
    color: "#8b5cf6",
    category: "Development",
    iconType: "git",
  },
  {
    id: "ollama-manager",
    name: "Ollama Manager",
    description: "Manage local AI models — pull, run, delete. Switch between Llama, Mistral, Qwen, and more.",
    rating: 4.6,
    color: "#10b981",
    category: "AI",
    iconType: "brain",
  },
  {
    id: "email-assistant",
    name: "Email Assistant",
    description: "Read, compose, and manage emails via IMAP/SMTP. Smart filtering and priority inbox.",
    rating: 4.5,
    color: "#f97316",
    category: "Productivity",
    iconType: "mail",
  },
  {
    id: "calendar",
    name: "Calendar",
    description: "Google Calendar integration — view events, create meetings, set reminders, manage availability.",
    rating: 4.7,
    color: "#3b82f6",
    category: "Productivity",
    iconType: "calendar",
  },
  {
    id: "web-scraper",
    name: "Web Scraper",
    description: "Extract data from websites. Supports pagination, authentication, and structured output.",
    rating: 4.4,
    color: "#14b8a6",
    category: "Utilities",
    iconType: "globe",
  },
  {
    id: "docker-manager",
    name: "Docker",
    description: "Manage Docker containers, images, networks, and compose stacks from natural language.",
    rating: 4.6,
    color: "#2563eb",
    category: "Development",
    iconType: "box",
  },
  {
    id: "telegram-bot",
    name: "Telegram Bot",
    description: "Build and manage Telegram bots. Handle messages, callbacks, inline queries, and media.",
    rating: 4.5,
    color: "#0ea5e9",
    category: "Communication",
    iconType: "chat",
  },
];

interface AppStoreProps {
  installedAppIds: string[];
  onInstall: (app: StoreApp) => void;
  onUninstall: (appId: string) => void;
}

export default function AppStore({ installedAppIds, onInstall, onUninstall }: AppStoreProps) {
  const [search, setSearch] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("All");

  const categories = ["All", ...Array.from(new Set(STORE_APPS.map((a) => a.category)))];

  const filtered = STORE_APPS.filter((app) => {
    const matchesSearch =
      app.name.toLowerCase().includes(search.toLowerCase()) ||
      app.description.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = category === "All" || app.category === category;
    return matchesSearch && matchesCategory;
  });

  const handleInstall = (app: StoreApp) => {
    setInstallingId(app.id);
    setTimeout(() => {
      onInstall(app);
      setInstallingId(null);
    }, 600);
  };

  return (
    <div className="h-full flex flex-col bg-[#0f1219] text-white">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-[#22c55e] flex items-center justify-center">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 01-8 0" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold">ClawBox App Store</h1>
            <p className="text-xs text-white/50">Powered by ClawHub — 500+ AI Skills</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-9 pr-3 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/20"
          />
        </div>

        {/* Categories */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                category === cat
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
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((app) => {
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
                  {/* App Icon */}
                  <div
                    className="w-12 h-12 shrink-0 rounded-xl flex items-center justify-center text-white font-bold text-lg"
                    style={{ backgroundColor: app.color }}
                  >
                    {app.name[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-medium text-sm truncate">{app.name}</h3>
                        <span className="text-xs text-white/40">{app.category}</span>
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

        {filtered.length === 0 && (
          <div className="text-center py-12 text-white/40">
            <p className="text-sm">No apps found</p>
            <a
              href="https://clawhub.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#22c55e] hover:underline mt-1 inline-block"
            >
              Browse more on ClawHub →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export { STORE_APPS as storeApps };
export type { StoreApp };
