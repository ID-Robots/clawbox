"use client";

import Image from "next/image";
import { useId, type ReactNode } from "react";

interface AIProviderIconProps {
  provider: string | null | undefined;
  size?: number;
  className?: string;
}

function normalizeProvider(provider: string | null | undefined): string {
  if (provider === "deepseek") return "clawai";
  return provider?.trim().toLowerCase() || "";
}

function SvgFrame({
  size,
  className = "",
  children,
  viewBox = "0 0 24 24",
}: {
  size: number;
  className?: string;
  children: ReactNode;
  viewBox?: string;
}) {
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export default function AIProviderIcon({
  provider,
  size = 24,
  className = "",
}: AIProviderIconProps) {
  const normalized = normalizeProvider(provider);
  const geminiGradientId = useId().replace(/:/g, "");

  if (normalized === "clawai") {
    return (
      <span
        className={`relative inline-flex items-center justify-center overflow-hidden ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <Image
          src="/clawbox-crab.png"
          alt=""
          width={size}
          height={size}
          className="w-full h-full object-contain"
        />
      </span>
    );
  }

  if (normalized === "openai") {
    return (
      <SvgFrame size={size} className={className}>
        <g transform="translate(12 12)">
          {[0, 60, 120, 180, 240, 300].map((rotation) => (
            <g key={rotation} transform={`rotate(${rotation})`}>
              <rect
                x="-2.25"
                y="-8.35"
                width="4.5"
                height="8.8"
                rx="2.25"
                fill="#F3F4F6"
                opacity="0.98"
              />
            </g>
          ))}
          <circle cx="0" cy="0" r="2.6" fill="#111827" />
        </g>
      </SvgFrame>
    );
  }

  if (normalized === "anthropic") {
    return (
      <SvgFrame size={size} className={className}>
        <path
          d="M12 3 19.5 21h-3.2l-1.55-3.86H9.2L7.65 21H4.5L12 3Zm0 5.06-1.7 4.35h3.42L12 8.06Z"
          fill="#F4E7C8"
        />
      </SvgFrame>
    );
  }

  if (normalized === "google") {
    return (
      <SvgFrame size={size} className={className}>
        <defs>
          <linearGradient id={geminiGradientId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#7DD3FC" />
            <stop offset="55%" stopColor="#A78BFA" />
            <stop offset="100%" stopColor="#F9A8D4" />
          </linearGradient>
        </defs>
        <path
          d="M12 2.5 14.65 9.35 21.5 12l-6.85 2.65L12 21.5l-2.65-6.85L2.5 12l6.85-2.65L12 2.5Z"
          fill={`url(#${geminiGradientId})`}
        />
        <circle cx="12" cy="12" r="2.1" fill="#E0F2FE" fillOpacity="0.95" />
      </SvgFrame>
    );
  }

  if (normalized === "openrouter") {
    return (
      <SvgFrame size={size} className={className}>
        <path
          d="M8.1 5.2h7.7l-1.7-1.7 1.35-1.35 4 4-4 4-1.35-1.35 1.7-1.7H8.1a2.9 2.9 0 0 0-2.9 2.9v.45H3.3V10a4.8 4.8 0 0 1 4.8-4.8Zm7.8 8.95H8.2l1.7 1.7-1.35 1.35-4-4 4-4 1.35 1.35-1.7 1.7h7.7a2.9 2.9 0 0 0 2.9-2.9V9.9h1.9v.45a4.8 4.8 0 0 1-4.8 4.8Z"
          fill="#60A5FA"
        />
      </SvgFrame>
    );
  }

  if (normalized === "ollama") {
    return (
      <SvgFrame size={size} className={className}>
        <path
          d="M8.25 4.6h4.4a3.2 3.2 0 0 1 3.2 3.2v2.05c.92.38 1.55 1.3 1.55 2.37v4.08c0 1.14-.92 2.07-2.07 2.07H8.67A2.07 2.07 0 0 1 6.6 16.3v-4.08c0-1.1.67-2.04 1.65-2.4V7.8a3.2 3.2 0 0 1 0-3.2Z"
          fill="#F9FAFB"
        />
        <circle cx="10.05" cy="12.55" r="0.95" fill="#0F172A" />
        <circle cx="14.1" cy="12.55" r="0.95" fill="#0F172A" />
        <path d="M10.2 15.45c1 .75 2.45.75 3.45 0" stroke="#0F172A" strokeWidth="1.2" strokeLinecap="round" />
      </SvgFrame>
    );
  }

  if (normalized === "llamacpp") {
    return (
      <SvgFrame size={size} className={className}>
        <rect x="3.5" y="4" width="17" height="16" rx="3" fill="#1E293B" stroke="#F97316" strokeWidth="1.3" />
        <path d="m8 10 2.6 2L8 14" stroke="#FDBA74" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.9 14.6h3.1" stroke="#FDBA74" strokeWidth="1.6" strokeLinecap="round" />
      </SvgFrame>
    );
  }

  return (
    <SvgFrame size={size} className={className}>
      <circle cx="12" cy="12" r="9" fill="#334155" />
      <path
        d="M8.5 13.5a3.5 3.5 0 1 1 7 0v2.2a1.3 1.3 0 0 1-1.3 1.3H9.8a1.3 1.3 0 0 1-1.3-1.3v-2.2Z"
        fill="#E2E8F0"
      />
    </SvgFrame>
  );
}
