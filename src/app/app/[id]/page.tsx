"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { fetchHarness } from "@/lib/client-harness";
import { I18nProvider } from "@/lib/i18n";
import { handoffSettingsSection, STANDALONE_SETTINGS_SECTION_PARAM } from "@/lib/ui-events";

const TerminalApp = dynamic(() => import("@/components/TerminalApp"), { ssr: false });
const CodingAgentApp = dynamic(() => import("@/components/CodingAgentApp"), { ssr: false });
const FilesApp = dynamic(() => import("@/components/FilesApp"), { ssr: false });
const BrowserApp = dynamic(() => import("@/components/BrowserApp"), { ssr: false });
const VNCApp = dynamic(() => import("@/components/VNCApp"), { ssr: false });
const SettingsApp = dynamic(() => import("@/components/SettingsApp"), { ssr: false });
const AppStore = dynamic(() => import("@/components/AppStore"), { ssr: false });
const HermesSkillsStore = dynamic(() => import("@/components/HermesSkillsStore"), { ssr: false });
const MemoryShardApp = dynamic(() => import("@/components/MemoryShardApp"), { ssr: false });

// Apps that exist on only ONE harness. This page is reachable directly
// ("Open in new tab"), so without the same gate the desktop applies, /app/store
// would render the whole OpenClaw App Store on a Hermes device.
const OPENCLAW_ONLY_APP_IDS = ["store", "openclaw", "memory-shard"];
const HERMES_ONLY_APP_IDS = ["hermes-skills"];

const APP_TITLES: Record<string, string> = {
  settings: "Settings",
  terminal: "Terminal",
  coding: "Coding Agent",
  files: "Files",
  browser: "Browser",
  vnc: "Remote Desktop",
  store: "App Store",
  openclaw: "OpenClaw",
  "hermes-skills": "Hermes Skills",
  "memory-shard": "Memory Shard",
};

export default function StandaloneAppPage() {
  const { id } = useParams<{ id: string }>();
  // null while unresolved — a harness-only app must not paint before we know
  // which harness this device actually runs.
  const [harness, setHarness] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // "unknown" rather than a guess: this route is reachable directly (a
    // bookmark, "Open in new tab"), so falling back to "openclaw" rendered the
    // whole OpenClaw App Store on a Hermes box whenever the probe failed.
    void fetchHarness().then((d) => { if (alive) setHarness(d?.active || "unknown"); });
    return () => { alive = false; };
  }, []);

  // `/app/settings?section=…` opens Settings on that section. There is no
  // desktop here to dispatch the open-section event for it, so the section
  // rides in the URL — this is where a link from another standalone page (the
  // Coding Agent's "Settings") lands — and is handed over the same two ways
  // the desktop uses, so it reaches Settings whether it has mounted yet or
  // not: the dynamic import usually resolves after this effect, and reads the
  // pending value; if it beat us, it hears the event.
  useEffect(() => {
    if (id !== "settings") return;
    const section = new URLSearchParams(window.location.search).get(STANDALONE_SETTINGS_SECTION_PARAM);
    if (section) handoffSettingsSection(section);
  }, [id]);

  const renderApp = () => {
    const appId = id ?? "";
    if (OPENCLAW_ONLY_APP_IDS.includes(appId) || HERMES_ONLY_APP_IDS.includes(appId)) {
      if (!harness) {
        return <div className="h-full flex items-center justify-center text-white/40 text-sm">Loading…</div>;
      }
      // An unknown harness hides BOTH sets — fail closed.
      const hidden =
        harness === "hermes"
          ? OPENCLAW_ONLY_APP_IDS
          : harness === "openclaw"
            ? HERMES_ONLY_APP_IDS
            : [...OPENCLAW_ONLY_APP_IDS, ...HERMES_ONLY_APP_IDS];
      if (hidden.includes(appId)) {
        return (
          <div className="h-full flex items-center justify-center text-white/50 text-sm">
            App not found: {appId}
          </div>
        );
      }
    }
    switch (id) {
      case "terminal":
        return <TerminalApp />;
      case "coding":
        return <CodingAgentApp />;
      case "files":
        return <FilesApp />;
      case "memory-shard":
        return <MemoryShardApp />;
      case "browser":
        return <BrowserApp />;
      case "vnc":
        return <VNCApp />;
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
      case "hermes-skills":
        return <HermesSkillsStore />;
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
              // No allow-same-origin: webapps are served from the ClawBox origin,
              // so allow-scripts + allow-same-origin together would give the
              // framed app the REAL origin — letting a malicious/agent-built app
              // fetch() the session-authenticated /setup-api routes and script
              // the parent desktop. Dropping allow-same-origin forces an opaque
              // origin; self-contained webapps still run fine.
              sandbox="allow-scripts allow-forms allow-popups"
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

  // Every app rendered here reads its copy through `t()`. Without a provider
  // `useT()` falls back to returning the KEY, so this route — the one behind
  // "Open in new tab" — painted `skills.facetTrust` and `settings.security.…`
  // at the customer while the desktop showed sentences.
  return (
    <I18nProvider>
      <div className="h-dvh w-full bg-[var(--ground)] text-white flex flex-col">
        {/* Minimal title bar */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[#111827] border-b border-white/10 shrink-0">
          <Image src="/clawbox-logo.png" alt="" width={20} height={20} className="w-5 h-5 rounded" />
          <span className="text-xs font-medium text-white/70">{APP_TITLES[id ?? ""] ?? id}</span>
          <Link href="/" className="ml-auto text-xs text-white/30 hover:text-white/60 no-underline">
            Back to Desktop
          </Link>
        </div>
        {/* App content */}
        <div className="flex-1 overflow-hidden">{renderApp()}</div>
      </div>
    </I18nProvider>
  );
}
