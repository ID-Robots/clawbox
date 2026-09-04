import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The guide ClawBox seeds into the OpenClaw workspace as `CLAWBOX.md`
 * (scripts/gateway-pre-start.sh) is the agent's only source of ClawBox-specific
 * conventions, so what it forbids is as load-bearing as what it offers.
 *
 * TASK-612: asked "restart the gateway", the agent reached for OpenClaw's
 * operator-approval path — the native `approval.request` RPC behind the
 * `operator.approvals` scope, which is the right mechanism on a box whose
 * operator surface renders it. ClawBox's chat renders nothing of the kind
 * today, so the proposal sat unanswered until the run ended or a gateway
 * restart cancelled it (`operator_approval_cancelled_gateway_restart`), and
 * the owner was told the restart was waiting for an approval they had nowhere
 * to give. Until that card exists (TASK-704, under TASK-604), the guide has to
 * forbid the queue and name the owner's real path — the power menu in the
 * desktop tray, NOT Settings -> System, which carries no power control at all.
 *
 * Asserted against the section, not the whole file, so a failure prints the
 * paragraph that is wrong rather than the entire guide.
 */

const GUIDE_PATH = path.join(process.cwd(), "config/clawbox-workspace-guide.md");
const GUIDE = readFileSync(GUIDE_PATH, "utf-8");

/**
 * The OTHER guide the model is handed: `clawbox_context` reads Clawbox.md from
 * the repo root and pastes it into the session verbatim
 * (mcp/tools/orientation.ts). Two guides, both loaded, so a rule changed in one
 * and not the other reaches the agent as a contradiction.
 */
const FIELD_GUIDE = readFileSync(path.join(process.cwd(), "Clawbox.md"), "utf-8");

/** The `## System actions and restarts` section, without its neighbours. */
function systemActionsSection(): string {
  const start = GUIDE.search(/^## .*\bSystem actions\b/im);
  if (start < 0) return "";
  const rest = GUIDE.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("the ClawBox workspace guide (CLAWBOX.md)", () => {
  it("carries a section on system actions and restarts", () => {
    expect(systemActionsSection().slice(0, 80)).toMatch(/^## .*System actions/);
  });

  it("separates the gateway restart it refuses from the device restart it owns", () => {
    const section = systemActionsSection();
    // The gateway restart, by name and with a reason the agent can act on.
    expect(section.toLowerCase()).toContain("gateway");
    expect(section).toMatch(/not yours|is not yours to do/i);
    // And the capability the device actually ships, which an earlier draft of
    // this section denied outright ("you have no tool for any of them") — the
    // guide would then have talked a confirm-gated, owner-consented tool out
    // of existence. mcp/tools/system.ts registers it on both editions.
    expect(section).toContain("system_power");
  });

  it("gives the owner's control as the tray power menu, and Settings -> System only for what is on it", () => {
    const section = systemActionsSection();
    // Settings -> System carries the harness picker, the performance mode, the
    // read-only stats and the password — no power control (SettingsApp.tsx).
    // Sending the owner there for a restart is the wrong screen.
    expect(section).toMatch(/power menu/i);
    expect(section).toMatch(/Settings\s*→\s*System/);
    // And it must tell the agent to SAY where the control is, not just decline.
    expect(section).toMatch(/say that|answer with|tell (?:the owner|them)|point (?:the owner|them)/i);
  });

  it("names the screen each control is actually on, not the one next to it", () => {
    const section = systemActionsSection();
    // Measured in src/components/SettingsApp.tsx at this head:
    //
    //   - the EDITABLE device name is the "Local URL (mDNS hostname)" card at
    //     :3425, inside `activeSection === "wifi"` (:3241-3631). That nav entry
    //     is `{ id: "wifi", ..., labelKey: "settings.network" }` (:255) and
    //     "settings.network" is "Network" (src/lib/translations.ts:302). Saving
    //     it POSTs /setup-api/system/power (:1090) — hence "reboots".
    //   - Settings -> About (`activeSection === "about"`, :5638) holds the
    //     version card, the docs/support links, the Beta toggle, the System
    //     Update tile and Factory reset. Grepping :5638-5800 for
    //     hostname|rename|deviceName returns nothing.
    //
    // Sending the owner to About to rename the box is the identical
    // wrong-screen failure this section was written to remove, one clause later.
    expect(section).toMatch(/Settings\s*→\s*Network/);
    const deviceNameClauses = section
      .split(/(?<=[.;])\s+/)
      .filter((clause) => /device name|hostname|Local URL/i.test(clause));
    expect(deviceNameClauses.length).toBeGreaterThan(0);
    for (const clause of deviceNameClauses) {
      expect(clause).toMatch(/Settings\s*→\s*Network/);
      expect(clause).not.toMatch(/Settings\s*→\s*About/);
    }
  });

  it("names the restart-on-save tabs by their labels", () => {
    const section = systemActionsSection();
    // There is no tab labelled "AI": nav id "ai" carries labelKey
    // "settings.providers" (SettingsApp.tsx:245) = "Providers"
    // (src/lib/desktop-translations.ts:411). Voice and Channels are correct.
    expect(section).toMatch(/Settings\s*→\s*Providers/);
    expect(section).not.toMatch(/Settings\s*→\s*AI\b/);
  });

  it("forbids queueing an operator-approval proposal, and names the way to answer a parked one", () => {
    const section = systemActionsSection();
    // The native id, so the instruction names what the agent would actually
    // reach for rather than a paraphrase of it.
    expect(section).toContain("operator_approval");
    expect(section).toMatch(/never\s+(?:queue|propose|raise|open)|do not\s+queue|don't\s+queue/i);
    // "nowhere to answer it" would be false: the CLI resolves one, and the
    // desktop ships a Terminal app.
    expect(section).toContain("openclaw approvals");
  });
});

/**
 * Where the owner's name comes from.
 *
 * Settings → Appearance used to carry a "Your name" field that wrote
 * `ui_user_name`; this batch deleted it, leaving the agent as the ONLY writer
 * of that preference — which is also why ClawBox now ships its own
 * first-conversation ritual (config/clawbox-bootstrap.md) that asks. A guide
 * still pointing the owner at that field sends them to a screen that no longer
 * has it, and tells the agent someone else will collect the name.
 */
describe("the two guides the agent loads — the owner's name", () => {
  const nameSection = (guide: string) => {
    const start = guide.search(/Remember the user's name/i);
    if (start < 0) return "";
    const rest = guide.slice(start);
    const next = rest.slice(1).search(/^#{2,3} |^- \*\*/m);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };

  for (const [label, guide] of [
    ["CLAWBOX.md (config/clawbox-workspace-guide.md)", GUIDE],
    ["the field guide (Clawbox.md)", FIELD_GUIDE],
  ] as const) {
    it(`tells the agent to persist the name, in ${label}`, () => {
      expect(nameSection(guide)).toContain('preferences_set(\'{"ui_user_name": "<name>"}\')');
    });

    it(`does not send the owner to a "Your name" field, in ${label}`, () => {
      // SettingsApp.tsx's Appearance section is Language, Wallpaper and the pet
      // picker; grepping it for ui_user_name returns nothing.
      expect(guide).not.toMatch(/"Your name"/);
      expect(guide).not.toMatch(/Your name.{0,40}field/i);
    });

    it(`says the agent is the only writer, in ${label}`, () => {
      expect(nameSection(guide)).toMatch(/only writer/i);
    });
  }
});
