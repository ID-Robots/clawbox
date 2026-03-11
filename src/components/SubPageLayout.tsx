"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ReactNode } from "react";

interface SubPageLayoutProps {
  title: string;
  children: ReactNode;
  /** If true, children manage their own background/layout (for full-page content like SetupWizard) */
  fullPage?: boolean;
}

export default function SubPageLayout({ title, children, fullPage = false }: SubPageLayoutProps) {
  const router = useRouter();

  const handleBack = () => {
    router.push("/setup");
  };

  if (fullPage) {
    // Floating navigation overlay for full-page content
    return (
      <div className="animate-page-in">
        {/* Floating back button */}
        <div className="fixed top-3 left-4 z-50 sm:top-4 sm:left-6">
          <button
            onClick={handleBack}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface-card-strong)] border border-[var(--border-subtle)] backdrop-blur-xl transition-all duration-200 hover:border-[var(--coral-bright)] hover:shadow-[0_0_12px_var(--shadow-coral-mid)] active:scale-95"
            aria-label="Go back to home"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-secondary)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
            <span className="text-sm text-[var(--text-secondary)]">{title}</span>
          </button>
        </div>

        {/* Content */}
        {children}

        {/* iOS-style home indicator */}
        <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center pb-2 pt-4 pointer-events-none">
          <Link
            href="/setup"
            className="pointer-events-auto w-32 h-1.5 rounded-full bg-white/20 hover:bg-white/40 transition-all duration-200 hover:w-36 active:scale-95"
            aria-label="Go to home screen"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-desktop relative overflow-hidden animate-page-in">
      {/* Wallpaper gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0f1a] via-[#111827] to-[#1a1f2e] z-0" />
      <div className="absolute inset-0 bg-stars z-0" />
      <div className="absolute inset-0 bg-nebula z-0" />

      {/* Header with back button */}
      <header className="relative z-10 px-4 py-3 sm:px-6 sm:py-4 flex items-center gap-3">
        <button
          onClick={handleBack}
          className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-subtle)] transition-all duration-200 hover:border-[var(--coral-bright)] hover:shadow-[0_0_12px_var(--shadow-coral-mid)] active:scale-95"
          aria-label="Go back to home"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-secondary)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-colors"
          >
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold text-[var(--text-primary)] font-display">
          {title}
        </h1>
      </header>

      {/* Main content area */}
      <main className="relative z-10 flex-1 overflow-auto px-4 pb-20">
        {children}
      </main>

      {/* iOS-style home indicator */}
      <div className="fixed bottom-0 left-0 right-0 z-20 flex justify-center pb-2 pt-4 pointer-events-none">
        <Link
          href="/setup"
          className="pointer-events-auto w-32 h-1.5 rounded-full bg-white/20 hover:bg-white/40 transition-all duration-200 hover:w-36 active:scale-95"
          aria-label="Go to home screen"
        />
      </div>
    </div>
  );
}
