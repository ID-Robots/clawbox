// ── The owner's allow-list of Claude Code permission rules ───────────────────
//
// WHAT THIS IS FOR. A delegated run is headless: in `-p` mode Claude Code
// cannot ask, so anything outside the list it was started with is DENIED and
// lands on the run's page as "Not allowed: Read: /…/memory/notes.md"
// (`describeDenial` in @/lib/coding-agent). Until now that was the end of it —
// the owner could read the refusal and had no way to answer it, so the next run
// was refused the same thing. This module is the other half: the grammar of a
// permission rule, the floor a rule may not go under, and the one place that
// turns a refused action into the narrowest rule that would have allowed it.
//
// THE FLOOR HAS TWO STOREYS. A deny rule outranks an allow rule in Claude Code,
// so a rule that lands inside something this box denies to every run would
// grant nothing at all. Which is why the denied subtrees are split:
//
//   HARD — credential and key material, and the box's own state: ~/.ssh,
//          ~/.gnupg, ~/.aws, the cloud CLI configs, the OpenClaw/Hermes/Codex/
//          ClawKeep stores, the harness's own settings and OAuth tokens, and
//          data/ with the device's secrets. NO rule may reach these, by any
//          owner, ever. Their deny rules ship on every single run.
//
//   SOFT — the harness's own PER-PROJECT state: `~/.claude/projects/<project>/`
//          and `~/.claude-ds/projects/<project>/`, where a run keeps its notes,
//          plans and memory for the folder it is working on. Nothing secret
//          lives there; it is merely outside the working folder, which is the
//          whole of why it was refused. An explicit owner rule naming one of
//          these unlocks that one subtree — and only for runs started after the
//          rule was saved (see `CodingRun.allowRules`).
//
// Anything else is judged against what the device actually denies right now
// (`fileDenyRules()`, walked from disk), which the server passes in as context.
//
// PURE ON PURPOSE. The settings panel and the run page both need the cap, the
// character limit and the refusal codes, and @/lib/coding-agent is server-only
// (it spawns processes and reads the run store). Nothing here touches the
// filesystem.
//
// WHY A RULE IS REFUSED RATHER THAN STORED AND IGNORED. A saved
// `Read(//home/owner/.ssh/**)` would never grant anything — it would sit in the
// owner's list looking like a standing permission the box does not honour. A
// list that lies about what the box allows is worse than a refusal that says
// why, so every rule the device cannot honour is refused at the door with a
// `code` the UI words in the owner's language.

/** The longest rule the owner may save. Real rules are far shorter; this is
 *  the bound on what may ARRIVE, so a pathological body cannot be stored. */
export const MAX_RULE_CHARS = 200;

/** How many rules the owner may keep. A list longer than this is not an
 *  allow-list any more, it is a switched-off gate — and every rule is argv on
 *  every run the box starts. */
export const MAX_ALLOW_RULES = 32;

/**
 * The tools an owner rule may name: the file tools, and only those.
 *
 * Bash is deliberately absent and refused with a sentence of its own (see
 * `bash_already_allowed`): a full run is already started with `Bash(*)`, so a
 * `Bash(prefix:*)` rule would grant nothing, and a read-only run is not given
 * the Bash tool at all (`READ_ONLY_TOOLS`), so it would grant nothing there
 * either. The only commands a run may not use are the kill deny-list, and those
 * are untouchable by design.
 *
 * The MCP tools (`mcp__clawbox__…`) are pre-approved by the runner for the runs
 * that may use them at all, and a standing owner rule over them would widen a
 * consent the run's own media and browser switches are supposed to own.
 */
export const ALLOW_RULE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"] as const;

export type AllowRuleTool = (typeof ALLOW_RULE_TOOLS)[number];

/**
 * Why a rule was not saved. A STABLE code beside the English sentence, the
 * shape every refusal in this subtree already has: the panel says it in the
 * owner's language, and an older panel still has something to show.
 *
 * A runtime list and not only a type, because a code travels: it is stored on a
 * run record beside the refusal it explains, and a record written by an older
 * build has to be read back without trusting what is on disk.
 */
