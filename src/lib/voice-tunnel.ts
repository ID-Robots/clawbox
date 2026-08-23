// -- Where voice input CAN work, when this origin cannot -------------------
//
// The chat microphone is gated by the browser on a secure context, and the
// ordinary way a customer reaches their box — http://<ip>/ or
// http://clawbox.local/ — is not one (TASK-470). The one secure origin the
// box ships is its Remote Access tunnel, so the mic's insecure-origin popup
// offers to take the customer there. That offer is only honest if the address
// is the LIVE one: *.trycloudflare.com hostnames change on every tunnel
// restart, so nothing here may be cached or guessed. The popup asks
// /setup-api/portal/status — the same endpoint the Remote Control panel
// polls — at the moment it opens, and classifies what came back.

export type TunnelDestination =
  /** The tunnel is running and published a usable https address. */
  | { kind: "ready"; url: string }
  /** The tunnel exists as a feature but is not running on this box. */
  | { kind: "off" }
  /** The status could not be read; nothing can honestly be offered. */
  | { kind: "failed" };

/**
 * Decide what the popup may offer, from a /setup-api/portal/status payload.
 *
 * `ready` requires BOTH halves: the service reporting `active` and a published
 * https URL. A URL without a running service is the previous run's hostname —
 * Quick Tunnels get a fresh one every start, so redirecting to it would be the
 * dead link Yanko's acceptance names as worse than no button at all. A running
 * service without a URL yet is still negotiating, and there is nowhere to go.
 *
 * The https check is deliberate even though the box only ever publishes
 * https addresses: this string becomes a navigation target, and the popup
 * exists precisely because the current origin is not secure — sending the
 * customer to another insecure (or non-http) address would be self-defeating.
 */
export function classifyTunnelDestination(payload: unknown): TunnelDestination {
  if (typeof payload !== "object" || payload === null) return { kind: "failed" };
  const tunnel = (payload as { tunnel?: unknown }).tunnel;
  if (typeof tunnel !== "object" || tunnel === null) return { kind: "failed" };
  const { service, url } = tunnel as { service?: unknown; url?: unknown };
  if (service === "active" && typeof url === "string") {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { kind: "off" };
    }
    if (parsed.protocol === "https:") return { kind: "ready", url: parsed.toString() };
  }
  return { kind: "off" };
}

/**
 * The live answer: what the tunnel is doing right now on this box.
 *
 * A network failure maps to `failed`, not `off` — "the tunnel is not enabled,
 * go turn it on" is a claim about the box, and a fetch that never reached the
 * box cannot back it.
 */
export async function fetchTunnelDestination(
  fetchImpl: typeof fetch = fetch,
): Promise<TunnelDestination> {
  try {
    const res = await fetchImpl("/setup-api/portal/status", { cache: "no-store" });
    if (!res.ok) return { kind: "failed" };
    return classifyTunnelDestination(await res.json());
  } catch {
    return { kind: "failed" };
  }
}
