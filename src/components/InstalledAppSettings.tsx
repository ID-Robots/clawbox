"use client";

import { useState, useEffect, useCallback } from "react";
import type { StoreApp } from "./AppStore";
import * as kv from "@/lib/client-kv";
import { useT } from "@/lib/i18n";
import { clawhubSkillUrl } from "@/lib/clawhub-url";

interface AppSetting {
  key: string;
  label: string;
  type: "text" | "url" | "password" | "toggle" | "select";
  placeholder?: string;
  options?: string[];
}

interface SkillInfo {
  name: string;
  description: string;
  emoji: string | null;
  eligible: boolean;
  primaryEnv: string | null;
  requiredEnv: string[];
  requiredBins: string[];
  requiredConfig: string[];
  /** From openclaw.json via skill-info; absent (older server) means enabled. */
  enabled?: boolean;
}

// Hand-crafted overrides for skills that need special treatment. Only fields
// the skill's config writer actually persists belong here — a "webhook_enabled"
// toggle used to sit alongside these, stored to KV and dropped by the writer,
// so it claimed a setting the skill never saw. HA's inbound webhooks are
// configured on the Home Assistant side; the note under the form says so.
const CUSTOM_SETTINGS: Record<string, AppSetting[]> = {
  "home-assistant": [
    { key: "ha_url", label: "Home Assistant URL", type: "url", placeholder: "http://homeassistant.local:8123" },
    { key: "ha_token", label: "Long-Lived Access Token", type: "password", placeholder: "Enter HA access token" },
  ],
};

