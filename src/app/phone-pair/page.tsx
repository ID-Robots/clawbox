"use client";

import PhonePairPage from "@/components/PhonePairPage";
import { I18nProvider } from "@/lib/i18n";

/** The page a phone opens from the owner's QR invite. Public — see src/middleware.ts `PUBLIC_EXACT`. */
export default function Page() {
  return (
    <I18nProvider>
      <PhonePairPage />
    </I18nProvider>
  );
}