export const ALLOW_RULE_REFUSALS = [
  /** Nothing but whitespace. */
  "empty",
  /** Longer than MAX_RULE_CHARS. */
  "too_long",
  /** Not `Tool(specifier)` at all. */
  "malformed",
  /** A tool this list does not carry — see ALLOW_RULE_TOOLS. */
  "unknown_tool",
  /** A Bash rule: already permitted, or already untouchable. Never both. */
  "bash_already_allowed",
  /** `Read(//**)`, `Read(//home/**)`: everything, which is not an allow-LIST. */
  "too_broad",
  /** A HARD subtree: credentials, keys, the box's own state. Never allowable. */
  "protected",
  /** Something else the device refuses on its own, or a rule that walks out
   *  of the folder it names. */
  "unsafe",
  /** Already saved. Not an error the owner has to fix, but not a second row. */
  "duplicate",
  /** MAX_ALLOW_RULES already saved. */
  "too_many",
] as const;

export type AllowRuleRefusal = (typeof ALLOW_RULE_REFUSALS)[number];

/** True when `code` is one this build knows — the guard for a code read back
 *  off a run record rather than produced by the validator just now. */
export function isAllowRuleRefusal(code: unknown): code is AllowRuleRefusal {
  return typeof code === "string" && (ALLOW_RULE_REFUSALS as readonly string[]).includes(code);
}

/**
 * The sentence each refusal is shown as, by translation key.
 *
 * A `Record` over the code union rather than a lookup with a fallback, so the
 * compiler refuses a new code that nobody worded: the refusals the owner meets
 * are the whole reason the codes exist, and one that rendered as an empty
 * string would be a refusal with no explanation at all.
 *
 * Here rather than in a component because BOTH surfaces read it — the rules
 * editor in Settings words what the route refused, and the run page words why
 * a refused action has no button.
 */
export const ALLOW_RULE_REFUSAL_KEYS: Record<AllowRuleRefusal, string> = {
  empty: "codingAgent.ruleRefusedEmpty",
  too_long: "codingAgent.ruleRefusedTooLong",
  malformed: "codingAgent.ruleRefusedMalformed",
  unknown_tool: "codingAgent.ruleRefusedUnknownTool",
  bash_already_allowed: "codingAgent.ruleRefusedBash",
  too_broad: "codingAgent.ruleRefusedTooBroad",
  protected: "codingAgent.ruleRefusedProtected",
  unsafe: "codingAgent.ruleRefusedUnsafe",
  duplicate: "codingAgent.ruleRefusedDuplicate",
  too_many: "codingAgent.ruleRefusedTooMany",
};

export interface AllowRuleOk {
  readonly ok: true;
  /** The rule as it will be stored and passed to the CLI — trimmed, never rewritten. */
  readonly rule: string;
  readonly tool: AllowRuleTool;
  readonly specifier: string;
}

export interface AllowRuleRefused {
  readonly ok: false;
  readonly code: AllowRuleRefusal;
  /** English, for a caller with no catalogue. The `code` is the contract. */
  readonly message: string;
}

export type AllowRuleVerdict = AllowRuleOk | AllowRuleRefused;

function refuse(code: AllowRuleRefusal, message: string): AllowRuleRefused {
  return { ok: false, code, message };
}

/**
 * Home-relative subtrees a rule may unlock — the SOFT half of the floor.
 *
 * Both are the harness's own per-project state: the transcripts, plans and
 * memory files a run writes for the folder it is working in. They are denied by
 * default only because they sit outside the working folder, which is exactly
 * the refusal an owner should be able to answer. They hold no credentials: the
 * harness keeps its OAuth token and settings in the PARENT directory, and those
 * stay denied entry by entry even while a project subtree is open (see
 * `fileDenyRules` and HARNESS_STATE_SECRETS in @/lib/coding-agent).
 *
 * Each entry is exactly one segment deep inside its parent; `fileDenyRules`
 * relies on that when it re-fences the siblings.
 */
