#!/usr/bin/env bash
# timeout: 4200
# tier: long
# covers: scripts/claude-ds src/lib/coding-context-window.ts
#
# A ClawBox AI coding session on a 1M-window model must COMPACT before the
# provider's hard cap, not die on it (TASK-2203). The field failure: a run on
# `deepseek-v4-pro[1m]` climbed to 1,016,260 tokens without one
# compact_boundary, and the next request was refused with DeepSeek's own 400
# ("This model's maximum context length is 1048576 tokens. However, you
# requested …") — a wording Claude Code does not read as "prompt too long", so
# its own reactive compaction never ran either.
#
# Real model, real proxy, real Claude Code — which is why this is a long-tier
# test: each half below reads about a million tokens of filler.
#
#   1. What the box runs: the Claude Code version, the plan tier, and the
#      environment claude-ds hands Claude Code for a [1m] and a 200k model
#      (a stand-in `claude` first on PATH records it).
#   2. What the proxy really serves behind each model id, asked in 16 tokens.
#      (Its window is in the refusal itself: 1,048,576 for both ids, measured on
#      the first run of this test — a max_tokens past the window is clamped,
#      not refused, so it cannot be asked for free.)
#   3. A scripted claude-ds session on `deepseek-v4-flash[1m]` — the cheap id
#      every plan may use, believed 1M by Claude Code exactly like the Max
#      plan's pro[1m] — reading ~20k-token files until its context passes the
#      cap. It must compact (compact_boundary, trigger auto, above 200k so the
#      climb went past where a 200k window compacts) and finish.
#   4. The same climb as a delegated run through the assistant's routes, on
#      whatever model the plan gives this box. It must complete; on a 1M model
#      its transcript must show a compaction.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

FILES=60
LONG_MODEL='deepseek-v4-flash[1m]'
# The provider's cap, as its 400 states it, and the request Claude Code makes
# on top of the context (max_tokens).
CAP=1048576
DIRECT_SECONDS=1800
RUN_SECONDS=1800

# The analysis both halves share, run on the board over a stream-json log or a
# session transcript: the largest context any request carried, every
# compaction, the context-length refusal if there was one, and the final word.
# shellcheck disable=SC2016  # expanded on the board
ANALYSE='
analyse() {
  python3 - "$1" <<'"'"'PY'"'"'
import json, re, sys
peak, comps, overflow, result = 0, [], None, None
for line in open(sys.argv[1], errors="replace"):
    try:
        e = json.loads(line)
    except Exception:
        continue
    if not isinstance(e, dict):
        continue
    t, sub = e.get("type"), e.get("subtype")
    if t == "assistant":
        m = e.get("message") or {}
        u = m.get("usage") or {}
        ctx = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        peak = max(peak, ctx)
        for b in m.get("content") or []:
            txt = b.get("text") if isinstance(b, dict) else None
            if isinstance(txt, str) and re.search(r"maximum context length is \d+ tokens", txt):
                overflow = txt[:300]
    if t == "system" and sub == "compact_boundary":
        md = e.get("compact_metadata") or e.get("compactMetadata") or {}
        comps.append({"trigger": md.get("trigger"), "pre": md.get("pre_tokens", md.get("preTokens"))})
    if t == "result":
        r = str(e.get("result") or "")
        result = {"is_error": e.get("is_error"), "subtype": sub, "turns": e.get("num_turns"), "text": r[-300:]}
        if re.search(r"maximum context length is \d+ tokens", r):
            overflow = r[:300]
print(json.dumps({"peak": peak, "compactions": comps, "overflow": overflow, "result": result}))
PY
}
'

# ---- 1. what the box runs ------------------------------------------------------

