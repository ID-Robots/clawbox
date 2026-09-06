import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(),
  probeStillOwed: vi.fn(),
}));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ clawaiTokenRejectedByPortal: vi.fn() }));

let GET: () => Promise<Response>;
let getActiveHarness: Mock;
let hasClawaiToken: Mock;
let readConfig: Mock;
let getConfigValue: Mock;
let getModelOptions: Mock;
let probeStillOwed: Mock;
let clawaiTokenRejectedByPortal: Mock;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ hasClawaiToken } = (await import("@/lib/harness/credentials")) as unknown as { hasClawaiToken: Mock });
  ({ readConfig } = (await import("@/lib/openclaw-config")) as unknown as { readConfig: Mock });
  ({ get: getConfigValue } = (await import("@/lib/config-store")) as unknown as { get: Mock });
  ({ getModelOptions, probeStillOwed } = (await import("@/lib/hermes-model-options")) as unknown as {
    getModelOptions: Mock;
    probeStillOwed: Mock;
  });
  ({ clawaiTokenRejectedByPortal } = (await import("@/lib/clawbox-ai-portal-tier")) as unknown as {
    clawaiTokenRejectedByPortal: Mock;
  });
  getConfigValue.mockResolvedValue(null);
  hasClawaiToken.mockResolvedValue(false);
  // Nobody has asked the portal yet: the cold answer, and beta's behaviour.
  clawaiTokenRejectedByPortal.mockReturnValue(false);
  // The settled box: the dashboard has answered, so nothing is outstanding.
  probeStillOwed.mockResolvedValue(false);
  ({ GET } = await import("@/app/setup-api/providers/status/route"));
});

function hermesPayload(overrides: Record<string, unknown> = {}) {
  return {
    providers: [
      { id: "anthropic", name: "Anthropic", authenticated: true, isUserDefined: false, source: "d", total: 3, models: [] },
      { id: "openrouter", name: "OpenRouter", authenticated: false, isUserDefined: false, source: "d", total: 0, models: [] },
      { id: "gemini", name: "Gemini", authenticated: null, isUserDefined: false, source: "d", total: 0, models: [] },
    ],
    current: { provider: "anthropic", model: "claude-sonnet-5" },
    reasoning: "medium",
    fetchedAt: Date.now(),
    source: "dashboard",
    stale: false,
    ...overrides,
  };
}

interface Row {
  id: string;
  label: string;
  state: string;
  isDefault: boolean;
  enabled: boolean;
  section: string;
}

/** The config store answering ONLY the owner's disabled list. */
function storeDisabled(ids: unknown) {
  getConfigValue.mockImplementation(async (key: string) => (key === "ai_disabled_providers" ? ids : null));
}

const rowFor = (body: { providers: Row[] }, id: string): Row | undefined =>
  body.providers.find((p) => p.id === id);

