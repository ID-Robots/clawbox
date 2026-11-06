import { vi } from "vitest";

/**
 * The factory a route suite hands to
 * `vi.mock("@/lib/gateway-hot-apply", gatewayHotApplyMock)` (TASK-1535).
 *
 * The CLASSIFICATION stays real — `restartRequiredPaths`, `diffConfigPaths`
 * and `gatewayReloadKind` are pure, and a suite that writes `gateway.auth.*`
 * should see the restart it causes. The gateway I/O is replaced, defaulting to
 * a gateway that answers and applies every save live:
 *
 *  - `awaitGatewayHotApply` / `settleConfigWrite` answer "applied";
 *  - `restartGatewayAnsweringEarly` delegates to the suite's own mock of
 *    `restartGateway` from `@/lib/openclaw-config` (so the assertions suites
 *    already make about that mock keep meaning "the gateway was restarted"),
 *    with `back` resolving true at once;
 *  - `waitForGatewayBack` answers true.
 *
 * Override per test with `vi.mocked(...)`.
 */
export async function gatewayHotApplyMock(importOriginal: () => Promise<unknown>) {
  const actual = (await importOriginal()) as typeof import("@/lib/gateway-hot-apply");
  return {
    ...actual,
    readGatewayConfigBaseline: vi.fn(async () => ({ hash: "baseline-hash" })),
    awaitGatewayHotApply: vi.fn(async () => ({ applied: true as const, how: "hot-reload" as const })),
    settleConfigWrite: vi.fn(async () => "applied" as const),
    restartGatewayAnsweringEarly: vi.fn(async () => {
      const { restartGateway } = await import("@/lib/openclaw-config");
      await restartGateway({ awaitReady: false });
      return { back: Promise.resolve(true) };
    }),
    waitForGatewayBack: vi.fn(async () => true),
    refreshGatewayModelAuth: vi.fn(async () => true),
  };
}
