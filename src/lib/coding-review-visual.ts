/**
 * The review pass's eyes.
 *
 * The automatic review pass ran the project's tests and read the diff, and
 * never once rendered the thing the run had just built — `coding_agent_real_
 * browser` decides WHICH Chromium answers, not whether anybody looks. So a
 * weekend of interface work could ship with nobody having seen it.
 *
 * This module is the pure half of the fix: which changed files actually surface
 * as an interface, the instructions the pass is given when they do, and the
 * evidence section a pull request carries afterwards. The side effects it needs
 * are two disk reads of the run's own evidence folder.
 *
 * WHY THE DEVICE DECIDES, not the model. "Does this diff touch the interface"
 * is answerable from the file list the runner already holds, and a model asked
 * to judge it would sometimes screenshot a library change (money for nothing)
 * and sometimes skip a page (the hole this closes). The device decides, and the
 * pass is told which files made the decision.
 */
import path from "path";
import { listArtifacts, artifactsDir } from "@/lib/coding-agent-artifacts";
import { readShotNotes } from "@/lib/coding-shot-notes";

/** File types that render. A change to one of these is something to look at. */
const INTERFACE_EXTENSIONS = new Set([
  ".tsx", ".jsx", ".vue", ".svelte", ".astro",
  ".html", ".htm", ".ejs", ".hbs", ".pug",
  ".css", ".scss", ".sass", ".less", ".styl",
]);

/**
 * Folders whose contents surface on screen whatever the extension is — a
 * `page.ts` under app/, a `.json` message catalogue under locales/. Matched as
 * whole path segments, so `mycomponents.ts` is not a component folder.
 */
const INTERFACE_SEGMENTS = new Set([
  "components", "component", "pages", "views", "screens", "layouts",
  "styles", "css", "templates", "partials", "public", "static", "assets",
  "locales", "locale", "i18n", "lang", "translations", "messages",
]);

/** File names that ARE the user-visible copy, wherever they sit. */
const COPY_FILE_RE = /(^|[-.])(translations?|messages|strings|locales?|i18n)(\.[cm]?[jt]sx?|\.json|\.ya?ml|\.po)$/i;

/**
 * Never a screen, however it is named: the checks, the stories, the build
 * output and the dependencies. A review pass sent to render `Button.test.tsx`
 * is the wasted money the skip line exists to save.
 */
const NOT_INTERFACE_FILE_RE = /\.(test|spec|stories|story|d)\.[cm]?[jt]sx?$/i;
const NOT_INTERFACE_SEGMENTS = new Set([
  "node_modules", "__tests__", "__mocks__", "__snapshots__", "tests", "test",
  "dist", "build", "out", ".next", "coverage", ".git",
]);

/** How many changed interface files the brief names before it stops listing. */
export const MAX_NAMED_FILES = 8;

/** Evidence rows a pull request body carries. Past this it is a transcript. */
export const MAX_EVIDENCE_ROWS = 12;

function segments(file: string): string[] {
  return file.split(/[\\/]+/).filter((part) => part && part !== ".");
}

