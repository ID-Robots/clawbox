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
    // Render the crab oversized so the first-party mark dominates the
    // provider tile — matches the "recommended" visual weight. 2.5x is
    // chosen so the crab clearly fills the container beyond the other
    // icons, in line with earlier UX direction.
    //
    // The crab PNG (public/clawbox-crab.png) is 87x128 but its visible
    // artwork lives in rows 29–88, i.e. the content center is at y=58.5
    // while the PNG geometric center is at y=64 — the artwork sits
    // ~4.3% above the image's bounding-box center. Flex- or transform-
    // based centering on the image bounding box therefore leaves the
    // visible crab visually above-center of the tile.
    //
    // Translating by `-50%, -45.7%` instead of `-50%, -50%` corrects for
    // that asymmetry so the crab's visible center aligns with the tile's
    // geometric center.
    const crabSize = Math.round(size * 2.5);
    return (
      <span
        className={`relative inline-flex items-center justify-center ${className}`}
        style={{ width: size, height: size, overflow: "visible" }}
        aria-hidden="true"
      >
        <Image
          src="/clawbox-crab.png"
          alt=""
          width={crabSize}
          height={crabSize}
          className="object-contain"
          style={{
            width: crabSize,
            height: crabSize,
            maxWidth: "none",
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-49%, -45.7%)",
          }}
        />
      </span>
    );
  }

  // Official OpenAI "blossom" mark (path from simple-icons/openai)
  if (normalized === "openai") {
    return (
      <SvgFrame size={size} className={className}>
        <path
          fill="#F9FAFB"
          d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"
        />
      </SvgFrame>
    );
  }

  // Official Anthropic "A" monogram (path from simple-icons/anthropic)
  if (normalized === "anthropic") {
    return (
      <SvgFrame size={size} className={className}>
        <path
          fill="#D97757"
          d="M17.3041 3.541h-3.6718l6.696 16.918H24ZM6.6959 3.541 0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5527h3.7442L10.5363 3.541Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
        />
      </SvgFrame>
    );
  }

  // Google Gemini — the four-point concave "sparkle" star in the canonical
  // blue → purple → pink Gemini gradient.
  if (normalized === "google") {
    return (
      <SvgFrame size={size} className={className}>
        <defs>
          <linearGradient id={geminiGradientId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#4285F4" />
            <stop offset="50%" stopColor="#9B72CB" />
            <stop offset="100%" stopColor="#D96570" />
          </linearGradient>
        </defs>
        <path
          fill={`url(#${geminiGradientId})`}
          d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z"
        />
      </SvgFrame>
    );
  }

  // OpenRouter — their recognizable "re-route / unify" mark in the signature
  // green. Two concentric rings with directional arrows representing a
  // unified router across multiple providers.
  if (normalized === "openrouter") {
    return (
      <SvgFrame size={size} className={className}>
        <path
          fill="#6ACA8A"
          d="M16.804 1.96A11.97 11.97 0 0 0 12 1C8.683 1 5.683 2.34 3.515 4.515a1 1 0 1 0 1.414 1.414A9.97 9.97 0 0 1 12 3c1.4 0 2.737.287 3.951.806L13.5 6.257V7l4.5 2.599v-5.2zm2.281.611A12.03 12.03 0 0 1 23 12c0 3.315-1.34 6.315-3.515 8.485a1 1 0 0 1-1.414-1.414A10.03 10.03 0 0 0 21 12a10.03 10.03 0 0 0-2.45-6.58l.535-2.849zM4.915 17.404 7.366 14.95V14.2L2.87 11.6v5.2a11.97 11.97 0 0 0 4.8 4.197A11.97 11.97 0 0 0 12 22c3.315 0 6.315-1.34 8.485-3.515a1 1 0 0 0-1.414-1.414A9.97 9.97 0 0 1 12 20a9.97 9.97 0 0 1-3.951-.806 10.04 10.04 0 0 1-3.134-1.79zM12.5 7.7 7.5 10.599v1.301l5 2.9 5-2.9v-1.301z"
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
