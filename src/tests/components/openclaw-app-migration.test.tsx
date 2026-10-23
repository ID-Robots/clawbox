import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import OpenClawApp from "@/components/OpenClawApp";

/**
 * The OpenClaw app over a gateway whose agents' databases are not on the
 * schema the installed core expects. Before, the port being open was all it
 * looked at: a 10.x gateway on un-migrated 9.x databases drew the Control UI as
 * if nothing were wrong while every agent refused its turns.
 */

// Real copy, from the real catalogue, so a missing key shows up as a raw key.
vi.mock("@/lib/i18n", async () => {
  const { translations } = await import("@/lib/translations");
  const table = translations.en;
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useT: () => ({
      locale: "en",
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          table[key] ?? key,
        ),
    }),
  };
});

let health: Record<string, unknown>;
beforeEach(() => {
  health = { available: true, port: 18789, restarting: false };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/setup-api/gateway/health") return new Response(JSON.stringify(health));
    if (url === "/setup-api/gateway/ws-config") return new Response(JSON.stringify({ wsUrl: "ws://box/", token: "t" }));
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenClawApp and the agents' databases", () => {
  it("draws the Control UI with no notice when the databases are fine", async () => {
    render(<OpenClawApp />);
    await waitFor(() => expect(screen.getByTitle(/./)).toBeInTheDocument());
    expect(screen.queryByTestId("openclaw-migration-notice")).toBeNull();
  });

  it("says the migration needs disk, with both sizes, above a gateway that is up", async () => {
    health = { ...health, migration: { state: "degraded", reason: "insufficient-disk", requiredBytes: 61 * 1024 ** 3, freeBytes: 12.5 * 1024 ** 3 } };
    render(<OpenClawApp />);
    const notice = await screen.findByTestId("openclaw-migration-notice");
    expect(notice).toHaveTextContent("OpenClaw's agent data needs attention");
    expect(notice).toHaveTextContent("needs about 61.0 GB of free disk, but only 12.5 GB is free");
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it.each([
    ["schema-behind", "has not finished moving the agents' data to its new format"],
    ["migration-incomplete", "did not finish migrating the agents' data"],
    ["schema-newer", "written by a newer OpenClaw than the one installed"],
  ])("explains %s in the owner's words", async (reason, text) => {
    health = { ...health, migration: { state: "degraded", reason, requiredBytes: null, freeBytes: null } };
    render(<OpenClawApp />);
    expect(await screen.findByTestId("openclaw-migration-notice")).toHaveTextContent(text);
  });

  it.each([
    ["repaired", null, "ClawBox ran OpenClaw's own repair on it"],
    ["restored", null, "ClawBox put back that database's copy from before the last update"],
    ["failed", "no-backup", "there is no copy from before the last update to put back"],
    ["failed", "restore-did-not-help", "so ClawBox stopped trying"],
  ])("says what the pre-start did about a %s start loop (%s), above a gateway that is up", async (outcome, reason, text) => {
    health = { ...health, startRecovery: { outcome, reason, at: "2026-10-23T11:00:00Z" } };
    render(<OpenClawApp />);
    const notice = await screen.findByTestId("openclaw-start-recovery-notice");
    expect(notice).toHaveTextContent("OpenClaw could not start over an agent database");
    expect(notice).toHaveTextContent(text);
    expect(notice).toHaveTextContent(/nothing was deleted/i);
    expect(document.querySelector("iframe")).not.toBeNull();
    // No restart-loop breaker holding channels back: nothing said about them.
    expect(screen.queryByTestId("openclaw-start-recovery-channels")).toBeNull();
  });

  it("says the chat channels are still paused while OpenClaw's restart-loop breaker holds them back", async () => {
    health = { ...health, startRecovery: { outcome: "repaired", reason: null, at: "2026-10-23T11:00:00Z", channelsSuppressed: true } };
    render(<OpenClawApp />);
    const notice = await screen.findByTestId("openclaw-start-recovery-notice");
    expect(notice).toHaveTextContent("ClawBox ran OpenClaw's own repair on it");
    expect(await screen.findByTestId("openclaw-start-recovery-channels")).toHaveTextContent(
      "Chat channels such as Telegram and Discord are paused for now",
    );
  });

  it("says it on the offline screen too, where a gateway it could not recover leaves the owner", async () => {
    health = { available: false, port: 18789, restarting: false, startRecovery: { outcome: "failed", reason: "no-backup", at: "2026-10-23T11:00:00Z" } };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<OpenClawApp />);
      await vi.advanceTimersByTimeAsync(16 * 3000);
      expect(await screen.findByTestId("openclaw-start-recovery-notice")).toHaveTextContent("Run the update again from Settings, or contact support");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a migration field it cannot read", async () => {
    health = { ...health, migration: { state: "fine", reason: 7 } };
    render(<OpenClawApp />);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByTestId("openclaw-migration-notice")).toBeNull();
  });
});
