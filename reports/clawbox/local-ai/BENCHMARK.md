# Local AI on the box: lean mode, launch settings, E4B and reasoning (2026-10-28)

The chat on the on-device model (Gemma 4 E2B on llama.cpp, OpenClaw edition) answered a
Bulgarian question in Russian, recited its own rules, asked instead of acting and never
called a tool — asked for an HTML app it never called `webapp_create`. This report is the
measurement behind the changes that fix it, and behind the decisions on E4B and reasoning.

## Setup

- **Box:** a lab Jetson Orin Nano 8 GB (7,607 MB RAM shared with the GPU, 12 GB swap),
  JetPack R36.5, OpenClaw edition. The gateway, the web server and the desktop run beside
  the model, as on any box.
- **Harness:** OpenClaw 2026.10.7 (the pinned core). llama.cpp `llama-server` build 10214
  (db7d8b24b), started with the flags of `scripts/start-llamacpp.sh` (`--no-mmproj --jinja
  --n-gpu-layers 99 --reasoning off|on`).
- **Models:** Google's QAT q4_0 GGUFs — `gemma-4-E2B_q4_0-it.gguf` (3.35 GB, the shipped
  default) and `gemma-4-E4B_q4_0-it.gguf` (5.15 GB). The E4B was served under the same
  OpenClaw model id, so nothing else changed between the two.
- **Method:** every task is a real `openclaw agent --agent main` turn on a session of its
  own, through the gateway and ClawBox's local-AI proxy, checked by a script: the reply's
  language by script and marker words (Bulgarian vs Russian: no ы/э/ё, no Russian-only
  words), tool calls from the session transcript (`chat.history`), files and web apps on
  disk. A turn that the cloud fallback answered counts as a failure. One run per task and
  config with OpenClaw's own sampling, so a single-task difference between two configs is
  within run-to-run noise; the systematic differences are the ones called out below.

## The ten tasks

| # | task | passes when |
|---|---|---|
| 1 | "Хей, какво можеш да правиш?" | the reply is Bulgarian (not Russian) |
| 2 | "Make me an HTML app with a dancing crab" | `clawbox__webapp_create` was called and the app on disk is an HTML page with a crab that animates |
| 3 | "Kannst du mir in zwei Sätzen erklären, warum der Himmel blau ist?" | German, and names light scattering |
| 4 | one-sentence summary of a three-sentence news item | English, at most two sentences, keeps "library" and "depot/railway" |
| 5 | "Create a file named shopping-list.txt in your workspace with the text: buy milk" | the file exists with that text |
| 6 | "Read the file bench-secret.txt in your workspace and tell me the code word." | a file tool was used and the reply has the code word |
| 7 | "Запиши във файл todo-bg.txt в работната си папка текста: купи хляб" | the file exists with that text and the reply is not Russian |
| 8 | "Fetch https://example.com and tell me the page title." | a web tool was used and the reply says "Example Domain" |
| 9 | "What is 17 × 23? Reply with just the number." | 391, nothing else |
| 10 | "¿Cuál es la capital de Australia? Responde en una frase." | Spanish, and Canberra |

## Configs

| key | system prompt | tools the model sees | KV cache / window | reasoning |
|---|---|---|---|---|
| baseline | OpenClaw's full prompt (44,837 chars) | 12: core file tools + `tool_search`/`tool_describe`/`tool_call` (OpenClaw's Tool Search hides every other schema) | q4_0 / 131072 | off |
| lean | lean prompt (~1.3k chars) | `read`, `write` + the Tool Search controls, four tools taught as `tool_call` | q4_0 / 131072 | off |
| lean_direct | lean prompt | the six lean tools as direct schemas (Tool Search off) | q4_0 / 131072 | off |
| lean_q8_32k | lean prompt | six, direct | **q8_0 / 32768** | off |
| lean_q8_32k_think | lean prompt | six, direct | q8_0 / 32768 | **on** (server-wide) |
| e4b_lean_q8_32k | lean prompt, **E4B** | six, direct | q8_0 / 32768 | off |

Prompt tokens on the first turn of a session: **13,351** at baseline, **1,229–1,281** in every
lean config (the lean prompt plus the tool schemas).

## Results

Pass/fail and wall time of the whole turn (CLI start to answer).

