import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

// The model catalog for cloud providers comes from `openclaw models list`. On an
// edition with no openclaw binary (Hermes) that spawn is a guaranteed ENOENT, so
// the refresh must skip it cleanly rather than fork a missing binary once per
// provider on every boot warmup.

vi.mock("child_process", () => ({ spawn: vi.fn() }));
// No gateway answers here: every enumeration falls back to the CLI this suite pins.
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) =>
  (await import("./gateway-ws-mock")).gatewayWsUnavailable(
    await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>(),
  ));
// On a Jetson, explicitly: the only host where the route asks the gateway first.
vi.mock("@/lib/ollama-size-cap", async (importOriginal) =>
  (await import("./gateway-ws-mock")).onJetson(await importOriginal<typeof import("@/lib/ollama-size-cap")>()));

const mockOpenclawIsAbsent = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => mockOpenclawIsAbsent(),
}));

// A per-PROCESS data root. A fixed `/tmp/<name>` is shared by every vitest
// worker on the machine and by every checkout of this repo on it — the same
// reason `vitest.config.ts` suffixes `CLAWBOX_ROOT` and `OPENCLAW_HOME`.
vi.mock("@/lib/config-store", () => ({ DATA_DIR: `/tmp/clawbox-catalog-edition-test-${process.pid}` }));

import { refreshInBackground } from "@/app/setup-api/ai-models/catalog/route";
import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGatewayCall = vi.mocked(gatewayWsCall);

describe("catalog refresh — edition guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not spawn openclaw, nor ask a gateway, for a CLI-backed provider on the hermes edition", async () => {
    mockOpenclawIsAbsent.mockReturnValue(true);
    refreshInBackground("anthropic");
    // Past the microtasks a socket refusal takes, so a call made after the
    // edition check could not hide behind the synchronous return.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockGatewayCall).not.toHaveBeenCalled();
  });

  it("spawns openclaw for a CLI-backed provider when the binary is present", async () => {
    mockOpenclawIsAbsent.mockReturnValue(false);
    // A distinct provider from the hermes test so the single-flight `refreshing`
    // set can't mask the spawn.
    refreshInBackground("openai");
    // The gateway is asked first and refuses (no gateway in this suite), so the
    // spawn follows a few microtasks later rather than inside the call.
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
  });
});
