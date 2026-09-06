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
// handed ONE payload for ONE channel: its context carries `channelId`,
// `accountId`, `conversationId` and `sessionKey` and nothing client-shaped, and
// all three webchat clients — ClawBox's dashboard chat, ClawBox's mascot popup
// and the Control UI — arrive as `webchat`. ClawBox's own connect frame does
// say `version: "clawbox-chat"`, but the gateway keeps that on the live
// connection record and the presence row, where no hook can read it. So a strip
// in the hook would take the card away from the two surfaces that make one, and
// there is no per-client outbound hook in the `transform` / `message_sending` /
// `after_turn` family that would let one message be three. `presentation`
// (`docs/plugins/message-presentation.md`) is the core's own rich-card contract,
// but its renderers are channel plugins — the provider table has no webchat row
// — so a presentation block reaches this surface as fallback text.
//
// WHAT IS LEFT IS OURS. ClawBox serves that page: `src/app/[...gateway]/route.ts`
// hands it to `serveGatewayHTML`, which already injects the ClawBox bar and the
// gateway-connect script into the HTML. Same origin, so the card can link
// straight at the chat that already renders the message, and the owner's
// session rides along.
//
// ONE GRAMMAR, NOW IN FOUR PLACES. The rule is the same rule:
// `src/lib/chat-email-refs.ts` (the chat window), the OpenClaw plugin's
// `email-directives.mjs`, the Hermes plugin's `email_directives.py`, and this
// one. They cannot share a file — this copy is evaluated by the browser inside
// the gateway's own page, with no bundler and no imports. What holds them
// together is the case table: `src/tests/fixtures/email-directive-cases.ts` runs
// through all four, three of them in `email-directive-parity.test.ts` and this
// one in `control-ui-email-directives.test.ts`, which evaluates the string that
// actually ships.

import { desktopTranslations } from "./desktop-translations";
import type { Locale } from "./i18n";

/** The query parameter `/app/clawbox` reads to open one message on arrival. */
export const CONTROL_UI_EMAIL_PARAM = "email";

/** Where a Control UI card sends the owner: the chat that already draws it. */
export function controlUiEmailHref(uid: number): string {
  return `/app/clawbox?${CONTROL_UI_EMAIL_PARAM}=${uid}`;
}

/** The card's label, in the language the owner picked, falling back to English. */
export function controlUiCardLabel(locale: string | undefined): string {
  const table = desktopTranslations[locale as Locale] ?? desktopTranslations.en;
  return table["chat.email.openFull"] ?? desktopTranslations.en["chat.email.openFull"];
}

/**
 * The `EMAIL:<uid>` grammar as the browser gets it — the fourth copy of the
 * rule in `chat-email-refs.ts`, held to it case for case by
 * `src/tests/unit/control-ui-email-directives.test.ts`.
 *
 * ES5-shaped on purpose: this is evaluated inside a page ClawBox does not
 * build, so it uses nothing a bundler would have to provide and nothing the
 * gateway's own scripts could collide with (everything is inside one IIFE at
 * the call site).
 *
 * `[\s\S]` and not `\s*(.*)`, for the reason the other three copies give: the
 * two quantifiers overlap on the space character and `$` without `m` matches
 * only at the end of the input, which made the pattern quadratic on a line
 * starting `email:` with a long run of spaces and a `\r`, ` ` or ` `
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

function splitEmailRefs(raw) {
  if (typeof raw !== "string") return { text: "", uids: [] };
  if (!/email:/i.test(raw)) return { text: raw, uids: [] };

  var uids = [];
  var seen = {};
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
    if (uids.length >= MAX_REFS) {
      kept.push(line);
      continue;
    }
    seen["u" + uid] = true;
    uids.push(uid);
  }

  if (kept.length === lines.length) return { text: raw, uids: uids };
  return { text: kept.join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim(), uids: uids };
}
`;

/**
 * The card, styled to read as the chat window's own: the same amber on the same
 * dark ground, because it is the same affordance on a page ClawBox does not
 * otherwise dress. Inline, since none of ClawBox's stylesheets are loaded here.
 */
const CARD_STYLE = [
  "display:inline-flex",
  "align-items:center",
  "gap:6px",
  "margin:4px 0",
  "padding:6px 10px",
  "border:1px solid rgba(249,115,22,0.25)",
  "border-radius:8px",
  "background:rgba(249,115,22,0.06)",
  "color:#fdba74",
  "font:inherit",
  "font-size:13px",
  "text-decoration:none",
  "cursor:pointer",
].join(";");

