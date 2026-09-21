# Hermes reasoning levels, end to end

What the customer picks, what reaches `hermes --reasoning`, and what the model
actually does with it. Every row here was measured on a device; the code that
encodes it is `src/lib/hermes-reasoning.ts` (vocabulary),
`src/lib/local-ai-thinking.ts` (the two on-device translations) and
`src/app/setup-api/hermes/chat/route.ts` (the per-turn clamp).

## The vocabulary

`hermes --reasoning` accepts eight words: `none, minimal, low, medium, high,
xhigh, max, ultra`. ClawBox **accepts** all eight from a client and **offers**
seven — see "Ultra" below.

## The mapping

| Picked | Cloud provider | `clawlocal` on llama.cpp | `clawlocal` on Ollama |
|---|---|---|---|
| `none` | `none` | `minimal` → thinking **off** | `none` → thinking **off** |
| `minimal` | `minimal` | `minimal` → thinking **off** | `none` → thinking **off** |
| `low`–`xhigh` | as picked | `minimal` → thinking **off** ‡ | `none` → thinking **off** ‡ |
| `max` | `max` | `max` → thinking **on** | `max` → thinking **on** |
| `ultra` | `max` | `max` → thinking **on** | `max` → thinking **on** |

‡ The on-device pickers only ever offer the two ends, so a middle level reaches
the clamp only from a stale client or from a preference saved while a cloud
provider was selected. `clampReasoningForProvider` walks *down* to the nearest
allowed level — dropping effort is the safe direction, raising it silently is
not — and on a two-state provider the nearest level below `low` is the OFF end.

The on-device model has **two** states, not eight. That is not a simplification:
`--reasoning-budget` is a llama.cpp *launch* flag and is not honoured per
request (budget 64 produced 371 reasoning chars, budget 0 produced 518 — noise,
not enforcement), so a graded Low/Medium/High would be three settings that all
do the same thing. The picker shows "Thinking off" / "Thinking on".

## Why the two on-device backends disagree about "off"

**llama.cpp ignores `reasoning_effort` entirely.** Verified against the shipped
binary: sending it produced a byte-identical response to sending nothing, and an
invented field name also returns HTTP 200. The field that *is* read is
`chat_template_kwargs.enable_thinking` — a non-boolean value returns HTTP 400,
which is how we know it is read. The proxy therefore deletes `reasoning_effort`
and sets that boolean instead. `minimal` is the off word because this switch
controls thinking, not the answer, and `none` reads as "no reasoning at all" in
other providers' pickers.

**Ollama reads `reasoning_effort` and validates it against the model.** Measured
on Ollama 0.32.15 with `qwen2.5:0.5b`, whose `/api/show` capabilities are
`["completion","tools"]`:

```
reasoning_effort=none            → HTTP 200
reasoning_effort=minimal         → HTTP 400  "qwen2.5:0.5b" does not support thinking
reasoning_effort=low|medium|high|max|ultra → HTTP 400, same message
(no reasoning_effort field)      → HTTP 200
reasoning_effort=banana-nonsense → HTTP 400  invalid reasoning value: … (must be
                                   "minimal","low","medium","high","xhigh",
                                   "ultra","max","none")
```

The last line is the important one: Ollama knows the **same eight words**, so
the 400 above is a *capability* check, not a spelling one. Hence two rules:

1. Ollama's off word is `none` — the only value a model without the `thinking`
   capability accepts.
2. The proxy **drops** `reasoning_effort` when `/api/show` reports no `thinking`
   capability, so the ON end cannot fail the turn either. A failed probe leaves
   the body untouched: if Ollama cannot answer `/api/show` it will not answer
   the completion either, and inventing a value from ignorance is the only way
   to break a turn that would otherwise work.

## Ultra

`ultra` is Hermes-internal ladder vocabulary. Its own
`agent/reasoning_effort.py` says so — "no provider wire accepts it verbatim
anywhere" — and `clamp_effort("ultra")` returns `"max"` for every
OpenAI-compatible wire, which is the wire ClawBox registers the local provider
on (`api_mode: "openai"`). ClawBox AI additionally answers the literal word with
`HTTP 400 … reasoning_effort: unknown`.

