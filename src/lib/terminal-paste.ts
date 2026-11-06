// Pasting a PICTURE into the Terminal. Pure and client-safe: the browser uses
// it to find the picture in a paste and to send it, the route to judge what
// arrived. Where the file lands on disk is terminal-paste-store.ts's business.
//
// A terminal carries text, so a picture cannot be pasted INTO it. What can be
// pasted is the path of a file — and a program that takes pictures that way
// (Claude Code: a pasted absolute path ending in an image extension, whose
// bytes really are that image, becomes an attachment) does the rest. So the
// picture is uploaded to the box, saved, and its path is what the terminal
// pastes; at a plain shell prompt the owner gets the path, which is as much
// as a shell can do with a picture.

/**
 * The largest picture the route accepts. Under 10 MiB for the reason
 * MAX_SCREENSHOT_BYTES is: Next keeps only the first 10 MiB of a request body
 * on a path the middleware matches, WITHOUT failing the request.
 */
export const TERMINAL_PASTE_MAX_BYTES = 9 * 1024 * 1024;

export const TERMINAL_PASTE_ROUTE = "/setup-api/terminal/paste-image";

/** The formats a pasted path may name — exactly the ones Claude Code attaches. */
export type PastedImageFormat = "png" | "jpg" | "gif" | "webp";

/** Why a pasted picture was not saved. Stable: the Terminal words each one. */
export type TerminalPasteRefusal =
  | "empty"
  | "incomplete"
  | "too_large"
  | "not_an_image"
  | "disk_full"
  | "unsafe_folder"
  | "write_failed"
  | "cross_origin"
  | "owner_only";

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** What the bytes really are, from their signature. The browser's `type` is only a claim. */
export function sniffPastedImage(bytes: Uint8Array): PastedImageFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  // "GIF87a" / "GIF89a"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  // "RIFF" <size> "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** The part of a paste or a drop this module reads. */
export interface PasteData {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
  getData?(format: string): string;
}

/** The pictures a paste carries, in the clipboard's own order. [] for a paste of text. */
export function pastedImageFiles(data: PasteData | null | undefined): File[] {
  const items = data?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** The paste's text, or "" where it has none (or cannot say). */
export function pastedText(data: PasteData | null | undefined): string {
  try {
    return data?.getData?.("text/plain") ?? "";
  } catch {
    return "";
  }
}

/**
 * A path this module will hand to a terminal: absolute, one of the four
 * extensions, and made of nothing a shell reads as anything but a file name.
 * The answer comes from the box's own route — and is still checked, because
 * what is done with it next is typing it at the owner's prompt.
 */
const SAFE_PASTED_PATH = /^\/[A-Za-z0-9._\-/]+\.(?:png|jpe?g|gif|webp)$/;

export function isSafePastedPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && SAFE_PASTED_PATH.test(value) && !value.includes("..");
}

/**
 * What the program in front does with a pasted picture's path — the box's
 * answer to the Terminal's `foreground` question, decided where the processes
 * can be seen (scripts/terminal-foreground.mjs):
 *
 * - `claude`: Claude Code attaches it. It always reads pastes as pastes, so
 *   the path may be sent to it marked as one whatever xterm believes.
 * - `shell`: a shell at its prompt, where the path is what the owner gets.
 * - null: anything else — an editor, a pager, a REPL, a script — or a box
 *   that could not say. Plain Ctrl+V there is the program's own key (vim's
 *   block select, nano's next page), and nothing the browser can see tells
 *   those programs from a prompt: vim and nano take pastes exactly as one does.
 */
export type PictureTaker = "claude" | "shell" | null;

/** The box's answer, or null for anything that is not one of the two. */
export function asPictureTaker(value: unknown): PictureTaker {
  return value === "claude" || value === "shell" ? value : null;
}

/** A path as a paste, marked so a program reads it as one: ESC[200~ … ESC[201~. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** An upload that has not answered in this long is not going to. */
export const TERMINAL_PASTE_UPLOAD_TIMEOUT_MS = 60_000;

export type PasteUpload =
  | { ok: true; path: string }
  | { ok: false; code: TerminalPasteRefusal | "network" | "unknown" };

const KNOWN_REFUSALS: ReadonlySet<string> = new Set<TerminalPasteRefusal>([
  "empty", "incomplete", "too_large", "not_an_image", "disk_full", "unsafe_folder", "write_failed", "cross_origin", "owner_only",
]);

/** Send one pasted picture to the box. Never throws: every ending is a value. */
export async function uploadPastedImage(file: Blob, fetchImpl: typeof fetch = fetch): Promise<PasteUpload> {
  if (file.size === 0) return { ok: false, code: "empty" };
  // Said here, before anything is sent: past the cap the body would arrive cut.
  if (file.size > TERMINAL_PASTE_MAX_BYTES) return { ok: false, code: "too_large" };
  let res: Response;
  try {
    res = await fetchImpl(TERMINAL_PASTE_ROUTE, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
      // Without one, a request that never settles leaves "Pasting the picture…" up for good.
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(TERMINAL_PASTE_UPLOAD_TIMEOUT_MS)
        : undefined,
    });
  } catch {
    return { ok: false, code: "network" };
  }
  let body: { path?: unknown; code?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && isSafePastedPath(body?.path)) return { ok: true, path: body.path };
  const code = typeof body?.code === "string" && KNOWN_REFUSALS.has(body.code) ? (body.code as TerminalPasteRefusal) : "unknown";
  return { ok: false, code };
}
