"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { AndroidStatusBar } from "@/components/AndroidStatusBar";
import { AndroidNavBar } from "@/components/AndroidNavBar";
import { FullScreenApp } from "@/components/FullScreenApp";
import SetupWizard from "@/components/SetupWizard";

const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// App icon definitions with inline SVGs
interface AppDef {
  id: string;
  name: string;
  color: string;
  type: "settings" | "openclaw" | "placeholder" | "external";
  url?: string;
}

const apps: AppDef[] = [
  { id: "settings", name: "Settings", color: "#6b7280", type: "settings" },
  { id: "openclaw", name: "OpenClaw", color: "#06b6d4", type: "openclaw" },
  { id: "terminal", name: "Terminal", color: "#22c55e", type: "placeholder" },
  { id: "system", name: "System", color: "#3b82f6", type: "placeholder" },
  { id: "ollama", name: "Ollama", color: "#a855f7", type: "placeholder" },
  { id: "files", name: "Files", color: "#f97316", type: "placeholder" },
  { id: "network", name: "Network", color: "#14b8a6", type: "placeholder" },
  { id: "help", name: "Help", color: "#ec4899", type: "external", url: "https://docs.openclaw.ai" },
  { id: "browser", name: "Browser", color: "#ef4444", type: "placeholder" },
  { id: "camera", name: "Camera", color: "#eab308", type: "placeholder" },
];

// Inline SVG icons for each app
function AppIcon({ id }: { id: string }) {
  const iconClass = "w-7 h-7 text-white";

  switch (id) {
    case "settings":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "openclaw":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
        </svg>
      );
    case "terminal":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
    case "system":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <polyline points="6 10 10 8 14 12 18 7" />
        </svg>
      );
    case "ollama":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z" />
          <path d="M6 10a6 6 0 0 0 12 0" />
          <path d="M12 16v6" />
          <path d="M8 22h8" />
          <circle cx="10" cy="6" r="1" fill="currentColor" />
          <circle cx="14" cy="6" r="1" fill="currentColor" />
        </svg>
      );
    case "files":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "network":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M1.42 9a16 16 0 0 1 21.16 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx="12" cy="20" r="1" fill="currentColor" />
        </svg>
      );
    case "help":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case "browser":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case "camera":
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      );
    default:
      return null;
  }
}

export default function AndroidHomePage() {
  const [activeApp, setActiveApp] = useState<AppDef | null>(null);

  const handleAppClick = (app: AppDef) => {
    if (app.type === "external" && app.url) {
      window.open(app.url, "_blank", "noopener,noreferrer");
    } else {
      setActiveApp(app);
    }
  };

  const handleCloseApp = () => {
    setActiveApp(null);
  };

  const renderAppContent = () => {
    if (!activeApp) return null;

    switch (activeApp.type) {
      case "settings":
        return (
          <div className="h-full overflow-y-auto">
            <SetupWizard />
          </div>
        );
      case "openclaw":
        return (
          <iframe
            src="/"
            className="w-full h-full border-0"
            title="OpenClaw Control"
          />
        );
      case "placeholder":
        return (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-white/60">
            <div
              className="w-20 h-20 rounded-[20px] flex items-center justify-center"
              style={{ backgroundColor: activeApp.color }}
            >
              <AppIcon id={activeApp.id} />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-medium text-white/80 mb-1">
                {activeApp.name}
              </h2>
              <p className="text-sm">Coming Soon</p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Dark gradient wallpaper background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e] z-0" />
      <div className="absolute inset-0 bg-stars z-0" />
      <div className="absolute inset-0 bg-nebula z-0" />

      {/* Status bar */}
      <AndroidStatusBar />

      {/* Main content area */}
      <main className="relative z-10 flex-1 flex flex-col pt-10 pb-12 px-4">
        {/* Google-style search pill */}
        <div className="mt-4 mb-8 mx-auto w-full max-w-md">
          <div className="flex items-center gap-3 h-12 px-4 bg-white/10 backdrop-blur-sm rounded-full border border-white/10">
            <svg
              className="w-5 h-5 text-white/50"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <span className="text-white/40 text-sm">Search...</span>
          </div>
        </div>

        {/* App grid - 4 cols mobile, 5 desktop */}
        <div className="flex-1 flex items-start justify-center">
          <div className="grid grid-cols-4 sm:grid-cols-5 gap-4 sm:gap-6 max-w-lg sm:max-w-xl">
            {apps.map((app) => (
              <button
                key={app.id}
                onClick={() => handleAppClick(app)}
                className="flex flex-col items-center gap-2 p-2 rounded-2xl hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer"
              >
                {/* 56px squircle icon */}
                <div
                  className="w-14 h-14 rounded-[16px] flex items-center justify-center shadow-lg"
                  style={{ backgroundColor: app.color }}
                >
                  <AppIcon id={app.id} />
                </div>
                {/* Label */}
                <span className="text-white text-xs text-center line-clamp-1 w-full">
                  {app.name}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Page indicator dots */}
        <div className="flex items-center justify-center gap-2 mt-4 mb-2">
          <div className="w-2 h-2 rounded-full bg-white/80" />
          <div className="w-2 h-2 rounded-full bg-white/30" />
          <div className="w-2 h-2 rounded-full bg-white/30" />
        </div>
      </main>

      {/* Mascot - only show on home screen */}
      {!activeApp && <Mascot />}

      {/* Navigation bar */}
      <AndroidNavBar onHome={handleCloseApp} />

      {/* Full screen app overlay */}
      {activeApp && (
        <FullScreenApp title={activeApp.name} onClose={handleCloseApp}>
          {renderAppContent()}
        </FullScreenApp>
      )}
    </div>
  );
}
