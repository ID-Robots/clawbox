import { describe, expect, it } from "vitest";
import { isJournalNoise } from "@/lib/journal-noise";
import { failureReason } from "@/lib/root-step-follow";

/**
 * A root step's journal carries su's and PAM's lines around every command it
 * runs as the clawbox user, and systemd's own around the unit. They were the
 * Whisper row's and card's status for minutes at a time (TASK-2128): they
 * belong in the log, never in the headline or a failure's reason.
 */
describe("isJournalNoise", () => {
  it.each([
    "pam_unix(su-l:session): session closed for user clawbox",
    "pam_unix(su-l:session): session opened for user clawbox(uid=1000) by (uid=0)",
    "pam_unix(sudo:session): session closed for user root",
    "(to clawbox) root on none",
    "clawbox : PWD=/ ; USER=root ; COMMAND=/usr/local/libexec/clawbox/clawbox-run-root-step.sh voice_whisper_install",
    "Starting ClawBox Root Update Step (voice_kokoro_install)...",
    "Finished ClawBox Root Update Step (voice_whisper_install).",
    "clawbox-root-update@voice_whisper_install.service: Deactivated successfully.",
    "clawbox-root-update@voice_whisper_install.service: Consumed 1.295s CPU time.",
  ])("is noise: %s", (line) => {
    expect(isJournalNoise(line)).toBe(true);
  });

  it.each([
    "  Building CTranslate2 with CUDA for sm_87...",
    "  Installing Kokoro TTS...",
    "Successfully installed av-17.1.0 ctranslate2-4.8.5 faster-whisper-1.2.1",
    "ERROR: faster-whisper was requested and did NOT install — see the log above",
    "Installing collected packages: mpmath, sympy, networkx, torch",
  ])("is progress: %s", (line) => {
    expect(isJournalNoise(line)).toBe(false);
  });

  it("never gives a session line as a failed step's reason", () => {
    expect(failureReason([
      "  Installing faster-whisper...",
      "No matching distribution found for ctranslate2",
      "pam_unix(su-l:session): session closed for user clawbox",
    ])).toBe("No matching distribution found for ctranslate2");
    expect(failureReason(["pam_unix(su-l:session): session closed for user clawbox"])).toBeNull();
  });
});
