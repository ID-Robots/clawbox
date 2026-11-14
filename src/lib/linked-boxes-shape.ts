/**
 * Linked ClawBoxes — the owner's other boxes, switched to like workspaces
 * (Ctrl+Shift+1 … Ctrl+Shift+9). The list's rules, shared by the route that
 * stores it (`src/lib/linked-boxes.ts`), the Settings panel that edits it and
 * the desktop's switcher (`src/lib/box-switcher.ts`). Pure: no fs, no DOM.
 *
 * Slot 1 is always THIS box, so the stored list holds the other eight at most.
 * A box is a name and the address of its desktop, http or https only, rebuilt
 * as `<origin>/`: the desktop is always the root page, and a pasted
 * `/login?next=…` or a fragment is never part of a box's address (the
 * switcher writes its own fragment, see box-switcher.ts).
 */

/** Slot 1 is this box; slots 2–9 are the stored list. */
export const MAX_LINKED_BOXES = 8;
export const MAX_BOX_NAME_LENGTH = 40;
export const MAX_BOX_URL_LENGTH = 300;

export interface LinkedBox {
  name: string;
  /** The box's desktop, `<origin>/`. */
  url: string;
}

/** Why a list was refused. Stable codes: the route answers them and Settings words them. */
export type LinkedBoxesError = "invalid_body" | "too_many" | "invalid_name" | "invalid_url" | "duplicate" | "self";

// C0 and C1 controls, DEL, and the bidi overrides that could make a name read
// as something it is not.
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** A box's name, trimmed and with runs of spaces folded, or null. */
export function normalizeBoxName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (NAME_FORBIDDEN.test(raw.replace(/[\t\n\r]/g, " "))) return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || [...name].length > MAX_BOX_NAME_LENGTH) return null;
  return name;
}

/**
 * A box's desktop address as `<origin>/`, or null. A bare host
 * (`laptop.local`, `laptop.local:3005`, `192.0.2.10`) is read as http://, the
 * way a browser's address bar reads it; any other scheme, a user name or a
 * password in the address, and anything that is not a URL are refused.
 */
export function normalizeBoxUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > MAX_BOX_URL_LENGTH) return null;
  if (/\s/.test(text)) return null;
  let withScheme: string;
  if (/^https?:\/\//i.test(text)) withScheme = text;
  else if (text.includes("://") || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null;
  else withScheme = `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  const out = `${url.origin}/`;
  return out.length <= MAX_BOX_URL_LENGTH ? out : null;
}

/**
 * A loopback host: `localhost`, 127.0.0.0/8, `::1`. From any browser that is
 * the machine the browser runs on, never another ClawBox.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(h) || h === "::1";
}

/** The origin of a box address (or of any http(s) URL), or null. */
export function boxOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * A list as WRITTEN — every entry must be good, or the whole list is refused
 * with the first entry's reason (`index` names it, 0-based).
 */
export function parseLinkedBoxesWrite(
  raw: unknown,
  opts: { selfHosts?: readonly string[] } = {},
): { ok: true; boxes: LinkedBox[] } | { ok: false; code: LinkedBoxesError; index?: number } {
  // This box under the address the request reached it by (host:port, lower
  // case) — always slot 1, never a slot of its own.
  const selfHosts = new Set((opts.selfHosts ?? []).map((h) => h.toLowerCase()));
  if (!Array.isArray(raw)) return { ok: false, code: "invalid_body" };
  if (raw.length > MAX_LINKED_BOXES) return { ok: false, code: "too_many" };
  const boxes: LinkedBox[] = [];
  const origins = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, code: "invalid_body", index: i };
    const name = normalizeBoxName((entry as { name?: unknown }).name);
    if (name === null) return { ok: false, code: "invalid_name", index: i };
    const url = normalizeBoxUrl((entry as { url?: unknown }).url);
    if (url === null) return { ok: false, code: "invalid_url", index: i };
    const parsed = new URL(url);
    if (isLoopbackHost(parsed.hostname) || selfHosts.has(parsed.host)) return { ok: false, code: "self", index: i };
    const origin = parsed.origin;
    if (origins.has(origin)) return { ok: false, code: "duplicate", index: i };
    origins.add(origin);
    boxes.push({ name, url });
  }
  return { ok: true, boxes };
}

/**
 * A list as READ — from the stored file, or a route's answer in the browser:
 * whatever is not a good entry is dropped, a second entry for the same box
 * too, and at most MAX_LINKED_BOXES are kept.
 */
export function parseLinkedBoxesRead(raw: unknown): LinkedBox[] {
  if (!Array.isArray(raw)) return [];
  const boxes: LinkedBox[] = [];
  const origins = new Set<string>();
  for (const entry of raw) {
    if (boxes.length >= MAX_LINKED_BOXES) break;
    if (typeof entry !== "object" || entry === null) continue;
    const name = normalizeBoxName((entry as { name?: unknown }).name);
    const url = normalizeBoxUrl((entry as { url?: unknown }).url);
    if (name === null || url === null) continue;
    const origin = boxOrigin(url)!;
    if (origins.has(origin)) continue;
    origins.add(origin);
    boxes.push({ name, url });
  }
  return boxes;
}
