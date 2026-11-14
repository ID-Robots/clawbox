// Validates a built extension folder the way "Load unpacked" would, plus our
// own rules: MV3, every referenced file exists, minimum permissions, strict
// CSP, no remote code, no eval in the bundles, nothing web-accessible (the
// pairing secret sits in this folder). Exits non-zero on any error.
//
//   bun run scripts/validate-manifest.ts [builtDir]   (default: extension-build/)
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? join(import.meta.dir, "../extension-build"));
const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

let manifest: Record<string, any>;
try {
  manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
} catch (err) {
  console.error(`manifest.json is not valid JSON: ${(err as Error).message}`);
  process.exit(1);
}

const has = (rel: string) => existsSync(join(dir, rel));
const need = (rel: string | undefined, what: string) => {
  if (!rel) fail(`${what}: missing`);
  else if (!has(rel)) fail(`${what}: file not found: ${rel}`);
};

// Required keys and formats (Chrome refuses to load otherwise).
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (typeof manifest.name !== "string" || !manifest.name || manifest.name.length > 75) fail("name is required (max 75 chars)");
if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version ?? ""))) fail("version must be 1-4 dot-separated integers");
if (manifest.description && String(manifest.description).length > 132) fail("description is longer than 132 chars");
if (manifest.short_name && String(manifest.short_name).length > 12) fail("short_name is longer than 12 chars");

// Referenced files.
for (const [size, file] of Object.entries(manifest.icons ?? {})) need(file as string, `icons.${size}`);
need(manifest.action?.default_popup, "action.default_popup");
for (const [size, file] of Object.entries(manifest.action?.default_icon ?? {})) need(file as string, `action.default_icon.${size}`);
need(manifest.background?.service_worker, "background.service_worker");
if (manifest.background?.scripts || manifest.background?.page) fail("background must be a service worker in MV3");
for (const [i, cs] of (manifest.content_scripts ?? []).entries()) {
  if (!Array.isArray(cs.matches) || !cs.matches.length) fail(`content_scripts[${i}].matches is empty`);
  for (const js of cs.js ?? []) need(js, `content_scripts[${i}].js`);
}
need("offscreen.html", "offscreen document");
need("pairing.json", "pairing file");
need("confirm.html", "card fill confirmation page");

// HTML pages: local scripts only, every referenced asset present.
for (const page of ["popup.html", "offscreen.html", "confirm.html"]) {
  const html = readFileSync(join(dir, page), "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) fail(`${page}: inline <script> is blocked by the CSP`);
  if (/\son[a-z]+\s*=/i.test(html)) fail(`${page}: inline event handler attributes are blocked by the CSP`);
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const ref = m[1]!;
    if (/^[a-z]+:/i.test(ref) || ref.startsWith("//")) fail(`${page}: remote reference ${ref}`);
    else need(ref, `${page} reference`);
  }
}

// Permissions: only what the extension uses.
const ALLOWED = new Set(["storage", "scripting", "alarms", "offscreen", "clipboardWrite", "tabs"]);
for (const p of manifest.permissions ?? []) if (!ALLOWED.has(p)) fail(`unexpected permission: ${p}`);
for (const h of [...(manifest.host_permissions ?? []), ...(manifest.content_scripts ?? []).flatMap((c: any) => c.matches)]) {
  if (h === "<all_urls>" || /^\*:\/\//.test(h) || /^http:\/\/\*/.test(h)) fail(`host pattern too broad: ${h}`);
  if (!/^(https:\/\/\*\/\*|http:\/\/(localhost|127\.0\.0\.1)\/\*)$/.test(h)) fail(`unexpected host pattern: ${h}`);
}
if (manifest.externally_connectable) fail("externally_connectable must not be set");
if (manifest.web_accessible_resources?.length) fail("web_accessible_resources must stay empty");

// CSP: strict, no remote or inline code.
const csp = String(manifest.content_security_policy?.extension_pages ?? "");
if (!csp) fail("content_security_policy.extension_pages is required");
const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1]?.trim() ?? "";
if (scriptSrc !== "'self'") fail(`script-src must be exactly 'self' (got "${scriptSrc}")`);
if (/unsafe-(eval|inline)|https?:\/\/(?!127\.0\.0\.1:4796)/.test(csp)) fail("CSP allows unsafe or remote sources");
if (!/object-src 'none'/.test(csp)) fail("CSP must set object-src 'none'");

// Bundles: no eval / Function constructor / remote imports / analytics.
for (const file of ["build/background.js", "build/content.js", "build/popup.js", "build/offscreen.js", "build/confirm.js"]) {
  if (!has(file)) {
    fail(`${file}: missing (run bun run scripts/build.ts first)`);
    continue;
  }
  const code = readFileSync(join(dir, file), "utf8");
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) fail(`${file}: uses eval or new Function`);
  if (/\bimportScripts\s*\(|\bimport\s*\(\s*["'`]https?:/.test(code)) fail(`${file}: loads remote code`);
  if (/google-analytics|googletagmanager|segment\.io|sentry\.io|mixpanel/i.test(code)) fail(`${file}: analytics endpoint`);
  if (/^\s*(import|export)\s/m.test(code)) fail(`${file}: must be a classic script (found ES module syntax)`);
}

if (errors.length) {
  console.error(`${dir} has ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`extension manifest OK: ${manifest.name} ${manifest.version}, MV3, permissions [${(manifest.permissions ?? []).join(", ")}]`);
