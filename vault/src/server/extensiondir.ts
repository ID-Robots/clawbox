// Builds the Chrome extension into a folder the box's own browser loads
// (scripts/launch-browser.sh passes it as --load-extension when it is there).
//
// The folder is built by the service, not shipped: the static files come from
// extension/, the scripts are bundled from src/extension/, and pairing.json
// carries the secret this run of the service accepts on POST /api/pair/auto.
// That file is mode 600 and no web page can read it (the manifest lists no
// web_accessible_resources), so only a browser running as the box user gets a
// token without a pairing code.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SERVICE = "http://127.0.0.1:4796";
export const EXTENSION_ENTRIES = ["background", "content", "popup", "offscreen", "confirm"] as const;
const STATIC_FILES = ["popup.html", "popup.css", "confirm.html", "offscreen.html", "icons/vault.png"] as const;

export interface ExtensionBuildOptions {
  /** The vault source folder (holds extension/ and src/extension/). */
  repoDir: string;
  outDir: string;
  /** The vault service the extension talks to; loopback only. */
  service?: string;
  /** Written to pairing.json. Without it the extension pairs with a code only. */
  pairSecret?: string;
  /** Payment cards compiled in. Off by default. */
  cards?: boolean;
  /** Appended to the extension's name (test builds). */
  nameSuffix?: string;
}

export function assertLoopbackService(service: string): string {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(service)) throw new Error("the extension's service must be http://127.0.0.1:<port>");
  return service;
}

/**
 * Every file lands by rename. The browser may be starting at this very moment
 * (an update restarts it together with this service) and must load either the
 * file that was there or the new one, never the first half of a script.
 */
function writeAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export async function buildExtension(opts: ExtensionBuildOptions): Promise<void> {
  const service = assertLoopbackService((opts.service ?? DEFAULT_SERVICE).replace(/\/$/, ""));
  const src = join(opts.repoDir, "extension");
  mkdirSync(join(opts.outDir, "build"), { recursive: true, mode: 0o700 });
  mkdirSync(join(opts.outDir, "icons"), { recursive: true, mode: 0o700 });
  chmodSync(opts.outDir, 0o700);

  for (const name of EXTENSION_ENTRIES) {
    const result = await Bun.build({
      entrypoints: [join(opts.repoDir, "src/extension", `${name}.ts`)],
      target: "browser",
      format: "iife",
      minify: false,
      sourcemap: "none",
      define: {
        "process.env.NODE_ENV": '"production"',
        __VAULT_SERVICE__: JSON.stringify(service),
        __VAULT_CARDS__: opts.cards ? "true" : "false",
      },
    });
    if (!result.success) throw new Error(`extension build failed (${name}): ${result.logs.map((l) => l.message).join("; ")}`);
    writeAtomic(join(opts.outDir, "build", `${name}.js`), await result.outputs[0]!.text());
  }

  for (const file of STATIC_FILES) writeAtomic(join(opts.outDir, file), new Uint8Array(readFileSync(join(src, file))));

  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as {
    name: string;
    content_security_policy: { extension_pages: string };
  };
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(DEFAULT_SERVICE, service);
  if (opts.nameSuffix) manifest.name = `${manifest.name} ${opts.nameSuffix}`;
  writeAtomic(join(opts.outDir, "pairing.json"), `${JSON.stringify(opts.pairSecret ? { secret: opts.pairSecret } : {})}\n`);
  // The manifest LAST: the launcher loads the folder only once it is complete
  // (scripts/lib/vault-extension.sh), and the manifest is what it looks for first.
  writeAtomic(join(opts.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
