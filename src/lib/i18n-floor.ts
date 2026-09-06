import { useCallback } from "react";
import { useT } from "@/lib/i18n";

/**
 * `t` with an English floor, and the ONE place a `{placeholder}` is filled in.
 *
 * A key the dictionaries do not hold yet comes back from `t` as the key itself,
 * and "chat.attachFile" on a tooltip is worse than the English word it stands
 * for. `useTr(key, english, params)` renders the translation when there is one
 * and `english` when there is not — so a string can ship with its key before
 * every locale has it, instead of being hardcoded with no key for a translator
 * to fill in.
 *
 * The substitution is done HERE rather than handed to `t`, because `t` is not
 * always the provider's: with no <I18nProvider> above the component `useT`
 * answers `fallbackT`, which returns the key and ignores params, and a test may
 * mock the hook with a plain table lookup. Both used to leave a literal
 * "{provider} model" on a control. Substituting after the lookup is also
 * harmless when `t` already did it — the placeholders are gone by then.
 *
 * It sits in its own module rather than in i18n.tsx because dozens of tests
 * replace "@/lib/i18n" with a hand-written `useT`; a component reaching for
 * `useTr` there would fail on every one of those mocks with "No useTr export
 * is defined". From here it reads the mocked `useT` like any other caller.
 */
export function useTr() {
  const { t } = useT();
  return useCallback(
    (key: string, english: string, params?: Record<string, string | number>): string => {
      const hit = t(key);
      let out = hit === key ? english : hit;
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          out = out.replaceAll(`{${name}}`, String(value));
        }
      }
      return out;
    },
    [t],
  );
}