board_runtime >/dev/null
note "runtime: $BOARD_RUNTIME"
# shellcheck disable=SC2016  # expanded on the board
FACTS=$(board '
  export PATH="$HOME/.local/bin:$PATH"
  echo "claude: $(claude --version 2>&1 | head -n1)"
  echo "tier: $(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"clawai_tier\") or \"unset\")" "$REPO/data/config.json" 2>&1)"
  if cmp -s "$HOME/.local/bin/claude-ds" "$REPO/scripts/claude-ds"; then echo "wrapper: the installed claude-ds is the checkout'"'"'s"; else echo "wrapper: the installed claude-ds DIFFERS from the checkout'"'"'s"; fi
  fake=$(mktemp -d)
  printf "#!/bin/sh\nenv | grep -E \"^(ANTHROPIC_MODEL|CLAUDE_CODE_AUTO_COMPACT_WINDOW|CLAUDE_CODE_MAX_OUTPUT_TOKENS|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)=\" | sort\n" > "$fake/claude"
  chmod +x "$fake/claude"
  for m in "deepseek-v4-flash[1m]" deepseek-v4-flash; do
    echo "env for $m: $(cd "$fake" && PATH="$fake:$PATH" CLAUDE_DS_MODEL="$m" claude-ds -p x 2>/dev/null | tr "\n" " ")"
  done
  rm -rf "$fake"
')
while IFS= read -r line; do note "$line"; done <<< "$FACTS"
TIER=$(printf '%s\n' "$FACTS" | sed -n 's/^tier: //p')

# ---- 2. what the proxy serves behind each id ------------------------------------

