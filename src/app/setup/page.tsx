"use client";

import SetupWizard from "@/components/SetupWizard";

export default function SetupPage() {
  return (
    <div className="min-h-screen bg-[#0a0f1a]">
      <SetupWizard onComplete={() => { window.location.href = "/"; }} />
    </div>
  );
}
