/**
 * The provider's first request (src/lib/i18n.tsx) is the ONE preference read
 * the middleware answers with no session, and the three parties — the
 * provider that sends it, the middleware that admits it, the route that
 * answers it — build it from src/lib/ui-language-read.ts. The middleware and
 * route suites pin their ends; this pins the provider's: the URL it fetches
 * IS that object's, so a key added to the fetch alone (and not to the object
 * every gate reads) fails here instead of sending /login back to the
 * browser's language with every gate's own test green.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider, useT } from "@/lib/i18n";
import { UI_LANGUAGE_READ } from "@/lib/ui-language-read";

function Probe() {
  const { locale, localeResolved } = useT();
  return <span data-testid="probe">{localeResolved ? locale : "pending"}</span>;
}

describe("I18nProvider — the language read", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches exactly UI_LANGUAGE_READ.url, once, and applies the answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ui_language: "de" }) });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("de"));
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual([UI_LANGUAGE_READ.url]);
    // The literal the middleware's carve-out is worth: the language, and no
    // second key riding along with it.
    expect(UI_LANGUAGE_READ.url).toBe("/setup-api/preferences?keys=ui_language");
  });
});
