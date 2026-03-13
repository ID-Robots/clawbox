import SubPageLayout from "@/components/SubPageLayout";
import SetupWizard from "@/components/SetupWizard";

export default function SettingsPage() {
  return (
    <SubPageLayout title="Settings" fullPage>
      <SetupWizard />
    </SubPageLayout>
  );
}