export const SOFT_HOME_SUBTREES: readonly string[] = [
  ".claude/projects",
  ".claude-ds/projects",
];

/**
 * Path segments no rule may name, whatever else it says — the HARD half, in the
 * form that can run in a browser.
 *
 * It is not the whole hard floor: the device's own deny rules are built from
 * what is on disk and are what actually refuse the read. It is the half that
 * needs no filesystem, and it is what stops a rule that WOULD be inert from
 * being saved as though it were a permission. Matched segment-wise, so
 * `//home/owner/.ssh/id_ed25519` and `.ssh/**` are both caught and a folder
 * innocently named `my.ssh-notes` is not.
 */
const HARD_SEGMENTS: readonly string[] = [
  // Credential and key stores (the file-guard list, by name).
  ".ssh", ".gnupg", ".aws", ".kube", ".docker",
  ".config/gcloud", ".config/gh", ".config/rclone",
  // The appliance's own state and tokens.
  ".openclaw", ".hermes", ".codex", ".clawkeep",
  // The harness's settings and OAuth token live directly in these; only the
  // `projects/` child below is ever unlockable.
  ".claude", ".claude-ds",
  // Key material and credential files by name, wherever they sit.
  "id_rsa", "id_ed25519", ".netrc", ".npmrc", ".pypirc", ".pgpass",
  ".git-credentials", ".credentials.json", ".claude.json", ".env",
  ".session-secret", ".mcp-token",
  // The box's own stores.
  "config.json", "kv.json", "coding-agent-runs.json",
  "email-pending.json", "email-outcomes.json", "email-approval-prompts.json",
];

/** Kernel and system trees a rule has no business naming. */
const HARD_PREFIXES: readonly string[] = ["/proc", "/sys", "/etc/shadow", "/etc/sudoers", "/dev"];

/** A specifier that means "anything at all", in the spellings people try. */
const EVERYTHING = new Set(["*", "**", "/*", "/**", "//*", "//**"]);

/**
 * What this box refuses to EVERY run, as the validator needs to read it.
 *
 * The textual lists above are the half that can run in a browser; this is the
 * half only the server knows, and it is the one that is actually true —
 * `fileDenyRules()` is built from what is on disk right now. Deny outranks allow
 * in Claude Code, so a rule that lands inside it could never take effect;
 * refusing it here is what keeps the owner's list honest.
 *
 * Optional, because the same validator runs where none of this is knowable:
 * with no context a rule clears the textual floor alone, and the server applies
 * the rest before anything is stored.
 */
export interface AllowRuleContext {
  /** The deny rules a run is spawned with, as `fileDenyRules()` returns them. */
  readonly denyRules: readonly string[];
  /** This box's home directory. No rule may name it or anything above it. */
  readonly homeDir: string;
}

/** True when `child` is `parent` or sits inside it. */
function isAtOrInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** The path a file deny rule is about, tree rules and single files alike. */
function denyRulePath(rule: string): { path: string; tree: boolean } | null {
  const m = /^(?:Read|Edit|Write|NotebookEdit|Glob|Grep)\(\/(.+?)(\/\*\*)?\)$/.exec(rule.trim());
  if (!m) return null;
  return { path: `/${m[1]}`.replace(/\/+/g, "/"), tree: Boolean(m[2]) };
}

/**
 * The concrete folder a path pattern is about: everything before the first
 * wildcard segment. `//home/me/notes/**` → `/home/me/notes`.
 */
