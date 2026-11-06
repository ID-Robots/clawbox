/**
 * The canned smoke run the owner can ask for, from the two places that offer
 * it: the "Test in the chat" owner tool on the Coding Agent's settings face,
 * and the last step of the setup wizard ("Try it in the chat").
 *
 * Since the 2026-10-30 redesign neither place starts the run itself: both
 * hand `buildHarnessTestPrompt()` (ui-events.ts) to the chat, and the
 * assistant makes the scratch folder and calls `coding_agent_run` — so the
 * first run appears as a card in the chat, like every other run. The
 * `startHarnessTest` fetcher that posted to `browse` and `run` from the app
 * went with that; what stays here is the two facts both callers and the
 * app's listing agree on.
 *
 * It lives here rather than in a component because the wizard cannot import
 * the app that renders it, and it is not in `@/lib/coding-agent` because that
 * module reaches for `fs` and is server-only.
 */

/** The scratch folder's bare name, inside the owner's default project folder.
 *  The app's listing hides a run in it (`listProjects` skips it too). */
export const HARNESS_TEST_PROJECT = "harness-test";

/**
 * The task exercises the whole delegation pipeline — spawn, brief, browser
 * MCP, vision description, evidence folder, summary — and says plainly that it
 * is a smoke test, so the "a short task is not a small task" bar in the brief
 * does not inflate it.
 */
export const HARNESS_TEST_TASK =
  "Harness self-test — a smoke test of the tooling, not a real feature. "
  + "Make index.html in this folder show the text HARNESS OK, centered, white on #1a1a2e, nothing else. "
  + "Then open it with browser_view_local and confirm the description shows that text. "
  + "Keep it minimal and fast: no polish, no extra features, no sub-agents. "
  + "Report what you built and what the description confirmed.";
