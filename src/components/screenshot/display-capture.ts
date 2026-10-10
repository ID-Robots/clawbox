// The browser's own screen capture (getDisplayMedia), as the Screenshot app's
// EXACT engine: one frame of this tab, pixel for pixel, including the windows
// the built-in renderer cannot read (sandboxed web apps, the PDF viewer).
//
// It is an upgrade, never the only way: it exists only in a secure context
// (https or localhost) on a desktop browser, and the box is usually opened
// over plain http, where `navigator.mediaDevices` is not even defined. The
// built-in renderer (dom-capture.ts) is what works everywhere.

import { CaptureError } from "./dom-capture";

export function displayCaptureSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

export interface DisplayCaptureResult {
  bitmap: HTMLCanvasElement;
  /** Bitmap pixels per CSS pixel when the owner shared THIS tab; null for a window or a whole screen. */
  scale: number | null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function captureDisplay(): Promise<DisplayCaptureResult> {
  if (!displayCaptureSupported()) {
    throw new CaptureError("unsupported", "The browser's screen capture is not available on this connection.");
  }
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
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // The first frames still show the browser's own "share this tab?" prompt fading out.
    await wait(350);
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
    const surface = track?.getSettings().displaySurface;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    return { bitmap, scale: surface === "browser" && viewportWidth > 0 ? bitmap.width / viewportWidth : null };
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
