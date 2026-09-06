// ── `EMAIL:` directives on the gateway's own Control UI chat ────────────────
//
// THE THIRD WEBCHAT SURFACE. `EMAIL:4471` is how the agent points a ClawBox
// chat at a message the owner can open; `chat-email-refs.ts` lifts the line out
// and draws a card. The OpenClaw gateway's Control UI at `/chat` is a `webchat`
// surface too — a ClawBox-served, default-pinned app on that edition
// (`desktop-apps.ts`) — and it renders the line as a bare internal id.
//
// WHY THE HARNESS CANNOT ANSWER THIS, read off the pinned 2026.8.1 core on the
// box. The outbound seam ClawBox already rides, `reply_payload_sending`, is
// handed ONE payload for ONE delivery: its context carries `sessionKey`,
// `runId`, `messageId`, `senderId` and trace ids and nothing client-shaped, and
// all three webchat clients — ClawBox's dashboard chat, ClawBox's mascot popup
// and the Control UI — arrive as `webchat`. So a strip in the hook would take
// the card away from the two surfaces that make one, and no hook in the
// catalog is per-client. ClawBox's own connect frame does say
// `version: "clawbox-chat"`, but the gateway keeps that on the live connection
// record and the presence row, where no hook can read it. `presentation`
// (`docs/plugins/message-presentation.md`) is the core's own rich-card
// contract and would have been the answer if webchat had a renderer: its
// provider table lists Discord, Feishu, Matrix, Mattermost, Teams, Slack,
// Telegram and "plain channels — text fallback", and no webchat row.
//
// WHAT IS LEFT IS OURS. ClawBox serves that page: `src/app/[...gateway]/route.ts`
// hands a navigation to `serveGatewayHTML`, which already injects the ClawBox
// bar and the gateway-connect script into the HTML. Same origin, so the card
// links straight into the chat that already renders the message and the owner's
// session rides along.
//
// ONE GRAMMAR, NOW IN FOUR PLACES. The rule is the same rule:
// `src/lib/chat-email-refs.ts` (the chat window), the OpenClaw plugin's
// `email-directives.mjs`, the Hermes plugin's `email_directives.py`, and this
// one. They cannot share a file — this copy is evaluated by the browser inside
// the gateway's own page, with no bundler and no imports. What holds them
// together is `src/tests/unit/email-directive-parity.test.ts`, which runs the
// shared case table AND both generated sweeps through all four.
//
// THE OTHER EDITION. The Control UI app is OpenClaw-only
// (`desktop-app-editions.ts`). Its Hermes twin is the Hermes dashboard, served
// through `scripts/hermes-dashboard-proxy.js` — which pipes the upstream
// response straight through and injects no HTML, so this module cannot reach it
// without giving that authentication proxy body buffering and content-encoding
// handling. Everything below is edition-neutral and ready for it.

import { desktopTranslations } from "./desktop-translations";
import * as configStore from "./config-store";
import { CONTROL_UI_EMAIL_PARAM, controlUiEmailHref } from "./chat-email-refs";
import type { Locale } from "./i18n";

// SERVER-ONLY. `configStore` is `node:fs`, so nothing a client component can
// reach may import this file — the link's own shape lives in
// `chat-email-refs.ts`, which the chat imports, and is re-exported here so the
// script and the chat cannot describe the same link differently.
export { CONTROL_UI_EMAIL_PARAM, controlUiEmailHref };

/** The one place the deep link's shape is written. */
const CONTROL_UI_EMAIL_HREF_PREFIX = controlUiEmailHref(0).slice(0, -1);

/** The card's label, in the language the owner picked, falling back to English. */
export function controlUiCardLabel(locale: string | undefined): string {
  const table = desktopTranslations[locale as Locale] ?? desktopTranslations.en;
  return table["chat.email.openFull"] ?? desktopTranslations.en["chat.email.openFull"];
}

