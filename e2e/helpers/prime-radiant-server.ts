import os from "os";
import path from "path";

/**
 * The second web server the Prime Radiant smoke spec drives.
 *
 * Every other spec mocks `/setup-api/**` in the browser, but a browser test
 * cannot mock a call the SERVER makes, and Prime Radiant's whole point is
 * what the server does: write pages into a git vault, embed and judge claims,
 * commit a verification. So `e2e/prime-radiant-smoke.spec.ts` keeps the
 * desktop's mocks and lets `/setup-api/prime-radiant/**` through to a server
 * of its own: the SAME production build, started a second time with
 *
 * - `CLAWBOX_TEST_MODE=1` + `PRIME_RADIANT_FLASH_STUB=1` — the deterministic
 *   model (`src/lib/prime-radiant/flash-stub.ts`) and hash embedder, so no
 *   call leaves the machine;
 * - every root in a temp directory (`CLAWBOX_ROOT`, `HOME`, `FILES_ROOT`,
 *   `PRIME_RADIANT_DIR`), so nothing reads or writes a real box's files;
 * - an edition file naming Hermes, so `POST init` never writes an OpenClaw
 *   config (the memory-wiki wiring answers `unavailable` there), and a
 *   gateway port nothing listens on, for the same reason;
 * - `CLAWBOX_SKIP_BOOT_JOBS=1`, no `SESSION_SECRET` (the middleware lets the
 *   desktop page through, as on the main e2e server).
 *
 * Kept apart from the main server so the test-mode switches never reach the
 * specs that assert the ordinary build's behaviour.
 */

const basePort = Number(process.env.PLAYWRIGHT_PORT || process.env.PORT || 3100);

export const PRIME_RADIANT_PORT = Number(process.env.PRIME_RADIANT_E2E_PORT || basePort + 1);
export const PRIME_RADIANT_BASE_URL = `http://localhost:${PRIME_RADIANT_PORT}`;

/** The server's fake box: `data/`, `home/`, `files/`, `prime-radiant/`, the edition file. */
export const PRIME_RADIANT_E2E_ROOT = path.join(os.tmpdir(), `clawbox-e2e-prime-radiant-${PRIME_RADIANT_PORT}`);
export const PRIME_RADIANT_E2E_DIR = path.join(PRIME_RADIANT_E2E_ROOT, "prime-radiant");
export const PRIME_RADIANT_E2E_SECRET = path.join(PRIME_RADIANT_E2E_ROOT, "data", ".session-secret");

/** The shell command `playwright.config.ts` starts it with (after the main server's build, or its own when there is none). */
export function primeRadiantServerCommand(): string {
  const root = PRIME_RADIANT_E2E_ROOT;
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const env = [
    "CLAWBOX_TEST_MODE=1",
    "PRIME_RADIANT_FLASH_STUB=1",
    "CLAWBOX_SKIP_BOOT_JOBS=1",
    `CLAWBOX_ROOT=${q(root)}`,
    `HOME=${q(path.join(root, "home"))}`,
    `FILES_ROOT=${q(path.join(root, "files"))}`,
    `PRIME_RADIANT_DIR=${q(PRIME_RADIANT_E2E_DIR)}`,
    `CLAWBOX_EDITION_FILE=${q(path.join(root, "edition.env"))}`,
    "GATEWAY_PORT=9",
    `PORT=${PRIME_RADIANT_PORT}`,
    "HOSTNAME=127.0.0.1",
    "NODE_ENV=production",
  ].join(" ");
  return [
    // The main server's command builds first, and Playwright starts web
    // servers one after the other — but a local run that REUSES a main server
    // already listening runs no build, so build here when there is none.
    "{ test -f .next/standalone/server.js || bun run build; }",
    `rm -rf ${q(root)}`,
    `mkdir -p ${q(path.join(root, "data"))} ${q(path.join(root, "home"))} ${q(path.join(root, "files"))}`,
    `printf 'CLAWBOX_EDITION=hermes\\n' > ${q(path.join(root, "edition.env"))}`,
    `env -u SESSION_SECRET -u OPENCLAW_HOME -u CLAWBOX_OPENCLAW_HOME ${env} node .next/standalone/server.js`,
  ].join(" && ");
}
