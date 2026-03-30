import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME || "/home/clawbox";
const OPENCLAW_BIN = path.join(HOME, ".npm-global", "bin", "openclaw");

interface SkillInfo {
  name: string;
  description: string;
  emoji: string | null;
  eligible: boolean;
  primaryEnv: string | null;
  requiredEnv: string[];
  requiredBins: string[];
  requiredConfig: string[];
  source: string;
}

let cachedSkills: SkillInfo[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 30_000;

async function loadSkills(): Promise<SkillInfo[]> {
  if (cachedSkills && Date.now() - cacheTime < CACHE_TTL) return cachedSkills;
  try {
    const { stdout } = await execFileAsync(OPENCLAW_BIN, ["skills", "list", "--json"], {
      timeout: 15_000,
      env: { ...process.env, PATH: `${path.dirname(OPENCLAW_BIN)}:${process.env.PATH}` },
    });
    const data = JSON.parse(stdout);
    const skills = (data.skills || []) as Record<string, unknown>[];
    cachedSkills = skills.map((s) => ({
      name: (s.name as string) || "",
      description: (s.description as string) || "",
      emoji: (s.emoji as string) || null,
      eligible: !!(s.eligible),
      primaryEnv: (s.primaryEnv as string) || null,
      requiredEnv: ((s.missing as Record<string, unknown>)?.env as string[]) || [],
      requiredBins: ((s.missing as Record<string, unknown>)?.bins as string[]) || [],
      requiredConfig: ((s.missing as Record<string, unknown>)?.config as string[]) || [],
      source: (s.source as string) || "",
    }));
    cacheTime = Date.now();
    return cachedSkills;
  } catch (err) {
    console.warn("[skill-info] Failed to load skills:", err instanceof Error ? err.message : err);
    return cachedSkills || [];
  }
}

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("appId");
  const skills = await loadSkills();

  if (appId) {
    const skill = skills.find((s) => s.name === appId);
    if (!skill) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    return NextResponse.json(skill);
  }

  return NextResponse.json(skills);
}
