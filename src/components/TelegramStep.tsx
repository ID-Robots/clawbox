"use client";

import { useState, useEffect, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import StatusMessage from "./StatusMessage";

interface TelegramStepProps {
  onNext: () => void;
}

export default function TelegramStep({ onNext }: TelegramStepProps) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      saveControllerRef.current?.abort();
    };
  }, []);

  const saveTelegram = async () => {
    if (!token.trim()) {
      setStatus({ type: "error", message: "Please enter a bot token" });
      return;
    }
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
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
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        setStatus({
          type: "success",
          message: "Telegram bot configured! Continuing...",
        });
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => onNext(), 1500);
      } else {
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-[520px]">
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          Connect Telegram
        </h1>
        <p className="text-gray-400 mb-5 leading-relaxed">
          Link a Telegram bot so you can chat with your ClawBox from your phone.
        </p>

        <div className="flex gap-5 items-start mb-5">
          <div className="shrink-0 p-2 bg-white rounded-lg">
            <QRCodeSVG
              value="https://t.me/BotFather"
              size={96}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
            />
          </div>
          <ol className="ml-0 pl-5 leading-[1.8] text-sm text-gray-300 list-decimal">
            <li>
              Scan the QR code or search{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-orange-400 hover:text-orange-300 font-semibold"
              >
                @BotFather
              </a>{" "}
              in Telegram
            </li>
            <li>
              Send{" "}
              <code className="bg-gray-700 px-1.5 py-0.5 rounded text-xs text-orange-400">
                /newbot
              </code>{" "}
              and follow the prompts
            </li>
            <li>
              Copy the <strong>Bot Token</strong> and paste it below
            </li>
          </ol>
        </div>
        <label htmlFor="telegram-bot-token" className="block text-xs font-semibold text-gray-400 mb-1.5 mt-4">
          Bot Token
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
            className="w-full px-3.5 py-2.5 pr-10 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500"
          />
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            aria-label={showToken ? "Hide token" : "Show token"}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 bg-transparent border-none cursor-pointer p-0.5"
          >
            {showToken ? (
              <svg aria-labelledby="hide-token-title" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><title id="hide-token-title">Hide token</title><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg aria-labelledby="show-token-title" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><title id="show-token-title">Show token</title><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        </div>
        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}
        <div className="flex items-center gap-3 mt-5">
          <button
            type="button"
            onClick={saveTelegram}
            disabled={saving}
            className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer disabled:opacity-50 disabled:hover:scale-100"
          >
            {saving ? "Saving..." : "Save & Continue"}
          </button>
          <button
            type="button"
            onClick={onNext}
            className="bg-transparent border-none text-orange-400 text-sm underline cursor-pointer p-1"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