export function concretePrefix(pattern: string): string {
  const abs = pattern.replace(/^\/\//, "/");
  const kept: string[] = [];
  for (const part of abs.split("/")) {
    if (/[*?[\]]/.test(part)) break;
    kept.push(part);
  }
  return kept.join("/").replace(/\/+$/, "") || "/";
}

/** The segments of a path, empties dropped. */
function segmentsOf(p: string): string[] {
  return p.split("/").filter(Boolean);
}

/** True when `needle` ("a" or "a/b") appears as a run of whole segments in `segs`. */
function hasSegmentRun(segs: readonly string[], needle: string): boolean {
  const want = segmentsOf(needle);
  for (let i = 0; i + want.length <= segs.length; i++) {
    if (want.every((w, j) => segs[i + j] === w)) return true;
  }
  return false;
}

/**
 * The ONE project folder a path would unlock, or null when it unlocks none.
 *
 * A path only counts as soft when it reaches at least one segment PAST the
 * subtree — `…/.claude-ds/projects/<project>/…`, a single project's state — and
 * what comes back is that project's folder, however much deeper the path went.
 * The bare `…/projects/**` is not soft: that is every project the harness has
 * ever touched, which is not what a one-click answer to one refusal should
 * open, and it is why the loop stops one short of the last segment.
 */
export function softProjectDir(absolutePath: string): string | null {
  const segs = segmentsOf(absolutePath);
  for (const sub of SOFT_HOME_SUBTREES) {
    const want = segmentsOf(sub);
    for (let i = 0; i + want.length < segs.length; i++) {
      if (want.every((w, j) => segs[i + j] === w)) {
        return `/${segs.slice(0, i + want.length + 1).join("/")}`;
      }
    }
  }
  return null;
}

/** `Tool(specifier)`, with the tool name anchored so nothing can arrive that
 *  the CLI would read as a flag (a leading `-` cannot parse as a tool name). */
const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9_]*)\((.+)\)$/;

/** Control characters, which never appear in a real rule. Written as escapes
 *  rather than as the characters themselves, so the source stays readable text. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate one rule the owner (or the "Allow next time" button) proposes.
 *
 * Shape → tool → floor, in that order, so the message names the first thing
 * wrong rather than the last. `known` is the list already saved, for the
 * duplicate and cap verdicts; pass it from the store, never from the client.
 *
 * @param raw whatever arrived — a string, or anything at all
 * @param known the rules already saved, in store order
 * @param context what the device denies right now; omit where it is unknowable
 * @returns the rule to store, or a coded refusal
 */