describe("GET /setup-api/providers/status — Hermes", () => {
  beforeEach(() => getActiveHarness.mockResolvedValue("hermes"));

  it("answers for EVERY provider in one call, not just the active one", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    // The whole point of the endpoint: no selecting a provider to learn about it.
    expect(body.providers.length).toBeGreaterThan(3);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(["clawai", "anthropic", "openrouter", "gemini"]),
    );
  });

  it("maps the three credential answers onto the three honest states", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    expect(rowFor(body, "anthropic")!.state).toBe("connected");
    expect(rowFor(body, "openrouter")!.state).toBe("disconnected");
    // `authenticated: null` is "we could not tell", NOT "not connected" —
    // telling someone their working key is gone is the worse of the two lies.
    expect(rowFor(body, "gemini")!.state).toBe("unknown");
  });

  it("marks the harness's configured provider as the default", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    expect(body.defaultProvider).toBe("anthropic");
    expect(rowFor(body, "anthropic")!.isDefault).toBe(true);
    expect(body.providers.filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(1);
  });

  it("calls the default provider 'needs-reauth' when it cannot authenticate", async () => {
    // The box is pointed at a provider it has no working credential for. That
    // is the one failure worth its own colour: chat is broken until it is fixed.
    getModelOptions.mockResolvedValue(
      hermesPayload({ current: { provider: "openrouter", model: "x" } }),
    );
    const body = await (await GET()).json();

    expect(rowFor(body, "openrouter")!.state).toBe("needs-reauth");
    expect(rowFor(body, "anthropic")!.state).toBe("connected");
  });

  it("falls back to our credential when the dashboard has no ClawBox AI row", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    hasClawaiToken.mockResolvedValue(true);
    const body = await (await GET()).json();

    // The dashboard never enumerated a `clawai` row; the box is linked anyway,
    // and a held credential is evidence of that.
    expect(rowFor(body, "clawai")!.state).toBe("connected");
  });

  it("believes the dashboard about ClawBox AI even when we hold no token", async () => {
    // The live regression this replaced: on a linked Hermes box the token is
    // Hermes' to hold, so `hasClawaiToken` is false while the dashboard reports
    // the provider authenticated and chat works through it. Reading the
    // credential first called the box's ACTIVE provider "Needs sign-in".
    getModelOptions.mockResolvedValue(hermesPayload({
      providers: [
        ...hermesPayload().providers,
        { id: "clawai", name: "clawai", authenticated: true, isUserDefined: true, source: "d", total: 2, models: [] },
      ],
      current: { provider: "clawai", model: "deepseek-v4-flash" },
    }));
    hasClawaiToken.mockResolvedValue(false);
    const body = await (await GET()).json();

    expect(rowFor(body, "clawai")!.state).toBe("connected");
    expect(rowFor(body, "clawai")!.isDefault).toBe(true);
  });

  it("says NOT CONNECTED for ClawBox AI when the dashboard answered and it is simply unlinked", async () => {
    // The dashboard enumerated no clawai row and we hold no token — but the
    // dashboard DID answer (payload not stale), and clawai's link state is fully
    // knowable from our own stores, so a held-nothing box is "not connected",
    // not "unknown". A mid-setup owner staring at their never-linked ClawBox AI
    // row must not be told its state is a mystery.
    getModelOptions.mockResolvedValue(hermesPayload());
    hasClawaiToken.mockResolvedValue(false);
    const body = await (await GET()).json();

    expect(rowFor(body, "clawai")!.state).toBe("disconnected");
  });

  it("keeps ClawBox AI 'unknown' ONLY when the probe itself failed", async () => {
    // Unknown is now reserved for a genuine probe failure: the dashboard could
    // not be asked (stale fallback), so we truly cannot tell.
    getModelOptions.mockResolvedValue(hermesPayload({ stale: true }));
    hasClawaiToken.mockResolvedValue(false);
    const body = await (await GET()).json();

    expect(rowFor(body, "clawai")!.state).toBe("unknown");
  });

  it("shows a provider configured outside our curated list", async () => {
    getModelOptions.mockResolvedValue(
      hermesPayload({ current: { provider: "fireworks", model: "y" } }),
    );
    const body = await (await GET()).json();

    expect(rowFor(body, "fireworks")).toBeDefined();
    expect(rowFor(body, "fireworks")!.isDefault).toBe(true);
  });

  it("passes a stale catalogue through as degraded", async () => {
    getModelOptions.mockResolvedValue(hermesPayload({ stale: true }));
    expect((await (await GET()).json()).degraded).toBe(true);
  });

  // ── TASK-663: "checking…" is a state, and it is not a failure ──────────────
  //
  // Right after a reboot the Hermes dashboard is not up yet — `clawbox-setup`
  // answers in 0 ms and `clawbox-hermes-dashboard` needs another ~11-12 s — so
  // `getModelOptions` answers from the on-disk manifest, which carries no auth
  // state for any row. Reporting THAT as `degraded: true` with every provider
  // "Unknown" paints a healthy box as broken over an answer nobody has been
  // able to ask for yet: a false failure, and the one the Providers panel
  // opened on.
  //
  // `probeStillOwed` is `hermes-model-options`' answer to "is the dashboard
  // still coming up?" — asked of systemd, read at CALL time so a cached payload
  // cannot report the window as it stood a poll ago.
  function unprobedPayload() {
    return hermesPayload({
      providers: [
        { id: "anthropic", name: "anthropic", authenticated: null, verified: null, isUserDefined: null, source: "catalog-file", total: 0, models: [] },
      ],
      source: "catalog-file",
      stale: true,
    });
  }

  it("says CHECKING, not degraded, while the first probe is still owed", async () => {
    getModelOptions.mockResolvedValue(unprobedPayload());
    probeStillOwed.mockResolvedValue(true);
    const body = await (await GET()).json();

    expect(body.degraded).toBe(false);
    expect(rowFor(body, "anthropic")!.state).toBe("checking");
    // Every row, not only the default one: none of them has been probed.
    expect(rowFor(body, "gemini")!.state).toBe("checking");
    // ClawBox AI has no live answer and no token of our own either, and that
    // is still "not asked yet" rather than "not linked".
    expect(rowFor(body, "clawai")!.state).toBe("checking");
  });

  // The other half, and the reason `awaitingProbe` is time-bounded rather than
  // a plain "have we ever succeeded": a dashboard that never comes back must
  // stop reading as "Checking…" and go back to reading as degraded. A probe
  // that failed shown as checking forever is the same lie in the other
  // direction.
  it("stops checking and degrades once the probe is no longer owed", async () => {
    getModelOptions.mockResolvedValue(unprobedPayload());
    probeStillOwed.mockResolvedValue(false);
    const body = await (await GET()).json();

    expect(body.degraded).toBe(true);
    expect(rowFor(body, "anthropic")!.state).toBe("unknown");
  });

  // A LIVE answer that says "this provider could not be judged" is a real probe
  // result and keeps its own word. `checking` is only ever about the absence of
  // a probe, never about what one returned.
  it("still says unknown for a row the live dashboard could not judge", async () => {
    // The shape the `stale` half of the guard exists for: the dashboard ANSWERED
    // (so `gemini`'s null is a result), while a concurrent outage has the probe
    // predicate saying an answer is owed. Without that half this row would be
    // repainted "checking" on the strength of a fact about a different read.
    getModelOptions.mockResolvedValue(hermesPayload({ stale: false }));
    probeStillOwed.mockResolvedValue(true);
    const body = await (await GET()).json();

    expect(body.degraded).toBe(false);
    expect(rowFor(body, "gemini")!.state).toBe("unknown");
  });

  it("keys the owner's switch by Hermes' own id, not a folded one", async () => {
    // `openai-codex` is what the Hermes row is called; folding it onto
    // `openai` the way OpenClaw's normaliser does would leave a switch flipped
    // on an id no row carries.
    getModelOptions.mockResolvedValue(hermesPayload({
      providers: [
        ...hermesPayload().providers,
        { id: "openai-codex", name: "OpenAI", authenticated: true, isUserDefined: false, source: "d", total: 1, models: [] },
      ],
    }));
    storeDisabled(["openai-codex"]);
    const body = await (await GET()).json();

    expect(rowFor(body, "openai-codex")!.enabled).toBe(false);
    expect(rowFor(body, "openai-codex")!.state).toBe("connected");
  });

  it("degrades rather than throwing when the box cannot be asked", async () => {
    getModelOptions.mockRejectedValue(new Error("dashboard down"));
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.providers).toEqual([]);
  });
});

