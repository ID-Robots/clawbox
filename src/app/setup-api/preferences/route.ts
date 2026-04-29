import { NextResponse } from "next/server";
import * as config from "@/lib/config-store";
import fs from "fs/promises";

export const dynamic = "force-dynamic";

// Allowed preference keys (prefix-based whitelist)
const ALLOWED_PREFIXES = ["wp_", "desktop_", "ui_", "app_", "installed_", "icon_", "pinned_", "hidden_"];

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
    // When language changes, update OpenClaw agent workspace files
    if (body.ui_language && typeof body.ui_language === "string") {
      const LANG_NAMES: Record<string, string> = {
        en: "English", bg: "Български", de: "Deutsch", es: "Español",
        fr: "Français", it: "Italiano", ja: "日本語", nl: "Nederlands",
        sv: "Svenska", zh: "中文",
      };
      const lang = body.ui_language;
      const langName = LANG_NAMES[lang] ?? "English";
      const wsDir = "/home/clawbox/.openclaw/workspace";
      await fs.mkdir(wsDir, { recursive: true }).catch(() => {});

      // Update USER.md with language preference
      const userFile = `${wsDir}/USER.md`;
      try {
        let userMd = await fs.readFile(userFile, "utf-8").catch(() => "# USER.md - About Your Human\n");
        // Remove existing language line if present
        userMd = userMd.replace(/\n- \*\*Language:\*\*.*\n/g, "\n");
        // Add language preference after the header or at the end
        const langLine = `- **Language:** ${langName} (${lang})` + (lang !== "en"
          ? ` — Always respond in ${langName}`
          : "");
        if (userMd.includes("- **Name:**")) {
          userMd = userMd.replace(/(- \*\*Name:\*\*.*\n)/, `$1${langLine}\n`);
        } else {
          userMd = userMd.trimEnd() + `\n${langLine}\n`;
        }
        await fs.writeFile(userFile, userMd, "utf-8");
      } catch (err) {
        console.error(`[preferences] Failed to update ${userFile}:`, err instanceof Error ? err.message : err);
      }

      // Also write SOUL.md language instruction for strong enforcement
      if (lang !== "en") {
        const soulFile = `${wsDir}/SOUL.md`;
        try {
          let soulMd = await fs.readFile(soulFile, "utf-8").catch(() => "# SOUL.md - Who You Are\n");
          // Remove existing language section
          soulMd = soulMd.replace(/\n## Language\n[\s\S]*?(?=\n## |\n$|$)/, "");
          // Append language section
          soulMd = soulMd.trimEnd() + `\n\n## Language\n\nYou MUST respond in ${langName}. The user's preferred language is ${langName} (${lang}). All messages, explanations, and summaries must be in ${langName}. Only use English for code, technical terms, and tool names.\n`;
          await fs.writeFile(soulFile, soulMd, "utf-8");
        } catch (err) {
          console.error(`[preferences] Failed to update ${soulFile}:`, err instanceof Error ? err.message : err);
        }
      } else {
        // English — remove language section from SOUL.md if present
        const soulFile = `${wsDir}/SOUL.md`;
        try {
          let soulMd = await fs.readFile(soulFile, "utf-8").catch(() => "");
          if (soulMd.includes("## Language")) {
            soulMd = soulMd.replace(/\n## Language\n[\s\S]*?(?=\n## |\n$|$)/, "");
            await fs.writeFile(soulFile, soulMd.trimEnd() + "\n", "utf-8");
          }
        } catch (err) {
          console.error(`[preferences] Failed to update ${soulFile}:`, err instanceof Error ? err.message : err);
        }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[preferences] Invalid request:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
