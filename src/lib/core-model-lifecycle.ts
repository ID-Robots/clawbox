import fsSync from "fs";
import path from "path";
import { findOpenclawBin } from "@/lib/openclaw-config";

/**
 * Which models the INSTALLED core has retired.
 *
 * The picker's job is to offer what the box can usefully run, and the one
 * authority on that is the harness's own catalogue — not a list kept here. The
 * core publishes it per provider in `openclaw.plugin.json`, and every entry
 * carries a lifecycle:
 *
 *   { "id": "claude-opus-4-8", "status": "deprecated",
 *     "replacedBy": "claude-opus-5", … }
 *
 * WHY THIS FILE EXISTS AT ALL, given `models list --json` is right there.
 * Measured against the pinned core (2026.8.1) with an isolated
 * `OPENCLAW_HOME`:
 *
 *   $ openclaw models list --provider anthropic --all --json
 *   … { "key": "anthropic/claude-opus-4-8", "name": "Claude Opus 4.8",
 *       "contextWindow": 1000000, "available": null, "tags": [] } …
 *
 * The row is enumerated and its lifecycle is NOT projected — `toModelRow`
 * carries `tags` (which come from configured entries and aliases) and drops
 * `status` / `replacedBy` entirely. So the catalogue route's own
 * `entry.tags?.includes("deprecated")` guard could never fire on this core: a
 * filter that reads as deference to the harness, deferring to nothing. That
 * projection gap is worth reporting upstream; until it closes, the manifest is
 * where the answer lives and this reads it there.
 *
 * Reading the shipped manifest is not a new trick in this repo:
 * `scripts/gateway-pre-start.sh` resolves the same file for deepseek on every
 * boot, from the same two places, and `ai-models/configure` stats it.
 *
 * FAILS OPEN, everywhere. A box with no core, an unreadable manifest, a plugin
 * that ships none, a shape this does not recognise — all answer "not
 * deprecated", so the picker keeps offering exactly what it offers today. The
 * failure this must never have is the other one: a parse slip that empties a
 * customer's model list.
 */

export interface ModelLifecycle {
  /** The core marks this model retired. */
  deprecated: boolean;
  /** What it says to use instead, when it says. */
  replacedBy: string | null;
}

/** Cached per provider for the process: a manifest changes only with a core upgrade, which restarts this server. */
const cache = new Map<string, Map<string, ModelLifecycle>>();

/**
 * The two places the manifest lives, in the order `gateway-pre-start.sh` tries
 * them: bundled in the core's `dist/extensions`, or beside the config once
 * OpenClaw 2 unbundled the provider into its own installed plugin.
 */
function manifestPaths(provider: string): string[] {
  const bin = findOpenclawBin();
  const paths: string[] = [];
  if (path.isAbsolute(bin)) {
    paths.push(path.join(
      path.dirname(bin), "..", "lib", "node_modules", "openclaw",
      "dist", "extensions", provider, "openclaw.plugin.json",
    ));
  }
  // Resolved from the environment rather than from `CONFIG_PATH`, which is a
  // module constant frozen at import: the same shape `harness/credentials.ts`
  // and `local-ai-token.ts` already use for this directory.
  const openclawHome = process.env.OPENCLAW_HOME
    || path.join(process.env.HOME ?? "/home/clawbox", ".openclaw");
  paths.push(path.join(openclawHome, "extensions", provider, "openclaw.plugin.json"));
  return paths;
}

/**
 * Every `{id, status, replacedBy}` anywhere in the manifest.
 *
 * Walked rather than addressed by a fixed path on purpose: the shape has moved
 * between core generations (a provider block, a `modelCatalog`, per-auth-mode
 * variants), the ids are the same in all of them, and a path that goes stale
 * would silently answer "nothing is deprecated" — the exact failure this file
 * replaces. Anything without an `id` string is not a model row and is skipped.
 */
function collect(node: unknown, out: Map<string, ModelLifecycle>): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const row = node as { id?: unknown; status?: unknown; replacedBy?: unknown };
  if (typeof row.id === "string" && row.id.trim()) {
    const deprecated = typeof row.status === "string" && row.status.trim().toLowerCase() === "deprecated";
    const replacedBy = typeof row.replacedBy === "string" && row.replacedBy.trim() ? row.replacedBy.trim() : null;
    const id = row.id.trim();
    const existing = out.get(id);
    // A manifest names the same model more than once (once per auth mode). Any
    // occurrence marking it retired retires it — that is the conservative
    // direction, and the observed manifests agree with themselves anyway.
    out.set(id, {
      deprecated: deprecated || (existing?.deprecated ?? false),
      replacedBy: replacedBy ?? existing?.replacedBy ?? null,
    });
  }
  for (const value of Object.values(node as Record<string, unknown>)) collect(value, out);
}

function lifecycleFor(provider: string): Map<string, ModelLifecycle> {
  const cached = cache.get(provider);
  if (cached) return cached;
  const found = new Map<string, ModelLifecycle>();
  for (const file of manifestPaths(provider)) {
    let raw: string;
    try {
      raw = fsSync.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    try {
      collect(JSON.parse(raw), found);
    } catch {
      // A manifest we cannot parse is a manifest we know nothing from.
    }
    break;
  }
  cache.set(provider, found);
  return found;
}

/**
 * What the installed core says about this model, or null when it says nothing —
 * which is also the answer on a box with no core installed.
 *
 * `id` is the BARE id (`claude-opus-4-8`), the same form the catalogue route
 * carries after `modelIdFromKey`.
 */
export function coreModelLifecycle(provider: string, id: string): ModelLifecycle | null {
  if (!provider || !id) return null;
  return lifecycleFor(provider).get(id.trim()) ?? null;
}

/** Test seam: forget the manifests so the next call reads them again. */
export function resetCoreModelLifecycle(): void {
  cache.clear();
}