So Ultra is not a level: it is Max with a worse failure mode. It is no longer
offered in any picker, and a client that still sends it (a saved preference from
before) gets the Max turn it would have got anyway rather than a 400.

## The slim profile for small on-device models

A Hermes turn ships a fixed preamble before the customer's first word:

| Component | Size |
|---|---|
| system prompt text | 22,565 chars |
| skills index | 7,703 chars |
| user profile | 204 chars |
| built-in tool schemas | 19 tools / 56,275 B |
| ClawBox MCP tool schemas | 42 tools / 26,358 B |
| **total** | **61 tools / ~113 KB** |

(Measured with `hermes prompt-size --platform cli --json` plus a live
`tools/list` over stdio. The tool *schemas*, not the prose, are the bulk.)

Against a 2–4B model that is most of the budget, and it shows: simple questions
come back as tool-call preamble instead of answers. When a turn runs on the
on-device provider with a small model (≤ 8B, or a context window ≤ 16k — see
`src/lib/local-model-profile.ts`), ClawBox narrows it on both sides:

- **Built-ins**: `hermes chat -t web,memory,file,terminal`. `-t` is a whitelist
  (`enabled_toolsets`, "Only enable tools from these toolsets"), and MCP-server
  tools are merged separately, so the ClawBox device tools are unaffected. What
  goes is the agentic scaffolding a small model cannot drive: `computer_use`
  (10.7 KB on its own), `session_search`, `delegation`, `clarify`,
  `code_execution`, `todo`, `tts`, vision, image generation, cron.
- **ClawBox MCP** (opt-in, `CLAWBOX_MCP_PROFILE=auto`): the `core` profile. The
  MCP server reads the device's configured default provider/model at startup and picks it
  (`mcp/lib/profile.ts`). Measured off-device: 38 tools / 22.4 KB → 14 tools /
  8.2 KB of `tools/list`. Under `auto` the MCP instruction stub also switches to
  its short form, which drops the two paragraphs about browser tools that `core`
  does not register anyway and adds the one instruction the whole profile exists
  for — answer the question, do not narrate a tool plan.

Switching back to a cloud provider restores everything on the next turn; nothing
is persisted.

### Why the MCP half is opt-in and the built-in half is not

The two halves see different things, and only one of them can see the turn.

The chat route narrows built-ins from the **per-turn** provider — the chat
header's `--provider`/`-m` override for *this* request. The MCP server is a
separate process and can only read the **persisted** pairing
(`hermes config get model.provider`), because the header override is
client-local: `ChatPopup` writes localStorage and puts the pair in the POST
body, and only Settings ever POSTs `/setup-api/hermes/models`.

Having the chat route export `CLAWBOX_MCP_PROFILE` for the turn does not bridge
that gap. Hermes builds the stdio child's environment with `_build_safe_env`
(`tools/mcp_tool.py`), which does **not** inherit `os.environ` — it copies an
allowlist (`_SAFE_ENV_KEYS`), `XDG_*`, secret-source variables, and the `env:`
block from `~/.hermes/config.yaml`. A ClawBox-specific variable is filtered out
before the server starts.

So with `auto` on, a device whose persisted provider is the on-device one would
drop a chat-header-selected **cloud** turn from 38 tools to 14 — tools that work
today. Default `full` keeps that from happening; `auto` exists so the on-device
bake-off can measure the win. Closing the gap needs a way to carry per-turn
context to an MCP child, which is a Hermes-side change.

Note also that `core` does not register `browser_open/navigate/screenshot/close`
while `scripts/register-mcp.sh` disables Hermes' own `browser` toolset on every
boot, so a device running `auto` on the local model currently has no way to open
a page. That is the first thing to settle before `auto` becomes the default.

### Escape hatches

| Variable | Effect |
|---|---|
| `CLAWBOX_SMALL_MODEL_PROFILE=off` | Never slim, anywhere. |
| `CLAWBOX_SMALL_MODEL_TOOLSETS` | Comma-separated replacement for the built-in list. |
| `CLAWBOX_MCP_PROFILE=core\|full` | Pins the MCP tool set regardless of model. |
| `CLAWBOX_MCP_PROFILE=auto` | Opts the MCP tool set into following the model. |
