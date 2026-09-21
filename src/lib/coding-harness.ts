/**
 * The ClawBox coding harness — one name for the command the desktop runs.
 *
 * `claude-ds` is a wrapper shipped by install.sh into ~/.local/bin: Claude Code
 * pointed at this box's ClawBox AI plan instead of at Anthropic (TASK-378).
 * The desktop opens a terminal and types this line, so the value has to match
 * what the installer put on PATH — the contract test asserts exactly that,
 * because a rename on either side would leave the icon opening onto
 * "command not found".
 */
export const CODING_HARNESS_COMMAND = "claude-ds";

/** Where install.sh puts the wrapper, relative to the clawbox user's home. */
export const CODING_HARNESS_WRAPPER_PATH = ".local/bin/claude-ds";
