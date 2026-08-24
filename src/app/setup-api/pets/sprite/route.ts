export const dynamic = "force-dynamic";

import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { hasHermesHarness } from "@/lib/edition-source";
import { loadPet, safePetSlug } from "@/lib/hermes-pets";

const MIME: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
};

/**
 * GET /setup-api/pets/sprite?slug=<slug>&rev=<revision>
 *
 * The active pet's spritesheet, straight off the device's own disk. This is
 * never a proxy for petdex.dev: the only bytes served are ones `hermes pets
 * install` already downloaded onto this machine at the user's request.
 *
 * `rev` is the sheet's `{mtime}:{size}` and is only a cache-buster — the
 * response is immutable for a year, so re-installing a pet (new mtime → new
 * rev → new URL) is what makes the browser refetch.
 */
export async function GET(request: Request) {
  if (!hasHermesHarness()) return new NextResponse(null, { status: 404 });

  const slug = safePetSlug(new URL(request.url).searchParams.get("slug"));
  if (!slug) return new NextResponse(null, { status: 400 });

  const pet = loadPet(slug);
  if (!pet) return new NextResponse(null, { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(pet.sheetPath);
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": MIME[path.extname(pet.sheetPath).toLowerCase()] || "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
