import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import ClawKeepWizard from "@/components/ClawKeepWizard";
import { I18nProvider } from "@/lib/i18n";

/**
 * ClawKeep's first-run wizard: the front door with the artwork, then pair,
 * seal, schedule — every step over the routes the dashboard already uses,
 * and the completion flag written only at the end.
 */

const BASE_STATUS = {
  paired: false,
  setupComplete: false,
  configured: false,
  server: "https://portal.example",
  lastBackupAtMs: 0,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  encryptionConfigured: false,
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 0 },
  nextRunAtMs: 0,
};

let status: Record<string, unknown>;
let calls: { url: string; method: string; body: unknown }[];

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ url, method, body });
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url === "/setup-api/clawkeep/pair/start") return ok({ user_code: "ABCD-1234", verification_url: "https://portal.example/pair", interval: 5, code_length: 8 });
    if (url === "/setup-api/clawkeep/pair/poll") { status = { ...status, paired: true }; return ok({ status: "complete" }); }
    if (url === "/setup-api/clawkeep/encryption") { status = { ...status, encryptionConfigured: true }; return ok({ ok: true }); }
    if (url === "/setup-api/clawkeep/schedule") return ok({ schedule: body, nextRunAtMs: 1 });
    if (url === "/setup-api/clawkeep/setup") { status = { ...status, setupComplete: true }; return ok({ setupComplete: true }); }
    if (url === "/setup-api/clawkeep/backup") return ok({ ok: true, exitCode: 0, stdoutTail: "", stderrTail: "" });
    if (url.startsWith("/setup-api/clawkeep")) return ok(status);
    return ok({});
  }));
}

beforeEach(() => {
  status = { ...BASE_STATUS };
  calls = [];
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const app = () => render(<I18nProvider><ClawKeepApp /></I18nProvider>);

describe("the ClawKeep front door", () => {
  it("shows the wizard, artwork first, on a box that has not been set up and is not paired", async () => {
    app();
    expect(await screen.findByTestId("clawkeep-wizard", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByTestId("clawkeep-art")).toBeInTheDocument();
    expect(screen.getByTestId("clawkeep-wizard-enable")).toBeInTheDocument();
    // Not the dashboard's Pair card.
    expect(screen.queryByRole("button", { name: "Pair with portal" })).toBeNull();
  });

  it("skips the wizard on a paired box whatever the flag says, and on a box that finished it", async () => {
    status = { ...BASE_STATUS, paired: true, configured: true, lastBackupAtMs: Date.now() - 3_600_000, cloudBytes: 1024, snapshotCount: 2, encryptionConfigured: true };
    app();
    const pill = await screen.findByTestId("clawkeep-state", {}, { timeout: 5000 });
    // The pill is on screen before the locale has loaded; wait for the word.
    await waitFor(() => expect(pill).toHaveTextContent("Paired"), { timeout: 5000 });
    expect(screen.queryByTestId("clawkeep-wizard")).toBeNull();
  });

  it("leaves the dashboard as it was for a server that predates the flag", async () => {
    const { setupComplete: _omitted, ...older } = BASE_STATUS;
    void _omitted;
    status = older;
    app();
    expect(await screen.findByRole("button", { name: "Pair with portal" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId("clawkeep-wizard")).toBeNull();
  });

  it("Not now marks setup done without pairing, and the dashboard's Pair card takes over", async () => {
    app();
    fireEvent.click(await screen.findByTestId("clawkeep-wizard-skip", {}, { timeout: 5000 }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/setup-api/clawkeep/setup", method: "POST", body: { setupComplete: true } }));
    expect(await screen.findByRole("button", { name: "Pair with portal" }, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("the ClawKeep wizard's steps", () => {
  const wizard = (over: Record<string, unknown> = {}, onDone = vi.fn()) => {
    const s = { ...BASE_STATUS, ...over } as unknown as Parameters<typeof ClawKeepWizard>[0]["status"];
    const view = render(
      <I18nProvider>
        <ClawKeepWizard status={s} agent="OpenClaw" onStatusChanged={() => {}} onDone={onDone} />
      </I18nProvider>,
    );
    return { ...view, onDone };
  };

  it("walks Enable → pair, and pairing runs the device-code loop through the same routes as the dashboard", async () => {
    wizard();
    fireEvent.click(await screen.findByTestId("clawkeep-wizard-enable", {}, { timeout: 5000 }));
    expect(await screen.findByText("Step 1 of 3")).toBeInTheDocument();
    // Nothing to go on to until the box is paired.
    expect(screen.getByTestId("clawkeep-wizard-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("clawkeep-wizard-pair"));
    // The code card, with the code the route minted.
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/clawkeep/pair/start")).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/clawkeep/pair/poll")).toBe(true));
  });

  it("goes straight to the passphrase on a paired box, seals it, and only the last step marks setup done", async () => {
    const { onDone } = wizard({ paired: true });
    fireEvent.click(await screen.findByTestId("clawkeep-wizard-enable", {}, { timeout: 5000 }));
    expect(await screen.findByText("Step 2 of 3")).toBeInTheDocument();
    const next = screen.getByTestId("clawkeep-wizard-next");
    expect(next).toBeDisabled();
    fireEvent.change(screen.getByTestId("clawkeep-wizard-passphrase"), { target: { value: "correct horse" } });
    fireEvent.change(screen.getByTestId("clawkeep-wizard-confirm"), { target: { value: "correct horse" } });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByTestId("clawkeep-wizard-ack"));
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() => expect(calls).toContainEqual({
      url: "/setup-api/clawkeep/encryption", method: "POST", body: { passphrase: "correct horse", confirm: "correct horse" },
    }));
    expect(await screen.findByText("Step 3 of 3")).toBeInTheDocument();
    // Nothing has been marked complete yet.
    expect(calls.some((c) => c.url === "/setup-api/clawkeep/setup")).toBe(false);

    fireEvent.click(screen.getByTestId("clawkeep-wizard-finish"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const schedule = calls.find((c) => c.url === "/setup-api/clawkeep/schedule");
    expect(schedule?.method).toBe("PUT");
    expect(schedule?.body).toMatchObject({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 0 });
    expect(calls).toContainEqual({ url: "/setup-api/clawkeep/setup", method: "POST", body: { setupComplete: true } });
    // And the first backup, asked for by default on a paired box.
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/clawkeep/backup" && c.method === "POST")).toBe(true));
  });

  it("says a passphrase is already set and skips to the schedule", async () => {
    wizard({ paired: true, encryptionConfigured: true });
    fireEvent.click(await screen.findByTestId("clawkeep-wizard-enable", {}, { timeout: 5000 }));
    expect(await screen.findByTestId("clawkeep-wizard-protected")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("clawkeep-wizard-next"));
    expect(await screen.findByText("Step 3 of 3")).toBeInTheDocument();
  });

  it("does not mark setup done when the schedule cannot be saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: null });
      if (url === "/setup-api/clawkeep/schedule") return { ok: false, status: 500, json: async () => ({ error: "disk full" }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const { onDone } = wizard({ paired: true, encryptionConfigured: true });
    fireEvent.click(await screen.findByTestId("clawkeep-wizard-enable", {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId("clawkeep-wizard-next"));
    fireEvent.click(await screen.findByTestId("clawkeep-wizard-finish"));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === "/setup-api/clawkeep/setup")).toBe(false);
  });
});
