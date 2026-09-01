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

/**
 * Start the harness self-test in the owner's OWN project folder.
 *
 * It used to be scaffolded as a code project under `data/code-projects/`,
 * which is a ClawBox-internal directory the owner never browses — so the one
 * run they are invited to start landed somewhere they could not find, and it
 * could never exercise the pull-request flow, which works on real project
 * folders. Now it is a folder inside the default project folder they chose in
 * the wizard, created the same way the folder picker creates one.
 *
 * `directory` is passed as a BARE NAME on purpose: the run resolver reads that
 * as "a folder inside the owner's default project folder", which is exactly
 * this, and keeps the default as the single place that decides where "inside"
 * is.
 */
export async function startHarnessTest(defaultDirectory: string | null): Promise<
  { ok: true; runId: string | null } | { ok: false; error: string }
> {
  if (!defaultDirectory) {
    return { ok: false, error: "Choose a project folder first." };
  }
  try {
    // 409 means it is already there, which is the normal case after the first
    // run — anything else is a real refusal worth showing.
    const made = await fetch("/setup-api/coding-agent/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: defaultDirectory, name: HARNESS_TEST_PROJECT }),
    });
    if (!made.ok && made.status !== 409) {
      const out = (await made.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: out?.error || "Could not create the test folder." };
    }
    const res = await fetch("/setup-api/coding-agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: HARNESS_TEST_PROJECT, task: HARNESS_TEST_TASK }),
    });
    if (!res.ok) {
      const out = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: out?.error || "Could not start the test run." };
    }
    // The id, so the caller can open the live view on the run it just started.
    const started = (await res.json().catch(() => null)) as { run?: { id?: string } } | null;
    return { ok: true, runId: started?.run?.id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not start the test run." };
  }
}
