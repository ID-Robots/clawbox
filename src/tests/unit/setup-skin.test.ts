import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";

// config-store backs the stored active_harness; mock it so we control the value
// without touching a real data/config.json.
const mockGet = vi.fn();
const mockSet = vi.fn();
vi.mock("@/lib/config-store", () => ({
  get: (...a: unknown[]) => mockGet(...a),
  set: (...a: unknown[]) => mockSet(...a),
}));

// The real module verifies an ed25519 licence; drive the two verdicts directly.
let licenseValid = false;
vi.mock("@/lib/edition-license", () => ({
  isDualLicenseEnforced: () => true,
  verifyDualLicense: () => licenseValid,
}));

async function loadSkin(edition?: string) {
  vi.resetModules();
  // Point the edition file at a path that cannot exist so the reader falls back
  // to process.env — the same path CI and dev boxes take.
  process.env.CLAWBOX_EDITION_FILE = "/nonexistent/clawbox/edition.env";
  if (edition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = edition;
  return import("@/lib/setup-skin");
}

describe("skinForHarness", () => {
  it("dresses only the hermes harness", async () => {
    const { skinForHarness } = await loadSkin();
    expect(skinForHarness("hermes")).toBe("hermes");
  });

  it("emits no attribute for anything else — that IS the ClawBox skin", async () => {
    const { skinForHarness } = await loadSkin();
    for (const value of ["openclaw", "dual", "", "HERMES", "Hermes", null, undefined]) {
      expect(skinForHarness(value)).toBeUndefined();
    }
  });
});

describe("resolveAgentSkin", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
    licenseValid = false;
  });
  afterEach(() => {
    delete process.env.CLAWBOX_EDITION;
    delete process.env.CLAWBOX_EDITION_FILE;
  });

  it("lights the hermes skin on the hermes SKU", async () => {
    // The edition lock wins outright: config.json is not even consulted.
    mockGet.mockResolvedValue("openclaw");
    const { resolveAgentSkin } = await loadSkin("hermes");
    await expect(resolveAgentSkin()).resolves.toBe("hermes");
  });

  it("leaves an openclaw box in ClawBox colours", async () => {
    mockGet.mockResolvedValue("hermes");
    const { resolveAgentSkin } = await loadSkin("openclaw");
    await expect(resolveAgentSkin()).resolves.toBeUndefined();
  });

  it("defaults to ClawBox when no edition is configured at all", async () => {
    mockGet.mockResolvedValue(undefined);
    const { resolveAgentSkin } = await loadSkin(undefined);
    await expect(resolveAgentSkin()).resolves.toBeUndefined();
  });

  it("follows the picker on a licensed dual box", async () => {
    licenseValid = true;

    mockGet.mockResolvedValue("hermes");
    const picked = await loadSkin("dual");
    await expect(picked.resolveAgentSkin()).resolves.toBe("hermes");

    mockGet.mockResolvedValue("openclaw");
    const switched = await loadSkin("dual");
    await expect(switched.resolveAgentSkin()).resolves.toBeUndefined();
  });

  it("degrades an unlicensed dual box to ClawBox, ignoring the stored pick", async () => {
    licenseValid = false;
    mockGet.mockResolvedValue("hermes");
    const { resolveAgentSkin } = await loadSkin("dual");
    await expect(resolveAgentSkin()).resolves.toBeUndefined();
  });

  it("renders ClawBox rather than failing when the harness cannot be resolved", async () => {
    // An unreadable config.json / edition file must never take the wizard down:
    // a wrong tint is cosmetic, a wizard that will not render is a brick.
    vi.resetModules();
    vi.doMock("@/lib/harness", () => ({
      getActiveHarness: async () => {
        throw new Error("EACCES");
      },
    }));
    const { resolveAgentSkin } = await import("@/lib/setup-skin");
    await expect(resolveAgentSkin()).resolves.toBeUndefined();
    vi.doUnmock("@/lib/harness");
  });
});

// ── The invariant the Hermes layer must never break ──────────────────────────
//
// --coral-bright is ACTION and --cyan-bright is DONE, on every box and under
// every harness. The Hermes layer is ADDITIVE: it re-points the ground and adds
// --agent-* names, and it must never redeclare those two. A previous attempt
// re-pointed them and put the wizard's two opposed states 1.08:1 apart.
describe("globals.css agent layer", () => {
  const css = fs.readFileSync(new URL("../../app/globals.css", import.meta.url), "utf-8");
  const declarationsOf = (token: string) =>
    css.split(/\r?\n/).filter((line) => line.trim().startsWith(`${token}:`));

  it.each(["--coral-bright", "--cyan-bright"])(
    "declares %s exactly once in the whole stylesheet",
    (token) => {
      expect(declarationsOf(token)).toHaveLength(1);
    }
  );

  it("declares both meanings before the agent layer, i.e. in :root and not inside it", () => {
    const agentLayerAt = css.indexOf('[data-agent="hermes"]');
    expect(agentLayerAt).toBeGreaterThan(-1);
    for (const token of ["--coral-bright", "--cyan-bright"]) {
      expect(css.indexOf(`  ${token}:`)).toBeLessThan(agentLayerAt);
    }
  });

  it("keeps the selector the wizard shell relies on, as a DESCENDANT selector", () => {
    // src/app/setup/layout.tsx stamps data-agent on a display:contents wrapper
    // ABOVE .setup-shell; a compound selector here would silently kill the skin.
    expect(css).toContain('[data-agent="hermes"] .setup-shell');
    expect(css).not.toContain('[data-agent="hermes"].setup-shell');
  });

  // The --agent-* ladder is shared by the wizard AND the Settings window. It
  // was briefly copied verbatim into a second rule, which is two sources of
  // truth for one palette: a change to --agent-ink in the wizard would have
  // silently missed Settings. One declaration, one selector list.
  it.each([
    "--agent-ink",
    "--agent-ink-2",
    "--agent-ink-3",
    "--agent-on-ink",
    "--agent-line",
    "--agent-card",
    "--agent-muted",
    "--agent-warn",
    "--agent-live",
    "--agent-term-bg",
    "--agent-term-fg",
  ])("declares %s exactly once in the whole stylesheet", (token) => {
    expect(declarationsOf(token)).toHaveLength(1);
  });

  it("reaches Settings' document.body portals, which are outside desktop-root", () => {
    // page.tsx stamps data-agent on desktop-root. SettingsApp portals the
    // factory-reset, hostname-reboot and update overlays to document.body —
    // SIBLINGS of desktop-root, not descendants — so a plain
    // `[data-agent="hermes"] .settings-pane` cannot reach them and they would
    // resolve no --set-* role at all. body:has() is the only shared ancestor.
    expect(css).toContain('body:has([data-agent="hermes"]) .settings-pane');
  });
});
