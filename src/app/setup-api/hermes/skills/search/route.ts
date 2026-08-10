export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import {
  type HermesSkill,
  clampInt,
  isValidQuery,
  isValidSource,
} from "@/lib/hermes-skills";
import { hermesSkillsGuard } from "@/lib/hermes-skills-server";

// Discovery for the Hermes Skills Store. `hermes skills search --json` is the
// only subcommand that emits machine-readable output (browse/list are
// table-only), so it's the sole backing for the store grid. The first search on
// a device builds a ~41 MB index and is slow — hence the generous timeout.

interface RawSearchItem {
  name?: unknown;
  identifier?: unknown;
  source?: unknown;
  trust_level?: unknown;
  description?: unknown;
}

function normalize(item: RawSearchItem): HermesSkill | null {
  const identifier = typeof item.identifier === "string" ? item.identifier.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  // Need at least an install id; fall back to the bare name if that's all we got.
  const id = identifier || name;
  if (!id) return null;
  return {
    id,
    name: name || id,
    description: typeof item.description === "string" ? item.description : undefined,
    source: typeof item.source === "string" ? item.source : undefined,
    trust: typeof item.trust_level === "string" ? item.trust_level : undefined,
  };
}

export async function GET(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  try {
    const params = new URL(request.url).searchParams;
    const q = (params.get("q") || "").trim();
    const source = (params.get("source") || "").trim();
    const limit = clampInt(params.get("limit"), 1, 50, 50);

    if (!isValidQuery(q)) {
      return NextResponse.json({ error: "Invalid query" }, { status: 400 });
    }
    if (limit === null) {
      return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
    }
    // `all` is the default firehose — omit the flag rather than pass it.
    if (source && !isValidSource(source)) {
      return NextResponse.json({ error: "Unknown source" }, { status: 400 });
    }

    const args = [
      "skills",
      "search",
      "--json",
      q,
      "--limit",
      String(limit),
    ];
    if (source && source !== "all") {
      args.push("--source", source);
    }

    const r = await runHermesCli(args, { timeoutMs: 60_000 });
    if (r.code !== 0) {
      return NextResponse.json({ error: r.stderr || "Search failed" }, { status: 502 });
    }

    let raw: unknown;
    try {
      raw = r.stdout ? JSON.parse(r.stdout) : [];
    } catch {
      // Non-JSON (e.g. an empty-result human message) → treat as no results.
      return NextResponse.json({ skills: [] });
    }
    const skills = Array.isArray(raw)
      ? raw.map((i) => normalize(i as RawSearchItem)).filter((s): s is HermesSkill => s !== null)
      : [];
    return NextResponse.json({ skills });
  } catch (err) {
    // runHermesCli rejects with "Hermes is not installed on this device" on
    // ENOENT — surface that message but never the binary path.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes search failed" },
      { status: 502 },
    );
  }
}