describe("GET /setup-api/providers/status — OpenClaw", () => {
  beforeEach(() => getActiveHarness.mockResolvedValue("openclaw"));

  it("counts an auth profile and a provider key as connected", async () => {
    readConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
      models: { providers: { openrouter: { apiKey: "sk-or-secret" } } },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });
    const body = await (await GET()).json();

    expect(rowFor(body, "anthropic")!.state).toBe("connected");
    expect(rowFor(body, "openrouter")!.state).toBe("connected");
    expect(rowFor(body, "google")!.state).toBe("disconnected");
    expect(body.defaultProvider).toBe("anthropic");
  });

  it("does not call OpenAI connected when its slot only carries ClawBox AI's own token", async () => {
    // ClawBox AI's image generation and cloud voice are registered under the
    // `openai` provider (its OpenAI-compatible routes on our proxy) with the
    // claw_ token. A box with nothing but ClawBox AI linked read
    // "OpenAI: Connected" — seen on a live box.
    readConfig.mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
      models: { providers: {
        deepseek: { apiKey: "claw_box_token" },
        openai: { apiKey: "claw_box_token", models: [{ id: "gpt-image-1-mini", baseUrl: "https://clawbox.com/api/ai" }] },
      } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
    });
    const body = await (await GET()).json();

    expect(rowFor(body, "clawai")!.state).toBe("connected");
    expect(rowFor(body, "openai")!.state).toBe("disconnected");
  });

  it("collapses the wire spellings of one vendor onto one row", async () => {
    // `deepseek` is ClawBox AI's provider id in openclaw.json, and `codex` is
    // the ChatGPT-subscription spelling of OpenAI. Two rows for one vendor in a
    // strip whose job is to be scannable is worse than none.
    readConfig.mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek" }, "codex:default": { provider: "codex" } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    });
    const body = await (await GET()).json();

    expect(body.providers.filter((p: { id: string }) => p.id === "clawai")).toHaveLength(1);
    expect(rowFor(body, "clawai")!.state).toBe("connected");
    expect(rowFor(body, "openai")!.state).toBe("connected");
    expect(body.defaultProvider).toBe("clawai");
  });

  it("lists a configured local engine, and points it at its own section", async () => {
    readConfig.mockResolvedValue({ agents: { defaults: { model: { primary: "llamacpp/gemma-4" } } } });
    getConfigValue.mockResolvedValue("llamacpp");
    const body = await (await GET()).json();

    expect(rowFor(body, "llamacpp")!.state).toBe("connected");
    // Sending someone to the AI Provider panel to change a local model lands
    // them on a panel that cannot change it.
    expect(rowFor(body, "llamacpp")!.section).toBe("localAi");
    expect(rowFor(body, "anthropic")!.section).toBe("ai");
  });

  // TASK-663, the OpenClaw leg. This path reads `openclaw.json` off disk and
  // performs NO probe at all, so it has no window in which an answer is owed:
  // it must never emit `checking`, and it must never degrade over a cold box.
  it("never says checking on OpenClaw, which probes nothing", async () => {
    readConfig.mockResolvedValue({});
    // The predicate says an answer IS owed — the shape that would repaint every
    // unjudged row on the Hermes leg. Left at its `false` default this test
    // passed on its own fixture and would have gone on passing if a later edit
    // wired the probe into this reader, which is the one thing it is named for.
    // Nothing on this path may consult it: `probeStillOwed` is also the only
    // route from here to the systemd read, so not calling it is what keeps an
    // OpenClaw box from forking `systemctl` over a Hermes unit it has stopped
    // and disabled.
    probeStillOwed.mockResolvedValue(true);
    const body = await (await GET()).json();

    expect(body.degraded).toBe(false);
    expect(body.providers.map((p: Row) => p.state)).not.toContain("checking");
    expect(probeStillOwed).not.toHaveBeenCalled();
  });
});

