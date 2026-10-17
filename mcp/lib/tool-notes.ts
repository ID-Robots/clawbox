// The field guide's tool notes: what the short tool descriptions leave out.
//
// TASK-1080. A tool description is paid for in `tools/list` at the start of
// every session, called or not, so it now says WHEN to call the tool in about
// one sentence (MAX_DESCRIPTION_CHARS in mcp/lib/register.ts). The caveats that
// used to follow it — how to read the answer, the edge cases, where the owner
// changes a setting — are here, and `clawbox_context` serves them with the rest
// of the field guide, which the agent reads once per session.
//
// KEYED BY TOOL, and served only for the tools this server registered: a
// Hermes box is not told about `browser_click`, a box without
// CLAWBOX_MCP_CODING_TOOLS=1 is not told about `bash`, and the mailbox notes
// follow Settings → Email like the tools do. The same holds for every tool a
// note names in backticks — it must be registered wherever the note's own tool
// is — and src/tests/unit/mcp-tool-notes.test.ts holds every posture to that,
// so a note cannot offer the agent a symbol its server does not have.
//
// Nor is a caveat repeated here that something the agent reads anyway already
// states — the tool's own answer (`system_power` saying the box has not
// restarted while it waits, `code_project_init` handing back the absolute paths
// to use verbatim) or Clawbox.md (the Hermes plugin restart, the coding-agent
// workflow): every note is paid for by every box that registers its tool, and
// a second copy only buys drift.
//
// Not here either: the run-only tools (`team_message`, `generate_image`,
// `generate_audio`, `browser_view_local`). A delegated run's server has no
// `clawbox_context`; what those tools leave out is in the run's own brief.

export interface ToolNote {
  /** The tool the note is about; the note is served only where it is registered. */
  tool: string;
  note: string;
}

