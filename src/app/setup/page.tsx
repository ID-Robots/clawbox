"use client";

import SetupWizard from "@/components/SetupWizard";
import { useFollowSessionSwitch } from "@/lib/session-switch";

export default function SetupPage() {
  // Once the owner has a password the wizard is behind the session gate, so a
  // sign-in or sign-out in another tab reopens it on the session that now
  // holds, like every other signed-in page (TASK-1247).
  useFollowSessionSwitch();
  return (
    // `setup-shell` carries the wizard's layout tokens and is the scope the
    // Hermes ground shift applies to, so a co-branded box changes hue without
    // reaching the desktop. --ground resolves to the same #0a0f1a as before.
    <div className="setup-shell min-h-screen flex flex-col bg-[var(--ground)]">
      <SetupWizard onComplete={() => { window.location.href = "/"; }} />
    </div>
  );
}
