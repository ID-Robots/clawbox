/**
 * Which grammar colours a file, from its name. Pure, so the mapping is
 * testable and the two editors that share it (the Files app's, the Coding
 * Agent's) cannot disagree. Null means plain text: a file this does not
 * recognise is shown, never refused.
 */

/** Every grammar `src/lib/code-highlight.ts` loads, by Prism's name. */
export const CODE_LANGUAGES = [
  "markup", "css", "scss", "javascript", "jsx", "typescript", "tsx", "json", "python", "bash",
  "yaml", "markdown", "sql", "go", "rust", "c", "cpp", "java", "ruby", "toml", "docker", "ini",
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

const BY_EXTENSION: Record<string, CodeLanguage> = {
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", xhtml: "markup", plist: "markup",
  css: "css", scss: "scss", less: "css",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  py: "python", pyw: "python",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml",
  md: "markdown", markdown: "markdown",
  sql: "sql",
  go: "go",
  rs: "rust",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  java: "java",
  rb: "ruby",
  toml: "toml",
  ini: "ini", cfg: "ini", conf: "ini",
};

const BY_NAME: Record<string, CodeLanguage> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
};

/** The grammar for a file named so, or null for plain text. */
export function languageForFile(name: string): CodeLanguage | null {
  const base = name.split("/").pop() ?? name;
  const lower = base.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith("dockerfile.")) return "docker";
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return BY_EXTENSION[lower.slice(dot + 1)] ?? null;
}