/**
 * The language the owner picked, or undefined when nothing has been picked or
 * the store cannot be read.
 *
 * ONE copy, imported by both routes that serve this page. The injected script
 * carries a label, and this page is the one place ClawBox draws UI it does not
 * own — `i18n.tsx` and its provider are not loaded there. Read on the server
 * rather than fetched by the script, which would cost a request per page load
 * to say three words.
 */
export async function controlUiLocale(): Promise<string | undefined> {
  try {
    const value = await configStore.get("pref:ui_language");
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `EMAIL:<uid>` grammar as the browser gets it — the fourth copy of the
 * rule in `chat-email-refs.ts`, held to it case for case (and over both
 * generated sweeps) by `src/tests/unit/email-directive-parity.test.ts`.
 *
 * ES5-shaped on purpose: this is evaluated inside a page ClawBox does not
 * build, so it uses nothing a bundler would have to provide, and everything is
 * inside one IIFE at the call site so it can collide with nothing.
 *
 * `[\s\S]` and not `\s*(.*)`, for the reason the other three copies give: the
 * two quantifiers overlap on the space character and `$` without `m` matches
 * only at the end of the input, which made the pattern quadratic on a line
 * starting `email:` with a long run of spaces and a `\r`, ` ` or ` `
 * held back from its end.
 */
export const CONTROL_UI_DIRECTIVE_PARSER_JS = `
var EMAIL_LINE_RE = /^email:([\\s\\S]*)$/i;
var FENCE_RE = /^(?:\`\`\`|~~~)/;
var MAX_UID = 4294967295;
var MAX_REFS = 25;

function unwrapQuoted(value) {
  var quotes = ["\`", '"', "'"];
  for (var i = 0; i < quotes.length; i++) {
    var quote = quotes[i];
    if (value.length >= 2 && value.charAt(0) === quote && value.charAt(value.length - 1) === quote) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function parseUid(payload) {
  var value = unwrapQuoted(payload.trim());
  if (!/^[0-9]{1,10}$/.test(value)) return null;
  var uid = Number(value);
  if (!isFinite(uid) || Math.floor(uid) !== uid || uid < 1 || uid > MAX_UID) return null;
  return uid;
}

/**
 * The shared rule. \`budget\` lets the CALLER carry the "already seen" set and
 * the remaining card count across the several text nodes one reply is rendered
 * into; omitted, it behaves exactly like the other three copies, which is what
 * the parity suite runs.
 */
function splitEmailRefs(raw, budget) {
  if (typeof raw !== "string") return { text: "", uids: [] };
  if (!/email:/i.test(raw)) return { text: raw, uids: [] };

  var uids = [];
  var seen = budget && budget.seen ? budget.seen : {};
  var taken = budget && typeof budget.taken === "number" ? budget.taken : 0;
  var kept = [];
  var inFence = false;
  var lines = raw.split("\\n");

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    var match = inFence ? null : EMAIL_LINE_RE.exec(trimmed);
    if (!match) {
      kept.push(line);
      continue;
    }
    var uid = parseUid(match[1]);
    if (uid === null) {
      kept.push(line);
      continue;
    }
    if (seen["u" + uid]) continue;
    if (taken + uids.length >= MAX_REFS) {
      kept.push(line);
      continue;
    }
    seen["u" + uid] = true;
    uids.push(uid);
  }

  if (budget) budget.taken = taken + uids.length;
  if (kept.length === lines.length) return { text: raw, uids: uids };
  return { text: kept.join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim(), uids: uids };
}
`;

/**
 * The card, dressed to read as the chat window's own — the same affordance on a
 * page ClawBox does not otherwise style.
 *
 * A stylesheet and a class rather than an inline `style`, because the Control UI
 * ships light themes as well as dark (`data-theme-mode="light"`, and the
 * system preference): amber-on-dark is unreadable on a `#faf9f7` ground, and an
 * inline style cannot carry a media query.
 */
const CARD_CSS = `
.clawbox-email-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 6px 10px;
  border: 1px solid rgba(249, 115, 22, 0.35);
  border-radius: 8px;
  background: rgba(249, 115, 22, 0.08);
  color: #fdba74;
  font: inherit;
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
}
@media (prefers-color-scheme: light) {
  .clawbox-email-card { color: #9a3412; background: rgba(249, 115, 22, 0.12); }
}
:root[data-theme-mode="light"] .clawbox-email-card,
[data-theme-mode="light"] .clawbox-email-card {
  color: #9a3412;
  background: rgba(249, 115, 22, 0.12);
}
:root[data-theme-mode="dark"] .clawbox-email-card,
[data-theme-mode="dark"] .clawbox-email-card {
  color: #fdba74;
  background: rgba(249, 115, 22, 0.08);
}
`;

/** How often the sweep looks for text that has stopped changing. */
export const CONTROL_UI_SWEEP_MS = 250;

/**
 * How long a piece of text must hold still before a directive in it becomes a
 * card.
 *
 * THE REASON THIS IS NOT IMMEDIATE. A reply streams, and the text node holding
 * it is rewritten token by token: `EMAIL:4`, `EMAIL:44`, `EMAIL:447`,
 * `EMAIL:4471`. Every one of those is a usable uid by this grammar, so a
 * rewrite on sight draws a card for message 4, then 44, then 447 — and if the
 * turn is interrupted between two digits the last one STAYS, pointing at
 * somebody else's mail, with no `EMAIL:` text left on screen to show that it is
 * wrong. ClawBox's own chats have `dropUnfinishedDirective` for exactly this
 * and can use it because they know the turn is streaming; this page carries no
 * such signal, so quiet is the signal. Half a second is far below noticing and
 * far above a token gap.
 */
export const CONTROL_UI_SETTLE_MS = 500;

/**
 * The program injected into the Control UI page.
 *
 * A TEXT-NODE rewrite and not a selector: the only thing it assumes about a page
 * ClawBox does not build is that a reply's prose ends up in text nodes, which is
 * true of any HTML and survives a gateway upgrade. A class name or a container
 * id would be the probe-once fix that silently stops working after an update —
 * and silently is the whole complaint here.
 *
 * NOTHING IS DRAWN TWICE. Three separate rules, because the observer sees its
 * own work: the text a rewrite puts back is remembered and never looked at
 * again (so the lines a reply had past the 25-card cap stay text instead of
 * being converted by the next pass); the card elements carry no `email:` text
 * to match; and the "already seen" set and the remaining card count are carried
 * ACROSS the text nodes that share a parent, so a reply the page rendered one
 * directive per line is deduped and capped as one reply rather than as N.
 *
 * WHAT IT WILL NOT TOUCH: text inside `pre`, `code`, `script`, `style`,
 * `textarea`, `input`, a link, or an editable element — an explanation of the
 * syntax, and anything the owner is still typing, stay exactly as they are. The
 * parser's own fenced-code rule covers the same ground when a whole reply
 * arrives in one text node; the tag check covers it when the page has already
 * rendered the fence.
 *
 * The chrome tags (`label`, `button`, `th`, `td`, `dt`, `dd`, `summary`,
 * `legend`, `select`, `kbd`, `samp`, `var`) are there for a different reason,
 * and it is the accepted cost of a rule that reads a whole page rather than a
 * transcript it owns: a line that is exactly `Email: 12345` is a directive by
 * this grammar wherever it appears, so a form label, a table cell or a
 * definition row that happened to be shaped that way would become a card.
 * Chrome is where such a line would plausibly live; prose is where a directive
 * does. A reply's own paragraph is touched by neither list.
 */
export function controlUiEmailDirectiveScript(locale?: string): string {
  return `<script>${controlUiEmailDirectiveScriptBody({ locale })}</script>`;
}

export interface ControlUiScriptOptions {
  /** The owner's language, for the card's label. */
  readonly locale?: string;
  /** Quiet required before a directive becomes a card. Tests shorten it. */
  readonly settleMs?: number;
  /** How often the sweep runs. Tests shorten it. */
  readonly sweepMs?: number;
}

/** The same program without its element, for a test that has to evaluate it. */
export function controlUiEmailDirectiveScriptBody(
  options: ControlUiScriptOptions = {},
): string {
  const label = jsonForScript(controlUiCardLabel(options.locale));
  const href = jsonForScript(CONTROL_UI_EMAIL_HREF_PREFIX);
  const css = jsonForScript(CARD_CSS);
  const settleMs = Math.max(0, Math.trunc(options.settleMs ?? CONTROL_UI_SETTLE_MS));
  const sweepMs = Math.max(1, Math.trunc(options.sweepMs ?? CONTROL_UI_SWEEP_MS));
  return `(function(){
// ONE per document. Two routes serve this page and a future third might; two
// copies of this program would each keep their own "already ours" set, draw the
// same reply twice and defeat the card cap between them.
if (document.__clawboxEmailCards) return;
document.__clawboxEmailCards = true;
${CONTROL_UI_DIRECTIVE_PARSER_JS}
var LABEL = ${label};
var HREF = ${href};
var CSS = ${css};
var SETTLE_MS = ${settleMs};
var SWEEP_MS = ${sweepMs};
var CARD_CLASS = "clawbox-email-card";
var SKIP_TAGS = {
  PRE: 1, CODE: 1, SCRIPT: 1, STYLE: 1, TITLE: 1, NOSCRIPT: 1,
  TEXTAREA: 1, INPUT: 1, OPTION: 1, SELECT: 1, A: 1,
  LABEL: 1, BUTTON: 1, SUMMARY: 1, LEGEND: 1,
  TH: 1, TD: 1, DT: 1, DD: 1, KBD: 1, SAMP: 1, VAR: 1
};

// The text nodes this script itself put back. The observer sees its own work,
// and without this the lines a reply had past the card cap — which the parser
// deliberately leaves as TEXT — would be converted by the very next pass, one
// batch of 25 at a time, until none were left.
var ours = typeof WeakSet === "function" ? new WeakSet() : null;
// Candidate text node -> the last time it was seen changing.
var pending = typeof Map === "function" ? new Map() : null;
var timer = null;

function skipped(node) {
  for (var el = node.parentNode; el && el.nodeType === 1; el = el.parentNode) {
    if (SKIP_TAGS[el.nodeName]) return true;
    if (el.id === "clawbox-bar") return true;
    if (el.isContentEditable) return true;
  }
  return false;
}

function styleOnce() {
  if (document.getElementById("clawbox-email-card-style")) return;
  var style = document.createElement("style");
  style.id = "clawbox-email-card-style";
  style.textContent = CSS;
  var head = document.head || document.documentElement;
  if (head) head.appendChild(style);
}

function card(uid) {
  var a = document.createElement("a");
  a.className = CARD_CLASS;
  a.setAttribute("data-clawbox-email-uid", String(uid));
  a.setAttribute("href", HREF + uid);
  // A NAMED target, so a reply naming five messages does not leave five tabs
  // behind; and the uid in the accessible name, because otherwise a screen
  // reader hears the same three words once per card.
  a.setAttribute("target", "clawbox-chat");
  a.setAttribute("rel", "noopener noreferrer");
  a.setAttribute("aria-label", LABEL + " #" + uid);
  a.setAttribute("title", LABEL + " #" + uid);
  a.textContent = LABEL;
  return a;
}

function note(node) {
  if (!node || node.nodeType !== 3) return;
  if (!pending) return;
  if (ours && ours.has(node)) return;
  var raw = node.nodeValue;
  if (!raw || !/email:/i.test(raw)) { pending["delete"](node); return; }
  if (skipped(node)) return;
  pending.set(node, Date.now());
  start();
}

function convert(node, budget) {
  var raw = node.nodeValue;
  if (!raw) return;
  var split = splitEmailRefs(raw, budget);
  if (!split.uids.length) return;
  var parent = node.parentNode;
  if (!parent) return;
  styleOnce();
  var frag = document.createDocumentFragment();
  if (split.text) {
    // The parser trims, because in the other three copies its input is a WHOLE
    // reply. Here it is one text node, which in any rendered markdown is a
    // fragment sitting beside inline elements — so the space after a </b> is
    // load-bearing and is put back.
    var lead = /^\\s*/.exec(raw)[0];
    var tail = /\\s*$/.exec(raw)[0];
    var kept = document.createTextNode(lead + split.text + tail);
    if (ours) ours.add(kept);
    frag.appendChild(kept);
  }
  for (var i = 0; i < split.uids.length; i++) frag.appendChild(card(split.uids[i]));
  parent.replaceChild(frag, node);
}

/** What this reply has already been given: the cards standing under it now. */
function budgetFor(parent) {
  var budget = { seen: {}, taken: 0 };
  if (!parent || typeof parent.querySelectorAll !== "function") return budget;
  var drawn = parent.querySelectorAll("a." + CARD_CLASS + "[data-clawbox-email-uid]");
  for (var i = 0; i < drawn.length; i++) {
    var uid = drawn[i].getAttribute("data-clawbox-email-uid");
    if (!uid || budget.seen["u" + uid]) continue;
    budget.seen["u" + uid] = true;
    budget.taken += 1;
  }
  return budget;
}

function flush() {
  if (!pending) return;
  var now = Date.now();
  var due = [];
  pending.forEach(function (seenAt, node) {
    if (!node.parentNode) { due.push([node, true]); return; }
    if (now - seenAt >= SETTLE_MS) due.push([node, false]);
  });
  // The "already seen" set and the card count are shared by the text nodes that
  // share a parent: that is as close to "one reply" as a page ClawBox does not
  // build will say, and it is the scope the chat window's own dedupe and cap
  // have. Nodes in different parents get their own budget, so a second reply
  // cannot be capped by the first.
  //
  // AND IT IS READ BACK OFF THE DOM, not carried in a variable. One reply's
  // text nodes do not have to settle in the same sweep — a directive that
  // arrived a second after its neighbour lands in the next one — so a
  // per-sweep budget would give it a fresh count and a fresh "already seen"
  // set, and the same message would get a second card. The cards already on
  // screen under that parent ARE the count, which also means a card the page
  // removed takes its place in the budget with it, instead of capping a
  // conversation for good the way a stored one would.
  var budgets = typeof Map === "function" ? new Map() : null;
  for (var i = 0; i < due.length; i++) {
    var node = due[i][0];
    var gone = due[i][1];
    pending["delete"](node);
    if (gone) continue;
    var parent = node.parentNode;
    var budget = budgets ? budgets.get(parent) : null;
    if (!budget) {
      budget = budgetFor(parent);
      if (budgets) budgets.set(parent, budget);
    }
    convert(node, budget);
  }
  if (!pending.size) stop();
}

function start() {
  if (timer !== null) return;
  timer = setInterval(flush, SWEEP_MS);
}

function stop() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function scan(root) {
  if (!root) return;
  if (root.nodeType === 3) { note(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  var walker = document.createTreeWalker(root, 4, null);
  var next;
  while ((next = walker.nextNode())) note(next);
}

try {
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === "characterData") { note(record.target); continue; }
      for (var j = 0; j < record.addedNodes.length; j++) scan(record.addedNodes[j]);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  scan(document.body);
} catch (e) {
  // The page is the gateway's, not ClawBox's. A directive shown as text is a
  // blemish; a script that throws on this page could cost the owner the chat.
}
})();`;
}

/**
 * A JSON literal safe to sit inside a `<script>` element.
 *
 * The same escaping `serveGatewayHTML` applies to the gateway token, and for the
 * same reason: `</script>` inside a string literal ends the ELEMENT, not the
 * string, and the rest of the program lands in the document as text.
 */
function jsonForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}