| # | task | baseline | lean | lean_direct | lean_q8_32k | lean_q8_32k_think | e4b_lean_q8_32k |
|---|---|---|---|---|---|---|---|
| 1 | bg_capabilities | FAIL 26.2s | PASS 18.3s | PASS 11.7s | PASS 19.5s | PASS 26.1s | PASS 15.6s |
| 2 | crab_app | FAIL 11.3s | FAIL 18.3s | PASS 31.7s | PASS 55.8s | PASS 36.7s | PASS 30.9s |
| 3 | de_question | PASS 7.1s | PASS 7.5s | PASS 7.4s | PASS 7.9s | PASS 17.5s | PASS 10.9s |
| 4 | summary | PASS 6.3s | PASS 6.2s | PASS 5.9s | PASS 6.0s | PASS 14.6s | PASS 7.9s |
| 5 | file_write | PASS 7.8s | PASS 6.5s | PASS 6.2s | PASS 6.6s | PASS 12.7s | PASS 8.0s |
| 6 | file_read | PASS 7.0s | PASS 5.9s | PASS 5.9s | PASS 5.7s | PASS 10.5s | PASS 6.2s |
| 7 | bg_file_write | PASS 7.1s | PASS 8.4s | PASS 6.6s | PASS 9.4s | PASS 11.4s | PASS 8.6s |
| 8 | web_fetch | PASS 13.3s | FAIL 5.8s | FAIL 7.0s | FAIL 9.4s | PASS* 21.9s | PASS 9.1s |
| 9 | math_short | FAIL 4.4s | PASS 4.3s | PASS 4.0s | PASS 4.3s | PASS 7.4s | PASS 4.7s |
| 10 | es_question | PASS 4.9s | PASS 5.3s | PASS 5.3s | PASS 5.4s | PASS 12.7s | PASS 7.3s |
| | **pass** | **7/10** | **8/10** | **9/10** | **9/10** | **10/10** | **10/10** |
| | **median / total** | 7.1s / 95s | 6.3s / 86s | 6.4s / 92s | 7.2s / 130s | 13.6s / 172s | 8.3s / 109s |

\* The reply quotes OpenClaw's `<<<EXTERNAL_UNTRUSTED_CONTENT …` wrapper around the page
before the title: a pass by the check, not a good answer.

What the failures were:

- **Baseline 1:** "Привет! Я — персональный ассистент в OpenClaw. Я могу: 1. Работать с
  файлами…" — Russian, and a list of its own capabilities.
- **Baseline 2:** one `tool_search`, then "I cannot directly create a running HTML
  application or a visual asset like a dancing crab."
- **Baseline 9:** "411".
- **Lean 2:** the model wrote a complete crab page but sent it as `tool_call` with no `id`
  (once nested under `args`, once flat), got a validation error, and answered "I created an
  HTML web application with a dancing crab for you." With direct schemas it called
  `clawbox__webapp_create` first time in every config, and the app opened on the desktop.
- **Lean 8 (three configs):** `web_fetch` was called and returned the page, but the model
  said the title "is not explicitly provided in the raw text". Baseline happened to pass it.

A run of the lean prompt on the old launch values also showed why the answer budget matters:
with `maxTokens` 131072 the crab turn generated 8,493 tokens and was still going (~25 tok/s)
when the 600 s agent timeout ended it. At 8192 that turn cannot run away.

## The server: memory, load time, speed

Raw `llama-server` measurements (no OpenClaw), streamed, temperature 0. "MemAvailable"
is the kernel's figure for the whole box with the gateway, web server and desktop running —
the number that decides whether anything else can still start. The page cache makes single
readings noisy; the minimum over the ten agent turns is the operational headroom.

| config | load | MemAvailable after load | min MemAvailable over the 10 turns | TTFT, short prompt | decode | 5,505-token prompt: TTFT / prefill |
|---|---|---|---|---|---|---|
| E2B, q4_0 / 131072 (baseline) | 7.2 s | 2,247 MB | 1,160 MB | 0.20 s | 30.8 tok/s | 5.6 s / 985 tok/s |
| E2B, q8_0 / 32768 | 6.9–17.3 s | 2,091–2,963 MB | 1,496 MB | 0.20 s | 31.2 tok/s | 5.6 s / 985 tok/s |
| E2B, q8_0 / 32768, reasoning on | 8.7 s | 2,012 MB | 1,033 MB | 0.35 s | 31.1 tok/s | 5.7 s / 984 tok/s |
| E4B, q8_0 / 32768 | 15.7 s | **471 MB** | **161 MB** | 0.32 s | **17.9 tok/s** | **9.8 s / 568 tok/s** |

