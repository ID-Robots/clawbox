import { fileURLToPath } from "url";
import { vi } from "vitest";

type GatewayWsModule = typeof import("@/lib/openclaw-gateway-ws");
type SizeCapModule = typeof import("@/lib/ollama-size-cap");

/**
 * The host as the catalogue suites see it: a Jetson.
 *
 * The route asks the gateway first only on a Jetson, by the installers' marker
 * (`/etc/nv_tegra_release`, read at every fork). Left to the machine running a
 * suite, the CI container (no marker) and a box (marker) would take different
 * paths through the same assertions. A Jetson, because these suites model the
 * box: an enumeration asks the gateway below, is refused, and forks the CLI.
 * catalog-gateway-first.test.ts pins every other host. The route only asks
 * whether the marker exists, so it is pointed at this file, which always does.
 */
export function onJetson(actual: SizeCapModule): Omit<SizeCapModule, "TEGRA_RELEASE"> & { TEGRA_RELEASE: string } {
  return { ...actual, TEGRA_RELEASE: fileURLToPath(import.meta.url) };
}

/**
 * The gateway socket as the catalogue suites see it: nothing listening.
 *
 * On a Jetson the catalogue asks the running gateway for `models.list` before
 * it forks `openclaw models list`, and falls back to the CLI when no gateway
 * answers. These suites pin the CLI path, so every socket call is refused the
 * way a box with its gateway stopped refuses it, and each enumeration then
 * spawns the CLI exactly as before. No suite opens a socket.
 *
 * Built FROM the real module, so its error classes are the ones the route's
 * `instanceof` checks compare against. A hand-written factory that left a
 * class out would make every such check false (or throw).
 */
export function gatewayWsUnavailable(actual: GatewayWsModule): GatewayWsModule {
  return {
    ...actual,
    gatewayWsCall: vi.fn(async () => {
      throw new actual.GatewayWsUnavailableError("no gateway in this suite");
    }),
  };
}
