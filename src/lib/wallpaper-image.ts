"use client";

import { useEffect, useState } from "react";

/**
 * An uploaded wallpaper has to be a PICTURE, and nothing used to ask.
 *
 * The desktop's Upload tile hands a file to a `FileReader`, keeps the data URL
 * in this browser's `localStorage` and points the box-wide `wp_id` at it. The
 * file input's `accept="image/*"` is only a hint: the picker's "All files"
 * filter, a drag onto the input or a renamed file all get past it. A text file
 * became `data:text/plain;base64,…`, was selected as the wallpaper, and the
 * desktop painted a background image that never loads over a black backing
 * colour — a black desktop, with nothing said (2026-10-13 smoke test).
 *
 * Two questions, and both are asked here:
 *
 *  - on the way IN (`readWallpaperFile`): is it declared as an image, and does
 *    the browser actually decode it? A `.txt` renamed to `.png` passes the
 *    first and fails the second.
 *  - on the way OUT (`isImageDataUrl`, `useUndecodableImage`): a list an older
 *    build already stored a non-picture in, or one that was edited by hand,
 *    must not paint black either — the desktop falls back to its default.
 *
 * The pictures never leave the browser (there is no upload route — only the
 * `wp_id` string reaches the box), so there is no server half to this check.
 */

/** Whether `value` is a data URL that at least CLAIMS to be an image. */
export function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-z0-9.+-]+[;,]/i.test(value);
}

/**
 * Whether the browser can decode `src` as a picture.
 *
 * Resolves on the image's own `load`/`error` — every browser fires exactly one
 * of them for a data URL, so there is no timer to race. A picture with no
 * pixels (`naturalWidth === 0`) counts as undecodable: it would paint nothing.
 */
export function decodesAsImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

function readAsDataUrl(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * The data URL for a file the owner picked as a wallpaper, or null when it is
 * not a picture this browser can show. Never throws.
 */
export async function readWallpaperFile(file: File): Promise<string | null> {
  // The declared type first: it is free, and it keeps a 2 GB video from being
  // read into memory only to be refused.
  if (!file.type.toLowerCase().startsWith("image/")) return null;
  const dataUrl = await readAsDataUrl(file);
  if (!isImageDataUrl(dataUrl)) return null;
  return (await decodesAsImage(dataUrl)) ? dataUrl : null;
}

/**
 * Whether the stored picture `src` turned out NOT to decode.
 *
 * False until the browser has said so — a good picture must not flash the
 * default while it is being checked — and false again as soon as `src` names a
 * different picture. Only an explicit decode error flips it.
 */
export function useUndecodableImage(src: string | undefined): boolean {
  const [undecodable, setUndecodable] = useState<string | null>(null);
  useEffect(() => {
    if (!isImageDataUrl(src)) return;
    let alive = true;
    void decodesAsImage(src).then((ok) => {
      if (alive && !ok) setUndecodable(src);
    });
    return () => { alive = false; };
  }, [src]);
  return src !== undefined && undecodable === src;
}

/**
 * Whether the custom picture a saved selection names can be painted: it has to
 * claim to be an image, and must not have failed to decode.
 */
export function isShowableCustomWallpaper(src: string | undefined, undecodable: boolean): boolean {
  return isImageDataUrl(src) && !undecodable;
}
