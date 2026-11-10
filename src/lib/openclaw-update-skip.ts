/**
 * Whether a full system update may skip its OpenClaw step because the core
 * the box runs IS already the pinned one.
 *
 * Pure: the caller reads `openclaw --version` and the pin
 * (config/openclaw-target.txt, or OPENCLAW_PIN_VERSION) and passes both in
 * as they are. A wrong YES skips an install the box needed, so only an exact,
 * readable match answers yes. A missing, empty or garbled banner or pin, or
 * a version that only contains the other one, answers no, and the step runs
 * as it always has.
 */

/** The decision, and the version it was made on (the installed one, equal to the pin). */
export interface OpenclawUpdateSkip {
  skip: boolean;
  /** The installed version when `skip` is true; null otherwise. */
  version: string | null;
}

/**
 * The npm spelling of a core version, as the pin is written and as
 * `clawbox-x64-step.sh` validates it: X.Y.Z with an optional pre-release suffix.
 */
const OPENCLAW_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

const NO_SKIP: OpenclawUpdateSkip = { skip: false, version: null };

/**
 * The version in `openclaw --version`'s banner, `OpenClaw X.Y.Z (hash)`: field
 * 2 of its first line, as install-x64.sh reads it with `awk '{print $2}'`. It
 * must be preceded by the product's own name and be a version. Anything else
 * (an error message, a bare number, a banner of another shape) answers null.
 */
export function installedOpenclawVersion(banner: string | null | undefined): string | null {
  if (typeof banner !== "string") return null;
  const firstLine = banner.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const [product, version] = firstLine.trim().split(/\s+/);
  if (product?.toLowerCase() !== "openclaw" || !version) return null;
  return OPENCLAW_VERSION.test(version) ? version : null;
}

/** The pin's first token (the file may carry text after it), or null when it is not a version. */
function pinnedVersion(pin: string | null | undefined): string | null {
  if (typeof pin !== "string") return null;
  const first = pin.trim().split(/\s+/)[0] ?? "";
  return OPENCLAW_VERSION.test(first) ? first : null;
}

/** Skip the full update's OpenClaw step only when field 2 of the banner equals the pin exactly. */
export function openclawUpdateSkip(
  banner: string | null | undefined,
  pin: string | null | undefined,
): OpenclawUpdateSkip {
  const installed = installedOpenclawVersion(banner);
  const target = pinnedVersion(pin);
  if (!installed || !target || installed !== target) return NO_SKIP;
  return { skip: true, version: installed };
}

/** The one line a skipped (or fast-pathed) OpenClaw step leaves in the update log. */
export function openclawSkippedLine(version: string): string {
  return `OpenClaw already at ${version}; skipped`;
}
