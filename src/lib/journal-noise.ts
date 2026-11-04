/**
 * Journal lines that are the PLUMBING of a root step, never its progress.
 *
 * A root step runs as `clawbox-root-update@<step>.service`, and its journal is
 * what the install rows read their headline from. install.sh drops to the
 * clawbox user with `su -l` for every pip and build command, and each of those
 * leaves PAM's and su's own lines in the same journal — so between two real
 * lines the "latest line" was `pam_unix(su-l:session): session closed for user
 * clawbox`, and that is what the Whisper row and its card showed as the
 * install's status for minutes at a time. systemd adds the unit's own
 * lifecycle lines around the run.
 *
 * Kept in the task's log (Show log), never shown as the headline or given as
 * a failure's reason. Its own module because suites mock the follow module
 * whole.
 *
 * Client-safe: strings only.
 */
const NOISE: readonly RegExp[] = [
  // pam_unix(su-l:session): session opened for user clawbox(uid=1000) by (uid=0)
  // pam_unix(sudo:session): session closed for user root
  /^pam_[\w-]+\(/,
  // su's own record: "(to clawbox) root on none"
  /^\(to \S+\) \S+ on \S+$/,
  // sudo's command log: "clawbox : PWD=/ ; USER=root ; COMMAND=…"
  /^\S+ : (?:TTY|PWD)=/,
  // systemd about the unit: "Starting ClawBox Root Update Step (voice_whisper_install)...",
  // "Finished …", and "clawbox-root-update@x.service: Deactivated successfully." /
  // "…: Consumed 1.295s CPU time."
  /^(?:Starting|Started|Finished|Stopping|Stopped) ClawBox Root Update Step\b/,
  /^clawbox-root-update@[\w.-]+\.service: /,
];

export function isJournalNoise(line: string): boolean {
  const text = line.trim();
  return NOISE.some((re) => re.test(text));
}
