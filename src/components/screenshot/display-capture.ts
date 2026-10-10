// The browser's own screen capture (getDisplayMedia), as the Screenshot app's
// EXACT engine: one frame of this tab, pixel for pixel, including the windows
// the built-in renderer cannot read (sandboxed web apps, the PDF viewer).
//
// It is an upgrade, never the only way: it exists only in a secure context
// (https or localhost) on a desktop browser, and the box is usually opened
// over plain http, where `navigator.mediaDevices` is not even defined. The
// built-in renderer (dom-capture.ts) is what works everywhere.

import { sharedTabIsThisTab, sharedTabScale } from "@/lib/screenshot/geometry";
import { CaptureError } from "./dom-capture";

/** Chromium's Capture Handle API: lets a capturing page learn WHICH tab it was given. */
type CaptureHandleDevices = MediaDevices & {
  setCaptureHandleConfig?: (config: { handle: string; permittedOrigins: string[] }) => void;
};
type CaptureHandleTrack = MediaStreamTrack & { getCaptureHandle?: () => { handle?: string } | null };

/** How long a tab's mark is waited for once a stream is running; a tab that is not this one never shows it. */
const HANDLE_WAIT_MS = 1200;
/** The first frames still show the browser's own "share this tab?" prompt fading out. */
const FIRST_FRAME_MS = 350;

/** undefined: not tried yet. null: this browser cannot mark a tab. */
let tabMark: string | null | undefined;

/**
 * Marks this tab, once, so that a frame of it can be told from a frame of any
 * other tab the picker offered. Done as soon as the engine is offered
 * (`prepareDisplayCapture`) — long before a capture — because the mark reaches
 * the browser's capture side asynchronously and a capture started in the same
 * breath may not carry it yet.
 */
function markThisTab(): string | null {
  if (tabMark !== undefined) return tabMark;
  tabMark = null;
  const devices = navigator.mediaDevices as CaptureHandleDevices;
  if (typeof devices.setCaptureHandleConfig !== "function") return tabMark;
  const handle = `clawbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    devices.setCaptureHandleConfig({ handle, permittedOrigins: [window.location.origin] });
    tabMark = handle;
  } catch {
    tabMark = null;
  }
  return tabMark;
}

export function displayCaptureSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/** Gets this tab ready to be recognised in a later capture. Call it when the engine is first offered. */
export function prepareDisplayCapture(): void {
  if (displayCaptureSupported()) markThisTab();
}

export interface DisplayCaptureResult {
  bitmap: HTMLCanvasElement;
  /** Bitmap pixels per CSS pixel when the owner shared THIS tab; null for another tab, a window or a whole screen. */
  scale: number | null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The mark of the tab a track is showing, waited for briefly; null when it shows none. */
async function capturedMark(track: CaptureHandleTrack, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    let handle: string | null = null;
    try {
      handle = track.getCaptureHandle?.()?.handle || null;
    } catch {
      handle = null;
    }
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await wait(50);
  }
}

export async function captureDisplay(): Promise<DisplayCaptureResult> {
  if (!displayCaptureSupported()) {
    throw new CaptureError("unsupported", "The browser's screen capture is not available on this connection.");
  }
  const mark = markThisTab();
  let stream: MediaStream;
  try {
    // `preferCurrentTab` and friends are Chromium's; other browsers ignore them and show their usual picker.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
    } as DisplayMediaStreamOptions);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "AbortError") {
      throw new CaptureError("denied", "The screen capture was cancelled.");
    }
    throw new CaptureError("unsupported", "The browser's screen capture could not start.");
  }
  try {
    const track = stream.getVideoTracks()[0] as CaptureHandleTrack | undefined;
    const surface = track?.getSettings().displaySurface;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    // "A browser tab" is ANY tab the picker offered, not necessarily this one,
    // and a region cut out of another tab's frame would be the wrong picture
    // presented as the right one. Where the browser can say whose tab it is,
    // only a frame carrying this tab's mark is treated as this tab.
    const canIdentify = mark !== null && typeof track?.getCaptureHandle === "function";
    const [seen] = await Promise.all([
      surface === "browser" && canIdentify && track ? capturedMark(track, HANDLE_WAIT_MS) : Promise.resolve(null),
      wait(FIRST_FRAME_MS),
    ]);

    if (!video.videoWidth || !video.videoHeight) {
      throw new CaptureError("render", "The browser shared an empty picture.");
    }
    const bitmap = document.createElement("canvas");
    bitmap.width = video.videoWidth;
    bitmap.height = video.videoHeight;
    const context = bitmap.getContext("2d");
    if (!context) throw new CaptureError("render", "This browser cannot draw to a canvas.");
    context.drawImage(video, 0, 0);
    video.srcObject = null;

    const scale = sharedTabScale({
      surface,
      sameTab: sharedTabIsThisTab({ mark, canIdentify, seen }),
      frame: bitmap,
      viewport: {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
      },
    });
    return { bitmap, scale };
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