/**
 * The program injected into the Control UI page.
 *
 * A TEXT-NODE rewrite and not a selector: the only thing it assumes about a page
 * ClawBox does not build is that a reply's prose ends up in text nodes, which is
 * true of any HTML and survives a gateway upgrade. A class name or a container
 * id would be the probe-once fix that silently stops working after an update —
 * and silently is the whole complaint here.
 *
 * IDEMPOTENT BY CONSTRUCTION. A rewritten node no longer carries the directive,
 * so the observer's own re-entry finds nothing and the pass terminates. That is
 * also why the card is never counted or de-duplicated by hand: the same turn
 * seen twice cannot produce two cards, because the second look has nothing left
 * to match.
 *
 * WHAT IT WILL NOT TOUCH: text inside `pre`, `code`, `script`, `style`,
 * `textarea`, `input` or an editable element — an explanation of the syntax, and
 * anything the owner is still typing, stay exactly as they are. The parser's own
 * fenced-code rule covers the same ground when a whole reply arrives in one text
 * node; the tag check covers it when the page has already rendered the fence.
 *
 * The chrome tags (`label`, `button`, `th`, `dt`, `summary`, `legend`, `select`)
 * are there for a different reason, and it is the accepted cost of a rule that
 * reads a whole page rather than a transcript it owns: a line that is exactly
 * `Email: 12345` is a directive by this grammar wherever it appears, so a form
 * label or a table header that happened to be shaped that way would become a
 * card. Chrome is where such a line would plausibly live; prose is where a
 * directive does. A reply's own paragraph is touched by neither list.
 */
export function controlUiEmailDirectiveScript(locale?: string): string {
  const label = jsonForScript(controlUiCardLabel(locale));
  const href = jsonForScript(`/app/clawbox?${CONTROL_UI_EMAIL_PARAM}=`);
  return `<script>${controlUiEmailDirectiveScriptBody(label, href)}</script>`;
}

/** The same program without its element, for a test that has to evaluate it. */
export function controlUiEmailDirectiveScriptBody(
  label = jsonForScript(controlUiCardLabel(undefined)),
  href = jsonForScript(`/app/clawbox?${CONTROL_UI_EMAIL_PARAM}=`),
): string {
  return `(function(){
${CONTROL_UI_DIRECTIVE_PARSER_JS}
var LABEL = ${label};
var HREF = ${href};
var SKIP_TAGS = {
  PRE: 1, CODE: 1, SCRIPT: 1, STYLE: 1, TITLE: 1,
  TEXTAREA: 1, INPUT: 1, OPTION: 1, SELECT: 1,
  LABEL: 1, BUTTON: 1, SUMMARY: 1, LEGEND: 1, TH: 1, DT: 1,
};
var CARD_CLASS = "clawbox-email-card";

function skipped(node) {
  for (var el = node.parentNode; el && el.nodeType === 1; el = el.parentNode) {
    if (SKIP_TAGS[el.nodeName]) return true;
    if (el.id === "clawbox-bar") return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute("class") === CARD_CLASS) return true;
  }
  return false;
}

function card(uid) {
  var a = document.createElement("a");
  a.className = CARD_CLASS;
  a.setAttribute("data-clawbox-email-uid", String(uid));
  a.setAttribute("href", HREF + uid);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  a.setAttribute("style", ${JSON.stringify(CARD_STYLE)});
  a.textContent = LABEL;
  return a;
}

function rewrite(node) {
  if (!node || node.nodeType !== 3) return;
  var raw = node.nodeValue;
  if (!raw || !/email:/i.test(raw)) return;
  if (skipped(node)) return;
  var split = splitEmailRefs(raw);
  if (!split.uids.length) return;
  var parent = node.parentNode;
  if (!parent) return;
  var frag = document.createDocumentFragment();
  if (split.text) frag.appendChild(document.createTextNode(split.text));
  for (var i = 0; i < split.uids.length; i++) frag.appendChild(card(split.uids[i]));
  parent.replaceChild(frag, node);
}

function scan(root) {
  if (!root) return;
  if (root.nodeType === 3) { rewrite(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  // Collected before anything is replaced: a walker whose current node is taken
  // out of the document stops there, and the rest of the reply keeps its ids.
  var walker = document.createTreeWalker(root, 4, null);
  var pending = [];
  var next;
  while ((next = walker.nextNode())) pending.push(next);
  for (var i = 0; i < pending.length; i++) rewrite(pending[i]);
}

try {
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === "characterData") { rewrite(record.target); continue; }
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
