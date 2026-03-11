"use client";

import Image from "next/image";
import type { WindowState } from "@/hooks/useWindows";

interface TaskbarProps {
  windows: WindowState[];
  onWindowClick: (id: string) => void;
  onExternalLink: (url: string) => void;
}

export default function Taskbar({ windows, onWindowClick, onExternalLink }: TaskbarProps) {
  const openWindows = windows.filter((w) => !w.isClosing);

  return (
    <footer className="relative z-[9999] px-4 py-3 sm:py-4">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-center gap-2 px-4 py-2 rounded-2xl bg-[var(--surface-card-strong)] border border-[var(--border-subtle)] backdrop-blur-xl">
          {/* Open windows section */}
          {openWindows.length > 0 && (
            <>
              {openWindows.map((win) => (
                <button
                  key={win.id}
                  onClick={() => onWindowClick(win.id)}
                  className={`relative flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border transition transform hover:scale-110 ${
                    win.isMinimized
                      ? "border-[var(--border-subtle)] opacity-60"
                      : "border-[var(--coral-bright)] shadow-[0_0_12px_var(--shadow-coral-mid)]"
                  }`}
                  title={win.title}
                >
                  <span className="w-5 h-5 flex items-center justify-center [&_svg]:w-5 [&_svg]:h-5">
                    {win.icon}
                  </span>
                  {/* Active indicator dot */}
                  <span
                    className={`absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full transition-all ${
                      win.isMinimized ? "bg-[var(--text-muted)]" : "bg-[var(--coral-bright)]"
                    }`}
                  />
                </button>
              ))}
              <div className="w-px h-6 bg-[var(--border-subtle)]" />
            </>
          )}

          {/* External links */}
          <button
            onClick={() => onExternalLink("https://openclawhardware.dev/")}
            aria-label="ClawBox website"
            className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] transition transform hover:scale-110"
            title="ClawBox Website"
          >
            <Image
              src="/clawbox-logo.png"
              alt="ClawBox"
              width={24}
              height={24}
              className="w-6 h-6 object-contain"
            />
          </button>
          <button
            onClick={() => onExternalLink("https://discord.gg/FbKmnxYnpq")}
            aria-label="Join our Discord"
            className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[#5865F2] transition transform hover:scale-110"
            title="Discord"
          >
            <svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor" aria-hidden="true">
              <path d="M60.1 4.9A58.5 58.5 0 0 0 45.4.2a.2.2 0 0 0-.2.1 40.8 40.8 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A37.4 37.4 0 0 0 25.4.3a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.6 4.9a.2.2 0 0 0-.1.1C1.5 18.7-.9 32.2.3 45.5v.2a58.9 58.9 0 0 0 17.7 9a.2.2 0 0 0 .3-.1 42 42 0 0 0 3.6-5.9.2.2 0 0 0-.1-.3 38.8 38.8 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.9a.2.2 0 0 1 .2 0 42 42 0 0 0 35.8 0 .2.2 0 0 1 .2 0l1.1.9a.2.2 0 0 1 0 .4 36.4 36.4 0 0 1-5.5 2.6.2.2 0 0 0-.1.3 47.2 47.2 0 0 0 3.6 5.9.2.2 0 0 0 .3.1 58.7 58.7 0 0 0 17.7-9 .2.2 0 0 0 .1-.2c1.4-15-2.3-28-9.8-39.6a.2.2 0 0 0-.1 0ZM23.7 37.3c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Zm23.3 0c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7Z" />
            </svg>
          </button>
          <button
            onClick={() => onExternalLink("https://docs.openclaw.ai")}
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
          </button>
        </div>
      </div>
    </footer>
  );
}
