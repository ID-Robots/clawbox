"use client";

import { useState, useEffect, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import StatusMessage from "./StatusMessage";
import TelegramConfiguringOverlay from "./TelegramConfiguringOverlay";
import { useT } from "@/lib/i18n";

interface TelegramStepProps {
  onNext: () => void;
}

export default function TelegramStep({ onNext }: TelegramStepProps) {
  const { t } = useT();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      saveControllerRef.current?.abort();
    };
  }, []);

  const saveTelegram = async () => {
    if (!token.trim()) {
      setStatus({ type: "error", message: t("telegram.enterToken") });
      return;
    }
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    setConfiguring(true);
    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: token.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setConfiguring(false);
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!data.success) {
        setConfiguring(false);
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setConfiguring(false);
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-[520px]" data-testid="setup-step-telegram">
      <div className="card-surface rounded-2xl p-5 sm:p-8 relative overflow-hidden">
        {configuring && (
          <TelegramConfiguringOverlay onDone={onNext} />
        )}
        <div className={configuring ? "invisible h-0 overflow-hidden" : ""}>
        <h1 className="text-xl sm:text-2xl font-bold font-display mb-2 flex flex-wrap items-center gap-2.5">
          {t("telegram.title")}
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-orange-500/15 text-orange-400 leading-none">{t("recommended")}</span>
        </h1>
        <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
          {t("telegram.description")}
        </p>

        <div className="flex flex-col sm:flex-row gap-4 sm:gap-5 items-center sm:items-start mb-4">
          <div className="hidden sm:block shrink-0 p-2 bg-white rounded-lg">
            <QRCodeSVG
              value="https://t.me/BotFather"
              size={96}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
            />
          </div>
          <ol className="ml-0 pl-5 leading-[1.8] text-sm text-[var(--text-primary)] list-decimal">
            <li>
              {t("telegram.step1")}{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--coral-bright)] hover:text-orange-300 font-semibold"
              >
                @BotFather
              </a>{" "}
              {t("telegram.step1Suffix")}
            </li>
            <li>
              {t("telegram.step2")}{" "}
              <code className="bg-[var(--bg-surface)] px-1.5 py-0.5 rounded text-xs text-[var(--coral-bright)]">
                /newbot
              </code>{" "}
              {t("telegram.step2Suffix")}
            </li>
            <li>
              {t("telegram.step3prefix")}{" "}
              <strong>{t("telegram.step3bold")}</strong>{" "}
              {t("telegram.step3suffix")}
            </li>
          </ol>
        </div>
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full px-4 py-3 mb-5 bg-[#229ED9]/15 hover:bg-[#229ED9]/25 border border-[#229ED9]/40 hover:border-[#229ED9]/60 rounded-lg text-sm font-semibold text-[#5eb8e6] transition-colors no-underline"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
          {t("telegram.openBotFather")}
        </a>
        <label htmlFor="telegram-bot-token" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5 mt-4">
          {t("telegram.botToken")}
        </label>
        <div className="relative">
          <input
            id="telegram-bot-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3.5 py-2.5 pr-10 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500"
          />
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            aria-label={showToken ? "Hide token" : "Show token"}
            className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
              {showToken ? "visibility_off" : "visibility"}
            </span>
          </button>
        </div>
        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-5">
          <button
            type="button"
            onClick={saveTelegram}
            disabled={saving}
            className="w-full sm:w-auto px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
          >
            {saving ? t("connecting") : t("settings.connect")}
          </button>
          <button
            type="button"
            onClick={onNext}
            className="bg-transparent border-none text-[var(--coral-bright)] text-sm underline cursor-pointer p-1 self-center"
          >
            {t("telegram.skipForNow")}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
