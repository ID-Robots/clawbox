"use client";

import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";

const TerminalApp = dynamic(() => import("@/components/TerminalApp"), { ssr: false });
const FilesApp = dynamic(() => import("@/components/FilesApp"), { ssr: false });
const BrowserApp = dynamic(() => import("@/components/BrowserApp"), { ssr: false });
const VNCApp = dynamic(() => import("@/components/VNCApp"), { ssr: false });
const VSCodeApp = dynamic(() => import("@/components/VSCodeApp"), { ssr: false });
const SettingsApp = dynamic(() => import("@/components/SettingsApp"), { ssr: false });
const AppStore = dynamic(() => import("@/components/AppStore"), { ssr: false });

const APP_TITLES: Record<string, string> = {
  settings: "Settings",
  terminal: "Terminal",
  files: "Files",
  browser: "Browser",
  vnc: "Remote Desktop",
  vscode: "VS Code",
  store: "App Store",
  openclaw: "OpenClaw",
};

export default function StandaloneAppPage() {
  const { id } = useParams<{ id: string }>();

  const renderApp = () => {
    switch (id) {
      case "terminal":
        return <TerminalApp />;
      case "files":
        return <FilesApp />;
      case "browser":
        return <BrowserApp />;
      case "vnc":
        return <VNCApp />;
      case "vscode":
        return <VSCodeApp />;
      case "settings":
        return (
          <div className="h-full overflow-y-auto">
            <SettingsApp ui={{
              wallpaperId: "clawbox",
              wpFit: "fill",
              wpBgColor: "#0a0f1a",
              wpOpacity: 100,
              mascotHidden: false,
              wallpapers: [],
              customWallpapers: [],
              onWallpaperChange: () => {},
              onWpFitChange: () => {},
              onWpBgColorChange: () => {},
              onWpOpacityChange: () => {},
              onMascotToggle: () => {},
              onWallpaperUpload: () => {},
              onCustomWallpaperDelete: () => {},
            }} />
          </div>
        );
      case "store":
        return (
          <AppStore
            installedAppIds={[]}
            onInstall={() => {}}
            onUninstall={() => {}}
          />
        );
      case "openclaw":
        return (
          <iframe
            src="/chat"
            style={{ width: "100%", height: "100%", border: "none" }}
            title="OpenClaw"
          />
        );
      default:
        // Try as webapp
        if (id?.startsWith("installed-")) {
          return (
            <iframe
              src={`/setup-api/webapps?app=${encodeURIComponent(id.replace("installed-", ""))}`}
              style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              title={id}
            />
          );
        }
        return (
          <div className="h-full flex items-center justify-center text-white/50 text-sm">
            App not found: {id}
          </div>
        );
    }
  };

  return (
    <div className="h-dvh w-full bg-[#0a0f1a] text-white flex flex-col">
      {/* Minimal title bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#111827] border-b border-white/10 shrink-0">
        <img src="/clawbox-logo.png" alt="" className="w-5 h-5 rounded" />
        <span className="text-xs font-medium text-white/70">{APP_TITLES[id ?? ""] ?? id}</span>
        <Link href="/" className="ml-auto text-xs text-white/30 hover:text-white/60 no-underline">
          Back to Desktop
        </Link>
      </div>
      {/* App content */}
      <div className="flex-1 overflow-hidden">
        {renderApp()}
      </div>
    </div>
  );
}
