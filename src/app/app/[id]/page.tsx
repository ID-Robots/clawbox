"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { fetchHarness } from "@/lib/client-harness";
import { apps } from "@/lib/desktop-apps";
import { I18nProvider, useT } from "@/lib/i18n";
import { handoffSettingsSection, STANDALONE_SETTINGS_SECTION_PARAM } from "@/lib/ui-events";
import { WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";
import { attachWebappKvBridge } from "@/lib/webapp-kv-bridge";
import type { InstalledMeta } from "@/lib/store-categories";
import { HARNESS_ONLY_APP_IDS, hiddenAppIdsForHarness } from "@/lib/desktop-app-editions";
import type { StoreApp } from "@/components/AppStore";
import InstalledAppIcon from "@/components/InstalledAppIcon";

const TerminalTabs = dynamic(() => import("@/components/TerminalTabs"), { ssr: false });
const ChatApp = dynamic(() => import("@/components/ChatApp"), { ssr: false });
const ClawKeepApp = dynamic(() => import("@/components/ClawKeepApp"), { ssr: false });
const SystemUpdateApp = dynamic(() => import("@/components/SystemUpdateApp"), { ssr: false });
const SetupWizard = dynamic(() => import("@/components/SetupWizard"), { ssr: false });
const InstalledAppSettings = dynamic(() => import("@/components/InstalledAppSettings"), { ssr: false });
const CodingAgentApp = dynamic(() => import("@/components/CodingAgentApp"), { ssr: false });
const FilesApp = dynamic(() => import("@/components/FilesApp"), { ssr: false });
const BrowserApp = dynamic(() => import("@/components/BrowserApp"), { ssr: false });
const VNCApp = dynamic(() => import("@/components/VNCApp"), { ssr: false });
const SettingsApp = dynamic(() => import("@/components/SettingsApp"), { ssr: false });
const AppStore = dynamic(() => import("@/components/AppStore"), { ssr: false });
const HermesSkillsStore = dynamic(() => import("@/components/HermesSkillsStore"), { ssr: false });
const MemoryShardApp = dynamic(() => import("@/components/MemoryShardApp"), { ssr: false });


// This window is the same app the desktop shows, so its title comes from the
// SAME registry rather than a second table of names — which is what it used to
// be, in English, while the desktop translated. `setup` is the one id this
// route hosts that the static registry does not carry: the desktop appends it
// in `getAllApps()` (src/app/page.tsx) because it is not an icon you can pin.
const APP_TITLES: Record<string, string> = {
  ...Object.fromEntries(apps.map((a) => [a.id, a.name])),
  setup: "app.setup",
};

/**
 * The title bar renders INSIDE `I18nProvider`, because the provider is this
 * page's own child: `useT()` in `StandaloneAppPage` would see no provider above
 * it and echo the key back.
 *
 * Only a built-in's name is a translation key. An installed app's name is copy
 * from the store catalogue and an unknown id is the raw URL segment — neither
 * goes through `t()`, or a webapp the agent registered as `search` would be
 * titled with the "Search..." button label.
 */
function StandaloneTitle({ nameKey, literal }: { nameKey?: string; literal?: string }) {
  const { t } = useT();
  const text = literal ?? (nameKey ? t(nameKey) || nameKey : "");
  return <span className="text-xs font-medium text-white/70">{text}</span>;
}

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

  // Hermes is an external dashboard rather than a React app. The desktop
  // opens it directly on the auth-proxy port; the standalone route behind
  // shelf/desktop "Open in new tab" must do the same instead of rendering an
  // "App not found" dead end.
  useEffect(() => {
    if (id !== "hermes" || harness !== "hermes") return;
    window.location.replace(`${window.location.protocol}//${window.location.hostname}:8090/`);
  }, [harness, id]);

  // An installed app's id says nothing about what it is. The desktop decides
  // from installed_meta (getAllApps in page.tsx): a webapp is framed, a store
  // skill opens its settings window. This page reads the same key, so a
  // bookmark or "Open in new tab" lands on what the desktop shows. It used to
  // frame every `installed-*` id as a webapp, which for a skill painted a 404
  // in an empty frame under its raw id.
  const installedId = id?.startsWith("installed-") ? id.slice("installed-".length) : null;
  const [installedMeta, setInstalledMeta] = useState<Record<string, InstalledMeta> | null>(null);
  useEffect(() => {
    if (!installedId) return;
    let alive = true;
    fetch("/setup-api/preferences?keys=installed_meta")
      .then((r) => r.json())
      .then((data: { installed_meta?: unknown }) => {
        if (!alive) return;
        const meta = data?.installed_meta;
        setInstalledMeta(meta && typeof meta === "object" ? (meta as Record<string, InstalledMeta>) : {});
      })
      .catch(() => { if (alive) setInstalledMeta({}); });
    return () => { alive = false; };
  }, [installedId]);

  // Answers the KV requests a framed webapp posts — see src/lib/webapp-kv-bridge.ts.
  useEffect(() => attachWebappKvBridge(), []);

  const loading = <div className="h-full flex items-center justify-center text-white/40 text-sm">Loading…</div>;
  const notFound = (
    <div className="h-full flex items-center justify-center text-white/50 text-sm">
      App not found: {id}
    </div>
  );

  const renderInstalledApp = (appId: string) => {
    if (!installedMeta) return loading;
    const meta = installedMeta[appId];
    // Fail closed, like the harness gate below: a stale or unknown id shows
    // the same "not found" as any other, never an empty frame.
    if (!meta) return notFound;
    if (meta.webappUrl) {
      // http(s) or a same-origin path only — the desktop's rule, so a
      // `javascript:` URL in an installed app's meta cannot run here either.
      let src = "about:blank";
      try {
        const u = new URL(meta.webappUrl, window.location.origin);
        if (["http:", "https:"].includes(u.protocol)) src = u.href;
      } catch {}
      return (
        <iframe
          src={src}
          style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          // The one sandbox both pages use; never allow-same-origin — see
          // src/lib/webapp-sandbox.ts for what the frame would otherwise reach.
          sandbox={WEBAPP_IFRAME_SANDBOX}
          data-webapp-id={appId}
          title={meta.name}
        />
      );
    }
    // A store skill. Its window shells out to the openclaw binary, which a
    // Hermes box does not have — the desktop's isInstalledAppVisible gate.
    if (!harness) return loading;
    if (harness === "hermes") return notFound;
    const storeApp: StoreApp = { id: appId, name: meta.name, description: "", rating: 0, color: meta.color, category: "", iconUrl: meta.iconUrl, developer: meta.developer };
    return (
      <InstalledAppSettings
        appId={appId}
        storeApp={storeApp}
        icon={<InstalledAppIcon appId={appId} iconUrl={meta.iconUrl} name={meta.name} size="w-12 h-12" />}
        // The uninstall confirmation belongs to the desktop's window manager,
        // which this page has none of — the same no-op the standalone store
        // hands its install and uninstall.
        onUninstall={() => {}}
      />
    );
  };

  const renderApp = () => {
    const appId = id ?? "";
    // Apps that exist on only ONE harness. This page is reachable directly
    // ("Open in new tab"), so without the same gate the desktop applies,
    // /app/store would render the whole OpenClaw App Store on a Hermes device.
    // Only these ids wait on the harness fetch; `settings` and `files` render
    // straight away.
    if (HARNESS_ONLY_APP_IDS.includes(appId)) {
      if (!harness) return loading;
      // An unknown harness hides BOTH sets — fail closed.
      if (hiddenAppIdsForHarness(harness).includes(appId)) {
        return (
          <div className="h-full flex items-center justify-center text-white/50 text-sm">
            App not found: {appId}
          </div>
        );
      }
    }
    switch (id) {
      case "clawbox":
        return <ChatApp />;
      case "clawkeep":
        return <ClawKeepApp />;
      case "system_update":
        return <SystemUpdateApp />;
      case "setup":
        return <SetupWizard />;
      case "hermes":
        return loading;
      case "terminal":
        return <TerminalTabs />;
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
        if (installedId) return renderInstalledApp(installedId);
        return notFound;
    }
  };

  const titleKey = installedId ? undefined : APP_TITLES[id ?? ""];
  const titleLiteral = installedId
    ? (installedMeta?.[installedId]?.name ?? installedId)
    : (titleKey ? undefined : id);

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
          <StandaloneTitle nameKey={titleKey} literal={titleLiteral} />
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
