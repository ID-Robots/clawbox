// The hand-offs between the Screenshot app's three pieces, which mount
// independently of one another:
//
//   the overlay (on the desktop, always)  — takes captures, also with the app closed
//   the app window                         — the editor
//   the Files app                          — "Annotate" on a picture
//
// A capture is a bitmap, which no window record or event `meta` (strings only)
// can carry, so it waits HERE until the app window — possibly one that is only
// just being opened — takes it.

import type { Rect } from "./geometry";
import type { CaptureMode } from "./shortcuts";
import { dispatchOpenApp } from "@/lib/ui-events";

export const SCREENSHOT_APP_ID = "screenshot";
export const CAPTURE_REQUEST_EVENT = "clawbox:screenshot-capture";

export type SkippedKind = "frame" | "canvas" | "media";

/** A surface a capture could not read, in the picture's CSS-pixel space. */
export interface SkippedSurface {
  kind: SkippedKind;
  label: string;
  rect: Rect;
}

export type CaptureEngineId = "dom" | "display";

export interface CaptureRequest {
  mode: CaptureMode;
  /** Seconds to wait before the picture is taken, so a menu can be opened first. */
  delay: number;
  engine: CaptureEngineId;
  /** Hidden for the moment of the capture — the Screenshot window itself. */
  hide?: HTMLElement | null;
}

export interface IncomingCapture {
  kind: "capture";
  bitmap: HTMLCanvasElement;
  engine: CaptureEngineId;
  skipped: SkippedSurface[];
  /** False when a region was asked for and the whole picture came back instead. */
  regionApplied: boolean;
}

export interface IncomingFile {
  kind: "file";
  /** Relative to the Files app's root. */
  relPath: string;
  name: string;
}

export type IncomingImage = IncomingCapture | IncomingFile;

let pending: IncomingImage | null = null;
const listeners = new Set<() => void>();
let overlays = 0;

/** Leaves an image for the app window. A newer one replaces one nobody took. */
export function offerImage(image: IncomingImage): void {
  pending = image;
  for (const listener of Array.from(listeners)) listener();
}

/** The waiting image, handed over once. */
export function takeImage(): IncomingImage | null {
  const image = pending;
  pending = null;
  return image;
}

export function subscribeImages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Leaves an image and brings the app window up (or to the front) to take it. */
export function openInScreenshot(image: IncomingImage): void {
  offerImage(image);
  dispatchOpenApp(SCREENSHOT_APP_ID);
}

/** Asks the overlay for a capture. */
export function requestCapture(request: CaptureRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CaptureRequest>(CAPTURE_REQUEST_EVENT, { detail: request }));
}

/** The overlay says it is there; the app mounts one of its own only when none is. */
export function registerOverlay(): () => void {
  overlays += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    overlays -= 1;
  };
}

export function overlayMounted(): boolean {
  return overlays > 0;
}