describe("the owner's switch", () => {
  beforeEach(() => {
    getActiveHarness.mockResolvedValue("openclaw");
    readConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic" } } },
      models: { providers: { openrouter: { apiKey: "sk-or-secret" } } },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });
  });

  it("is on for every row until the owner says otherwise", async () => {
    const body = await (await GET()).json();

    expect(body.providers.length).toBeGreaterThan(0);
    for (const row of body.providers) expect(row.enabled).toBe(true);
  });

  it("reports a switched-off provider as enabled:false with its state untouched", async () => {
    // Two orthogonal facts. Switching a provider off does not disconnect it —
    // the credential is kept so switching it back on is one click — and the
    // strip must say both: still connected, currently off.
    storeDisabled(["openrouter"]);
    const body = await (await GET()).json();

    expect(rowFor(body, "openrouter")!.enabled).toBe(false);
    expect(rowFor(body, "openrouter")!.state).toBe("connected");
    expect(rowFor(body, "anthropic")!.enabled).toBe(true);
    expect(rowFor(body, "google")!.enabled).toBe(true);
  });

  it("reads a malformed stored list as nothing disabled", async () => {
    // config.json is hand-editable; a bad value must not take the strip down
    // or, worse, switch anything off.
    storeDisabled("anthropic");
    const body = await (await GET()).json();

    for (const row of body.providers) expect(row.enabled).toBe(true);
  });
});

