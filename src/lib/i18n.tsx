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

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within I18nProvider");
  return ctx;
}

function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = navigator.language?.slice(0, 2).toLowerCase();
  return VALID_LOCALES.has(lang) ? (lang as Locale) : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [translations, setTranslations] = useState<Record<string, string> | null>(null);

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

  // Load translations when locale changes
  useEffect(() => {
    import("@/lib/translations").then((mod) => {
      setTranslations(mod.translations[locale] ?? mod.translations.en);
    });
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
          str = str.replace(`{${k}}`, String(v));
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