(This llama.cpp build does not log its KV buffer sizes; the system figures above include it.)

**q8_0 KV and a 32768 window cost nothing in speed or answers** — decode, prefill and the
pass rate are the same as q4_0 at 131072 — and in these runs left the box more headroom
(minimum 1,496 MB against 1,160 MB). The lean prompt is ~1.3k tokens and the full OpenClaw prompt
~13.4k, so a 131k window only ever held empty cache; 32k still fits the full prompt with
room to spare (OpenClaw compacts at 75% of the window). The answer budget is 8192 tokens.

## E4B: not the default, not offered

E4B answered a little better (10/10, and the cleanest web-fetch reply) but it does not fit:
471 MB available after loading and **161 MB at its lowest** during the ten turns — far below
the 1 GB of headroom set as the bar for a default.
It is also slower where it shows: decode 17.9 against 31 tok/s, a long prompt 9.8 s to the
first token against 5.6 s. It slipped too: task 7 began "Я записвах…", a Russian pronoun in
a Bulgarian sentence. **E2B stays the default and E4B is not added to the Local AI list.**
(The same conclusion as the earlier bake-off in `src/lib/llamacpp.ts`, with a different
E4B build.)

## Reasoning: off by default, on per request

llama-server honours `chat_template_kwargs.enable_thinking` on every request (same server,
started with `--reasoning off`: 0 reasoning characters without the field, 365–611 with it),
and ClawBox's local-AI proxy already sets it from an OpenAI-style `reasoning_effort`. So the
stack supports reasoning per request, and the trade-off decides only the default:

- **Ten everyday tasks:** 9/10 → 10/10, and the one gained was the weak pass above; median
  turn 7.2 s → 13.6 s, total 130 s → 172 s. Asked for a 256-token story, thinking spent all
  256 tokens on reasoning and wrote no story.
- **Six multi-step questions** (`complex.py`: weekday arithmetic, a train time, counting
  apples, 17 × 23, sorting, an age puzzle), asked directly: 4/6 → 5/6, total 39 s → 90 s.
  Thinking fixed the apple count (21 → 27); both missed the weekday (Monday): off rambled
  1,136 tokens without an answer, on said Tuesday.
- **Through OpenClaw, per request** (the shipped wiring): the apple question at the default
  level ran `thinking=off` in 6.9 s and answered 29; the same question with
  `--thinking high` ran `thinking=high` in 13.6 s and answered 27.

So reasoning stays **off by default** and is **on when a chat or a single message asks for
it**: the OpenClaw row declares binary reasoning and an `off` default for the model, the chat
header offers Off / High for Gemma, and `/think high` turns it on for one message.

## What shipped (and why each part)

- **Lean mode** (`scripts/openclaw-plugins/clawbox-local-lean`): a turn on the llamacpp model
  gets a ~1.3k-character prompt — who it is, reply in the language of the user's last message
  (named when it can be told, "Bulgarian (not Russian)"), act instead of asking, retry a tool
  error instead of claiming success, keep it short — and six tools: `read`, `write`,
  `clawbox__webapp_create`, `web_fetch`, `web_search`, `clawbox__browser_open`. Through the
  core's `before_prompt_build` hook, keyed on the attempt's own provider, so any cloud turn —
  a cloud fallback after a local failure included — keeps OpenClaw's full prompt and tools.
- **Tool Search follows the primary**: off while the primary is the on-device model, as
  OpenClaw ships it otherwise. The core's switch is global, and the 2B model cannot drive
  `tool_call` (task 2 above).
- **Launch:** `LLAMACPP_CONTEXT_WINDOW` 32768, `LLAMACPP_CACHE_TYPE_K/V` q8_0,
  `LLAMACPP_MAX_TOKENS` 8192; the OpenClaw row is told the same window. Fielded boxes are
  migrated off exactly the old shipped values.
- **Reasoning:** off by default, per request as above.
