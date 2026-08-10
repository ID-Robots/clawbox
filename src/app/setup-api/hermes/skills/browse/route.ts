export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { type HermesSkill, isValidSource, clampInt } from "@/lib/hermes-skills";
import { hermesSkillsGuard } from "@/lib/hermes-skills-server";

// Default listing for the store's Browse tab. `hermes skills browse` is the
// "show everything" command but emits only a Rich table (no --json). We render
// it at a wide COLUMNS so each skill is a single row, then parse the box-drawing
// table. Continuation rows (blank #) carry wrapped identifier/description tails.
function parseBrowse(out: string): HermesSkill[] {
  const skills: HermesSkill[] = [];
  let last: HermesSkill | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("│")) continue;
    // cells: ["", num, name, description, source, trust, identifier, ""]
    const cells = line.split("│").map((c) => c.trim());
    if (cells.length < 7) continue;
    const num = cells[1];
    if (/^\d+$/.test(num)) {
      const trust = cells[5].replace(/^★\s*/, "").trim();
      last = {
        id: cells[6],
        name: cells[2],
        description: cells[3] || undefined,
        source: cells[4] || undefined,
        trust: trust || undefined,
      };
      if (last.id && last.name) skills.push(last);
      else last = null;
    } else if (num === "" && last) {
      // Wrapped tail of the previous row.
      if (cells[6]) last.id += cells[6];
      if (cells[3]) last.description = `${last.description || ""} ${cells[3]}`.trim();
    }
  }
  // Post-process: a truncated name ("3-statement…") is unreliable — derive it
  // from the (now-complete) identifier leaf. Trim the description ellipsis.
  for (const s of skills) {
    if (/[…]|\.\.\.$/.test(s.name)) {
      const leaf = s.id.split("/").pop();
      if (leaf) s.name = leaf;
    }
    if (s.description) {
      s.description = s.description.replace(/\s*(?:…|\.\.\.)\s*$/, "").trim() || undefined;
    }
  }
  return skills;
}

export async function GET(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  try {
    const params = new URL(request.url).searchParams;
    const source = (params.get("source") || "").trim();
    const page = clampInt(params.get("page"), 1, 100000, 1);
    const size = clampInt(params.get("size"), 1, 50, 30);
    if (page === null) return NextResponse.json({ error: "Invalid page" }, { status: 400 });
    if (size === null) return NextResponse.json({ error: "Invalid size" }, { status: 400 });
    if (source && !isValidSource(source)) {
      return NextResponse.json({ error: "Unknown source" }, { status: 400 });
    }

    const args = ["skills", "browse", "--page", String(page), "--size", String(size)];
    if (source && source !== "all") args.push("--source", source);

    // Wide terminal → one row per skill (identifiers/names don't wrap).
    const r = await runHermesCli(args, { timeoutMs: 60_000, env: { COLUMNS: "400" } });
    if (r.code !== 0) {
      return NextResponse.json({ error: r.stderr || "Browse failed" }, { status: 502 });
    }
    const skills = parseBrowse(r.stdout);
    const m = r.stdout.match(/page\s+(\d+)\/(\d+)/i);
    const hasMore = m ? Number(m[1]) < Number(m[2]) : false;
    return NextResponse.json({ skills, page, hasMore });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes browse failed" },
      { status: 502 },
    );
  }
}
