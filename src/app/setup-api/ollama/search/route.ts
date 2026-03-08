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

    // Extract description - usually in a <p> tag
    const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    // Extract pull count
    const pullMatch = block.match(/([\d.]+[KMB]?)\s*Pull/i);
    const pulls = pullMatch ? pullMatch[1] : "";

    // Extract capability tags (vision, tools, thinking, etc.)
    const tagMatches = block.match(/(?:vision|tools|thinking|code|embedding)/gi) || [];
    const tags = [...new Set(tagMatches.map(t => t.toLowerCase()))];

    // Extract parameter sizes (e.g., "1b", "3b", "7b", "8b", "70b")
    const sizeMatches = block.match(/\b(\d+(?:\.\d+)?b)\b/gi) || [];
    const sizes = [...new Set(sizeMatches.map(s => s.toLowerCase()))];

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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();

  if (!query) {
    return NextResponse.json({ results: [] });
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

    return NextResponse.json({ results: filtered.slice(0, 20) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 502 },
    );
  }
}
