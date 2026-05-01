import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";

import { applyModelOverrideToAllAgentSessions } from "@/lib/openclaw-config";

// These tests exercise the on-disk session-sweep helper against real
// sessions.json fixtures. The chat-popup model dropdown calls into this
// helper with `skipUserTagged: true` so per-session user choices stay
// sticky; the wizard / Settings configure flow calls without it for a
// full sweep when the primary provider changes wholesale.

describe("applyModelOverrideToAllAgentSessions — skipUserTagged", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = await mkdtemp(path.join(os.tmpdir(), "clawbox-sweep-"));
  });

  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
  });

  async function seedSessions(agent: string, sessions: Record<string, Record<string, unknown>>) {
    const dir = path.join(agentsDir, agent, "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "sessions.json"), JSON.stringify(sessions, null, 2));
  }

  async function readSessions(agent: string): Promise<Record<string, Record<string, unknown>>> {
    const file = path.join(agentsDir, agent, "sessions", "sessions.json");
    return JSON.parse(await readFile(file, "utf-8"));
  }

  it("rewrites every session by default (matches the wizard's 'change primary provider' intent)", async () => {
    await seedSessions("main", {
      auto: { modelOverride: "old-model", modelOverrideSource: "auto" },
      sticky: { modelOverride: "user-pick", modelOverrideSource: "user" },
    });

    const result = await applyModelOverrideToAllAgentSessions(
      { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      { agentsDir },
    );

    expect(result.sessionsUpdated).toBe(2);
    const after = await readSessions("main");
    expect(after.auto.modelOverride).toBe("claude-sonnet-4-6");
    // Without skipUserTagged the user-tagged session also gets stomped —
    // this is the wizard / Settings configure path's documented behavior.
    expect(after.sticky.modelOverride).toBe("claude-sonnet-4-6");
    expect(after.sticky.modelOverrideSource).toBe("user");
  });

  it("with skipUserTagged: leaves diverging user-tagged sessions alone", async () => {
    // Mirrors the parallel-sessions scenario the chat-popup dropdown is
    // about to support: chat A user-picked Sonnet, chat B user-picked
    // Haiku. Switching chat C (auto-tagged) to Gemini should not stomp
    // either of A's or B's intentional choice.
    await seedSessions("main", {
      chatA_sticky_sonnet: {
        modelOverride: "claude-sonnet-4-6",
        modelOverrideSource: "user",
        providerOverride: "anthropic",
      },
      chatB_sticky_haiku: {
        modelOverride: "claude-haiku-4-5",
        modelOverrideSource: "user",
        providerOverride: "anthropic",
      },
      chatC_auto_old: {
        modelOverride: "old-model",
        modelOverrideSource: "auto",
        providerOverride: "openai",
      },
    });

    await applyModelOverrideToAllAgentSessions(
      { provider: "google", modelId: "gemini-2.5-flash" },
      { agentsDir, skipUserTagged: true },
    );

    const after = await readSessions("main");
    // User-tagged sessions are preserved verbatim — the soft-sweep
    // contract is "leave diverging intent alone".
    expect(after.chatA_sticky_sonnet.modelOverride).toBe("claude-sonnet-4-6");
    expect(after.chatA_sticky_sonnet.providerOverride).toBe("anthropic");
    expect(after.chatB_sticky_haiku.modelOverride).toBe("claude-haiku-4-5");
    // Auto-tagged session DID get rewritten — the dropdown still wants
    // un-pinned chats to follow it.
    expect(after.chatC_auto_old.modelOverride).toBe("gemini-2.5-flash");
    expect(after.chatC_auto_old.providerOverride).toBe("google");
    expect(after.chatC_auto_old.modelOverrideSource).toBe("user");
  });

  it("with skipUserTagged: still updates user-tagged sessions that already match the target", async () => {
    // Edge case: the user re-clicks the same model on a sticky session.
    // We should still touch it so authProfile/source converge with the
    // target — otherwise re-rendering the picker on a re-click would
    // appear to do nothing even though the user expects an idempotent
    // re-application of the chosen target.
    await seedSessions("main", {
      already_matching: {
        modelOverride: "claude-sonnet-4-6",
        modelOverrideSource: "user",
        providerOverride: "anthropic",
        // authProfileOverride is intentionally absent so the rewrite
        // can be detected by checking it's now set.
      },
    });

    await applyModelOverrideToAllAgentSessions(
      { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      { agentsDir, skipUserTagged: true },
    );

    const after = await readSessions("main");
    expect(after.already_matching.authProfileOverride).toBe("anthropic:default");
    expect(after.already_matching.modelOverrideSource).toBe("user");
  });

  it("ignores sessions files that fail to parse instead of bailing the sweep", async () => {
    await seedSessions("main", {
      ok: { modelOverride: "old", modelOverrideSource: "auto" },
    });
    // Drop a second agent with a corrupt sessions.json — should be
    // skipped, not abort the rest.
    const corruptDir = path.join(agentsDir, "broken", "sessions");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(path.join(corruptDir, "sessions.json"), "{ not json");

    const result = await applyModelOverrideToAllAgentSessions(
      { provider: "google", modelId: "gemini-2.5-flash" },
      { agentsDir },
    );

    expect(result.filesUpdated).toBe(1);
    expect(result.sessionsUpdated).toBe(1);
  });
});
