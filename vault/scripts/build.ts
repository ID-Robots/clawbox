// Builds the extension the way the service does at start-up, into a folder you
// name (default: extension-build/, which git ignores), and checks that the
// desktop app bundles. Nothing built is committed: on a box the service builds
// the extension into its own folder every time it starts.
//
//   bun run scripts/build.ts [outDir]
//
// Environment: CLAWBOX_VAULT_EXT_SERVICE=http://127.0.0.1:<port> points the
// build at a vault on a spare port (browser tests); CLAWBOX_VAULT_CARDS=1
// compiles payment cards in.
import { join, resolve } from "node:path";
import { buildExtension, DEFAULT_SERVICE, EXTENSION_ENTRIES } from "../src/server/extensiondir";

const root = resolve(import.meta.dir, "..");
const outDir = resolve(process.argv[2] ?? process.env.CLAWBOX_VAULT_EXT_OUT ?? join(root, "extension-build"));
const service = process.env.CLAWBOX_VAULT_EXT_SERVICE?.replace(/\/$/, "") || DEFAULT_SERVICE;

if (outDir === join(root, "extension") || outDir.startsWith(`${join(root, "src")}/`)) {
  throw new Error("build into a folder of its own, not into the sources");
}

await buildExtension({
  repoDir: root,
  outDir,
  service,
  cards: process.env.CLAWBOX_VAULT_CARDS === "1",
  ...(service !== DEFAULT_SERVICE ? { nameSuffix: `(test ${service.split(":").pop()})` } : {}),
});
for (const name of EXTENSION_ENTRIES) console.log(`${outDir}/build/${name}.js`);

const ui = await Bun.build({ entrypoints: [join(root, "src/ui/app.ts")], target: "browser", format: "esm", minify: true });
if (!ui.success) {
  for (const log of ui.logs) console.error(log);
  process.exit(1);
}
console.log("desktop app bundle ok");