describe("the response carries statuses, never credentials", () => {
  // The rule `/setup-api/chat/capabilities` already states, enforced: a page
  // needs to know whether a provider WORKS, not what the key is.
  const SECRETS = [
    "sk-ant-verysecretkeymaterial",
    "claw_portaltokenverysecret",
    "sk-or-v1-openroutersecretkey",
  ];

  it("does not echo key material from either harness's config", async () => {
    getActiveHarness.mockResolvedValue("openclaw");
    hasClawaiToken.mockResolvedValue(true);
    readConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic" } } },
      models: {
        providers: {
          anthropic: { apiKey: SECRETS[0] },
          clawai: { apiKey: SECRETS[1] },
          openrouter: { apiKey: SECRETS[2] },
        },
      },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });

    const raw = await (await GET()).text();
    for (const secret of SECRETS) expect(raw).not.toContain(secret);
    // And nothing token-SHAPED, in case a future field carries one by accident.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(raw).not.toMatch(/claw_[A-Za-z0-9_-]{8,}/);
    expect(raw).not.toMatch(/"apiKey"|"api_key"|"token"|"baseUrl"/);
  });

  it("emits only the fields the strip renders", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    expect(Object.keys(body).sort()).toEqual(
      // `unrunnable` is a list of provider IDS — a status, like every other
      // field here, and pinned by the same contract (TASK-668).
      ["defaultProvider", "degraded", "harness", "providers", "unrunnable"],
    );
    for (const row of body.providers) {
      expect(Object.keys(row).sort()).toEqual(["enabled", "id", "isDefault", "label", "section", "state"]);
      expect(typeof row.isDefault).toBe("boolean");
      expect(typeof row.enabled).toBe("boolean");
      // The owner's switch is an orthogonal FIELD — never a state.
      expect(["connected", "disconnected", "needs-reauth", "checking", "unknown"]).toContain(row.state);
    }
  });

  // ...and the same contract on the answer a booting box gives, which is the
  // one shape the fixture above cannot produce.
  it("emits only those fields while the box is still being checked", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue(hermesPayload({ stale: true }));
    probeStillOwed.mockResolvedValue(true);
    const body = await (await GET()).json();

    expect(Object.keys(body).sort()).toEqual(
      // `unrunnable` is a list of provider IDS — a status, like every other
      // field here, and pinned by the same contract (TASK-668).
      ["defaultProvider", "degraded", "harness", "providers", "unrunnable"],
    );
    expect(body.providers.some((row: Row) => row.state === "checking")).toBe(true);
    for (const row of body.providers) {
      expect(Object.keys(row).sort()).toEqual(["enabled", "id", "isDefault", "label", "section", "state"]);
      expect(["connected", "disconnected", "needs-reauth", "checking", "unknown"]).toContain(row.state);
    }
  });
});

