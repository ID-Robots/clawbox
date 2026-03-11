"use client";

import Link from "next/link";
import Image from "next/image";

interface DesktopIconProps {
  href: string;
  label: string;
  icon: React.ReactNode;
  external?: boolean;
}

function DesktopIcon({ href, label, icon, external }: DesktopIconProps) {
  const className =
    "group flex flex-col items-center gap-2 p-3 rounded-xl transition-all duration-200 hover:bg-white/5 hover:scale-110 cursor-pointer";

  const content = (
    <>
      <div className="w-16 h-16 sm:w-20 sm:h-20 flex items-center justify-center rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] group-hover:border-[var(--coral-bright)] group-hover:shadow-[0_0_20px_var(--shadow-coral-mid)] transition-all duration-200">
        {icon}
      </div>
      <span className="text-xs sm:text-sm text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors text-center max-w-20 truncate">
        {label}
      </span>
    </>
  );

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {content}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}

// Inline SVG Icons
const SettingsIcon = () => (
  <svg
    width="32"
    height="32"
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

const OpenClawIcon = () => (
  <svg
    width="36"
    height="36"
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

const TerminalIcon = () => (
  <svg
    width="32"
    height="32"
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

const SystemMonitorIcon = () => (
  <svg
    width="32"
    height="32"
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

const OllamaIcon = () => (
  <svg
    width="32"
    height="32"
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

const FilesIcon = () => (
  <svg
    width="32"
    height="32"
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

const NetworkIcon = () => (
  <svg
    width="32"
    height="32"
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

const HelpIcon = () => (
  <svg
    width="32"
    height="32"
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

const desktopApps = [
  { href: "/setup/settings", label: "Settings", icon: <SettingsIcon /> },
  { href: "/", label: "OpenClaw", icon: <OpenClawIcon /> },
  { href: "/setup/terminal", label: "Terminal", icon: <TerminalIcon /> },
  { href: "/setup/system", label: "System Monitor", icon: <SystemMonitorIcon /> },
  { href: "/setup/models", label: "Ollama Models", icon: <OllamaIcon /> },
  { href: "/setup/files", label: "Files", icon: <FilesIcon /> },
  { href: "/setup/network", label: "Network", icon: <NetworkIcon /> },
  { href: "https://docs.openclaw.ai", label: "Help", icon: <HelpIcon />, external: true },
];

export default function DesktopPage() {
  return (
    <div className="min-h-screen flex flex-col bg-desktop relative overflow-hidden">
      {/* Wallpaper gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e] z-0" />
      <div className="absolute inset-0 bg-stars z-0" />
      <div className="absolute inset-0 bg-nebula z-0" />

      {/* Header */}
      <header className="relative z-10 px-4 py-3 sm:px-6 sm:py-4 flex items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={36}
            height={36}
            className="w-9 h-9 object-contain"
            priority
          />
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-bold font-display title-gradient">
              ClawBox
            </span>
            <span className="text-[10px] text-green-400 -mt-1">
              {process.env.NEXT_PUBLIC_APP_VERSION}
            </span>
          </div>
        </Link>
        <div className="text-xs text-[var(--text-muted)]">
          {new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
        </div>
      </header>

      {/* Desktop Icon Grid */}
      <main className="relative z-10 flex-1 flex items-start sm:items-center justify-center px-4 py-6 sm:py-8">
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-4 gap-4 sm:gap-6 md:gap-8 max-w-2xl">
          {desktopApps.map((app) => (
            <DesktopIcon
              key={app.href}
              href={app.href}
              label={app.label}
              icon={app.icon}
              external={app.external}
            />
          ))}
        </div>
      </main>

      {/* Taskbar / Dock */}
      <footer className="relative z-10 px-4 py-3 sm:py-4">
        <div className="mx-auto max-w-md">
          <div className="flex items-center justify-center gap-2 px-4 py-2 rounded-2xl bg-[var(--surface-card-strong)] border border-[var(--border-subtle)] backdrop-blur-xl">
            <Link
              href="/"
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] transition transform hover:scale-110 hover:border-[var(--cyan-bright)] hover:shadow-[0_0_12px_rgba(0,229,204,0.3)]"
              title="OpenClaw Control"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--cyan-bright)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="2" fill="var(--cyan-bright)" />
              </svg>
            </Link>
            <Link
              href="/setup/settings"
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] transition transform hover:scale-110 hover:border-[var(--coral-bright)] hover:shadow-[0_0_12px_var(--shadow-coral-mid)]"
              title="Settings"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--coral-bright)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
            <div className="w-px h-6 bg-[var(--border-subtle)]" />
            <a
              href="https://openclawhardware.dev/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="ClawBox website"
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] transition transform hover:scale-110"
              title="ClawBox Website"
            >
              <Image src="/clawbox-logo.png" alt="ClawBox" width={24} height={24} className="w-6 h-6 object-contain" />
            </a>
            <a
              href="https://discord.gg/FbKmnxYnpq"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Join our Discord"
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[#5865F2] transition transform hover:scale-110"
              title="Discord"
            >
              <svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor" aria-hidden="true">
                <path d="M60.1 4.9A58.5 58.5 0 0 0 45.4.2a.2.2 0 0 0-.2.1 40.8 40.8 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A37.4 37.4 0 0 0 25.4.3a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.6 4.9a.2.2 0 0 0-.1.1C1.5 18.7-.9 32.2.3 45.5v.2a58.9 58.9 0 0 0 17.7 9a.2.2 0 0 0 .3-.1 42 42 0 0 0 3.6-5.9.2.2 0 0 0-.1-.3 38.8 38.8 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.9a.2.2 0 0 1 .2 0 42 42 0 0 0 35.8 0 .2.2 0 0 1 .2 0l1.1.9a.2.2 0 0 1 0 .4 36.4 36.4 0 0 1-5.5 2.6.2.2 0 0 0-.1.3 47.2 47.2 0 0 0 3.6 5.9.2.2 0 0 0 .3.1 58.7 58.7 0 0 0 17.7-9 .2.2 0 0 0 .1-.2c1.4-15-2.3-28-9.8-39.6a.2.2 0 0 0-.1 0ZM23.7 37.3c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Zm23.3 0c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Z"/>
              </svg>
            </a>
            <a
              href="https://docs.openclaw.ai"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Documentation"
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] transition transform hover:scale-110"
              title="Help & Docs"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-secondary)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