/** Does this one changed file surface as an interface? */
export function isInterfaceFile(file: string): boolean {
  const parts = segments(file);
  if (!parts.length) return false;
  if (parts.some((part) => NOT_INTERFACE_SEGMENTS.has(part.toLowerCase()))) return false;
  const name = parts[parts.length - 1];
  if (NOT_INTERFACE_FILE_RE.test(name)) return false;
  if (INTERFACE_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
  if (COPY_FILE_RE.test(name)) return true;
  // The last segment is the file itself, so only the folders above it count.
  return parts.slice(0, -1).some((part) => INTERFACE_SEGMENTS.has(part.toLowerCase()));
}

/** The changed files that render, in the order the run touched them. */
export function interfaceFiles(files: readonly string[]): string[] {
  return files.filter((file) => typeof file === "string" && isInterfaceFile(file));
}

function nameList(files: readonly string[]): string {
  const shown = files.slice(0, MAX_NAMED_FILES).join(", ");
  const rest = files.length - MAX_NAMED_FILES;
  return rest > 0 ? `${shown} (and ${rest} more)` : shown;
}

/**
 * What the review pass is told about looking at the work.
 *
 * Always present, in both directions: a diff with no interface in it gets the
 * one-line skip, said explicitly so the pass reports "nothing to look at"
 * rather than saying nothing — a silent skip is how the hole stayed invisible.
 *
 * `previewScript` is the absolute path of scripts/clawbox-preview.mjs, which
 * the runner also puts in the environment as CLAWBOX_PREVIEW.
 */
export function visualCheckBrief(files: readonly string[], previewScript: string): string {
  const touched = interfaceFiles(files);
  if (touched.length === 0) {
    return "VISUAL CHECK: none is needed — this diff touches no screens, styles or user-visible copy."
      + " Say that in one line in your report and do not open a browser: screenshotting a library change is wasted money.";
  }
  return [
    "VISUAL CHECK — this diff touches the interface, so you must LOOK at it and report what you SAW, never what the code says it should show.",
    `Changed interface files: ${nameList(touched)}.`,
    // The preview server exists because a run's worktree is not the running
    // app and port 80 is the box's own. Named as a command rather than
    // described, because an unattended pass cannot ask what was meant.
    `1. Serve this folder: \`node "$CLAWBOX_PREVIEW" --ttl 900\` (the script is ${previewScript}). It prints PREVIEW_PID and then PREVIEW_URL —`
      + " an ephemeral 127.0.0.1 address it builds and serves, or your project's own dev server if it has one. Run it in the background from this folder and read those two lines.",
    "   A single standalone HTML file needs no server at all: browser_view_local on the file is enough.",
    "   If it prints PREVIEW_FAILED instead, or you get no URL, that is the answer — report plainly that you could not render the work and why (quote the failure line), and review the diff without pretending you looked.",
    "2. Open each screen the diff changes with browser_open (first) or browser_navigate (after) on that URL. Each reply archives a screenshot into your evidence folder and tells you in words what actually rendered.",
    "3. Drive the new control through every state it can reach — empty, filled, submitted, error, loading, and whatever else this change makes reachable — taking ONE described screenshot per state.",
    "   Use browser_fill and browser_click if they are in your tool list. If they are not, reach what states you can through the URL and the page itself, and say in your report which states you could not reach and why.",
    "4. Report what you saw, one line per state, in report.md and in your closing message. Findings of the form \"the confirm button is below the fold\", \"the error state renders the raw code\" or \"the German label overflows its row\" are the point of this step — a layout or copy defect you can SEE is as real as a logic bug, so fix it and look again.",
    "5. Stop the preview when you are done: `kill <PREVIEW_PID>`. Never pkill. It also stops itself after the TTL.",
    "Do not screenshot a state twice, and do not re-photograph a page you have already described: one pass over the states that matter is the finish line.",
  ].join(" ");
}

/** One archived picture and what it showed. */
export interface VisualEvidence {
  runId: string;
  name: string;
  description: string | null;
}

/**
 * The pictures a run's evidence folder holds, newest last, with the words that
 * were recorded for them. Runs are read in the order given and de-duplicated,
 * so the reviewing run's own look comes before the run it reviewed.
 */
export function collectVisualEvidence(runIds: readonly string[]): VisualEvidence[] {
  const out: VisualEvidence[] = [];
  const seen = new Set<string>();
  for (const runId of runIds) {
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    let notes: Record<string, string> = {};
    try {
      notes = readShotNotes(artifactsDir(runId));
    } catch {
      // A malformed id or an unreadable folder is simply no evidence.
    }
    for (const artifact of listArtifacts(runId)) {
      if (artifact.kind !== "image") continue;
      out.push({ runId, name: artifact.name, description: notes[artifact.name] ?? null });
    }
  }
  return out;
}

/** The markers that make the section replaceable without touching the rest. */
export const EVIDENCE_BEGIN = "<!-- clawbox:visual-evidence -->";
export const EVIDENCE_END = "<!-- /clawbox:visual-evidence -->";

/**
 * The pull-request section, or null when there is nothing to show.
 *
 * The pictures themselves stay on the device — a run's evidence folder is not
 * something this box uploads anywhere — so what travels is the file name and
 * the description, which is the part a reviewer can actually act on, plus where
 * to find the picture. A row with no description still goes in: "a screenshot
 * was taken and nobody wrote down what it showed" is itself worth seeing.
 */
export function renderEvidenceSection(evidence: readonly VisualEvidence[]): string | null {
  if (evidence.length === 0) return null;
  const rows = evidence.slice(-MAX_EVIDENCE_ROWS);
  const dropped = evidence.length - rows.length;
  const lines = [
    EVIDENCE_BEGIN,
    "**What the review pass saw**",
    "",
    ...rows.map((item) => `- \`${item.name}\` — ${item.description ?? "no description was recorded for this screenshot."}`),
  ];
  if (dropped > 0) lines.push(`- …and ${dropped} earlier screenshot${dropped === 1 ? "" : "s"}.`);
  lines.push(
    "",
    "The screenshots themselves are in the run's evidence folder on the device, on the run's page in the Coding Agent app.",
    EVIDENCE_END,
  );
  return lines.join("\n");
}

/**
 * Put `section` into `body`, replacing a previous one.
 *
 * Marker-delimited rather than "append to the end" so a later review round can
 * refresh what it saw without touching a word a person wrote around it. A body
 * with no markers gains the section at the end; a null section removes it.
 */
export function withEvidenceSection(body: string, section: string | null): string {
  const start = body.indexOf(EVIDENCE_BEGIN);
  const end = body.indexOf(EVIDENCE_END);
  if (start !== -1 && end > start) {
    const before = body.slice(0, start).replace(/\s+$/, "");
    const after = body.slice(end + EVIDENCE_END.length).replace(/^\s+/, "");
    if (!section) return [before, after].filter(Boolean).join("\n\n");
    return [before, section, after].filter(Boolean).join("\n\n");
  }
  if (!section) return body;
  return `${body.replace(/\s+$/, "")}\n\n${section}`;
}
