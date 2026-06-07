/**
 * Cross-origin reachability probe for the WiFi/credentials handoff overlays.
 *
 * After the box moves networks (or is renamed), a `fetch` to its new origin is
 * CORS-blocked — but loading an `<img>` from that origin still succeeds once the
 * box answers there. Cache-busted per `attempt` so a previously-failed probe
 * isn't served from cache. Resolves `false` after a 4s timeout.
 */
export function imgProbe(baseUrl: string, attempt: number): Promise<boolean> {
  return new Promise((resolve) => {
    const img = document.createElement("img");
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = `${baseUrl}/clawbox-icon.png?probe=${attempt}`;
    setTimeout(() => finish(false), 4000);
  });
}