# The portal token is read HERE, on the board, and handed to curl on stdin as a
# config line — never on a command line, never printed (the `api` rule).
# shellcheck disable=SC2016  # expanded on the board
PROBE=$(board '
  proxy=${CLAWBOX_AI_PROXY_URL:-https://clawbox.com/api/ai}
  # The rule claude-ds applies before it hands the token anywhere.
  case "$proxy" in
    https://*|http://127.0.0.1[:/]*|http://localhost[:/]*) ;;
    *) echo "not asked: the proxy address is neither HTTPS nor loopback"; exit 0 ;;
  esac
  token=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"clawai_token\") or \"\")" "$REPO/data/config.json" 2>/dev/null)
  [ -n "$token" ] || { echo "no ClawBox AI token on this board"; exit 0; }
  for m in deepseek-v4-flash deepseek-v4-pro; do
    body="{\"model\":\"$m\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Say OK.\"}]}"
    out=$(printf "header = \"Authorization: Bearer %s\"\n" "$token" \
      | curl -sS --max-time 60 -K - -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
          --data-binary "$body" "${proxy%/}/anthropic/v1/messages" 2>&1 \
      | python3 -c "import json,sys; raw=sys.stdin.read()
try:
    d=json.loads(raw); print(\"served by\", d.get(\"model\"), \"usage\", json.dumps(d.get(\"usage\") or d.get(\"error\")))
except Exception:
    print(raw[:300].replace(chr(10), \" \"))")
    echo "$m: $out"
  done
')
while IFS= read -r line; do note "proxy — $line"; done <<< "$PROBE"

# Both fixture folders go on every way out, a failed one included.
DIRECT_DIR=
cleanup_and_finish() {
  # shellcheck disable=SC2016  # expanded on the board
  [ -n "$DIRECT_DIR" ] && board 'case "$1" in *..*) ;; /home/clawbox/?*/nano-ci-*) rm -rf -- "$1" ;; esac' "$DIRECT_DIR" >/dev/null 2>&1
  remove_project_dir
  finish
}

if ! fresh_project_dir "-autocompact"; then
  not_ok "could not create $PROJECT_DIR on the board"
  finish
fi
DIRECT_DIR=$PROJECT_DIR

# Filler a model has no reason to act on: ~1,700 lines of call-sign words per
# file, about 20k tokens through Read with its line numbers, each file naming
# the next. Seeded, so every run reads the same bytes.
# shellcheck disable=SC2016  # expanded on the board
MAKE_FILES='
make_files() {
  python3 - "$1" "$2" <<'"'"'PY'"'"'
import random, sys
folder, n = sys.argv[1], int(sys.argv[2])
rng = random.Random(2203)
words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split()
for i in range(1, n + 1):
    lines = [f"File {i:02d} of {n}: filler for a context-window test. Nothing in it needs acting on."]
    lines += [" ".join(rng.choice(words) for _ in range(6)) for _ in range(1700)]
    lines.append(f"END OF FILE {i:02d}." + (f" Next: f{i + 1:02d}.txt" if i < n else " This was the LAST file."))
    with open(f"{folder}/f{i:02d}.txt", "w") as fh:
        fh.write("\n".join(lines) + "\n")
PY
}
'

task_for() {
  printf '%s' "This session tests how the harness copes when the context window fills up, so its ONLY job is to read. Read the files f01.txt to f$(printf '%02d' "$1").txt in the current working folder, in order, with the Read tool: the whole file each time (no offset, no limit), four files per message (four Read calls in one message), never skipping a file and never reading one twice. Do not summarise them, do not run any command, do not write any file, do not use any other tool. If the conversation is compacted, carry on with the next file you have not read yet. When you have read f$(printf '%02d' "$1").txt, reply with exactly: ALL FILES READ"
}

# ---- 3. a scripted claude-ds session on a 1M model -----------------------------

# shellcheck disable=SC2016  # expanded on the board
if ! board "$MAKE_FILES"'
  set -e
  make_files "$1" "$2"
  mkdir -p "$1/.direct"
  cd "$1"
  export PATH="$HOME/.local/bin:$PATH"
  nohup env CLAUDE_DS_MODEL="$3" claude-ds -p --verbose --output-format stream-json \
    --tools Read --allowedTools Read --max-turns 150 "$4" \
    > "$1/.direct/stream.jsonl" 2> "$1/.direct/stderr.log" < /dev/null &
  echo $! > "$1/.direct/pid"
' "$DIRECT_DIR" "$FILES" "$LONG_MODEL" "$(task_for "$FILES")"; then
  not_ok "could not start the scripted claude-ds session in $DIRECT_DIR"
  cleanup_and_finish
fi
ok "scripted claude-ds session started on $LONG_MODEL over $FILES files"

deadline=$(( $(date +%s) + DIRECT_SECONDS ))
while :; do
  # shellcheck disable=SC2016  # expanded on the board
  alive=$(board 'kill -0 "$(cat "$1/.direct/pid")" 2>/dev/null && echo yes || echo no' "$DIRECT_DIR")
  [ "$alive" = no ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    # shellcheck disable=SC2016  # expanded on the board
    board 'kill "$(cat "$1/.direct/pid")" 2>/dev/null' "$DIRECT_DIR" >/dev/null
    note "the scripted session was still going after ${DIRECT_SECONDS}s and was stopped"
    break
  fi
  sleep 30
done

# shellcheck disable=SC2016  # expanded on the board
DIRECT_OUT=$(board "$ANALYSE"'grep -m3 -E "^claude-ds:|unrecognized_model" "$1/.direct/stderr.log"; analyse "$1/.direct/stream.jsonl"' "$DIRECT_DIR")
while IFS= read -r line; do note "scripted session stderr: $line"; done < <(printf '%s\n' "$DIRECT_OUT" | grep -v '^{')
DIRECT=$(printf '%s\n' "$DIRECT_OUT" | grep '^{' | tail -n1)
note "scripted session: $DIRECT"
d_peak=$(printf '%s' "$DIRECT" | jq -r '.peak // 0')
d_auto=$(printf '%s' "$DIRECT" | jq -r '[.compactions[] | select(.trigger == "auto")] | length')
d_first=$(printf '%s' "$DIRECT" | jq -r '[.compactions[] | select(.trigger == "auto") | .pre // 0] | first // 0')
d_overflow=$(printf '%s' "$DIRECT" | jq -r '.overflow // empty')
# Not `// "none"`: jq's alternative treats `false` as missing too.
d_err=$(printf '%s' "$DIRECT" | jq -r 'if .result == null then "none" else (.result.is_error | tostring) end')
d_text=$(printf '%s' "$DIRECT" | jq -r '.result.text // ""')

if [ -n "$d_overflow" ]; then
  not_ok "the scripted session hit the provider's context cap at a peak of $d_peak tokens with $d_auto automatic compaction(s): $d_overflow"
else
  ok "no context-length refusal (peak context $d_peak tokens)"
fi
if [ "$d_auto" -ge 1 ] && [ "$d_first" -gt 200000 ] && [ "$d_first" -lt $(( CAP - 32000 )) ]; then
  ok "compacted automatically at $d_first tokens — past where a 200k window compacts, below the cap less the reply"
else
  not_ok "expected an automatic compaction between 200k and $(( CAP - 32000 )) tokens; saw $d_auto, the first at ${d_first:-none}"
fi
case "$d_err:$d_text" in
  false:*"ALL FILES READ"*) ok "the scripted session carried on after compacting and finished" ;;
  *) not_ok "the scripted session did not finish: is_error=$d_err, last words '$(printf '%s' "$d_text" | tail -c 200 | tr '\n' ' ')'" ;;
esac

# ---- 4. the same climb as a delegated run ---------------------------------------

board_api GET /setup-api/coding-agent/status
if [ "$API_STATUS" != 200 ] || [ "$(api_json '.ready')" != true ]; then
  not_ok "the coding agent cannot start a run here: $(api_error)"
  PROJECT_DIR=
  cleanup_and_finish
fi
# On a 200k model a third of the files already means two compactions.
RUN_FILES=$FILES
[ "$TIER" = pro ] || RUN_FILES=24
PROJECT_DIR=
if ! fresh_project_dir "-autocompact-run"; then
  not_ok "could not create $PROJECT_DIR on the board"
  cleanup_and_finish
fi
# shellcheck disable=SC2016  # expanded on the board
if ! board "$MAKE_FILES"'make_files "$1" "$2" && [ -f "$1/f$(printf %02d "$2").txt" ]' "$PROJECT_DIR" "$RUN_FILES" >/dev/null; then
  not_ok "could not write the $RUN_FILES files into $PROJECT_DIR"
  cleanup_and_finish
fi
if ! start_coding_run "$(task_for "$RUN_FILES")"; then
  not_ok "the run did not start: $(api_error)"
  cleanup_and_finish
fi
ok "run $RUN_ID started over $RUN_FILES files (plan tier: ${TIER:-unknown})"
wait_coding_run "$RUN_SECONDS"
note "run: $(api_json -c '.run | {status, model, tokensUsed, numTurns, error: (.error // "" | .[0:300])}')"
expect_completed
SESSION=$(api_json '.run.sessionId // empty')
if [ -n "$SESSION" ]; then
  # shellcheck disable=SC2016  # expanded on the board
  RUN=$(board "$ANALYSE"'
    f=$(find "$HOME/.claude-ds/projects" -name "$1.jsonl" 2>/dev/null | head -n1)
    [ -n "$f" ] && analyse "$f" || echo "{}"
  ' "$SESSION" | grep '^{' | tail -n1)
  note "run transcript: $RUN"
  r_auto=$(printf '%s' "$RUN" | jq -r '[.compactions[]? | select(.trigger == "auto")] | length')
  r_peak=$(printf '%s' "$RUN" | jq -r '.peak // 0')
  # On a 200k model (any plan below Max) the compactions are the old
  # behaviour, kept; either way a run that read its files compacted.
  if [ "${r_auto:-0}" -ge 1 ]; then ok "the delegated run compacted on plan tier ${TIER:-unknown} ($r_auto time(s), peak $r_peak tokens)"
  else not_ok "the delegated run never compacted on plan tier ${TIER:-unknown} (peak $r_peak tokens)"; fi
else
  not_ok "the run's answer named no session, so its transcript could not be read"
fi

cleanup_and_finish
