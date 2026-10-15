# harness-contract

ClawBox drives two harnesses it does not own: OpenClaw (an npm package) and
Hermes (NousResearch/hermes-agent). Both move fast, and both reject what they do
not know: an OpenClaw config key the schema lacks fails `openclaw config set`,
a Hermes key outside its validator is refused, a removed flag or RPC method
fails at run time on a box. The `harness-contract` CI check catches that on the
pull request instead.

## The pins

| Harness | Pinned in | Read by |
|---|---|---|
| OpenClaw | `config/openclaw-target.txt` | install.sh, install-x64.sh, gateway-pre-start.sh, the updater (also from the branch it updates to) |
| Hermes | `HERMES_PIN_COMMIT` in `install.sh`, the tag on the comment line above it | install.sh |

`scripts/harness-pins.mjs` is the one reader for tools. The fallbacks that
repeat the OpenClaw version (`OPENCLAW_VERSION` in both installers,
`OPENCLAW_VERSION_FALLBACK` in the updater) and the updater's
`OPENCLAW_STATE_SCHEMA_BY_VERSION` row are held to the pin by
`src/tests/unit/harness-pins.test.ts`.

## What the check proves

Against the pinned OpenClaw package (installed with `--ignore-scripts`, run with
HOME, OPENCLAW_HOME, OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH in a temporary
directory):

- every CLI command and flag ClawBox runs exists (`openclaw <path> --help`);
- every config key ClawBox writes, unsets or reads exists (`openclaw config schema --json`);
- every gateway RPC method ClawBox calls exists (the core's method table, hidden methods included);
- every gateway event ClawBox waits for is one the core sends;
- every plugin hook ClawBox's own plugins register exists;
- the updater's state-schema row for the pin matches the package's `openclaw.schemaVersions.state`;
- install.sh's `OPENCLAW_NODE_ENGINE` matches the package's `engines.node`.

Against the Hermes source at `HERMES_PIN_COMMIT` (one shallow commit; nothing is
installed or executed beyond importing the modules that build its parser,
config validator and web app):

- every `hermes` subcommand and flag ClawBox runs exists in its argparse tree,
  and no `hermes chat` flag is one the gateway-routed chat refuses;
- every key ClawBox writes with `hermes config set` passes Hermes's own
  validator (refused = failure; accepted with a warning = warning);
- every dashboard JSON-RPC method ClawBox sends, and every event it waits for,
  is in the committed OpenRPC contract;
- every dashboard REST or WebSocket route ClawBox calls exists;
- the tag named beside the pin points at the pinned commit (asked when the pin
  is first fetched).

## Where the usage comes from

`scripts/harness-contract/scan.mjs` reads ClawBox's source on every run — so
the list cannot fall behind the code. It follows the calls through which
ClawBox reaches a harness (the CLI wrappers, the config writers, the gateway
and dashboard clients, shell functions that forward to a harness binary, and
wrappers of those), with constants and local argv arrays resolved. Tests are
never read. A call whose command, key or method is computed at run time is not
guessed at: the job prints it under "unchecked" with its file:line.

## When it fails

Each failure names the harness and its pinned version, the item, why, and the
ClawBox file:line that uses it (also as an annotation on the PR diff).

1. Fix the call: use the key, flag or method the pinned harness has.
2. Or, when the failure is right but accepted for now, add an entry to
   `config/harness-contract-allowlist.json` with its category
   (`version-guarded` for a write behind a guard for an older core,
   `known-gap` for a real gap at the pin), a reason, the sites and an expiry
   date. An entry that has expired, or that no longer matches a failure, fails
   the check, so the list cannot outlive its reason.

## Running it

`scripts/harness-contract/run.sh` runs the whole check (Node 24.16 or newer and
Python 3.11 or newer). It keeps the pinned harnesses in
`~/.cache/clawbox-harness-contract` (`HARNESS_CONTRACT_CACHE`), so only the
first run after a pin moves uses the network; CI caches the same paths by pin.
