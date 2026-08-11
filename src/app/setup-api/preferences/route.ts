import { NextResponse } from "next/server";
import * as config from "@/lib/config-store";
import fs from "fs/promises";
import path from "path";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { sanitizePreferences, validatePreference } from "@/lib/preference-schema";

export const dynamic = "force-dynamic";

// Allowed preference keys (prefix-based whitelist)
const ALLOWED_PREFIXES = ["wp_", "desktop_", "ui_", "app_", "installed_", "icon_", "pinned_", "hidden_"];

function isAllowed(key: string) {
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

// Where the RUNNING agent reads its persona from. Writing the language
// preference into the other harness's files is a silent no-op: OpenClaw scans
// ~/.openclaw/workspace, Hermes reads SOUL.md from its own home and USER.md
// from the memories/ directory beside it (agent/prompt_builder.py resolves
// both against HERMES_HOME). On a ClawBox those Hermes paths are symlinks to
// the shared ~/.clawbox/agent-identity bridge, so a write here follows through
// to the canonical files and both harnesses stay in step.
function personaFilesFor(harness: Harness): { userFile: string; soulFile: string } {
  if (harness === "hermes") {
    const home = process.env.HOME || "/home/clawbox";
    const hermesHome = process.env.HERMES_HOME || path.join(home, ".hermes");
    return {
      userFile: path.join(hermesHome, "memories", "USER.md"),
      soulFile: path.join(hermesHome, "SOUL.md"),
    };
  }
  const wsDir = "/home/clawbox/.openclaw/workspace";
  return { userFile: `${wsDir}/USER.md`, soulFile: `${wsDir}/SOUL.md` };
}

const LANG_NAMES: Record<string, string> = {
  en: "English", bg: "Български", de: "Deutsch", es: "Español",
  fr: "Français", it: "Italiano", ja: "日本語", nl: "Nederlands",
  sv: "Svenska", zh: "中文",
};

// Rewrite the persona files for `lang`. Byte-for-byte the same content the
// OpenClaw path has always written — only the target paths vary by harness.
async function writeLanguagePersona(lang: string, files: { userFile: string; soulFile: string }) {
  const langName = LANG_NAMES[lang] ?? "English";
  const { userFile, soulFile } = files;
  await fs.mkdir(path.dirname(userFile), { recursive: true }).catch(() => {});
  await fs.mkdir(path.dirname(soulFile), { recursive: true }).catch(() => {});

  // Update USER.md with language preference
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

// GET /setup-api/preferences?keys=wp_opacity,wp_bg_color
// GET /setup-api/preferences?all=1  (returns all pref:* keys)
//
// Values are run through the same rules the write path enforces. A value
// stored before those rules existed is DROPPED rather than served: this
// endpoint feeds the agent-callable `preferences_get` tool, so anything the
// store still holds from an older, unvalidated write must not reach a caller.
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
    return NextResponse.json(sanitizePreferences(result));
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
  return NextResponse.json(sanitizePreferences(result));
}

// POST /setup-api/preferences  { wp_opacity: 80, wp_bg_color: "#111" }
//
// Every value is validated before it is stored. The request is rejected whole
// rather than partially applied — a caller that sent an impossible value
// should learn that, not have the rest of its bundle silently land.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!isAllowed(key)) continue;
      const check = validatePreference(key, value);
      if (!check.ok) {
        console.error(`[preferences] Rejected write: ${check.reason}`);
        return NextResponse.json({ error: check.reason ?? "Invalid preference value" }, { status: 400 });
      }
      entries[`pref:${key}`] = value;
    }
    if (Object.keys(entries).length > 0) {
      await config.setMany(entries);
    }
    // When language changes, update the persona files of the harness that is
    // actually running. Validation above already constrained ui_language to a
    // locale we ship, so nothing free-form reaches the agent's system prompt.
    if (typeof body.ui_language === "string" && body.ui_language) {
      await writeLanguagePersona(body.ui_language, personaFilesFor(await getActiveHarness()));
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[preferences] Invalid request:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