// ── TASK-606: a provider whose plugin the boot script could not repair ──────
//
// "Not connected" was true and useless: the plugin behind the row would not
// install or consent, the boot script switched it off so the gateway could
// start, and the panel had nothing to say and nothing to press. The marker is
// stamped in `readProviderStatus`, beside the enabled switch, so neither
// harness reader has to know about it and the two cannot disagree.
describe("providers/status — needs repair", () => {
  const markerDir = path.join(process.env.CLAWBOX_ROOT as string, "data");
  const markerPath = path.join(markerDir, "plugin-repair.json");

  afterEach(() => {
    rmSync(markerPath, { force: true });
  });

  function writeMarker(rows: unknown) {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(markerPath, JSON.stringify(rows), "utf-8");
  }

  it("puts the DeepSeek plugin's failure on the ClawBox AI row", async () => {
    getActiveHarness.mockResolvedValue("openclaw");
    readConfig.mockResolvedValue({});
    writeMarker({
      deepseek: {
        id: "@openclaw/deepseek-provider",
        stage: "install",
        reason: "The DeepSeek provider plugin, which ClawBox AI runs on, could not be installed.",
        atMs: 1_700_000_000_000,
        disabled: true,
      },
    });

    const body = await (await GET()).json() as { providers: (Row & { needsRepair?: { pluginId: string; stage: string; reason: string } })[] };
    const clawai = body.providers.find((r) => r.id === "clawai");
    expect(clawai?.needsRepair?.pluginId).toBe("@openclaw/deepseek-provider");
    expect(clawai?.needsRepair?.stage).toBe("install");
    expect(clawai?.needsRepair?.reason).toMatch(/could not be installed/);
    // Only the row it belongs to.
    expect(body.providers.find((r) => r.id === "anthropic")).not.toHaveProperty("needsRepair");
  });

  it("says nothing on a box with no failures", async () => {
    getActiveHarness.mockResolvedValue("openclaw");
    readConfig.mockResolvedValue({});
    const body = await (await GET()).json() as { providers: Row[] };
    for (const row of body.providers) expect(row).not.toHaveProperty("needsRepair");
  });

  it("is inert on Hermes, where nothing writes the marker", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json() as { providers: Row[] };
    for (const row of body.providers) expect(row).not.toHaveProperty("needsRepair");
  });
});

describe("providers/status — a ClawBox AI token the portal refused", () => {
  // TASK-419. The strip derives "Connected" from the credential being PRESENT,
  // so a revoked token painted the cyan dot and the word Connected on the very
  // screen the chat's own failure text sends the customer to. `needs-reauth`
  // already exists for this and is already worded in all ten locales.
  it("shows the ClawBox AI row as needing sign-in on OpenClaw", async () => {
    getActiveHarness.mockResolvedValue("openclaw");
    readConfig.mockResolvedValue({
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
      models: { providers: { deepseek: { apiKey: "claw_x" } } },
    });
    hasClawaiToken.mockResolvedValue(true);

    clawaiTokenRejectedByPortal.mockReturnValue(false);
    const healthy = await (await GET()).json() as { providers: { id: string; state: string }[] };
    expect(healthy.providers.find((r) => r.id === "clawai")?.state).toBe("connected");

    clawaiTokenRejectedByPortal.mockReturnValue(true);
    const refused = await (await GET()).json() as { providers: { id: string; state: string }[] };
    expect(refused.providers.find((r) => r.id === "clawai")?.state).toBe("needs-reauth");
  });

  it("shows it the same way on Hermes", async () => {
    // The shared-surface rule: the same fact, the same row, the same word on
    // the edition whose panel is built from a different reader entirely.
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue(hermesPayload());
    hasClawaiToken.mockResolvedValue(true);

    clawaiTokenRejectedByPortal.mockReturnValue(false);
    const healthy = await (await GET()).json() as { providers: { id: string; state: string }[] };
    expect(healthy.providers.find((r) => r.id === "clawai")?.state).toBe("connected");

    clawaiTokenRejectedByPortal.mockReturnValue(true);
    const refused = await (await GET()).json() as { providers: { id: string; state: string }[] };
    expect(refused.providers.find((r) => r.id === "clawai")?.state).toBe("needs-reauth");
  });
});
