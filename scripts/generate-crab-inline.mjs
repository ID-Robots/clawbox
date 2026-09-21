// Regenerates src/lib/clawbox-crab-inline.ts from public/clawbox-crab.png.
//
// The reconnect overlays must render the mascot with the box's server already
// gone, so the bytes have to live in the JS bundle rather than behind a URL.
// Run this after changing the PNG; the drift guard in
// src/tests/components/reconnect-stage-offline-logo.test.tsx fails otherwise.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const png = readFileSync(join(root, "public", "clawbox-crab.png"));
const dataUri = `data:image/png;base64,${png.toString("base64")}`;

const source = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/generate-crab-inline.mjs

/**
 * The ClawBox crab mascot inlined as a base64 data URI (source of truth:
 * public/clawbox-crab.png, ${png.length} bytes).
 *
 * The reconnect/handoff overlays are shown precisely while the box's own
 * server is going away — the restart after an update, or the AP-to-LAN handoff
 * once WiFi credentials are saved. A logo sourced from a server path therefore
 * points at a dead socket at exactly the moment the overlay mounts, and the
 * user gets the browser's broken-image placeholder instead of the mascot. That
 * is doubly true of \`next/image\`, which rewrites the path to a
 * \`/_next/image?url=...\` request served by the very process that is
 * restarting. Every other usage renders fine only because the server is up.
 *
 * Inlining the bytes is what makes the mark render with zero network. The CSP
 * in next.config.ts already allows \`data:\` in \`img-src\`.
 */
export const CLAWBOX_CRAB_DATA_URI =
  "${dataUri}";
`;

writeFileSync(join(root, "src", "lib", "clawbox-crab-inline.ts"), source);
console.log(`wrote src/lib/clawbox-crab-inline.ts (${png.length} B PNG -> ${dataUri.length} B data URI)`);
