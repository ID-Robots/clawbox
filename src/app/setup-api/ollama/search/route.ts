export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { OLLAMA_MAX_MODEL_PARAM_B } from "@/lib/resource-limits";

/**
 * Search the Ollama model library and filter for models that can run
 * under the memory cap ollama.service has on this box.
 *
 * Strategy: fetch the Ollama website search page, extract model info
 * from the structured HTML, and filter by parameter size.
 */

// The size class the box can actually serve. Not "what fits in 8 GB": the
// cap is ollama.service's MemoryMax — see src/lib/resource-limits.ts and the
// "Known and deliberate" paragraph in config/clawbox-resource-limits.env.
const MAX_PARAM_BILLIONS = OLLAMA_MAX_MODEL_PARAM_B;

interface SearchResult {
  name: string;
  description: string;
  pulls: string;
  tags: string[];       // capability tags like "vision", "tools"
  sizes: string[];      // available parameter sizes like "3b", "7b", "360m"
}

/** "7b" → 7, "360m" → 0.36; NaN when it is not a size. */
function sizeInBillions(size: string): number {
  const m = /^(\d+(?:\.\d+)?)([bm])$/i.exec(size);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === "m" ? n / 1000 : n;
}

// WARNING: This function scrapes HTML from ollama.com. It is inherently fragile
// and may break if Ollama changes their page structure. Any field extraction
// (description, pulls, tags, sizes) should fail gracefully — only the model
// name is required for a result to be included.
function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Each model card is an <li> whose first child links to /library/<name>.
  // `<li\b` matters: `<li[^>]*>` also opened a block on every `<link …>` in
  // <head>, so the first "card" ran from the favicon through the site nav to
  // the first real </li> and its description became the nav text.
  const modelBlockRe = /<li\b[^>]*>[\s\S]*?<\/li>/gi;
  const blocks = html.match(modelBlockRe) || [];

  for (const block of blocks) {
    // Extract model name from link href="/library/<name>"
    const nameMatch = block.match(/href="\/library\/([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    // All remaining fields are best-effort — if any extraction fails,
    // we still keep the model with sensible defaults.
    let description = "";
    let pulls = "";
    let tags: string[] = [];
    let sizes: string[] = [];

    try {
      const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      description = descMatch
        ? descMatch[1].replace(/<[^>]+>/g, "").trim()
        : "";
    } catch { /* keep default */ }

    try {
      // The count and the word sit in separate spans joined by &nbsp;
      // (`<span>3.9M</span><span>&nbsp;Pulls</span>`), so match on the text.
      const text = block.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
      const pullMatch = text.match(/([\d.]+[KMB]?)\s+Pulls?\b/i);
      pulls = pullMatch ? pullMatch[1] : "";
    } catch { /* keep default */ }

    try {
      // Capability chips only — the same words in a description are prose.
      const tagMatches = block.matchAll(/<span[^>]*>\s*(vision|tools|thinking|code|embedding)\s*<\/span>/gi);
      tags = [...new Set([...tagMatches].map(m => m[1].toLowerCase()))];
    } catch { /* keep default */ }

    try {
      // "b" and "m": a family's sub-billion variants (smollm2 135m/360m) are
      // exactly the ones this box runs best, and dropping them left only the
      // largest size selectable. Case-sensitive: the pull count is "3.9M".
      const sizeMatches = block.match(/\b(\d+(?:\.\d+)?[bm])\b/g) || [];
      sizes = [...new Set(sizeMatches)];
    } catch { /* keep default */ }

    results.push({ name, description, pulls, tags, sizes });
  }

  return results;
}

function filterForJetson(results: SearchResult[]): (SearchResult & { filteredSizes: string[] })[] {
  return results
    .map((r) => {
      // Filter sizes to only those that fit under the memory cap
      const filteredSizes = r.sizes.filter((s) => {
        const num = sizeInBillions(s);
        return !isNaN(num) && num <= MAX_PARAM_BILLIONS;
      });
      // If no sizes listed, include the model (it might be small)
      // If sizes listed but none fit, exclude
      if (r.sizes.length > 0 && filteredSizes.length === 0) return null;
      return { ...r, filteredSizes: filteredSizes.length > 0 ? filteredSizes : r.sizes };
    })
    .filter((r): r is SearchResult & { filteredSizes: string[] } => r !== null);
}

// Short-lived in-memory cache to avoid hammering ollama.com on repeated searches
const searchCache = new Map<string, { results: (SearchResult & { filteredSizes: string[] })[]; ts: number }>();
const CACHE_TTL_MS = 45_000; // 45 seconds

/** `maxParamBillions` rides along so the picker's copy cannot drift from the filter. */
function answer(results: (SearchResult & { filteredSizes: string[] })[]) {
  return NextResponse.json({ results, maxParamBillions: MAX_PARAM_BILLIONS });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();

  if (!query) {
    return answer([]);
  }

  // Check cache first
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return answer(cached.results);
  }

  try {
    const res = await fetch(
      `https://ollama.com/search?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "ClawBox/1.0",
          "Accept": "text/html",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to search Ollama library" },
        { status: 502 },
      );
    }

    const html = await res.text();
    const allResults = parseSearchResults(html);
    const filtered = filterForJetson(allResults);
    const results = filtered.slice(0, 20);

    // Evict oldest entry before inserting to keep cache within limit
    if (searchCache.size >= 50) {
      const oldest = [...searchCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) searchCache.delete(oldest[0]);
    }
    searchCache.set(cacheKey, { results, ts: Date.now() });

    return answer(results);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 502 },
    );
  }
}
