"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

export type Locale = "en" | "bg" | "de" | "es" | "fr" | "it" | "ja" | "nl" | "sv" | "zh";

export interface LangOption {
  code: Locale;
  flag: string;
  label: string;
}

export const LANGUAGES: LangOption[] = [
  { code: "en", flag: "🇬🇧", label: "English" },
  { code: "bg", flag: "🇧🇬", label: "Български" },
  { code: "de", flag: "🇩🇪", label: "Deutsch" },
  { code: "es", flag: "🇪🇸", label: "Español" },
  { code: "fr", flag: "🇫🇷", label: "Français" },
  { code: "it", flag: "🇮🇹", label: "Italiano" },
  { code: "ja", flag: "🇯🇵", label: "日本語" },
  { code: "nl", flag: "🇳🇱", label: "Nederlands" },
  { code: "sv", flag: "🇸🇪", label: "Svenska" },
  { code: "zh", flag: "🇨🇳", label: "中文" },
];

const VALID_LOCALES = new Set<string>(LANGUAGES.map((l) => l.code));

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const fallbackT = (key: string) => key;
const fallbackCtx: I18nContextValue = { locale: "en", setLocale: () => {}, t: fallbackT };

export function useT() {
  const ctx = useContext(I18nContext);
  return ctx ?? fallbackCtx;
}

function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = navigator.language?.slice(0, 2).toLowerCase();
  return VALID_LOCALES.has(lang) ? (lang as Locale) : "en";
}

/**
 * Keep `<html lang>` in step with the locale the UI is actually rendering.
 *
 * The root layout is a server component and every route (desktop, /login, the
 * captive portal) shares it, while the locale is only known on the client —
 * it comes from the `pref:ui_language` preference, falling back to
 * `navigator.language`. So the attribute is written from an effect rather than
 * from render: the server keeps emitting `lang="en"`, hydration sees exactly
 * what was serialized, and the correction lands one commit later. Without it a
 * screen reader pronounces Bulgarian, Japanese or German copy with an English
 * voice — every locale but `en` is affected.
 *
 * Only the OUTERMOST provider writes: SettingsApp mounts nested I18nProviders
 * for the embedded AIModelsStep, and each of those starts at "en" and only
 * learns the real locale after its own fetch resolves, so letting them write
 * would flip the document back to English every time Settings opened.
 */
export function useSyncHtmlLang(locale: Locale, isRootProvider: boolean) {
  useEffect(() => {
    if (!isRootProvider || typeof document === "undefined") return;
    document.documentElement.setAttribute("lang", locale);
  }, [locale, isRootProvider]);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [translations, setTranslations] = useState<Record<string, string> | null>(null);
  // Read BEFORE this provider's own value is published, so it sees the parent
  // context (null when this is the outermost provider on the page).
  useSyncHtmlLang(locale, useContext(I18nContext) === null);

  // Load saved preference or detect from browser
  useEffect(() => {
    fetch("/setup-api/preferences?keys=ui_language")
      .then((r) => r.json())
      .then((data) => {
        const saved = data.ui_language;
        if (saved && VALID_LOCALES.has(saved)) {
          setLocaleState(saved as Locale);
        } else {
          setLocaleState(detectLocale());
        }
      })
      .catch(() => setLocaleState(detectLocale()));
  }, []);

  // Load translations when locale changes. Layer the active locale on
  // top of English so any key missing from the active locale falls back
  // to the English copy instead of rendering as the raw key string.
  useEffect(() => {
    import("@/lib/translations")
      .then((mod) => {
        const enBase = mod.translations.en ?? {};
        const active = mod.translations[locale] ?? enBase;
        setTranslations({ ...enBase, ...active });
      })
      // A chunk load can fail for reasons that are not bugs: the device is
      // offline mid-update, or the page is being torn down while this is in
      // flight. Keep whatever copy is already in state (English, or the raw
      // keys on a first load) rather than turning it into an unhandled
      // rejection — nothing here is recoverable by retrying.
      .catch(() => {});
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    fetch("/setup-api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui_language: newLocale }),
    }).catch(() => {});
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let str = translations?.[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          str = str.replaceAll(`{${k}}`, String(v));
        }
      }
      return str;
    },
    [translations],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}
