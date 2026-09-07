import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import { CLAWBOX_AI_DESCRIPTION, CLAWBOX_AI_DESCRIPTION_KEY } from "@/lib/clawbox-ai-tiers";
import ClawboxAiProviderRow from "@/components/ClawboxAiProviderRow";

/**
 * The ClawBox AI row is the one provider row both editions share, and it drew
 * its description from the English constant while every locale had carried a
 * translation of it for months: a German Settings → Anbieter page showed
 * "All-in cloud AI for ClawBox — …" under "ClawBox AI · EMPFOHLEN" with
 * German all around it (locale sweep DE-1, 2026-09-07). The constant stays as
 * the English floor; the row asks the catalogue.
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string) => translations.de[key] ?? translations.en[key] ?? key,
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("ClawboxAiProviderRow description", () => {
  it("is the locale's own line, not the English constant", () => {
    render(<ClawboxAiProviderRow radioName="ai-provider" selected={false} onSelect={() => {}} />);

    const german = translations.de[CLAWBOX_AI_DESCRIPTION_KEY];
    expect(german).toBeTruthy();
    expect(german).not.toBe(CLAWBOX_AI_DESCRIPTION);
    expect(screen.getByText(german)).toBeInTheDocument();
    expect(screen.queryByText(CLAWBOX_AI_DESCRIPTION)).toBeNull();
  });
});