export function validateAllowRule(
  raw: unknown,
  known: readonly string[] = [],
  context?: AllowRuleContext,
): AllowRuleVerdict {
  if (typeof raw !== "string") return refuse("malformed", "A permission rule must be text.");
  const rule = raw.trim();
  if (!rule) return refuse("empty", "Type a permission rule first.");
  if (rule.length > MAX_RULE_CHARS) {
    return refuse("too_long", `A permission rule may be at most ${MAX_RULE_CHARS} characters.`);
  }
  // Control characters never appear in a real rule and would travel into argv
  // and into the owner's own list unread. Refused before anything else looks
  // at the text.
  if (CONTROL_CHARS.test(rule)) {
    return refuse("malformed", "A permission rule may not contain control characters.");
  }
  const m = RULE_SHAPE.exec(rule);
  if (!m) {
    return refuse(
      "malformed",
      "A permission rule looks like Read(//home/you/notes/**) — a tool, then the paths it may open, in brackets.",
    );
  }
  const [, tool, specifier] = m;
  if (tool === "Bash") {
    return refuse(
      "bash_already_allowed",
      "A run may already use every command except the ones that kill processes by name, and those can never be allowed. A permission rule is for files.",
    );
  }
  if (!(ALLOW_RULE_TOOLS as readonly string[]).includes(tool)) {
    return refuse("unknown_tool", `${tool} is not a tool a permission rule may name.`);
  }
  const trimmedSpecifier = specifier.trim();
  if (!trimmedSpecifier) return refuse("malformed", "The brackets are empty: say which paths the tool may open.");
  if (EVERYTHING.has(trimmedSpecifier)) {
    return refuse("too_broad", "That rule would allow everything. Name the folder it is about.");
  }
  if (segmentsOf(trimmedSpecifier).includes("..")) {
    return refuse("unsafe", "A permission rule may not step up out of the folder it names.");
  }
  // `//path` is the rule syntax for an absolute path; a single leading slash
  // means "relative to the project root" and would silently miss. A relative
  // pattern is fine — it can only mean the run's own folder, which is open to
  // it anyway.
  if (trimmedSpecifier.startsWith("/") && !trimmedSpecifier.startsWith("//")) {
    return refuse("malformed", "Write an absolute path with two leading slashes, e.g. Read(//home/you/notes/**).");
  }

  if (trimmedSpecifier.startsWith("//")) {
    const target = concretePrefix(trimmedSpecifier);
    // One top-level segment or none — `//**`, `//home/**`, `//etc/**`. Whole
    // regions of the box rather than a folder. Checked without the context so
    // the answer is the same in the browser as on the server.
    if (segmentsOf(target).length < 2) {
      return refuse("too_broad", "That rule matches a whole region of the box. Name the folder it is about.");
    }
    const soft = softProjectDir(target);
    // A soft subtree is judged FIRST and on its own: its parent is on the hard
    // list (the harness keeps its token there) and the device's own deny rules
    // still cover the parent tree, so every check below would refuse the one
    // path this feature exists to open.
    if (soft) {
      const home = context?.homeDir.replace(/\/+$/, "") ?? "";
      // Only the harness state under THIS box's home is soft. A lookalike path
      // elsewhere gets no exemption.
      if (!home || isAtOrInside(target, home)) {
        return okRule(tool, trimmedSpecifier, known);
      }
    }
    for (const prefix of HARD_PREFIXES) {
      if (isAtOrInside(target, prefix)) return protectedRefusal();
    }
    const segs = segmentsOf(target);
    for (const segment of HARD_SEGMENTS) {
      if (hasSegmentRun(segs, segment)) return protectedRefusal();
    }
    if (context) {
      const home = context.homeDir.replace(/\/+$/, "");
      if (home && isAtOrInside(home, target)) {
        return refuse("too_broad", "That rule opens the whole home directory. Name the folder it is about.");
      }
      for (const deny of context.denyRules) {
        const denied = denyRulePath(deny);
        if (!denied) continue;
        // Inside a denied tree: the rule could never take effect.
        if (denied.tree ? isAtOrInside(target, denied.path) : target === denied.path) {
          return protectedRefusal();
        }
        // AROUND a denied tree: the deny rule still fences it at run time, but a
        // rule this wide is not what a one-click "Allow next time" should write
        // and not what an owner means by naming a folder.
        if (denied.path !== target && isAtOrInside(denied.path, target)) {
          return refuse(
            "too_broad",
            `A rule for ${target} would reach folders this box keeps runs out of. Name a folder inside it.`,
          );
        }
      }
    }
  } else {
    // A working-folder-relative pattern. It cannot escape (the `..` check
    // above), but it must not name the harness state or a credential store by
    // the same segments either — a run's folder could be anywhere.
    const segs = segmentsOf(concretePrefix(trimmedSpecifier));
    for (const segment of HARD_SEGMENTS) {
      if (hasSegmentRun(segs, segment)) return protectedRefusal();
    }
  }

  return okRule(tool, trimmedSpecifier, known);
}

function protectedRefusal(): AllowRuleRefused {
  return refuse(
    "protected",
    "That path holds credentials or this box's own state. No permission rule can open it.",
  );
}

function okRule(tool: string, specifier: string, known: readonly string[]): AllowRuleVerdict {
  const normalized = `${tool}(${specifier})`;
  if (known.includes(normalized)) return refuse("duplicate", "That rule is already on the list.");
  if (known.length >= MAX_ALLOW_RULES) {
    return refuse("too_many", `The list is full at ${MAX_ALLOW_RULES} rules. Remove one first.`);
  }
  return { ok: true, rule: normalized, tool: tool as AllowRuleTool, specifier };
}

