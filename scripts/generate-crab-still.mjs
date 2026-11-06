// Cuts the still crab out of the bundled ClawBox crab spritesheet (the
// `vibrant-clawd` pack — the slug is the directory name, the pack is the crab).
//
//   node scripts/generate-crab-still.mjs
//
// Writes public/clawbox-crab.png and docs-site/images/clawbox-crab.png, then
// tells you to rerun scripts/generate-crab-inline.mjs (the drift guard in
// src/tests/components/reconnect-stage-offline-logo.test.tsx fails otherwise).
// Also writes public/clawbox-crab-sleep.png: the same still with its eyes shut,
// which the desktop mascot's fail-open body wears while it sleeps.
//
// WHY A SCRIPT and not a one-off crop: the still and the animated mascot are
// the same drawing, and they have to stay the same drawing. Everything that is
// not the desktop mascot still renders this PNG — the login page, the desktop
// hero, both chat headers, the shelf, the ClawBox AI provider icon, the
// reconnect overlays through the inlined copy, and the docs site — so when the
// pack is redrawn, this reproduces all of it from the new sheet instead of
// leaving a year-old crab on half the product.
//
// The contract every one of those consumers depends on, and which this keeps:
//
//   - 192x192 px, transparent, the artwork FITTED inside it. Nothing sizes the
//     mascot off the file's own dimensions; they all draw it `object-contain`
//     into a box, so a change of aspect ratio is what would move things.
//   - cut from the IDLE row, first frame (cell 0,0) — the pose the pet rests in
//     and the same cell src/lib/hermes-pets.ts crops for the gallery thumbnail.
//   - trimmed to the ART's own alpha bounds first. A Petdex cell insets its
//     character by a different amount on every row, so keeping the cell's
//     padding would draw a crab two thirds the size of the old one.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEET = join(root, "public", "pets", "vibrant-clawd", "spritesheet.webp");
/** Petdex cell geometry — the same numbers as src/lib/pet-state-map.ts. */
const FRAME_W = 192;
const FRAME_H = 208;
/** The row the mascot sleeps on: `waiting`, in src/lib/pet-state-map.ts's
 *  Codex row order. Its frame 3 has the eyes open. */
const SLEEP_ROW = 6;
/** The square every consumer of the still draws into. */
const OUT_PX = 192;
/** Alpha at or below this is background, not art — antialiased edges included. */
const ALPHA_FLOOR = 8;

/** The art's bounding box inside one cell, measured off the alpha channel. */
async function artBounds(left, top) {
  const { data, info } = await sharp(SHEET)
    .extract({ left, top, width: FRAME_W, height: FRAME_H })
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] <= ALPHA_FLOOR) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error(`the idle frame at ${left},${top} is fully transparent`);
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const meta = await sharp(SHEET).metadata();
if (meta.width < FRAME_W || meta.height < FRAME_H) {
  throw new Error(`${SHEET} is ${meta.width}x${meta.height}: too small for one ${FRAME_W}x${FRAME_H} cell`);
}

/** One still: `box` of the sheet, fitted into the OUT_PX square. */
function cutStill(box) {
  return sharp(SHEET)
    .extract(box)
    .resize({
      width: OUT_PX,
      height: OUT_PX,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    // `palette` keeps the file — and the base64 copy inlined into the client
    // bundle for the offline overlays — in the tens of kilobytes rather than
    // the hundreds. The artwork is flat-shaded, so 256 colours is not a
    // visible loss.
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

const bounds = await artBounds(0, 0);
const png = await cutStill({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });

for (const out of [join(root, "public", "clawbox-crab.png"), join(root, "docs-site", "images", "clawbox-crab.png")]) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} B)`);
}
console.log(
  `idle frame art ${bounds.width}x${bounds.height} at ${bounds.left},${bounds.top} -> ${OUT_PX}x${OUT_PX}`,
);

// The SLEEPING still: the pack's first `sleepFrames` frame of the sleep row,
// cut through a window the size of the idle one — so it is scaled exactly as
// much — lowered to the sleeping frame's own feet. Fitted to its own bounds,
// the crab would grow and hop the moment it dozed off.
const pack = JSON.parse(readFileSync(join(dirname(SHEET), "pet.json"), "utf-8"));
const sleepCol = Number.isInteger(pack.sleepFrames?.[0]) ? pack.sleepFrames[0] : 0;
const sleep = await artBounds(sleepCol * FRAME_W, SLEEP_ROW * FRAME_H);
const sleepWindow = {
  left: bounds.left,
  top: sleep.top + sleep.height - bounds.height,
  width: bounds.width,
  height: bounds.height,
};
if (
  sleepWindow.top < 0 ||
  sleep.height > sleepWindow.height ||
  sleep.left < sleepWindow.left ||
  sleep.left + sleep.width > sleepWindow.left + sleepWindow.width
) {
  throw new Error(`the sleeping frame's art (${JSON.stringify(sleep)}) does not fit the idle still's window`);
}
const sleepPng = await cutStill({
  ...sleepWindow,
  left: sleepCol * FRAME_W + sleepWindow.left,
  top: SLEEP_ROW * FRAME_H + sleepWindow.top,
});
const sleepOut = join(root, "public", "clawbox-crab-sleep.png");
writeFileSync(sleepOut, sleepPng);
console.log(`wrote ${sleepOut} (${sleepPng.length} B) — sleep row ${SLEEP_ROW} frame ${sleepCol}`);
console.log("now run: node scripts/generate-crab-inline.mjs");
