import { describe, expect, it, vi } from "vitest";
import { followNewestModel, type FollowNewestDeps } from "@/lib/provider-follow-newest";

// A box that took the newest-model default moves with it when the provider
// ships a newer model; a box whose owner picked a model stays where it was put
// (TASK-713: a default fills a gap, never overwrites a choice).

function deps(over: Partial<FollowNewestDeps> = {}): FollowNewestDeps {
  return {
    readPrimary: vi.fn(async () => "xai/grok-4.7"),
    readPicks: vi.fn(async () => ({})),
    readUnavailable: vi.fn(async () => new Set<string>()),
    switchModel: vi.fn(async () => true),
    ...over,
  };
}

const withNew = [{ id: "grok-4.8" }, { id: "grok-4.7" }, { id: "grok-4.6" }];

describe("followNewestModel", () => {
  it("moves a chat that took the default onto the model the provider just shipped", async () => {
    const d = deps();
    expect(await followNewestModel("xai", withNew, d)).toEqual({ moved: true, from: "xai/grok-4.7", to: "xai/grok-4.8" });
    expect(d.switchModel).toHaveBeenCalledWith("xai/grok-4.8");
  });

  it("keeps the owner's own pick, whatever ships", async () => {
    const d = deps({ readPicks: vi.fn(async () => ({ xai: "xai/grok-4.7" })) });
    expect(await followNewestModel("xai", withNew, d)).toEqual({ moved: false, why: "owner-picked" });
    expect(d.switchModel).not.toHaveBeenCalled();
  });

  it("skips a newer model this account has a zero limit on", async () => {
    const d = deps({ readUnavailable: vi.fn(async () => new Set(["grok-4.8"])) });
    expect(await followNewestModel("xai", withNew, d)).toEqual({ moved: false, why: "already-newest" });
    expect(d.switchModel).not.toHaveBeenCalled();
  });

  it("moves a chat off a default this account was refused on", async () => {
    const d = deps({
      readPrimary: vi.fn(async () => "xai/grok-4.6"),
      readUnavailable: vi.fn(async () => new Set(["grok-4.6"])),
    });
    expect(await followNewestModel("xai", [{ id: "grok-4.7" }, { id: "grok-4.6" }], d))
      .toEqual({ moved: true, from: "xai/grok-4.6", to: "xai/grok-4.7" });
  });

  it("leaves a chat on another provider, or on a variant nobody defaulted to, alone", async () => {
    expect(await followNewestModel("xai", withNew, deps({ readPrimary: vi.fn(async () => "anthropic/claude-opus-5-5") })))
      .toEqual({ moved: false, why: "not-on-provider" });
    expect(await followNewestModel("xai", withNew, deps({ readPrimary: vi.fn(async () => "xai/grok-4.20-0309-reasoning") })))
      .toEqual({ moved: false, why: "not-a-flagship" });
    expect(await followNewestModel("anthropic", withNew, deps())).toEqual({ moved: false, why: "not-following" });
  });

  it("never moves the chat down to an older model than the one it is on", async () => {
    // A release the enumeration has not caught up with, or a list that came
    // back short: the chat stays on its own, newer model.
    const d = deps({ readPrimary: vi.fn(async () => "xai/grok-4.9") });
    expect(await followNewestModel("xai", withNew, d)).toEqual({ moved: false, why: "already-newest" });
    expect(d.switchModel).not.toHaveBeenCalled();
  });

  it("says when the switch did not land", async () => {
    expect(await followNewestModel("xai", withNew, deps({ switchModel: vi.fn(async () => false) })))
      .toEqual({ moved: false, why: "switch-failed" });
  });
});
