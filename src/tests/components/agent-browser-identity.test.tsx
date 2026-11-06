import { describe, expect, it } from "vitest";
import { render } from "@/tests/helpers/test-utils";
import AgentBrowserIcon from "@/components/AgentBrowserIcon";
import { apps } from "@/lib/desktop-apps";
import { desktopTranslations } from "@/lib/desktop-translations";
import { translations } from "@/lib/translations";

/**
 * The desktop's "Browser" is the Agent Browser: the Chromium the assistant
 * drives, shown on the device's screen. Under the plain name and a Chrome-style
 * roundel it read as a browser for the owner — which is `web`, on the boxes
 * that have one.
 */
describe("the Agent Browser's name", () => {
  const app = apps.find((a) => a.id === "browser");

  it("is what the desktop, the launcher and the window title all read", () => {
    expect(app?.name).toBe("app.browser");
    expect(desktopTranslations.en["app.browser"]).toBe("Agent Browser");
  });

  // What each locale called it before: the bare word for "browser".
  const PLAIN: Record<string, string> = {
    bg: "Браузър", de: "Browser", es: "Navegador", fr: "Navigateur", it: "Browser",
    ja: "ブラウザ", nl: "Browser", sv: "Webbläsare", zh: "浏览器",
  };

  it.each(Object.keys(PLAIN))("says whose browser it is in '%s', in that language", (locale) => {
    const name = desktopTranslations[locale as keyof typeof desktopTranslations]["app.browser"];
    expect(name).toBeTruthy();
    expect(name).not.toBe(PLAIN[locale]);
    expect(name).not.toBe(desktopTranslations.en["app.browser"]);
    // Still names a browser, in the locale's own word for one.
    expect(name.toLowerCase()).toContain(PLAIN[locale].toLowerCase());
  });

  // The two sentences that point the owner AT the app by its name: under the
  // old name they pointed at nothing on the desktop (or, on a kiosk, at Web).
  it.each(["en", ...Object.keys(PLAIN)])("is the name the Coding Agent's browser hints use in '%s'", (locale) => {
    const table = translations[locale as keyof typeof translations];
    const name = table["app.browser"];
    for (const key of ["codingAgent.realBrowserHint", "codingAgent.wizardBrowserHint"]) {
      // German and Dutch compound the name with "App"; every locale carries it whole.
      expect(table[key].replace(/-App\b|-app\b/g, ""), `${locale} ${key}`).toContain(name);
    }
  });

  it("covers every locale the desktop ships", () => {
    expect(Object.keys(desktopTranslations).sort()).toEqual(["en", ...Object.keys(PLAIN)].sort());
  });
});

describe("the Agent Browser's icon", () => {
  it("is drawn in the colour it is given, so one drawing sits on the blue tile and the orange header mark", () => {
    const { getByTestId } = render(<AgentBrowserIcon className="w-6 h-6 text-white" />);
    const svg = getByTestId("agent-browser-icon");

    expect(svg.getAttribute("class")).toContain("w-6 h-6 text-white");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    const paints = [...svg.querySelectorAll("*")].flatMap((el) => [el.getAttribute("fill"), el.getAttribute("stroke")]).filter(Boolean);
    expect(paints.length).toBeGreaterThan(0);
    // No hex, no named colour: nothing that would have to match a tile.
    for (const paint of paints) expect(["currentColor", "none"]).toContain(paint);
  });

  it("cuts the eyes out of the head rather than painting them", () => {
    const { getByTestId } = render(<AgentBrowserIcon />);
    const head = getByTestId("agent-browser-icon").querySelector('path[fill="currentColor"]');

    expect(head).toHaveAttribute("fill-rule", "evenodd");
    // One outline and two holes.
    expect(head?.getAttribute("d")?.match(/M/g)).toHaveLength(3);
  });

  it("is decoration: the name beside it is what a screen reader hears", () => {
    const { getByTestId } = render(<AgentBrowserIcon />);
    expect(getByTestId("agent-browser-icon")).toHaveAttribute("aria-hidden", "true");
  });
});
