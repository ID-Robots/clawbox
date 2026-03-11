"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useWindows, type WindowConfig } from "@/hooks/useWindows";
import Window from "@/components/Window";
import Taskbar from "@/components/Taskbar";

const Mascot = dynamic(() => import("@/components/Mascot"), { ssr: false });

// Inline SVG Icons
const SettingsIcon = ({ size = 32 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--coral-bright)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="group-hover:rotate-45 transition-transform duration-300"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const OpenClawIcon = ({ size = 36 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--cyan-bright)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
    <circle cx="12" cy="12" r="2" fill="var(--cyan-bright)" />
  </svg>
);

const TerminalIcon = ({ size = 32 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--text-secondary)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="group-hover:stroke-[var(--cyan-bright)] transition-colors"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const SystemMonitorIcon = ({ size = 32 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--text-secondary)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="group-hover:stroke-green-400 transition-colors"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
    <polyline points="6 10 10 8 14 12 18 7" />
  </svg>
);

const OllamaIcon = ({ size = 32 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--text-secondary)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="group-hover:stroke-purple-400 transition-colors"
  >
    <path d="M12 2a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z" />
    <path d="M6 10a6 6 0 0 0 12 0" />
    <path d="M12 16v6" />
    <path d="M8 22h8" />
    <circle cx="10" cy="6" r="1" fill="var(--text-secondary)" className="group-hover:fill-purple-400" />
    <circle cx="14" cy="6" r="1" fill="var(--text-secondary)" className="group-hover:fill-purple-400" />
  </svg>
);

const FilesIcon = ({ size = 32 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--text-secondary)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="group-hover:stroke-yellow-400 transition-colors"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

const NetworkIcon = ({ size = 32 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--text-secondary)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="group-hover:stroke-blue-400 transition-colors"
  >
    <path d="M5 12.55a11 11 0 0 1 14.08 0" />
    <path d="M1.42 9a16 16 0 0 1 21.16 0" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <circle cx="12" cy="20" r="1" fill="var(--text-secondary)" className="group-hover:fill-blue-400" />
  </svg>
);

const HelpIcon = ({ size = 32 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--text-secondary)"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="group-hover:stroke-[var(--coral-bright)] transition-colors"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

// Desktop app definitions
interface DesktopApp {
  id: string;
  label: string;
  icon: React.ReactNode;
  iconSmall: React.ReactNode;
  action: "window" | "external";
  windowConfig?: Omit<WindowConfig, "icon">;
  externalUrl?: string;
}

const desktopApps: DesktopApp[] = [
  {
    id: "settings",
    label: "Settings",
    icon: <SettingsIcon />,
    iconSmall: <SettingsIcon size={16} />,
    action: "window",
    windowConfig: {
      appId: "settings",
      title: "Settings",
      defaultWidth: 800,
      defaultHeight: 600,
      minWidth: 400,
      minHeight: 400,
      content: "settings",
    },
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    icon: <OpenClawIcon />,
    iconSmall: <OpenClawIcon size={16} />,
    action: "window",
    windowConfig: {
      appId: "openclaw",
      title: "OpenClaw Control",
      defaultWidth: 900,
      defaultHeight: 700,
      minWidth: 500,
      minHeight: 400,
      content: "openclaw",
    },
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: <TerminalIcon />,
    iconSmall: <TerminalIcon size={16} />,
    action: "window",
    windowConfig: {
      appId: "terminal",
      title: "Terminal",
      defaultWidth: 700,
      defaultHeight: 500,
      content: "placeholder",
    },
  },
  {
    id: "system",
    label: "System Monitor",
    icon: <SystemMonitorIcon />,
    iconSmall: <SystemMonitorIcon size={16} />,
    action: "window",
    windowConfig: {
      appId: "system",
      title: "System Monitor",
      defaultWidth: 600,
      defaultHeight: 450,
      content: "placeholder",
    },
  },
  {
    id: "models",
    label: "Ollama Models",
    icon: <OllamaIcon />,
    iconSmall: <OllamaIcon size={16} />,
    action: "window",
    windowConfig: {
      appId: "models",
      title: "Ollama Models",
      defaultWidth: 700,
      defaultHeight: 500,
      content: "placeholder",
    },
  },
  {
    id: "files",
    label: "Files",
    icon: <FilesIcon />,
    iconSmall: <FilesIcon size={16} />,
    action: "window",
    windowConfig: {
      appId: "files",
      title: "Files",
      defaultWidth: 800,
      defaultHeight: 550,
      content: "placeholder",
    },
  },
  {
    id: "network",
    label: "Network",
    icon: <NetworkIcon />,
    iconSmall: <NetworkIcon size={16} />,
    action: "window",
    windowConfig: {
      appId: "network",
      title: "Network",
      defaultWidth: 600,
      defaultHeight: 450,
      content: "placeholder",
    },
  },
  {
    id: "help",
    label: "Help",
    icon: <HelpIcon />,
    iconSmall: <HelpIcon size={16} />,
    action: "external",
    externalUrl: "https://docs.openclaw.ai",
  },
];

interface DesktopIconProps {
  app: DesktopApp;
  onClick: () => void;
}

function DesktopIcon({ app, onClick }: DesktopIconProps) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center gap-2 p-3 rounded-xl transition-all duration-200 hover:bg-white/5 hover:scale-110 cursor-pointer"
    >
      <div className="w-16 h-16 sm:w-20 sm:h-20 flex items-center justify-center rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] group-hover:border-[var(--coral-bright)] group-hover:shadow-[0_0_20px_var(--shadow-coral-mid)] transition-all duration-200">
        {app.icon}
      </div>
      <span className="text-xs sm:text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors text-center max-w-20 truncate">
        {app.label}
      </span>
    </button>
  );
}

export default function DesktopPage() {
  const {
    windows,
    openWindow,
    closeWindow,
    finishClosing,
    finishOpening,
    minimizeWindow,
    maximizeWindow,
    restoreWindow,
    focusWindow,
    moveWindow,
    resizeWindow,
  } = useWindows();

  const handleAppClick = (app: DesktopApp) => {
    if (app.action === "external" && app.externalUrl) {
      window.open(app.externalUrl, "_blank", "noopener,noreferrer");
    } else if (app.action === "window" && app.windowConfig) {
      openWindow({
        ...app.windowConfig,
        icon: app.iconSmall,
      });
    }
  };

  const handleTaskbarWindowClick = (id: string) => {
    const win = windows.find((w) => w.id === id);
    if (win?.isMinimized) {
      restoreWindow(id);
    } else {
      focusWindow(id);
    }
  };

  const handleExternalLink = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // Get app by appId for window content lookup
  const getAppByAppId = (appId: string) => desktopApps.find((a) => a.id === appId);

  return (
    <div className="min-h-screen flex flex-col bg-desktop relative overflow-hidden">
      {/* Wallpaper gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e] z-0" />
      <div className="absolute inset-0 bg-stars z-0" />
      <div className="absolute inset-0 bg-nebula z-0" />

      {/* Header */}
      <header className="relative z-10 px-4 py-3 sm:px-6 sm:py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={36}
            height={36}
            className="w-9 h-9 object-contain"
            priority
          />
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-bold font-display title-gradient">ClawBox</span>
            <span className="text-[10px] text-green-400 -mt-1">
              {process.env.NEXT_PUBLIC_APP_VERSION}
            </span>
          </div>
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          {new Date().toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </div>
      </header>

      {/* Desktop Icon Grid */}
      <main className="relative z-10 flex-1 flex items-start sm:items-center justify-center px-4 py-6 sm:py-8">
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-4 gap-4 sm:gap-6 md:gap-8 max-w-2xl">
          {desktopApps.map((app) => (
            <DesktopIcon key={app.id} app={app} onClick={() => handleAppClick(app)} />
          ))}
        </div>
      </main>

      {/* Windows Layer */}
      <div className="fixed inset-0 pointer-events-none z-50">
        {windows.map((win) => {
          const app = getAppByAppId(win.appId);
          return (
            <div key={win.id} className="pointer-events-auto">
              <Window
                window={win}
                content={app?.windowConfig?.content ?? "placeholder"}
                onClose={closeWindow}
                onMinimize={minimizeWindow}
                onMaximize={maximizeWindow}
                onFocus={focusWindow}
                onMove={moveWindow}
                onResize={resizeWindow}
                onFinishClosing={finishClosing}
                onFinishOpening={finishOpening}
              />
            </div>
          );
        })}
      </div>

      {/* Mascot */}
      <Mascot />

      {/* Taskbar / Dock */}
      <Taskbar
        windows={windows}
        onWindowClick={handleTaskbarWindowClick}
        onExternalLink={handleExternalLink}
      />
    </div>
  );
}
