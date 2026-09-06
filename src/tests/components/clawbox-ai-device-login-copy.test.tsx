import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import ClawboxAiDeviceLogin from "@/components/ClawboxAiDeviceLogin";

// One mutable pack — the same card is asked what it renders for a locale that
// HAS these strings and for one that does not yet.
const pack = vi.hoisted(() => ({ strings: {} as Record<string, string> }));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => pack.strings[key] ?? key }),
}));

const GERMAN: Record<string, string> = {
  "ai.clawaiDeviceIntro": "Öffne das ClawBox-Portal und gib den unten angezeigten Gerätecode ein.",
  "ai.clawaiGetCode": "Gerätecode abrufen",
  "ai.clawaiHaveToken": "Du hast ein API-Token? Gib es stattdessen ein",
};

/**
 * The whole "Connect AI Provider" card was English on a German box. These are
 * the strings this component owns; the plan card's live in ClawboxAiPlanPicker.
 */
describe("ClawBox AI device login copy", () => {
  it("renders the locale's own words for the intro and the button", () => {
    pack.strings = GERMAN;
    render(
      <ClawboxAiDeviceLogin
        deviceCode={null}
        verificationUrl={null}
        polling={false}
        busy={false}
        onStart={() => {}}
        onSubmitToken={async () => {}}
      />,
    );

    expect(screen.getByText(GERMAN["ai.clawaiDeviceIntro"])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: GERMAN["ai.clawaiGetCode"] })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: GERMAN["ai.clawaiHaveToken"] })).toBeInTheDocument();
    expect(screen.queryByText(/Get device code/)).toBeNull();
  });

  it("falls back to English, never to the raw key, until the pack catches up", () => {
    pack.strings = {};
    render(
      <ClawboxAiDeviceLogin
        deviceCode={null}
        verificationUrl={null}
        polling={false}
        busy={false}
        onStart={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Get device code" })).toBeInTheDocument();
    expect(screen.getByText(/Open the ClawBox portal and enter the device code/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("ai.clawai");
  });
});
