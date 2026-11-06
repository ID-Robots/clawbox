/**
 * The shells a new terminal may run, as the Terminal's settings sheet offers
 * them: the ones /etc/shells lists that are really on this box.
 *
 * The web server's copy of `parseEtcShells` and `availableShells` in
 * scripts/terminal-launch.mjs — that script is standalone ESM run by the
 * terminal server and cannot import TypeScript. The PTY server is the one that
 * decides; this only fills the list. src/tests/unit/terminal-launch.test.ts
 * runs the same table against both copies.
 */

import fs from "node:fs";

export const DEFAULT_SHELL = "/bin/bash";

export function parseEtcShells(text: string): string[] {
  const shells: string[] = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (line.startsWith("/") && !/\s/.test(line) && !shells.includes(line)) shells.push(line);
  }
  return shells;
}

export function readEtcShells(file = "/etc/shells"): string[] {
  try {
    // `turbopackIgnore`, because of the default above. Since Next 16.4.0 the
    // build reads a parameter's default through to the call, so to it `file`
    // is "/etc/shells, or whatever a caller passes": a path it can only partly
    // resolve, which is a file reference and so a walk over the whole project,
    // data/ included (src/lib/runtime-path.ts). 16.4.0 stopped the build there
    // on a coding run's venv link; scripts/check-build-isolation.sh found it.
    return parseEtcShells(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"));
  } catch {
    return [];
  }
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One entry per binary: a merged-/usr image lists /bin/bash and /usr/bin/bash, which are the same file. */
export function availableShells(listed: string[]): string[] {
  const seen = new Set<string>();
  const shells: string[] = [];
  for (const shell of listed) {
    if (!isExecutableFile(shell)) continue;
    let real = shell;
    try {
      real = fs.realpathSync(shell);
    } catch {
      // keep the listed name
    }
    if (seen.has(real)) continue;
    seen.add(real);
    shells.push(shell);
  }
  return shells;
}
