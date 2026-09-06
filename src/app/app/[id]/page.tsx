"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { fetchHarness } from "@/lib/client-harness";
import { customWallpaperId, wallpaperIdAfterDelete } from "@/lib/custom-wallpapers";
import {
  brandingHarness,
  brandWallpaperId,
  builtinWallpapers,
  renderedWallpaperId as resolveRenderedWallpaperId,
} from "@/lib/builtin-wallpapers";
import { apps } from "@/lib/desktop-apps";
import { I18nProvider, useT } from "@/lib/i18n";
import { handoffSettingsSection, STANDALONE_SETTINGS_SECTION_PARAM } from "@/lib/ui-events";
import { isProxiedAppUrl, WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";
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

type WpFit = "fill" | "fit" | "center";

/**
 * The localStorage key the uploaded wallpapers live under. It MUST be the same
 * string the desktop uses: the desktop and this page are one origin, so a
 * wallpaper added on either is the same list.
 *
 * The BUILT-IN list used to be mirrored here too, with a comment asking for the
 * two copies to be kept in step by hand. It is `builtinWallpapers()` on both
 * surfaces now — the list is edition-scoped, and a rule applied in two places
 * is a rule that will be applied in one.
 */
const CUSTOM_WPS_KEY = "clawbox-custom-wallpapers";

/** The wallpapers this browser was given by hand. Read where the state is
 *  initialised rather than from an effect: it is a value on disk, not a
 *  subscription, and there is no first paint to correct. */
function readCustomWallpapers(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const saved = window.localStorage.getItem(CUSTOM_WPS_KEY);
    const parsed = saved ? JSON.parse(saved) : null;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * One debounced POST per key set, and nothing at all before the device's own
 * values have been read — the desktop's `usePreferenceWriter` rule, for the
 * same two reasons: the opacity slider fires on every pixel, and writing the
 * defaults this page starts at would erase what the box actually holds. It is
 * a second copy because the desktop's lives inside src/app/page.tsx.
 */
function usePreferenceSaver(loadedRef: { current: boolean }) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);
  return useCallback((body: Record<string, unknown>, slotKey?: string) => {
    if (!loadedRef.current) return;
    // An explicit slot where the body's SHAPE changes over the life of the page
    // — see the desktop's copy.
    const slot = slotKey ?? Object.keys(body).join(",");
    const pending = timers.current.get(slot);
    if (pending) clearTimeout(pending);
    timers.current.set(slot, setTimeout(() => {
      timers.current.delete(slot);
      fetch("/setup-api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    }, 500));
  }, [loadedRef]);
}

/**
 * Appearance, on the page that IS Settings for a phone.
 *
 * This route used to hand `SettingsApp` a table of hard-coded defaults and
 * seven `() => {}` handlers, so /app/settings showed no wallpapers, 100%
 * opacity and the mascot on whatever the device actually had, and every
 * control on the card was dead. The state here is the SAME preferences the
 * desktop reads and writes (`wp_id`, `wp_fit`, `wp_bg_color`, `wp_opacity`,
 * `ui_mascot_hidden`) and the same uploaded-wallpaper list, so a change made
 * from a phone is the change the desktop would have made.
 */
function useAppearance(enabled: boolean, wallpaperHarness: string | null) {
  // The built-ins this EDITION offers, and — painted vs persisted, exactly as
  // on the desktop — what a box with nothing showable selected falls back to.
  // `wallpaperHarness` is null until the device has named an edition, and then
  // there is no brand to fall back to and none to write.
  const wallpapers = builtinWallpapers(wallpaperHarness);
  const persistableFallbackWallpaperId = brandWallpaperId(wallpaperHarness);
  // Null until something has chosen one — see the desktop's copy of this.
  const [wallpaperId, setWallpaperId] = useState<string | null>(null);
  const [wpFit, setWpFit] = useState<WpFit>("fill");
  const [wpBgColor, setWpBgColor] = useState("#000000");
  const [wpOpacity, setWpOpacity] = useState(50);
  const [mascotHidden, setMascotHidden] = useState(false);
  const [customWallpapers, setCustomWallpapers] = useState<string[]>(readCustomWallpapers);
  const uploadRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  // The read has answered. A STATE flag rather than the ref alone, because the
  // ref has to be armed one commit later than the values it guards — see the
  // arming effect at the foot of this hook.
  const [hydrated, setHydrated] = useState(false);
  // The upload's FileReader callback runs after the render that added the
  // previous picture, so the next list is computed from a mirror rather than
  // from the state this closure captured — the desktop's rule, and the reason
  // both writers go through `applyCustomWallpapers`.
  const customRef = useRef<string[]>(customWallpapers);
  const applyCustomWallpapers = useCallback((next: string[]) => {
    customRef.current = next;
    setCustomWallpapers(next);
  }, []);
  // The STORED list is the OUTCOME of an upload or a delete, so it is written
  // first and its failure is the whole operation's — the desktop's rule, and
  // the same reasoning: it is what the next load paints and `wp_id` is a
  // box-wide position into it, so moving the card over a list that never
  // changed leaves a DIFFERENT picture on screen after a reload. There is no
  // toast surface on this route (ToastHost is the desktop's), and the picture
  // staying put is the honest answer: the operation did not happen.
  const storeCustomWallpapers = useCallback((next: string[]) => {
    try {
      localStorage.setItem(CUSTOM_WPS_KEY, JSON.stringify(next));
    } catch {
      return false;
    }
    applyCustomWallpapers(next);
    return true;
  }, [applyCustomWallpapers]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/setup-api/preferences?keys=wp_id,wp_fit,wp_bg_color,wp_opacity,ui_mascot_hidden")
      .then((r) => r.json())
      .then((data: Record<string, unknown>) => {
        if (!alive) return;
        if (data.wp_id) setWallpaperId(String(data.wp_id));
        if (data.wp_fit) setWpFit(data.wp_fit as WpFit);
        if (data.wp_bg_color) setWpBgColor(String(data.wp_bg_color));
        if (data.wp_opacity !== undefined && data.wp_opacity !== null) {
          const opacity = parseInt(String(data.wp_opacity), 10);
          if (Number.isFinite(opacity)) setWpOpacity(opacity);
        }
        setMascotHidden(Boolean(data.ui_mascot_hidden));
      })
      // Either way the card is now showing this device, so it may be written
      // to: a box whose preferences endpoint blinked must still be settable.
      .finally(() => { if (alive) setHydrated(true); });
    return () => { alive = false; };
  }, [enabled]);

  // This browser's list is read synchronously into the state above, so it is
  // never "not read yet" here — the desktop's third argument is what carries
  // that case.
  const renderedWallpaperId = resolveRenderedWallpaperId(
    wallpaperId,
    wallpaperHarness,
    customWallpapers.length,
  );

  const save = usePreferenceSaver(loaded);
  useEffect(() => {
    // `wp_id` is left out while nothing has chosen one — the desktop's rule and
    // for the same reason: this page must not pick a wallpaper box-wide for a
    // box whose edition it could not read. One slot for both shapes.
    const appearance = { wp_fit: wpFit, wp_bg_color: wpBgColor, wp_opacity: wpOpacity };
    save(wallpaperId === null ? appearance : { ...appearance, wp_id: wallpaperId }, "appearance");
  }, [wallpaperId, wpFit, wpBgColor, wpOpacity, save]);
  useEffect(() => { save({ ui_mascot_hidden: mascotHidden ? 1 : 0 }); }, [mascotHidden, save]);
  // Declared AFTER both save effects, deliberately. `loaded.current = true`
  // used to be set in the fetch's own `.finally`, which runs before React has
  // committed the state the `.then` above it queued — so the commit that lands
  // the box's values found the writer already armed and posted them straight
  // back. A response that omits a key leaves that key's state at this page's
  // default, and the echo then wrote the default over what the box holds
  // (an older server, or a partial answer, silently reset the fit and the
  // opacity the moment /app/settings opened). Effects run in declaration
  // order, so the two above see `loaded.current === false` for that one
  // commit; arming here leaves every later change — the owner's — saved.
  useEffect(() => { if (hydrated) loaded.current = true; }, [hydrated]);

  const onUploadFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const next = [...customRef.current, reader.result as string];
      // The picture is not there to be selected unless it was stored.
      if (!storeCustomWallpapers(next)) return;
      setWallpaperId(customWallpaperId(next.length - 1));
      setWpOpacity(100);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, [storeCustomWallpapers]);

  return {
    uploadRef,
    onUploadFile,
    ui: {
      // What is on screen, not what the box holds. `wp_id` is box-wide and the
      // pictures are this browser's, so a `custom-<n>` a phone cannot answer
      // is the laptop's selection, still valid there — the card shows the
      // fallback and leaves the box's own value alone. Only an explicit choice
      // below ever writes it.
      wallpaperId: renderedWallpaperId,
      wpFit,
      wpBgColor,
      wpOpacity,
      mascotHidden,
      wallpapers,
      customWallpapers,
      onWallpaperChange: setWallpaperId,
      onWpFitChange: setWpFit,
      onWpBgColorChange: setWpBgColor,
      onWpOpacityChange: setWpOpacity,
      onMascotToggle: setMascotHidden,
      onWallpaperUpload: () => uploadRef.current?.click(),
      onCustomWallpaperDelete: (idx: number) => {
        const before = customRef.current;
        const next = before.filter((_, i) => i !== idx);
        // Nothing was removed, so nothing is renumbered.
        if (!storeCustomWallpapers(next)) return;
        // `custom-<n>` is an INDEX into that list, so deleting one renumbers
        // every picture after it. Through the SHARED rule, not a fourth
        // spelling of it: this handler and the desktop's write the same
        // box-wide `wp_id`, and the fallback is the harness's own art — a
        // Hermes box whose only custom wallpaper is deleted must not land on
        // the ClawBox one (TASK-719).
        // `before` is the list as it stood immediately ahead of THIS delete,
        // captured before the store above advances the ref to the shortened
        // one — not the list the saved id was originally chosen against, which
        // may have been another browser's entirely.
        //
        // Nothing chosen yet is nothing to renumber (the desktop's rule).
        if (wallpaperId === null) return;
        setWallpaperId(wallpaperIdAfterDelete(wallpaperId, idx, before, persistableFallbackWallpaperId));
      },
    },
  };
}

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

/**
 * Inside the provider for the reason `StandaloneTitle` is: the page component
 * itself sits ABOVE `I18nProvider`, where `t()` echoes the key back. The
 * literal was the last hard-coded English on this bar — a German desktop's
 * Files and Terminal pages said "Back to Desktop" while everything around it
 * was translated. English is the FLOOR here, not the answer: the key is not in
 * the desktop catalogue yet, and a raw key on screen would be worse than the
 * English it replaces.
 */
function BackToDesktopLabel() {
  const { t } = useT();
  const hit = t("app.backToDesktop");
  return <>{hit === "app.backToDesktop" ? "Back to Desktop" : hit}</>;
}

export default function StandaloneAppPage() {
  const { id } = useParams<{ id: string }>();
  // Only /app/settings reads the appearance preferences — every other page
  // here would be paying for a request it never renders.
  // null while unresolved — a harness-only app must not paint before we know
  // which harness this device actually runs.
  const [harness, setHarness] = useState<string | null>(null);
  // Which harness's BRANDING this device wears — null while that is unknown,
  // which is not the same question as the app gate's `harness` above. See the
  // desktop's copy of this pair.
  const [wallpaperHarness, setWallpaperHarness] = useState<string | null>(null);
  const appearance = useAppearance(id === "settings", wallpaperHarness);

  useEffect(() => {
    let alive = true;
    // "unknown" rather than a guess: this route is reachable directly (a
    // bookmark, "Open in new tab"), so falling back to "openclaw" rendered the
    // whole OpenClaw App Store on a Hermes box whenever the probe failed.
    void fetchHarness().then((d) => {
      if (!alive) return;
      setHarness(d?.active || "unknown");
      setWallpaperHarness(brandingHarness(d));
    });
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
          sandbox={isProxiedAppUrl(src) ? undefined : WEBAPP_IFRAME_SANDBOX}
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
            <SettingsApp ui={appearance.ui} />
            {/* The Upload tile clicks this, exactly as the desktop's does. */}
            <input
              ref={appearance.uploadRef}
              type="file"
              accept="image/*"
              className="hidden"
              data-testid="standalone-wallpaper-upload"
              onChange={appearance.onUploadFile}
            />
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
            <BackToDesktopLabel />
          </Link>
        </div>
        {/* App content */}
        <div className="flex-1 overflow-hidden">{renderApp()}</div>
      </div>
    </I18nProvider>
  );
}
