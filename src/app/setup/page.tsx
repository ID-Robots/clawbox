"use client";

import SetupWizard from "@/components/SetupWizard";

export default function SetupPage() {
  return (
    // `setup-shell` carries the wizard's layout tokens and is the scope the
    // Hermes ground shift applies to, so a co-branded box changes hue without
    // reaching the desktop. --ground resolves to the same #0a0f1a as before.
    <div className="setup-shell min-h-screen flex flex-col bg-[var(--ground)]">
      <SetupWizard onComplete={() => { window.location.href = "/"; }} />
    </div>
  );
}
