import { NextResponse } from "next/server";
import * as config from "@/lib/config-store";
import fs from "fs/promises";

export const dynamic = "force-dynamic";

// Allowed preference keys (prefix-based whitelist)
const ALLOWED_PREFIXES = ["wp_", "desktop_", "ui_", "app_", "installed_", "icon_", "pinned_", "hidden_", "ff_"];

function isAllowed(key: string) {
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

// GET /setup-api/preferences?keys=wp_opacity,wp_bg_color
// GET /setup-api/preferences?all=1  (returns all pref:* keys)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const allParam = url.searchParams.get("all");

  if (allParam) {
    // Return all preferences
    const allConfig = await config.getAll();
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(allConfig)) {
      if (key.startsWith("pref:")) {
        result[key.slice(5)] = value;
      }
    }
    return NextResponse.json(result);
  }

  const keysParam = url.searchParams.get("keys");
  if (!keysParam) {
    return NextResponse.json({ error: "keys or all param required" }, { status: 400 });
  }
  const keys = keysParam.split(",").filter(isAllowed);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = await config.get(`pref:${key}`);
  }
  return NextResponse.json(result);
}

// POST /setup-api/preferences  { wp_opacity: 80, wp_bg_color: "#111" }
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (isAllowed(key)) {
        entries[`pref:${key}`] = value;
      }
    }
    if (Object.keys(entries).length > 0) {
      await config.setMany(entries);
    }
    // When language changes, update OpenClaw agent instruction
    if (body.ui_language && typeof body.ui_language === "string") {
      const LANG_NAMES: Record<string, string> = {
        en: "English", bg: "Български", de: "Deutsch", es: "Español",
        fr: "Français", it: "Italiano", ja: "日本語", nl: "Nederlands",
        sv: "Svenska", zh: "中文",
      };
      const lang = body.ui_language;
      const langName = LANG_NAMES[lang] ?? "English";
      const instruction = lang === "en"
        ? "Respond in English."
        : `IMPORTANT: Always respond in ${langName} (${lang}). The user's preferred language is ${langName}. All your messages, explanations, and tool output summaries must be in ${langName}.`;
      const langFile = "/home/clawbox/.openclaw/workspace/LANGUAGE.md";
      fs.writeFile(langFile, `# Language Preference\n\n${instruction}\n`, "utf-8").catch(() => {});
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
