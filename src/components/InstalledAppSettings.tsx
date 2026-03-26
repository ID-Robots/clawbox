"use client";

import { useState, useEffect, useCallback } from "react";
import type { StoreApp } from "./AppStore";
import * as kv from "@/lib/client-kv";

interface AppSetting {
  key: string;
  label: string;
  type: "text" | "url" | "password" | "toggle" | "select";
  placeholder?: string;
  options?: string[]; // for select type
}

// Common setting templates by app category/type
function getAppSettings(appId: string): AppSetting[] {
  const common: AppSetting[] = [
    { key: "enabled", label: "Enabled", type: "toggle" },
    { key: "api_url", label: "API URL", type: "url", placeholder: "https://..." },
    { key: "api_key", label: "API Key", type: "password", placeholder: "Enter API key" },
  ];

  // App-specific settings
  const appSettings: Record<string, AppSetting[]> = {
    "home-assistant": [
      { key: "enabled", label: "Enabled", type: "toggle" },
      { key: "ha_url", label: "Home Assistant URL", type: "url", placeholder: "http://homeassistant.local:8123" },
      { key: "ha_token", label: "Long-Lived Access Token", type: "password", placeholder: "Enter HA access token" },
      { key: "webhook_enabled", label: "Enable Webhooks", type: "toggle" },
    ],
    "binance-pro": [
      { key: "enabled", label: "Enabled", type: "toggle" },
      { key: "api_key", label: "API Key", type: "password", placeholder: "Binance API key" },
      { key: "api_secret", label: "API Secret", type: "password", placeholder: "Binance API secret" },
      { key: "testnet", label: "Use Testnet", type: "toggle" },
    ],
    "weather-forecast": [
      { key: "enabled", label: "Enabled", type: "toggle" },
      { key: "location", label: "Default Location", type: "text", placeholder: "City name or coordinates" },
      { key: "units", label: "Units", type: "select", options: ["metric", "imperial"] },
    ],
  };

  return appSettings[appId] || common;
}

interface InstalledAppSettingsProps {
  appId: string;
  storeApp: StoreApp;
  icon: React.ReactNode;
}

export default function InstalledAppSettings({ appId, storeApp, icon }: InstalledAppSettingsProps) {
  const SETTINGS_KEY = `clawbox-app-settings-${appId}`;
  const [settings, setSettings] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    kv.init().then(() => {
      const stored = kv.getJSON<Record<string, string | boolean>>(SETTINGS_KEY);
      if (stored) setSettings(stored);
    });
  }, [SETTINGS_KEY]);

  const appSettings = getAppSettings(appId);

  const updateSetting = useCallback((key: string, value: string | boolean) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      kv.setJSON(SETTINGS_KEY, next);
      return next;
    });
    setSaved(false);
  }, [SETTINGS_KEY]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fetch("/setup-api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [`app_${appId}_settings`]: settings }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  }, [appId, settings]);

  return (
    <div className="h-full flex flex-col bg-[#0f1219] text-white overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 flex flex-col items-center pt-8 pb-4 px-6 border-b border-white/10">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center shadow-lg mb-4"
          style={{ backgroundColor: storeApp.color }}
        >
          {icon}
        </div>
        <h2 className="text-xl font-semibold mb-1">{storeApp.name}</h2>
        <div className="flex items-center gap-2 mb-2">
          <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-xs font-medium rounded-full">
            Installed
          </span>
          {storeApp.rating > 0 && (
            <span className="flex items-center gap-1 text-xs text-white/50">
              <span className="material-symbols-rounded text-yellow-400" style={{ fontSize: 12 }}>star</span>
              {storeApp.rating.toFixed(1)}
            </span>
          )}
        </div>
        <p className="text-xs text-white/40 text-center max-w-sm">{storeApp.description}</p>
      </div>

      {/* Settings */}
      <div className="flex-1 px-6 py-4">
        <h3 className="text-sm font-medium text-white/70 mb-4">Settings</h3>
        <div className="space-y-4">
          {appSettings.map((setting) => (
            <div key={setting.key}>
              {setting.type === "toggle" ? (
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm text-white/80">{setting.label}</span>
                  <button
                    onClick={() => updateSetting(setting.key, !settings[setting.key])}
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
      </div>

      {/* Footer */}
      <div className="shrink-0 px-6 py-4 border-t border-white/10 flex items-center justify-between">
        <a
          href={`https://openclawhardware.dev/store/app/${appId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 transition-colors"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>
          View in Store
        </a>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
            saved
              ? "bg-green-500/20 text-green-400"
              : "bg-white/10 hover:bg-white/15 text-white"
          } disabled:opacity-50`}
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
