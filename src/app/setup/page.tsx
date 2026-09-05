"use client";

import SetupWizard from "@/components/SetupWizard";
import TimezoneAdopter from "@/components/TimezoneAdopter";

export default function SetupPage() {
  return (
    // `setup-shell` carries the wizard's layout tokens and is the scope the
    // Hermes ground shift applies to, so a co-branded box changes hue without
    // reaching the desktop. --ground resolves to the same #0a0f1a as before.
    <div className="setup-shell min-h-screen flex flex-col bg-[var(--ground)]">
      {/* The box has no other source for the owner's timezone — see the
          component. Mounted here so a fresh install is right from the first
          turn, and on the desktop so a box already in the field heals too. */}
      <TimezoneAdopter />
      <SetupWizard onComplete={() => { window.location.href = "/"; }} />
    </div>
  );
}
