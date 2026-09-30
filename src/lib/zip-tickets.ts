import { randomBytes } from "crypto";

// ── A selection, downloaded as one ZIP ──────────────────────────────────────
//
// The Files app's multi-select download names the items it wants, and there
// can be thousands of them ("Select all" in a folder of photos). A GET that
// carried the list in its query string would pass Node's 16 KiB header limit
// long before that, and a download has to be a GET — an `<a download>` is what
// lets the browser stream the archive to disk instead of the page holding it
// in memory. So the list travels in a POST, which answers what the archive
// would hold (the "too many files" refusal comes back there, before anything
// starts) and a TICKET; the download is then a plain link that redeems it.
//
// A ticket holds browse-RELATIVE paths, never absolute ones: the download
// re-resolves each through the route's own `safePath`, so an item that became
// a protected path, or was moved away, between the POST and the GET is
// judged by the rule in force when its bytes are read.

/** How long a ticket can be redeemed for. A download starts within seconds; ten minutes covers a retry. */
export const ZIP_TICKET_TTL_MS = 10 * 60 * 1000;

/** Live tickets at once; the oldest goes first. One owner does not start sixty-four downloads. */
export const MAX_ZIP_TICKETS = 64;

export interface ZipTicket {
  /** Browse-relative paths of the selected items, in the order they go into the archive. */
  rels: string[];
  /** The name each item takes at the top of the archive (deduplicated). */
  names: string[];
  /** The archive's own file name. */
  archiveName: string;
  expiresAt: number;
}

const TICKET_RE = /^[0-9a-f]{32}$/;

// On globalThis so a dev-server module reload does not strand a ticket the
// POST just handed out; one process serves both halves in production.
const store: Map<string, ZipTicket> = (() => {
  const g = globalThis as typeof globalThis & { __clawboxZipTickets?: Map<string, ZipTicket> };
  g.__clawboxZipTickets ??= new Map();
  return g.__clawboxZipTickets;
})();

function prune(now: number): void {
  for (const [id, ticket] of store) {
    if (ticket.expiresAt <= now) store.delete(id);
  }
}

/** Keep `ticket` for `ZIP_TICKET_TTL_MS` and answer the id that redeems it. */
export function issueZipTicket(ticket: Omit<ZipTicket, "expiresAt">, now = Date.now()): string {
  prune(now);
  while (store.size >= MAX_ZIP_TICKETS) {
    // Map iteration is insertion order: the first key is the oldest ticket.
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  const id = randomBytes(16).toString("hex");
  store.set(id, { ...ticket, expiresAt: now + ZIP_TICKET_TTL_MS });
  return id;
}

/**
 * The ticket `id` names, or null for one that is malformed, unknown or
 * expired. Not single-use: a browser that retries a download, or asks for it
 * twice, gets the same archive until the ticket runs out.
 */
export function redeemZipTicket(id: unknown, now = Date.now()): ZipTicket | null {
  if (typeof id !== "string" || !TICKET_RE.test(id)) return null;
  prune(now);
  return store.get(id) ?? null;
}

/**
 * `names` made unique for the top of one archive: a selection drawn from
 * search results can hold two `README.md`s from different folders, and two
 * entries of one name would unzip as one file overwriting the other.
 */
export function uniqueArchiveNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 2; ; n += 1) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  });
}
