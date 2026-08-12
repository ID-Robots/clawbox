import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

// The model catalog for cloud providers comes from `openclaw models list`. On an
// edition with no openclaw binary (Hermes) that spawn is a guaranteed ENOENT, so
// the refresh must skip it cleanly rather than fork a missing binary once per
// provider on every boot warmup.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const mockOpenclawIsAbsent = vi.fn();
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => mockOpenclawIsAbsent(),
}));

vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-edition-test" }));

import { refreshInBackground } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);

describe("catalog refresh — edition guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not spawn openclaw for a CLI-backed provider on the hermes edition", () => {
    mockOpenclawIsAbsent.mockReturnValue(true);
    refreshInBackground("anthropic");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns openclaw for a CLI-backed provider when the binary is present", () => {
    mockOpenclawIsAbsent.mockReturnValue(false);
    // A distinct provider from the hermes test so the single-flight `refreshing`
    // set can't mask the spawn.
    refreshInBackground("openai");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
