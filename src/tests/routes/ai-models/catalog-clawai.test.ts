import { describe, expect, it, vi } from "vitest";

// The ClawBox AI catalog is hardcoded rather than fetched, so nothing upstream
// will ever correct it: whatever these entries say is what every model picker
// on the device shows. They used to claim 128K — a number that was never V4's
// limit — and text+image, which the text-only proxy rejects. This pins them to
// the same values the provider definition writes into openclaw.json, so the
// picker and the gateway can't drift apart again.

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-clawai-test" }));

import { CLAWAI_STATIC_MODELS } from "@/app/setup-api/ai-models/catalog/route";

describe("ClawBox AI static catalog", () => {
  it("offers exactly the two subscription tiers", () => {
    expect(CLAWAI_STATIC_MODELS.map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("reports V4's real 1M context window on both tiers", () => {
    for (const model of CLAWAI_STATIC_MODELS) {
      expect(model.contextWindow).toBe(1_000_000);
    }
  });

  it("declares text-only input, matching the proxy", () => {
    for (const model of CLAWAI_STATIC_MODELS) {
      expect(model.input).toBe("text");
    }
  });
});
