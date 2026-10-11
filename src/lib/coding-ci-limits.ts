/**
 * How many times a failing CI is fixed before it is the owner's — the bounds
 * of src/lib/coding-ci.ts, here on their own and with no imports, because the
 * MCP server (mcp/tools/coding-agent.ts) words them too and must not pull the
 * suite reader in with them.
 */

/** "Fix CI" continuations one run's pull request may get, counted along the chain. */
export const MAX_CI_FIX_ATTEMPTS = 2;
/** Rounds of re-offered tasks a team's pull request may get before the team fails on its CI. */
export const MAX_TEAM_CI_ROUNDS = 2;
