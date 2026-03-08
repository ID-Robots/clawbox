export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

/**
 * Search the Ollama model library and filter for models that can run
 * on a Jetson Orin Nano with 8 GB shared RAM.
 *
 * Strategy: fetch the Ollama website search page, extract model info
 * from the structured HTML, and filter by parameter size.
 */

// Max parameter sizes that fit comfortably in 8 GB shared RAM
// (quantized Q4 of 7-8B is ~4-5 GB, leaving room for OS + Ollama overhead)
const MAX_PARAM_BILLIONS = 8;

interface SearchResult {
  name: string;
  description: string;
  pulls: string;
  tags: string[];       // capability tags like "vision", "tools"
  sizes: string[];      // available parameter sizes like "3b", "7b"
}

// WARNING: This function scrapes HTML from ollama.com. It is inherently fragile
// and may break if Ollama changes their page structure. Any field extraction
// (description, pulls, tags, sizes) should fail gracefully — only the model
// name is required for a result to be included.
function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Each model card is in an <li> element with an <a> linking to the model
  // The structure has: model name, description, tags, sizes, pull count
  // We'll extract using regex patterns on the HTML

  // Match model entries - the search page has a list structure
  // Model names appear as links: /library/<name>
  const modelBlockRe = /<li[^>]*>[\s\S]*?<\/li>/gi;
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
      const pullMatch = block.match(/([\d.]+[KMB]?)\s*Pull/i);
      pulls = pullMatch ? pullMatch[1] : "";
    } catch { /* keep default */ }

    try {
      const tagMatches = block.match(/(?:vision|tools|thinking|code|embedding)/gi) || [];
      tags = [...new Set(tagMatches.map(t => t.toLowerCase()))];
    } catch { /* keep default */ }

    try {
      const sizeMatches = block.match(/\b(\d+(?:\.\d+)?b)\b/gi) || [];
      sizes = [...new Set(sizeMatches.map(s => s.toLowerCase()))];
    } catch { /* keep default */ }

    results.push({ name, description, pulls, tags, sizes });
  }

  return results;
}

function filterForJetson(results: SearchResult[]): (SearchResult & { filteredSizes: string[] })[] {
  return results
    .map((r) => {
      // Filter sizes to only those that fit in 8GB RAM
      const filteredSizes = r.sizes.filter((s) => {
        const num = parseFloat(s.replace(/b$/i, ""));
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();

  if (!query) {
    return NextResponse.json({ results: [] });
  }

  // Check cache first
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json({ results: cached.results });
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

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 502 },
    );
  }
}
