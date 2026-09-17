"use client";

import SubPageLayout from "@/components/SubPageLayout";
import SetupWizard from "@/components/SetupWizard";
import { I18nProvider } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";

/**
 * A client component, and the one that mounts the provider for this route.
 *
 * `title` is a plain string prop, so a server component had no hook to
 * translate it with and the back button read "Settings" on every locale.
 * Making the page a client component is free — SubPageLayout and SetupWizard
 * are both "use client" already, so nothing crosses the boundary that was not
 * on the client side of it before.
 *
 * The provider has to be HERE rather than inside SubPageLayout: SetupWizard
 * mounts its own I18nProvider around its inner tree, which left everything
 * ABOVE it — the back button's caption and its two aria-labels — outside any
 * provider, where `t()` echoes the key back and `tr()` falls through to
 * English. Nesting is the expected shape (see `useSyncHtmlLang`): only the
 * outermost provider writes `<html lang>`, so the inner one stays harmless.
 */
function SettingsPageInner() {
  const tr = useTr();
  return (
    <SubPageLayout title={tr("app.settings", "Settings")} fullPage>
      <SetupWizard />
    </SubPageLayout>
  );
}

export default function SettingsPage() {
  return (
    <I18nProvider>
      <SettingsPageInner />
    </I18nProvider>
  );
}
