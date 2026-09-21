/**
 * Settings → System → Agent harness — the pre-exec shell scanning notice
 * (HERMES-08).
 *
 * This is the only place the product tells the owner that a SECURITY control is
 * off, so it is translated rather than left in English like the rest of that
 * card: an owner reading Settings in Bulgarian or Japanese must not have the one
 * sentence that matters arrive in a language they do not read.
 *
 * The copy deliberately separates two outcomes that look alike and are not:
 * with upstream's default (fail-open) a missing scanner means commands still
 * run, unchecked; with `security.tirith_fail_open: false` it means they stop.
 *
 * `security.tirith_enabled` is a config key and stays verbatim in every locale.
 */
export const shellScanEn: Record<string, string> = {
  "shellScan.offTitle": "Shell command scanning is off",
  "shellScan.blockedTitle": "Shell commands are blocked",
  "shellScan.unknownTitle": "Shell command scanning: unknown",

  "shellScan.missingDetail":
    "The safety scanner is not installed. The agent downloads it the first time the box is online; until then it runs shell commands without checking them.",
  "shellScan.blockedDetail":
    "The safety scanner is not installed, and the agent is set to refuse shell commands without it. Connect the box to the internet so it can download the scanner.",
  "shellScan.disabledDetail":
    "It was switched off in the agent's settings (security.tirith_enabled). Commands run without a pre-execution safety check.",
  "shellScan.unknownDetail":
    "The agent's security settings could not be read, so this box cannot confirm that shell commands are checked before they run.",

  "shellScan.retryAfter": "The agent will not retry the download before {time}.",
};