/**
 * The stored list, read defensively.
 *
 * The config store holds whatever was last written, and a rule that was legal
 * under an older build may not be now — the floor only ever grows. Every entry
 * is re-validated on the way out, so a rule the device would no longer accept
 * cannot reach a run's argv just because it is already on disk; the cap is
 * applied as the list is built, so an over-long list from an older build is
 * cut rather than refused wholesale.
 */
export function normalizeAllowRules(raw: unknown, context?: AllowRuleContext): string[] {
  if (!Array.isArray(raw)) return [];
  const kept: string[] = [];
  for (const entry of raw) {
    if (kept.length >= MAX_ALLOW_RULES) break;
    const verdict = validateAllowRule(entry, kept, context);
    if (verdict.ok) kept.push(verdict.rule);
  }
  return kept;
}

/**
 * The project folders a saved list actually unlocks, as absolute paths.
 *
 * What `fileDenyRules()` reads to decide which of its own deny rules to leave
 * out of one run's argv. A rule unlocks the ONE project folder it names — never
 * the `projects/` parent and never a sibling project, which is why what comes
 * back is `…/projects/<project>` rather than `…/projects` — and only while it is
 * on the list.
 */
export function unlockedSoftPaths(rules: readonly string[], homeDir: string): string[] {
  const home = homeDir.replace(/\/+$/, "");
  const out = new Set<string>();
  for (const rule of rules) {
    const m = RULE_SHAPE.exec(rule.trim());
    if (!m) continue;
    const [, tool, specifier] = m;
    if (!(ALLOW_RULE_TOOLS as readonly string[]).includes(tool)) continue;
    const spec = specifier.trim();
    if (!spec.startsWith("//")) continue;
    const project = softProjectDir(concretePrefix(spec));
    if (!project) continue;
    // Only the harness state under THIS box's home is soft; the validator says
    // the same thing when the rule is saved, and says it again here because
    // this is what actually drops a deny rule.
    if (home && !isAtOrInside(project, home)) continue;
    out.add(project);
  }
  return [...out];
}

/** The fields of one refused action this module can read. */
export interface DenialInput {
  readonly tool: string;
  /** The path or pattern the tool was pointed at. */
  readonly target: string | null;
}

/**
 * The narrowest rule that would have allowed a refused action — the text only,
 * with no floor applied. The caller validates it with the device's own context
 * (see `denialsFrom` in @/lib/coding-agent), which is the only place that knows
 * whether the path is hard, soft or merely outside the folder.
 *
 * THE CONTAINING FOLDER, NOT THE ONE FILE. A denied `Read` of
 * `…/memory/notes.md` becomes `Read(//…/memory/**)`. The single-file rule looks
 * narrower and is worse in practice: the harness writes a handful of files side
 * by side, so the next turn is refused `notes-2.md` and the owner is back on the
 * same page pressing the same button. The folder is the unit the refusal is
 * really about, the owner sees the derived rule before it is saved, and the
 * floor above is what keeps that folder from being somewhere it should not be.
 *
 * Bash gets no rule: every command is already allowed except the kill
 * deny-list, which nothing can open.
 */
export function deriveAllowRule(denial: DenialInput): string | null {
  const target = (denial.target ?? "").trim();
  if (!target) return null;
  if (!(ALLOW_RULE_TOOLS as readonly string[]).includes(denial.tool)) return null;
  // `//` is the rule syntax for an absolute path; a single leading slash would
  // mean "relative to the project root" and silently miss. A relative target is
  // inside the working folder, which needs no rule.
  if (!target.startsWith("/")) return null;
  const concrete = concretePrefix(target);
  // A pattern already stops at its first wildcard; a plain file gives up its
  // last segment. Either way the rule is about a folder.
  const folder = concrete === target ? concrete.replace(/\/[^/]*$/, "") : concrete;
  if (!folder || folder === "/") return null;
  return `${denial.tool}(/${folder}/**)`;
}
