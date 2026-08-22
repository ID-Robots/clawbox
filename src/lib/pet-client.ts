// ── Client-side view of the active Hermes pet ──
//
// One shared fetch of `/setup-api/pets`, so the mascot and the Settings picker
// do not each pay for it, and one event so a pick in Settings reaches the
// mascot without a page reload.

export interface PetDescriptor {
  slug: string;
  displayName: string;
  submittedBy: string;
  revision: string;
  frameW: number;
  frameH: number;
  cols: number;
  rows: number;
  framesPerState: number;
  loopMs: number;
}

export interface PetStatus {
  /** False on OpenClaw — there is no Hermes on the box, so there are no pets. */
  supported: boolean;
  edition: string;
  enabled: boolean;
  active: PetDescriptor | null;
}

const OFF: PetStatus = { supported: false, edition: "openclaw", enabled: false, active: null };

/** Fired after a successful pick so the mascot re-reads without a reload. */
export const PET_CHANGED_EVENT = "clawbox-pet-changed";

let cache: PetStatus | null = null;
let inFlight: Promise<PetStatus> | null = null;

/** Test seam / invalidation after a pick. */
export function invalidatePetStatus(): void {
  cache = null;
  inFlight = null;
}

function coerce(data: unknown): PetStatus {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.supported !== true) return { ...OFF, edition: typeof d.edition === "string" ? d.edition : "openclaw" };
  const a = d.active as Record<string, unknown> | null | undefined;
  const active: PetDescriptor | null =
    a && typeof a.slug === "string" && typeof a.revision === "string"
      ? {
          slug: a.slug,
          displayName: String(a.displayName ?? a.slug),
          submittedBy: String(a.submittedBy ?? ""),
          revision: a.revision,
          frameW: Number(a.frameW) || 192,
          frameH: Number(a.frameH) || 208,
          cols: Number(a.cols) || 8,
          rows: Number(a.rows) || 9,
          framesPerState: Number(a.framesPerState) || 6,
          loopMs: Number(a.loopMs) || 1100,
        }
      : null;
  return {
    supported: true,
    edition: typeof d.edition === "string" ? d.edition : "hermes",
    enabled: d.enabled === true,
    active,
  };
}

/**
 * The pet status, cached for the life of the document (invalidated on a pick).
 *
 * Any failure resolves to "no pets" rather than rejecting: the caller is the
 * mascot, and a mascot that throws would take the desktop's render with it.
 */
export function fetchPetStatus(): Promise<PetStatus> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  // `fetch` itself can be absent or throw synchronously (a test environment, a
  // very old browser); a mascot must not take the desktop's render with it.
  let call: Promise<Response>;
  try {
    call = fetch("/setup-api/pets", { cache: "no-store" });
  } catch {
    return Promise.resolve(OFF);
  }
  const request = call
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const status = coerce(d);
      cache = status;
      return status;
    })
    .catch(() => OFF)
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

/** Tell every mounted surface the active pet changed. */
export function announcePetChanged(): void {
  invalidatePetStatus();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PET_CHANGED_EVENT));
}
