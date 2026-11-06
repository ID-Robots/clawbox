// One capture of the desktop, by whichever engine was asked for, optionally
// cut down to a region. The Screenshot overlay calls this; it knows nothing of
// how the picture is made.

import { type Rect, captureScale, rectsIntersect, toPixelRect, translateRect } from "@/lib/screenshot/geometry";
import { type SkippedSurface, CaptureError, captureDocument } from "./dom-capture";
import { captureDisplay } from "./display-capture";
import { cropBitmap } from "./render";

/** "dom": the built-in renderer, everywhere. "display": the browser's screen capture, secure contexts only. */
export type CaptureEngine = "dom" | "display";

export interface ScreenCapture {
  bitmap: HTMLCanvasElement;
  engine: CaptureEngine;
  /** Surfaces drawn as a "not captured" tile, in the picture's own CSS-pixel space. */
  skipped: SkippedSurface[];
  /** False when a region was asked for but the browser shared something other than this tab. */
  regionApplied: boolean;
}

export interface CaptureOptions {
  engine: CaptureEngine;
  /** In viewport CSS pixels; absent for the whole screen. */
  region?: Rect | null;
  blockedLabel: string;
  /** Called as soon as the screen has been read, before the picture is finished. */
  onRead?: () => void;
}

/** The scale the built-in renderer draws at for this viewport — also what the region readout shows. */
export function currentCaptureScale(): number {
  if (typeof window === "undefined") return 1;
  return captureScale(
    {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    },
    window.devicePixelRatio || 1,
    8_000_000,
  );
}

export async function captureScreen(options: CaptureOptions): Promise<ScreenCapture> {
  const region = options.region ?? null;
  if (options.engine === "display") {
    let shot: Awaited<ReturnType<typeof captureDisplay>>;
    try {
      shot = await captureDisplay();
    } finally {
      options.onRead?.();
    }
    if (!region || shot.scale === null) {
      return { bitmap: shot.bitmap, engine: "display", skipped: [], regionApplied: !region };
    }
    const area = toPixelRect(region, shot.scale, shot.bitmap);
    if (area.width < 1 || area.height < 1) throw new CaptureError("render", "The selected area is empty.");
    return { bitmap: cropBitmap(shot.bitmap, area), engine: "display", skipped: [], regionApplied: true };
  }

  const shot = await captureDocument({
    scale: currentCaptureScale(),
    blockedLabel: options.blockedLabel,
    onRead: options.onRead,
  });
  if (!region) return { bitmap: shot.bitmap, engine: "dom", skipped: shot.skipped, regionApplied: true };
  const area = toPixelRect(region, shot.scale, shot.bitmap);
  if (area.width < 1 || area.height < 1) throw new CaptureError("render", "The selected area is empty.");
  return {
    bitmap: cropBitmap(shot.bitmap, area),
    engine: "dom",
    // Only what the region actually shows is worth telling the owner about.
    skipped: shot.skipped
      .filter((surface) => rectsIntersect(surface.rect, region))
      .map((surface) => ({ ...surface, rect: translateRect(surface.rect, -region.x, -region.y) })),
    regionApplied: true,
  };
}
