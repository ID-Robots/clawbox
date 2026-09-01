/**
 * The canned smoke run, shared by the two places that offer it: the Test
 * harness card in the Coding Agent's settings page, and the last step of the
 * setup wizard.
 *
 * It lives here rather than in a component because the wizard cannot import
 * the app that renders it, and it is not in `@/lib/coding-agent` because that
 * module reaches for `fs` and is server-only.
 *
 * The task exercises the whole delegation pipeline — spawn, brief, browser
 * MCP, vision description, evidence folder, summary — and says plainly that it
 * is a smoke test, so the "a short task is not a small task" bar in the brief
 * does not inflate it.
 */
export const HARNESS_TEST_PROJECT = "harness-test";

export const HARNESS_TEST_TASK =
  "Harness self-test — a smoke test of the tooling, not a real feature. "
  + "Make index.html in this folder show the text HARNESS OK, centered, white on #1a1a2e, nothing else. "
  + "Then open it with browser_view_local and confirm the description shows that text. "
  + "Keep it minimal and fast: no polish, no extra features, no sub-agents. "
  + "Report what you built and what the description confirmed.";
