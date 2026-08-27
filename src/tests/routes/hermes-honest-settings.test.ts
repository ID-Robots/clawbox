import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Three OpenClaw-only controls that Settings offered to Hermes owners as if
 * they worked.
 *
 * The Telegram one is the sharpest, because it is the exact shape this
 * codebase has already been bitten by twice: a route answering
 * `{restarted: true}` for a service that does not exist on the edition asking.
 * `restartGateway()` returns immediately when `gatewayIsAbsent()`, so the
 * "restart" always "succeeded".
 */

const readEdition = vi.fn<() => string>();
vi.mock("@/lib/edition-source", () => ({ readEdition: () => readEdition() }));

// The real module, except for the edition it resolves — everything else
// (gatewayIsAbsent, readConfig's ENOENT behaviour) is exercised as shipped.
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
  setMany: vi.fn(async () => {}),
}));

function post(body: unknown): Request {
  return new Request("http://localhost/setup-api", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  readEdition.mockReturnValue("hermes");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Telegram progress streaming on Hermes", () => {
  it("does not claim a gateway it does not have was restarted", async () => {
    // THE regression. `restartGateway()` is a no-op on Hermes, so the old code
    // sailed past its own try/catch and answered `{success:true,
    // restarted:true}` — for a setting living in `~/.openclaw/openclaw.json`,
    // which Hermes neither has nor reads.
    const route = await import("@/app/setup-api/telegram/streaming/route");
    const res = await route.POST(post({ enabled: true }));
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body.supported).toBe(false);
    expect(body.restarted).toBeUndefined();
    expect(body.success).toBeUndefined();
  });

  it("does not report the switch as already ON", async () => {
    // `readConfig()` answers `{}` for a missing file, so the shipped
    // expression `mode !== "off"` was `undefined !== "off"` — true. A Hermes
    // owner opened Settings and found a feature they do not have turned on.
    const route = await import("@/app/setup-api/telegram/streaming/route");
    const body = await (await route.GET()).json();

    expect(body.enabled).toBe(false);
    expect(body.supported).toBe(false);
  });

  it("still works normally on the openclaw edition", async () => {
    readEdition.mockReturnValue("openclaw");
    const route = await import("@/app/setup-api/telegram/streaming/route");
    const body = await (await route.GET()).json();

    // No `supported:false` short-circuit — the real reader runs.
    expect(body.supported).toBeUndefined();
    expect(typeof body.enabled).toBe("boolean");
  });
});

describe("Local-only mode on Hermes", () => {
  it("refuses instead of leaking a CLI error into a red banner", async () => {
    // Every path here calls `runOpenclawConfigSet`, which throws
    // `OpenclawUnavailableError` on Hermes. The catch-all turned that into a
    // 500 whose body SettingsApp painted verbatim: "The OpenClaw CLI is not
    // available on this edition." That is our internals, in an error colour,
    // for a control we chose to show them.
    const route = await import("@/app/setup-api/local-ai/exclusive/route");
    const res = await route.POST(post({ enabled: true }));
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body.supported).toBe(false);
    expect(body.error).not.toMatch(/CLI/i);
  });

  it("reports local-only as off rather than unknown", async () => {
    const route = await import("@/app/setup-api/local-ai/exclusive/route");
    const body = await (await route.GET()).json();

    expect(body.enabled).toBe(false);
    expect(body.supported).toBe(false);
  });
});

describe("the Fix-it prompt", () => {
  it("names no systemd unit, so it cannot name the wrong one", async () => {
    // It used to hardcode `journalctl -u clawbox-setup -u clawbox-gateway`.
    // clawbox-gateway is removed and masked on Hermes, so that read an empty
    // log and never mentioned clawbox-hermes-dashboard. This module is bundled
    // into the browser and cannot read the root-owned edition file, so the fix
    // is to defer to `logs_tail`, whose enum is already per-edition.
    const { buildFixErrorPrompt } = await import("@/lib/ui-events");
    const prompt = buildFixErrorPrompt({ source: "Settings", message: "boom" });

    expect(prompt).not.toContain("clawbox-gateway");
    expect(prompt).toContain("logs_tail");
  });
});
