export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasHermesHarness } from "@/lib/edition-source";
import { petThumbnail, safePetSlug } from "@/lib/hermes-pets";

/**
 * GET /setup-api/pets/thumb?slug=<slug>
 *
 * One 192x208 PNG: the pet's idle frame, cropped server-side.
 *
 * The picker cannot simply `<img src>` the Petdex CDN — each sheet is 2.0-2.4
 * MB, thirteen tiles would be ~27 MB onto a Jetson, and hotlinking third-party
 * art from our own UI is the redistribution posture we are deliberately not
 * taking. Cropping here costs one fetch per pet, ever, and keeps ~5 KB.
 *
 * A pet whose thumbnail cannot be produced (offline, taken down, unreadable
 * sheet) 404s and the picker draws its name-only tile instead.
 */
export async function GET(request: Request) {
  if (!hasHermesHarness()) return new NextResponse(null, { status: 404 });

  const slug = safePetSlug(new URL(request.url).searchParams.get("slug"));
  if (!slug) return new NextResponse(null, { status: 400 });

  const png = await petThumbnail(slug);
  if (!png) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      // Short: the thumbnail of a not-yet-installed pet is derived from a
      // remote sheet that can change or disappear.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
