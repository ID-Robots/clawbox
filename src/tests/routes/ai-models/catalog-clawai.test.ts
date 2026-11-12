import { describe, expect, it, vi } from "vitest";

// The ClawBox AI catalog is hardcoded rather than fetched, so nothing upstream
// will ever correct it: whatever these entries say is what every model picker
// on the device shows. This pins it to what the provider definition writes into
// openclaw.json — ONE model since TASK-2261, the 1M window, and pictures as
// well as text — so the picker and the gateway can't drift apart again.

vi.mock("child_process", () => ({ spawn: vi.fn() }));
// No gateway answers here: every enumeration falls back to the CLI this suite pins.
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) =>
  (await import("./gateway-ws-mock")).gatewayWsUnavailable(
    await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>(),
  ));
// On a Jetson, explicitly: the only host where the route asks the gateway first.
vi.mock("@/lib/ollama-size-cap", async (importOriginal) =>
  (await import("./gateway-ws-mock")).onJetson(await importOriginal<typeof import("@/lib/ollama-size-cap")>()));
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));
// A per-PROCESS data root. A fixed `/tmp/<name>` is shared by every vitest
// worker on the machine and by every checkout of this repo on it — the same
// reason `vitest.config.ts` suffixes `CLAWBOX_ROOT` and `OPENCLAW_HOME`.
vi.mock("@/lib/config-store", () => ({ DATA_DIR: `/tmp/clawbox-catalog-clawai-test-${process.pid}` }));

import { CLAWAI_STATIC_MODELS } from "@/app/setup-api/ai-models/catalog/route";
import {
  RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS,
  RETIRED_CLAWBOX_AI_VISION_MODEL_IDS,
} from "@/lib/clawbox-ai-retired-models";

describe("ClawBox AI static catalog", () => {
  it("offers exactly the one model, on every plan", () => {
    expect(CLAWAI_STATIC_MODELS.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });

  it("offers none of the retired ids", () => {
    const ids = CLAWAI_STATIC_MODELS.map((m) => m.id);
    for (const retired of [...RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS, ...RETIRED_CLAWBOX_AI_VISION_MODEL_IDS]) {
      expect(ids).not.toContain(retired);
    }
  });

  it("reports V4's real 1M context window", () => {
    for (const model of CLAWAI_STATIC_MODELS) {
      expect(model.contextWindow).toBe(1_000_000);
    }
  });

  it("declares pictures as well as text, matching the provider definition", () => {
    for (const model of CLAWAI_STATIC_MODELS) {
      expect(model.input).toBe("text+image");
    }
  });

  it("names the model that serves it and claims no bigger one", () => {
    for (const model of CLAWAI_STATIC_MODELS) {
      expect(`${model.label} ${model.hint ?? ""}`, model.id).not.toMatch(/V4[ -]?Pro|1[.,]6\s?T|frontier/i);
      expect(model.label).toBe("DeepSeek V4 Flash");
    }
  });
});
