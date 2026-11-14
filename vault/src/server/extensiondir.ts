// Builds the Chrome extension into a folder the box's own browser loads
// (scripts/launch-browser.sh passes it as --load-extension when it is there).
//
// The folder is built by the service, not shipped: the static files come from
// extension/, the scripts are bundled from src/extension/, and pairing.json
// carries the secret this run of the service accepts on POST /api/pair/auto.
// That file is mode 600 and no web page can read it (the manifest lists no
// web_accessible_resources), so only a browser running as the box user gets a
// token without a pairing code.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    writeFileSync(join(opts.outDir, "build", `${name}.js`), await result.outputs[0]!.text());
  }

  for (const file of STATIC_FILES) copyFileSync(join(src, file), join(opts.outDir, file));

  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as {
    name: string;
    content_security_policy: { extension_pages: string };
  };
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(DEFAULT_SERVICE, service);
  if (opts.nameSuffix) manifest.name = `${manifest.name} ${opts.nameSuffix}`;
  writeFileSync(join(opts.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Replaced by rename: the browser reads either the old secret or the new one, never half a file.
  const pairing = join(opts.outDir, "pairing.json");
  const tmp = `${pairing}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(opts.pairSecret ? { secret: opts.pairSecret } : {})}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, pairing);
}