function envToLabel(envVar: string): string {
  return envVar
    .replace(/_/g, " ")
    .replace(/\b(api|url|key|token|secret|id)\b/gi, (m) => m.toUpperCase())
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function envToInputType(envVar: string): "password" | "url" | "text" {
  const lower = envVar.toLowerCase();
  if (lower.includes("token") || lower.includes("secret") || lower.includes("key") || lower.includes("password")) return "password";
  if (lower.includes("url") || lower.includes("endpoint") || lower.includes("host")) return "url";
  return "text";
}

function buildSettings(appId: string, skillInfo: SkillInfo | null): AppSetting[] {
  if (CUSTOM_SETTINGS[appId]) return CUSTOM_SETTINGS[appId];
  if (!skillInfo || skillInfo.requiredEnv.length === 0) return [];

  const settings: AppSetting[] = [];
  const envVars = [...skillInfo.requiredEnv];
  if (skillInfo.primaryEnv) {
    const idx = envVars.indexOf(skillInfo.primaryEnv);
    if (idx > 0) { envVars.splice(idx, 1); envVars.unshift(skillInfo.primaryEnv); }
  }

  for (const env of envVars) {
    settings.push({
      key: env.toLowerCase(),
      label: envToLabel(env),
      type: envToInputType(env),
      placeholder: `Enter ${envToLabel(env)}`,
    });
  }

  return settings;
}

interface InstalledAppSettingsProps {
  appId: string;
  storeApp: StoreApp;
  icon: React.ReactNode;
  onUninstall: (appId: string) => void;
}

export default function InstalledAppSettings({ appId, storeApp, icon, onUninstall }: InstalledAppSettingsProps) {
  const { t } = useT();
  const SETTINGS_KEY = `clawbox-app-settings-${appId}`;
  const [settings, setSettings] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  // "connected" = backend actually wrote the skill's config (the button then
  // says "Saved to skill config" — that is a file write, never a probed
  // connection); "saved" = values stored but the skill has no on-device config
  // writer yet (so it can't use them). Distinguishing the two keeps us from
  // claiming a wiring that never happened.
  const [saveResult, setSaveResult] = useState<"idle" | "connected" | "saved">("idle");
  const [skillInfo, setSkillInfo] = useState<SkillInfo | null>(null);
  const [loadingSkill, setLoadingSkill] = useState(true);
  const [skillError, setSkillError] = useState(false);
  // A skill-info 404: the preference entry survived but the skill is gone from
  // the box (removed out-of-band). Distinct from skillError — this window used
  // to show both as a healthy "works out of the box".
  const [skillMissing, setSkillMissing] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [toggling, setToggling] = useState(false);

  // Who publishes this skill. The recorded `developer` is a display label that
  // is sometimes another publisher's name entirely, so the store detail is
  // always asked — it carries `ownerHandle`, the publisher ClawHub itself
  // names. `null` here is the store's explicit "ClawHub could not name one":
  // the developer guess must not resurrect the dead link the server removed.
  // An unanswered lookup (or an old server with no ownerHandle field) leaves
  // it undefined and the link falls back through `developer`.
  const [resolvedDeveloper, setResolvedDeveloper] = useState<string | undefined>(storeApp.developer);
  const [resolvedOwner, setResolvedOwner] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setResolvedDeveloper(storeApp.developer);
    setResolvedOwner(undefined);
    const controller = new AbortController();
    fetch(`/setup-api/apps/store?slug=${encodeURIComponent(appId)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data === "object" && "ownerHandle" in data) {
          setResolvedOwner(typeof data.ownerHandle === "string" && data.ownerHandle ? data.ownerHandle : null);
        }
        if (typeof data?.developer === "string") setResolvedDeveloper((prev) => prev ?? data.developer);
      })
      .catch(() => { /* offline, or a skill the store does not list — the link falls back. */ });
    return () => controller.abort();
  }, [appId, storeApp.developer]);

  useEffect(() => {
    fetch(`/setup-api/apps/skill-info?appId=${encodeURIComponent(appId)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (r.ok && data) {
          setSkillInfo(data as SkillInfo);
          // `enabled` is read back from openclaw.json; a server that predates
          // the field omits it, and an absent field means enabled.
          if ((data as SkillInfo).enabled === false) setEnabled(false);
          return;
        }
        // 404 `not_installed` (and the bare 404 an older server sends) is a
        // skill that is gone from the box. Anything else — the 503
        // `skills_unavailable`, the Hermes guard — is the skill CLI failing,
        // which is what the red error panel was written for.
        const code = (data as { code?: string } | null)?.code;
        if (r.status === 404 && (!code || code === "not_installed")) setSkillMissing(true);
        else setSkillError(true);
      })
      .catch((err) => { console.warn("[settings] Failed to load skill info:", err); setSkillError(true); })
      .finally(() => setLoadingSkill(false));
  }, [appId]);

  useEffect(() => {
    kv.init().then(() => {
      const stored = kv.getJSON<Record<string, string | boolean>>(SETTINGS_KEY);
      if (stored) setSettings(stored);
    });
  }, [SETTINGS_KEY]);

  const appSettings = buildSettings(appId, skillInfo);
  // The publisher namespace is what makes a ClawHub URL real; when the store
  // explicitly answered ownerHandle: null the developer guess is skipped, and
  // the store's own page is the honest fallback — labelled as the store page,
  // not as ClawHub.
  const hubUrl = clawhubSkillUrl(appId, resolvedOwner || undefined)
    || (resolvedOwner === null ? undefined : clawhubSkillUrl(appId, resolvedDeveloper))
    || storeApp.url;
  const hubIsClawhub = !!hubUrl && hubUrl.startsWith("https://clawhub.ai/");

  const updateSetting = useCallback((key: string, value: string | boolean) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      kv.setJSON(SETTINGS_KEY, next);
      return next;
    });
    setSaveResult("idle");
  }, [SETTINGS_KEY]);

  const [toggleError, setToggleError] = useState(false);

  const handleToggleEnabled = useCallback(async () => {
    const newEnabled = !enabled;
    setToggling(true);
    setToggleError(false);
    try {
      const res = await fetch("/setup-api/apps/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, settings: { _setEnabled: newEnabled } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // No local record: skill-info reads the value back from openclaw.json,
      // which the write above just changed — a KV mirror only ever disagreed.
      setEnabled(newEnabled);
      window.dispatchEvent(new CustomEvent('clawbox-skill-installed', { detail: { action: newEnabled ? 'enable' : 'disable', id: appId } }));
    } catch (err) {
      console.warn("[settings] Failed to toggle skill:", err);
      setToggleError(true);
    }
    setToggling(false);
  }, [appId, enabled]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fetch("/setup-api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [`app_${appId}_settings`]: settings }),
      });
      const res = await fetch("/setup-api/apps/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, settings }),
      });
      // Only claim "Connected" when the backend actually wrote the skill's
      // config (configWritten). Otherwise the values are stored but the skill
      // can't read them yet — don't imply it's wired up.
      const data = res.ok ? await res.json().catch(() => null) : null;
      setSaveResult(data?.configWritten ? "connected" : "saved");
      setTimeout(() => setSaveResult("idle"), 4000);
    } catch {}
    setSaving(false);
  }, [appId, settings]);

  const hasConfigFields = appSettings.length > 0;

  return (
    <div className="h-full flex flex-col bg-[var(--bg-deep)] text-white overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 flex flex-col items-center pt-8 pb-4 px-6 border-b border-white/10">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center shadow-lg mb-4"
          style={{ backgroundColor: storeApp.color, opacity: enabled ? 1 : 0.4 }}
        >
          {icon}
        </div>
        <h2 className="text-xl font-semibold mb-1">{storeApp.name}</h2>
        <div className="flex items-center gap-2 mb-2">
          {skillMissing ? (
            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-white/10 text-white/40">
              {t("installed.notInstalledBadge")}
            </span>
          ) : (
            <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
              enabled ? "bg-green-500/20 text-green-400" : "bg-white/10 text-white/40"
            }`}>
              {enabled ? t("installed.active") : t("installed.disabled")}
            </span>
          )}
          {skillInfo && enabled && (
            <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
              skillInfo.eligible
                ? "bg-green-500/10 text-green-400/70"
                : "bg-yellow-500/10 text-yellow-400/70"
            }`}>
              {skillInfo.eligible ? t("installed.ready") : t("installed.needsSetup")}
            </span>
          )}
          {storeApp.rating > 0 && (
            <span className="flex items-center gap-1 text-xs text-white/50">
              <span className="material-symbols-rounded text-yellow-400" style={{ fontSize: 12 }}>star</span>
              {storeApp.rating.toFixed(1)}
            </span>
          )}
        </div>
        <p className="text-xs text-white/40 text-center max-w-sm">{storeApp.description}</p>
      </div>

      {/* Enable/Disable toggle. Not offered for a skill that is gone from the
          box — the switch would write config for nothing. */}
      {!skillMissing && (
      <div className="px-6 py-4 border-b border-white/10">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-sm text-white/80 font-medium">{t("installed.skillEnabled")}</span>
            <p className="text-xs text-white/30 mt-0.5">
              {toggleError
                ? <span className="text-red-400">{t("installed.toggleFailed")}</span>
                : toggling ? t("installed.saving")
                : enabled ? t("installed.agentCanUse") : t("installed.inactive")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {toggling && (
              <div className="w-4 h-4 border-2 border-white/20 rounded-full animate-spin" style={{ borderTopColor: "rgba(255,255,255,0.7)" }} />
            )}
            <button
              onClick={handleToggleEnabled}
              disabled={toggling}
              role="switch"
              aria-checked={enabled}
              aria-label={t("installed.enableSkillAria")}
              className={`w-11 h-6 rounded-full transition-colors relative ${
                enabled ? "bg-green-500" : "bg-white/20"
              } ${toggling ? "opacity-50" : ""}`}
            >
              <div
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  enabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </label>
      </div>
      )}

      {/* Settings */}
      <div className="flex-1 px-6 py-4">
        {loadingSkill ? (
          <div className="text-sm text-white/30 text-center py-8">{t("installed.loading")}</div>
        ) : skillMissing ? (
          <div className="text-center py-8">
            <span className="material-symbols-rounded text-yellow-400/60 mb-2" style={{ fontSize: 40 }}>help</span>
            <p className="text-sm text-white/50 mt-2">{t("installed.notInstalled")}</p>
            <p className="text-xs text-white/30 mt-1">{t("installed.notInstalledHint")}</p>
          </div>
        ) : skillError ? (
          <div className="text-center py-8">
            <span className="material-symbols-rounded text-red-400/60 mb-2" style={{ fontSize: 40 }}>error</span>
            <p className="text-sm text-white/50 mt-2">{t("installed.loadFailed")}</p>
            <p className="text-xs text-white/30 mt-1">{t("installed.cliUnavailable")}</p>
          </div>
        ) : !hasConfigFields ? (
          <div className="text-center py-8">
            <span className="material-symbols-rounded text-green-400/60 mb-2" style={{ fontSize: 40 }}>check_circle</span>
            <p className="text-sm text-white/50 mt-2">{t("installed.noConfig")}</p>
            <p className="text-xs text-white/30 mt-1">{t("installed.worksOutOfBox")}</p>
          </div>
        ) : (
          <>
            <h3 className="text-sm font-medium text-white/70 mb-4">{t("installed.settings")}</h3>
            {skillInfo && skillInfo.requiredBins.length > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 mb-4">
                <p className="text-xs text-yellow-200/70">
                  {t("installed.missingTools")} <strong>{skillInfo.requiredBins.join(", ")}</strong>
                </p>
              </div>
            )}
            <div className="space-y-4">
              {appSettings.map((setting) => (
                <div key={setting.key}>
                  {setting.type === "toggle" ? (
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-sm text-white/80">{setting.label}</span>
                      <button
                        onClick={() => updateSetting(setting.key, !settings[setting.key])}
                        role="switch"
                        aria-checked={!!settings[setting.key]}
                        aria-label={setting.label}
                        className={`w-10 h-5 rounded-full transition-colors relative ${
                          settings[setting.key] ? "bg-green-500" : "bg-white/20"
                        }`}
                      >
                        <div
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                            settings[setting.key] ? "translate-x-5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </label>
                  ) : setting.type === "select" ? (
                    <div>
                      <label className="text-sm text-white/80 block mb-1">{setting.label}</label>
                      <select
                        value={(settings[setting.key] as string) || setting.options?.[0] || ""}
                        onChange={(e) => updateSetting(setting.key, e.target.value)}
                        className="w-full h-9 px-3 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-white/20"
                      >
                        {setting.options?.map(opt => (
                          <option key={opt} value={opt} className="bg-[#1a1a2e]">{opt}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="text-sm text-white/80 block mb-1">{setting.label}</label>
                      <input
                        type={setting.type === "password" ? "password" : "text"}
                        value={(settings[setting.key] as string) || ""}
                        onChange={(e) => updateSetting(setting.key, e.target.value)}
                        placeholder={setting.placeholder}
                        className="w-full h-9 px-3 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/20"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
            {appId === "home-assistant" && (
              <p className="text-xs text-white/30 mt-3 leading-relaxed">
                {t("installed.haWebhookNote")}
              </p>
            )}
            {saveResult === "saved" && (
              <p className="text-xs text-amber-300/70 mt-3 leading-relaxed">
                {t("installed.savedNotWired")}
              </p>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-6 py-4 border-t border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {hubUrl && (
            <a
              href={hubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 transition-colors"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>
              {hubIsClawhub ? t("store.viewOnHub") : t("store.viewInStore")}
            </a>
          )}
          <button
            onClick={() => onUninstall(appId)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
            {t("store.uninstall")}
          </button>
        </div>
        {hasConfigFields && !skillMissing && (
          <button
            onClick={handleSave}
            disabled={saving}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              saveResult === "connected"
                ? "bg-green-500/20 text-green-400"
                : saveResult === "saved"
                ? "bg-amber-500/15 text-amber-300"
                : "bg-white/10 hover:bg-white/15 text-white"
            } disabled:opacity-50`}
          >
            {saving ? t("installed.connecting") : saveResult === "connected" ? t("installed.savedToConfig") : saveResult === "saved" ? t("installed.saved") : t("installed.connect")}
          </button>
        )}
      </div>
    </div>
  );
}
