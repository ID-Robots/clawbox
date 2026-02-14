"use client";

import { useState, useEffect, useRef } from "react";
import StatusMessage from "./StatusMessage";

interface TelegramStepProps {
  onNext: () => void;
}

export default function TelegramStep({ onNext }: TelegramStepProps) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const saveTelegram = async () => {
    if (!token.trim()) {
      setStatus({ type: "error", message: "Please enter a bot token" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: token.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
        return;
      }
      const data = await res.json();
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
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-[520px]">
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
        <h1 className="text-2xl font-bold font-display mb-2">
          Connect Telegram
        </h1>
        <p className="text-gray-400 mb-6 leading-relaxed">
          Link a Telegram bot so you can chat with your ClawBox from your phone.
        </p>
        <ol className="my-4 mb-5 ml-5 leading-[1.8] text-sm text-gray-300 list-decimal">
          <li>
            Open Telegram and search for <strong>@BotFather</strong>
          </li>
          <li>
            Send{" "}
            <code className="bg-gray-700 px-1.5 py-0.5 rounded text-xs text-orange-400">
              /newbot
            </code>{" "}
            and follow the prompts to create a bot
          </li>
          <li>
            Copy the <strong>Bot Token</strong> and paste it below
          </li>
        </ol>
        <label htmlFor="telegram-bot-token" className="block text-xs font-semibold text-gray-400 mb-1.5 mt-4">
          Bot Token
        </label>
        <input
          id="telegram-bot-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
          spellCheck={false}
          autoComplete="off"
          className="w-full px-3.5 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-orange-500 transition-colors placeholder-gray-500"
        />
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
