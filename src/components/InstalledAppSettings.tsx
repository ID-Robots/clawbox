"use client";

import { useState, useEffect, useCallback } from "react";
import type { StoreApp } from "./AppStore";
import * as kv from "@/lib/client-kv";

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
}

// Hand-crafted overrides for skills that need special treatment
const CUSTOM_SETTINGS: Record<string, AppSetting[]> = {
  "home-assistant": [
    { key: "ha_url", label: "Home Assistant URL", type: "url", placeholder: "http://homeassistant.local:8123" },
    { key: "ha_token", label: "Long-Lived Access Token", type: "password", placeholder: "Enter HA access token" },
    { key: "webhook_enabled", label: "Enable Webhooks", type: "toggle" },
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
  const SETTINGS_KEY = `clawbox-app-settings-${appId}`;
  const [settings, setSettings] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [skillInfo, setSkillInfo] = useState<SkillInfo | null>(null);
  const [loadingSkill, setLoadingSkill] = useState(true);
  const [skillError, setSkillError] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    fetch(`/setup-api/apps/skill-info?appId=${encodeURIComponent(appId)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => setSkillInfo(data))
      .catch((err) => { console.warn("[settings] Failed to load skill info:", err); setSkillError(true); })
      .finally(() => setLoadingSkill(false));
  }, [appId]);

  useEffect(() => {
    kv.init().then(() => {
      const stored = kv.getJSON<Record<string, string | boolean>>(SETTINGS_KEY);
      if (stored) setSettings(stored);
      // Load enabled state (default true)
      const enabledState = kv.get(`clawbox-skill-enabled-${appId}`);
      if (enabledState === "0") setEnabled(false);
    });
  }, [SETTINGS_KEY, appId]);

  const appSettings = buildSettings(appId, skillInfo);

  const updateSetting = useCallback((key: string, value: string | boolean) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      kv.setJSON(SETTINGS_KEY, next);
      return next;
    });
    setSaved(false);
  }, [SETTINGS_KEY]);

  const [toggleError, setToggleError] = useState<string | null>(null);

  const handleToggleEnabled = useCallback(async () => {
    const newEnabled = !enabled;
    setToggling(true);
    setToggleError(null);
    try {
      const res = await fetch("/setup-api/apps/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, settings: { _setEnabled: newEnabled } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEnabled(newEnabled);
      kv.set(`clawbox-skill-enabled-${appId}`, newEnabled ? "1" : "0");
      window.dispatchEvent(new CustomEvent('clawbox-skill-installed', { detail: { action: newEnabled ? 'enable' : 'disable', id: appId } }));
    } catch (err) {
      console.warn("[settings] Failed to toggle skill:", err);
      setToggleError("Failed to toggle skill");
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
      await fetch("/setup-api/apps/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, settings }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  }, [appId, settings]);

  const hasConfigFields = appSettings.length > 0;

  return (
    <div className="h-full flex flex-col bg-[#0f1219] text-white overflow-y-auto">
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
          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
            enabled ? "bg-green-500/20 text-green-400" : "bg-white/10 text-white/40"
          }`}>
            {enabled ? "Active" : "Disabled"}
          </span>
          {skillInfo && enabled && (
            <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
              skillInfo.eligible
                ? "bg-green-500/10 text-green-400/70"
                : "bg-yellow-500/10 text-yellow-400/70"
            }`}>
              {skillInfo.eligible ? "Ready" : "Needs Setup"}
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

      {/* Enable/Disable toggle */}
      <div className="px-6 py-4 border-b border-white/10">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-sm text-white/80 font-medium">Skill Enabled</span>
            <p className="text-xs text-white/30 mt-0.5">
              {toggleError ? <span className="text-red-400">{toggleError}</span> : enabled ? "Agent can use this skill" : "Skill is installed but inactive"}
            </p>
          </div>
          <button
            onClick={handleToggleEnabled}
            disabled={toggling}
            role="switch"
            aria-checked={enabled}
            aria-label="Enable skill"
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
        </label>
      </div>

      {/* Settings */}
      <div className="flex-1 px-6 py-4">
        {loadingSkill ? (
          <div className="text-sm text-white/30 text-center py-8">Loading skill info...</div>
        ) : skillError ? (
          <div className="text-center py-8">
            <span className="material-symbols-rounded text-red-400/60 mb-2" style={{ fontSize: 40 }}>error</span>
            <p className="text-sm text-white/50 mt-2">Could not load skill info</p>
            <p className="text-xs text-white/30 mt-1">The skill CLI may not be available.</p>
          </div>
        ) : !hasConfigFields ? (
          <div className="text-center py-8">
            <span className="material-symbols-rounded text-green-400/60 mb-2" style={{ fontSize: 40 }}>check_circle</span>
            <p className="text-sm text-white/50 mt-2">No configuration needed</p>
            <p className="text-xs text-white/30 mt-1">This skill works out of the box.</p>
          </div>
        ) : (
          <>
            <h3 className="text-sm font-medium text-white/70 mb-4">Settings</h3>
            {skillInfo && skillInfo.requiredBins.length > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 mb-4">
                <p className="text-xs text-yellow-200/70">
                  Missing tools: <strong>{skillInfo.requiredBins.join(", ")}</strong>
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
          </>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-6 py-4 border-t border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a
            href={`https://clawhub.ai/skills/${appId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 transition-colors"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>
            ClawHub
          </a>
          <button
            onClick={() => onUninstall(appId)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
            Uninstall
          </button>
        </div>
        {hasConfigFields && (
          <button
            onClick={handleSave}
            disabled={saving}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
              saved
                ? "bg-green-500/20 text-green-400"
                : "bg-white/10 hover:bg-white/15 text-white"
            } disabled:opacity-50`}
          >
            {saving ? "Connecting..." : saved ? "Connected!" : "Connect"}
          </button>
        )}
      </div>
    </div>
  );
}
