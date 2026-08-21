// -- Chat composer attachments ---------------------------------------------
//
// The state behind the attachment strip under the mascot chat composer, kept
// out of the component so the parts that can leak resources or hide a failure
// are testable without rendering a browser.
//
// Two things went wrong in the shipped version and both are fixed here.
//
// 1. There was no preview. An attachment rendered as a material icon plus its
//    file name, and a clipboard paste has no file name — the composer stamps
//    it `paste-<ts>-<idx>.png` so a burst of pastes cannot collide on disk.
//    So the one thing the customer needed to check, "is that the picture I
//    meant to send", was the one thing the interface could not show. With the
//    transcript not echoing the image either (TASK-436), a pasted image was
//    invisible everywhere in the product.
//
// 2. A failed upload was silent. The uploader returned early on a non-OK
//    response and swallowed exceptions into console.error, so a full disk or a
//    rejected file looked exactly like a paste that had not happened yet.
//
// Object URLs are the reason this is a module rather than three lines in the
// component: `URL.createObjectURL` pins the whole Blob in memory until it is
// revoked, and a chat surface that stays open all day pasting screenshots is
// precisely where that turns into a leak on an 8 GB box.

import { sanitizeErrorPayload } from "./safe-error-text";

export type ChatAttachment = {
  /** File name as staged on the box. */
  name: string;
  /** Absolute path under the OpenClaw media allowlist, named in the turn. */
  path: string;
  /** MIME type as reported by the browser. */
  type: string;
  /**
   * Object URL for a local thumbnail, present only for images. Undefined when
   * the file is not an image, or when the environment has no
   * `URL.createObjectURL` (jsdom, SSR) — a missing preview must degrade to the
   * icon, never throw.
   */
  previewUrl?: string;
};

/** Whether this attachment can be shown as a thumbnail. */
export function isPreviewableImage(type: string | undefined): boolean {
  return typeof type === "string" && type.startsWith("image/");
}

/**
 * A local object URL for `file`, or undefined when one cannot be made.
 *
 * Deliberately local: the staged copy on the box is behind a session-gated
 * route and fetching it back would be a second round trip for bytes the
 * browser already holds.
 */
export function createPreviewUrl(file: Blob & { type?: string }): string | undefined {
  if (!isPreviewableImage(file?.type)) return undefined;
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    // A browser that refuses to mint the URL still has a perfectly good
    // attachment; it just does not get a thumbnail.
    return undefined;
  }
}

/**
 * Release the object URLs held by `items`.
 *
 * Safe to call with attachments that have no preview, and safe to call twice —
 * revoking an already-revoked URL is a no-op in every browser, and callers
 * revoke on removal, on send and on unmount, which legitimately overlap.
 */
export function revokePreviews(items: readonly { previewUrl?: string }[] | undefined): void {
  if (!items?.length) return;
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const item of items) {
    if (!item?.previewUrl) continue;
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch {
      // Best effort: a failed revoke must not stop the rest of the list, and
      // must never take down a send.
    }
  }
}

/** Why an attachment could not be staged, in terms the composer can render. */
export type StagingFailure = {
  /** Translation key for the generic line. */
  reason: "tooLarge" | "rejected" | "session" | "box";
  /** A vetted message from the box, when it gave one that is safe to show. */
  detail: string | null;
};

/**
 * Classify a failed staging upload.
 *
 * Split by what the customer can actually do about it, which is the only
 * distinction worth making in a chat composer: shrink the file, pick a
 * different one, sign in again, or try again later. The status codes come from
 * `/setup-api/chat/attachments`, which answers 413 above its size ceiling,
 * 400 for a body only the caller can fix, and 500 for anything that is ours.
 */
export function classifyStagingFailure(status: number | undefined, payload: unknown): StagingFailure {
  const detail = sanitizeErrorPayload(payload);
  if (status === 413) return { reason: "tooLarge", detail };
  if (status === 401 || status === 403) return { reason: "session", detail };
  if (typeof status === "number" && status >= 400 && status < 500) return { reason: "rejected", detail };
  // No status at all means the request never completed — a dropped connection
  // or a gateway restart mid-upload. That is the box's problem, not the file's.
  return { reason: "box", detail };
}