/** In the order they are served: orientation and device first, the coding agent last. */
export const TOOL_NOTES: readonly ToolNote[] = [
  {
    tool: "device_status",
    note: "A part it cannot read says \"unknown\" rather than failing the whole call.",
  },
  {
    tool: "system_stats",
    note: "An empty `cpu.perCore` means the per-core figures have not been measured yet (the first read after a restart has nothing to diff against), not that the cores are idle — call again for them.",
  },
  {
    tool: "backup_status",
    note: "`reason`: stale = no recent backup; error = a run failed; blocked = no backup can run until the box has an encryption passphrase (Settings → Backup); never = it has never backed up.",
  },
  {
    tool: "anthropic_accounts",
    note: "A run whose account hits its limit moves to the next account by itself; when every account is limited, runs wait and resume by themselves at the first reset. The owner adds and orders accounts in Settings → Providers.",
  },
  {
    tool: "clawbox_ai_usage",
    note: "The plan and credits are the owner's, in Settings → Providers or on clawbox.com.",
  },
  {
    tool: "local_ai_status",
    note: "Installing or removing an engine is the owner's, in Settings → Local AI.",
  },
  {
    tool: "memory_shard_status",
    note: "Starting a reindex is the owner's, in the Memory Shard app.",
  },
  {
    tool: "memory_shard_search",
    note: "It holds the owner's PDFs, Word files and Markdown. Ask a question or a phrase (\"what does the lease say about the deposit\") rather than one keyword.",
  },
  {
    tool: "prime_radiant_status",
    note: "Prime Radiant is the owner's wiki: pages with YAML frontmatter, each fact a claim with a global id `<domain>/<entity>/<fact>`. Every change you make through the `prime_radiant_*` tools is one commit authored \"ClawBox assistant\", which the owner sees in Prime Radiant → History and can undo.",
  },
  {
    tool: "prime_radiant_page_edit",
    note: "`summary` replaces only the first paragraph; `body` replaces everything (its first paragraph becomes the summary). Read the page with `prime_radiant_page` first so you do not drop what is there.",
  },
  {
    tool: "prime_radiant_page_merge",
    note: "Run it with `dry_run: true` first and tell the user what would move and which pages' links would change; merge once they agree. The page that stays keeps its text exactly as it is (pick the fuller page as `into`); a link in it to a page being merged refuses the merge until it is taken out, or until the user lets its text change (`keep_into_body: false`).",
  },
  {
    tool: "prime_radiant_pages_bulk_edit",
    note: "For a change of domain, owner, privacy or status on more than one page — re-tagging pages with a new domain, say — use this instead of one `prime_radiant_page_edit` per page: up to 500 pages in one commit. Run it with `dry_run: true` first and tell the user how many pages would change; a refused page says why, and the others still change.",
  },
  {
    tool: "prime_radiant_claim_verify",
    note: "A verification is final for the wiki: a later import never overwrites the page, and only verifying again changes the text. Verify only what the user confirmed; when you are unsure, `prime_radiant_review_raise` asks the owner instead.",
  },
  {
    tool: "prime_radiant_undo",
    note: "Only the commits you made can be undone here — the answer refuses any other as the owner's. A later commit that touched the same lines blocks the undo: undo that one first. Undoing a verification that retired other ids is refused by the wiki's rules.",
  },
  {
    tool: "prime_radiant_ingest_start",
    note: "Run `prime_radiant_ingest_preview` on folders first and tell the user how many documents it would read: a large import spends a lot of the owner's ClawBox AI allowance.",
  },
  {
    tool: "skill_list",
    note: "Only skills marked \"from the store\" can be removed. A final line in brackets saying how many skills were left out is not a skill.",
  },
  {
    tool: "skill_install",
    note: "The install runs a security scan and can take two minutes. Set confirm only after a refusal AND the user's go-ahead — never on a first attempt, never on your own judgement.",
  },
  {
    tool: "webapp_create",
    note: "CSS and JavaScript go inline in the one document, with no links to the internet. For more than one file use `code_project_init`.",
  },
  {
    tool: "browser_type",
    note: "The typed text is never echoed back: these are the tools that type passwords. `browser_fill` with a CSS selector beats clicking and typing, and Tab-by-Tab navigation — one step per field.",
  },
  {
    tool: "grep",
    note: "Ask for output_mode \"files_with_matches\" first, then \"content\" on one file. Files holding device credentials are never searched or shown — nor listed by `list_directory` or matched by `glob`.",
  },
  {
    tool: "bash",
    note: "The one unguarded tool: it can read and change anything the device user can, including files the other tools refuse to open. For files prefer `read_file`, `write_file`, `edit_file`, `glob` and `grep`. Use run_in_background for anything that takes minutes, then `job_status`. `allow_dangerous` skips only the typo check on destructive spellings: it is not permission and not the user's consent, and nothing on the device treats it as either.",
  },
  {
    tool: "read_file",
    note: "Use `list_directory` for a folder and `glob` for a file whose path you do not know. Read a file before you edit it.",
  },
  {
    tool: "edit_file",
    note: "old_text must match the file character for character, indentation included, and appear once unless replace_all is true.",
  },
  {
    tool: "notebook_edit",
    note: "Read the notebook with `read_file` first to see its cell numbers.",
  },
  {
    tool: "web_fetch",
    note: "HTML comes back as plain text and JSON formatted. It cannot reach addresses inside the ClawBox or the home network.",
  },
  {
    tool: "coding_agent_run",
    note: "A one-line change is your own tools' job. Work only in a `project_id` from `code_project_list` or a `directory` inside the owner's project folder, preferring one the owner already has to scaffolding a new one; the run cannot ask questions. `input_files` are copied where the run can read them — it cannot open your media folder, so a path only mentioned in the task is never read. Name `deliverable_files` for any concrete output: the run is not finished until they exist and are not empty. `delivery_pipeline` adds review and improvement laps; this box cannot deploy, so the deploy and check stages are skipped.",
  },
  {
    tool: "coding_agent_status",
    note: "Never set wait_seconds just after starting a run. Run ids stay valid across sessions.",
  },
  {
    tool: "coding_agent_stop",
    note: "A long first turn with no output and 0 turns is normal at high effort: turns are counted when the run finishes. `end_leftovers` also takes down any app the box serves from the server it ends.",
  },
  {
    tool: "coding_secret_list",
    note: "No tool reads a value: the owner types it in Settings and only a run's own environment sees it.",
  },
];

/**
 * The "Tool notes" section for the tools `registered` names, or null when none
 * of them has a note.
 */
export function toolNotesFor(registered: Iterable<string>): string | null {
  const have = new Set(registered);
  const lines = TOOL_NOTES.filter((n) => have.has(n.tool)).map((n) => `- \`${n.tool}\` — ${n.note}`);
  if (!lines.length) return null;
  return [
    "## Tool notes",
    "",
    "What the short tool descriptions leave out. Read a tool's line before you first call it.",
    "",
    ...lines,
  ].join("\n");
}
