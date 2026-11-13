#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/stt-endpoint.ts src/lib/stt-preference.ts src/lib/stt-channel.ts src/app/setup-api/chat/transcribe/route.ts src/app/setup-api/stt/endpoint/route.ts scripts/stt-endpoint-client.py src/lib/hermes-tts.ts src/lib/voice-box.ts scripts/gateway-pre-start.sh
#
# Speech local-only (TASK-2501 PR-D), on the runtime the board runs.
#
# A mock OpenAI-compatible speech-to-text server on the board (127.0.0.1 only,
# it answers one fixed sentence and logs the model of every request) stands in
# for the owner's own speech server. The local-only AI lock
# (`ai_cloud_lock: true` in data/config.json) is put on for the test's length.
#   1. mic dictation: the server is saved through Settings' route as the
#      owner, and a recording posted to /setup-api/chat/transcribe is
#      transcribed BY it (engine "endpoint", the mock logs the request);
#   2. channel voice notes (OpenClaw): `tools.media` holds the server's CLI row
#      and no ClawBox AI row or endpoint, and `openclaw infer audio transcribe`
#      — the media-understanding path a Telegram voice note takes — reaches
#      the mock;
#   3. a spoken reply: POST /setup-api/tts/speak answers audio from the box's
#      own voice (Kokoro); on Hermes the factory `edge` (Microsoft's cloud) is
#      set first and must have been replaced by `clawbox-local`; on OpenClaw no
#      ClawBox AI cloud voice entry is left in openclaw.json;
#   4. the server stopped: the recording is refused with `cloud_ai_locked`,
#      through the running server and in-process with every fetch recorded,
#      and not one request goes anywhere but the stopped server.
# Every key, the channel list, Hermes' voice selection and the cloud voice
# entry are put back as they were on any way out, and the mock is stopped.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

RUNTIME=$(board_runtime)
note "runtime: $RUNTIME"

# The in-process leg: the route itself, imported from the checkout with bun,
# every fetch recorded. One JSON line, the last line of the answer.
# shellcheck disable=SC2016  # JavaScript, not shell
INPROC='
(async () => {
  const R = process.cwd();
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => { urls.push(String(typeof input === "string" ? input : input.url)); return realFetch(input, init); };
  const out = {};
  try {
    const fs = await import("fs");
    const { NextRequest } = await import("next/server");
    const { POST } = await import(R + "/src/app/setup-api/chat/transcribe/route.ts");
    const form = new FormData();
    form.set("file", new Blob([fs.readFileSync(process.argv[1])], { type: "audio/wav" }), "voice.wav");
    const res = await POST(new NextRequest("http://127.0.0.1/setup-api/chat/transcribe", { method: "POST", body: form }));
    const body = await res.json().catch(() => null);
    out.status = res.status;
    out.code = body && body.code || null;
    out.error = body && body.error || null;
    out.urls = urls;
  } catch (err) {
    out.crash = String((err && err.stack) || err).split("\n").slice(0, 4).join(" | ");
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("INPROC " + JSON.stringify(out));
  process.exit(0);
})();
'

# shellcheck disable=SC2016  # expanded on the board
RAW=$(board '
cd "$REPO" || exit 1
RUNTIME=$1
INPROC_JS=$2
WORK=$(mktemp -d)
PORT=18931
MOCK_PID=
say() { printf "R %s\n" "$1"; }

cookie() {
  node -e "const fs = require(\"fs\"), crypto = require(\"crypto\");
    const secret = fs.readFileSync(process.argv[1], \"utf8\").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1200, gen })).toString(\"base64url\");
    process.stdout.write(payload + \".\" + crypto.createHmac(\"sha256\", secret).update(payload).digest(\"hex\"));
  " "$REPO/data/.session-secret" "$REPO/data/config.json" 2>/dev/null
}
# A recording posted as the browser posts it; the status, then the body.
mic() {
  local out code
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$(cookie)" \
    | curl -sS -o "$out" -w "%{http_code}" -X POST --max-time 200 -F "file=@$WORK/voice.wav;type=audio/wav" -K - "$DASHBOARD/setup-api/chat/transcribe" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}
# The board has no jq: nj EXPR reads JSON on stdin and prints EXPR of it (v)
# as JSON; njs prints stdin as one JSON string.
nj() { node -e "let s=\"\";process.stdin.on(\"data\",(d)=>s+=d).on(\"end\",()=>{let v=null;try{v=JSON.parse(s)}catch{}let r=null;try{r=(new Function(\"v\",\"return (\"+process.argv[1]+\")\"))(v)}catch{}process.stdout.write(JSON.stringify(r===undefined?null:r))})" "$1"; }
# njc EXPR: EXPR of the JSON on stdin, printed with its keys sorted, so two
# reads of one config compare equal whatever order a writer left them in.
njc() { node -e "let s=\"\";process.stdin.on(\"data\",(d)=>s+=d).on(\"end\",()=>{let v=null;try{v=JSON.parse(s)}catch{}let r=null;try{r=(new Function(\"v\",\"return (\"+process.argv[1]+\")\"))(v)}catch{}const c=(x)=>Array.isArray(x)?x.map(c):(x&&typeof x===\"object\")?Object.fromEntries(Object.keys(x).sort().map((k)=>[k,c(x[k])])):x;process.stdout.write(JSON.stringify(c(r===undefined?null:r)))})" "$1"; }
njs() { node -e "let s=\"\";process.stdin.on(\"data\",(d)=>s+=d).on(\"end\",()=>process.stdout.write(JSON.stringify(s)))"; }
mock_count() { [ -f "$WORK/mock.log" ] && wc -l < "$WORK/mock.log" | tr -d " " || echo 0; }

# The keys this test may change, saved strictly and put back exactly.
keys() {
  node -e "
    const fs = require(\"fs\");
    const [cfgPath, savedPath, mode] = process.argv.slice(1);
    const read = () => { const c = JSON.parse(fs.readFileSync(cfgPath, \"utf8\")); if (!c || typeof c !== \"object\" || Array.isArray(c)) throw new Error(\"not an object\"); return c; };
    const write = (c) => { const t = cfgPath + \".nano-tmp\"; fs.writeFileSync(t, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(t, cfgPath); };
    const KEYS = [\"ai_cloud_lock\", \"stt_primary\", \"stt_endpoint\", \"stt_choice_source\", \"voice_auto_reply\"];
    let c;
    try { c = read(); } catch (err) { console.log(\"CONFIG_UNREADABLE \" + (err && err.message)); process.exit(0); }
    if (mode === \"save\") {
      fs.writeFileSync(savedPath, JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(c, k) ? c[k] : null]))));
      console.log(\"KEYS_SAVED\");
    } else if (mode === \"lock\") {
      // The lock, and spoken replies on so the reply leg has a reply to speak.
      c.ai_cloud_lock = true; c.voice_auto_reply = true; write(c);
      if (read().ai_cloud_lock === true) console.log(\"LOCK_SET\");
    } else if (mode === \"check\") {
      const before = JSON.parse(fs.readFileSync(savedPath, \"utf8\"));
      const same = KEYS.every((k) => JSON.stringify(before[k]) === JSON.stringify(Object.prototype.hasOwnProperty.call(c, k) ? c[k] : null));
      console.log(same ? \"KEYS_SAME\" : \"KEYS_DIFFER\");
    } else {
      let before = null;
      try { before = JSON.parse(fs.readFileSync(savedPath, \"utf8\")); } catch {}
      if (!before) process.exit(0);
      for (const k of KEYS) { if (before[k] === null || before[k] === undefined) delete c[k]; else c[k] = before[k]; }
      write(c);
      console.log(\"KEYS_RESTORED\");
    }
  " data/config.json "$WORK/saved.json" "$1"
}
# openclaw.json speech blocks, as JSON: tools.media and both tts homes.
oc_speech() {
  node -e "
    const c = JSON.parse(require(\"fs\").readFileSync(process.env.HOME + \"/.openclaw/openclaw.json\", \"utf8\"));
    console.log(JSON.stringify({ media: (c.tools && c.tools.media) ?? null, tts: c.tts ?? null, legacyTts: (c.messages && c.messages.tts) ?? null }));
  " 2>/dev/null
}
hermes_provider() {
  timeout 60 bun -e "
    const m = await import(process.cwd() + \"/src/lib/hermes-tts.ts\");
    const v = await m.readHermesVoice();
    console.log(\"PROVIDER \" + JSON.stringify(v.provider));
  " 2>/dev/null | sed -n \"s/^PROVIDER //p\" | tail -n 1
}
hermes_set_provider() {
  timeout 60 bun -e "
    const m = await import(process.cwd() + \"/src/lib/hermes-tts.ts\");
    await m.restoreHermesProviderId(JSON.parse(process.argv[1]));
    console.log(\"SET\");
  " "$1" 2>/dev/null | tail -n 1
}
restart_gateway() {
  timeout 200 bun -e "
    const m = await import(process.cwd() + \"/src/lib/openclaw-config.ts\");
    await m.restartGateway();
    console.log(\"RESTARTED\");
  " 2>&1 | tail -n 1
}

KEY_EXISTED=0
[ -f data/.stt-endpoint-key ] && { KEY_EXISTED=1; cp -p data/.stt-endpoint-key "$WORK/key"; }
# Hermes'"'"' voice markers: whatever was there before is put back, and only that.
MARKERS="$HOME/.hermes/config.yaml.clawbox-voice-lock.json $HOME/.hermes/config.yaml.clawbox-voice-standdown.json"
mkdir -p "$WORK/markers"
for m in $MARKERS; do [ -f "$m" ] && cp -p "$m" "$WORK/markers/"; done
cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  keys restore
  if [ "$KEY_EXISTED" = 1 ]; then cp -p "$WORK/key" data/.stt-endpoint-key; else rm -f data/.stt-endpoint-key; fi
  if [ "$RUNTIME" = openclaw ]; then
    local now media
    now=$(oc_speech)
    media=$(printf "%s" "$BEFORE_OC" | nj "v && v.media")
    if [ "$(printf "%s" "$now" | nj "v && v.media")" != "$media" ]; then
      if [ "$media" = null ]; then openclaw config unset tools.media >/dev/null 2>&1; else openclaw config set tools.media "$media" --json >/dev/null 2>&1; fi
      say "{\"restored\":\"tools.media\"}"
    fi
    # The cloud voice entry the lock withdrew comes back at the next gateway
    # start, now that the lock is off again.
    if [ "$(oc_speech | nj "v && [v.tts, v.legacyTts]")" != "$(printf "%s" "$BEFORE_OC" | nj "v && [v.tts, v.legacyTts]")" ]; then
      say "{\"restartForTts\":$(restart_gateway | njs)}"
    fi
    local after differs="" part
    after=$(oc_speech)
    for part in media tts legacyTts; do
      [ "$(printf "%s" "$after" | njc "v && v.$part")" = "$(printf "%s" "$BEFORE_OC" | njc "v && v.$part")" ] || differs="$differs $part"
    done
    say "{\"restoredSame\":$([ -z "$differs" ] && echo true || echo false),\"differs\":$(printf "%s" "$differs" | njs),\"heldLeft\":$([ -e data/.tts-local-only-held.json ] && echo true || echo false),\"audioMarkLeft\":$([ -e data/.channel-audio-lock-off ] && echo true || echo false)}"
  else
    [ "$(hermes_provider)" != "$BEFORE_PROVIDER" ] && hermes_set_provider "$BEFORE_PROVIDER" >/dev/null
    for m in $MARKERS; do
      if [ -f "$WORK/markers/$(basename "$m")" ]; then cp -p "$WORK/markers/$(basename "$m")" "$m"; else rm -f "$m"; fi
    done
    say "{\"restoredProvider\":$([ "$(hermes_provider)" = "$BEFORE_PROVIDER" ] && echo true || echo false)}"
  fi
  say "{\"keys\":\"$(keys check)\"}"
  rm -rf "$WORK"
}
keys save | grep -q KEYS_SAVED || { echo "CONFIG_UNREADABLE"; exit 0; }
# What is put back has to have been read: nothing is changed over a read that failed.
if [ "$RUNTIME" = openclaw ]; then
  BEFORE_OC=$(oc_speech)
  [ "$(printf "%s" "$BEFORE_OC" | nj "v !== null && typeof v === \"object\"")" = true ] || { echo "CONFIG_UNREADABLE openclaw.json"; exit 0; }
else
  BEFORE_PROVIDER=$(hermes_provider)
  [ -n "$BEFORE_PROVIDER" ] || { echo "CONFIG_UNREADABLE hermes voice"; exit 0; }
fi
trap cleanup EXIT

# The owner'"'"'s speech server, mocked: 127.0.0.1 only, one fixed sentence.
node -e "
  const http = require(\"http\"), fs = require(\"fs\");
  const log = process.argv[1];
  http.createServer((req, res) => {
    const chunks = [];
    req.on(\"data\", (c) => chunks.push(c));
    req.on(\"end\", () => {
      if (req.method === \"GET\" && req.url === \"/v1/models\") { res.writeHead(200, { \"content-type\": \"application/json\" }); return res.end(JSON.stringify({ data: [{ id: \"mock-asr\" }] })); }
      if (req.method === \"POST\" && req.url === \"/v1/audio/transcriptions\") {
        const body = Buffer.concat(chunks).toString(\"latin1\");
        const model = (/name=\"model\"\r\n\r\n([^\r]*)/.exec(body) || [])[1] || \"\";
        fs.appendFileSync(log, JSON.stringify({ model, bytes: body.length, auth: Boolean(req.headers.authorization) }) + \"\n\");
        res.writeHead(200, { \"content-type\": \"application/json\" });
        return res.end(JSON.stringify({ text: \"The harbour lantern turns amber at quarter past four.\" }));
      }
      res.writeHead(404); res.end();
    });
  }).listen(Number(process.argv[2]), \"127.0.0.1\");
" "$WORK/mock.log" "$PORT" &
MOCK_PID=$!
python3 - "$WORK/voice.wav" <<PY
import math, struct, sys, wave
w = wave.open(sys.argv[1], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000)))
w.close()
PY
sleep 1

keys lock
# 1. Save the server as the owner, then dictate.
SAVE=$(owner_api POST /setup-api/stt/endpoint "{\"baseUrl\":\"http://127.0.0.1:$PORT/v1\",\"model\":\"mock-asr\"}")
say "{\"save\":{\"status\":\"$(printf "%s" "$SAVE" | head -n1)\",\"body\":$(printf "%s" "$SAVE" | tail -n +2 | nj "v && {ok: v.ok, configured: v.configured, baseUrl: v.baseUrl, model: v.model, apiKeySet: v.apiKeySet, warning: v.warning, code: v.code, error: v.error}")}}"
STT=$(owner_api GET /setup-api/stt)
say "{\"stt\":$(printf "%s" "$STT" | tail -n +2 | nj "v && {primary: v.primary, localOnly: v.localOnly, chain: v.chain, cloud: v.engines && v.engines.cloud, channels: v.channels && v.channels.chain}")}"
[ "$RUNTIME" = openclaw ] && sleep 20
N0=$(mock_count)
MIC=$(mic)
say "{\"mic\":{\"status\":\"$(printf "%s" "$MIC" | head -n1)\",\"body\":$(printf "%s" "$MIC" | tail -n +2 | nj v),\"mockRequests\":$(( $(mock_count) - N0 )),\"mockModel\":$(tail -n 1 "$WORK/mock.log" 2>/dev/null | nj "v && v.model")}}"

# 2. Channel voice notes (OpenClaw): the list, and the media-understanding path.
if [ "$RUNTIME" = openclaw ]; then
  say "{\"channelConfig\":$(oc_speech | nj "v && {audio: v.media && v.media.audio, models: ((v.media && v.media.models) || []).filter((m) => (m.capabilities || []).includes(String.fromCharCode(97,117,100,105,111))).map((m) => ({type: m.type, args: m.args, provider: m.provider}))}")}"
  N0=$(mock_count)
  INFER=$(timeout 180 openclaw infer audio transcribe --file "$WORK/voice.wav" --json 2>&1 | tail -n 40)
  say "{\"channel\":{\"mockRequests\":$(( $(mock_count) - N0 )),\"heard\":$(printf "%s" "$INFER" | grep -c "harbour lantern"),\"tail\":$(printf "%s" "$INFER" | tail -n 3 | head -c 400 | njs)}}"
fi

# 3. A spoken reply from the box'"'"'s own voice.
if [ "$RUNTIME" = hermes ]; then
  hermes_set_provider "\"edge\"" >/dev/null
  say "{\"hermesBefore\":$(hermes_provider)}"
fi
HDR=$(mktemp)
SPK=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\nheader = \"Content-Type: application/json\"\n" "$(cookie)" \
  | curl -sS -D "$HDR" -o "$WORK/reply.bin" -w "%{http_code}" -X POST --max-time 200 --data-binary "{\"text\":\"Spoken by this box alone.\"}" -K - "$DASHBOARD/setup-api/tts/speak" 2>/dev/null)
ENGINE=$(grep -i "^x-clawbox-voice-engine:" "$HDR" | tr -d "\r" | awk "{print \$2}")
CTYPE=$(grep -i "^content-type:" "$HDR" | tr -d "\r" | awk "{print \$2}")
say "{\"speak\":{\"status\":\"${SPK:-000}\",\"engine\":$(printf "%s" "$ENGINE" | njs),\"type\":$(printf "%s" "$CTYPE" | njs),\"bytes\":$(stat -c %s "$WORK/reply.bin" 2>/dev/null || echo 0),\"error\":$(head -c 300 "$WORK/reply.bin" | tr -cd "[:print:]" | njs)}}"
rm -f "$HDR"
if [ "$RUNTIME" = hermes ]; then
  say "{\"hermesAfter\":$(hermes_provider)}"
else
  say "{\"ttsCloudEntry\":$(oc_speech | nj "v && [v.tts && v.tts.providers && v.tts.providers.openai, v.legacyTts && v.legacyTts.providers && v.legacyTts.providers.openai].filter(Boolean).map((e) => ({baseUrl: e.baseUrl, managed: e.clawboxManaged}))")}"
fi

# 4. The server stopped: refused, with the reason, and no cloud leg.
kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; MOCK_PID=
MIC=$(mic)
say "{\"stopped\":{\"status\":\"$(printf "%s" "$MIC" | head -n1)\",\"body\":$(printf "%s" "$MIC" | tail -n +2 | nj v)}}"
timeout 200 bun -e "$INPROC_JS" "$WORK/voice.wav" 2>&1 | sed -n "s/^INPROC /R {\"inproc\":/p" | sed "s/\$/}/" | tail -n 1
if [ "$RUNTIME" = openclaw ]; then
  INFER=$(timeout 180 openclaw infer audio transcribe --file "$WORK/voice.wav" --json 2>&1); RC=$?
  # Any transcript at all — not only the mock'"'"'s sentence — would be another
  # engine answering: the stopped server'"'"'s row is the only one listed.
  say "{\"channelStopped\":{\"rc\":$RC,\"heard\":$(printf "%s" "$INFER" | grep -c "harbour lantern"),\"anyText\":$(printf "%s" "$INFER" | grep -cE "\"(text|transcript)\"[[:space:]]*:[[:space:]]*\"[^\"]"),\"tail\":$(printf "%s" "$INFER" | tail -n 3 | head -c 300 | njs)}}"
fi
# Control: the same stopped server with the lock lifted — the chain the box
# always had, so a box holding a ClawBox AI credential shows its cloud leg here.
node -e "const fs=require(\"fs\");const p=\"data/config.json\";const c=JSON.parse(fs.readFileSync(p,\"utf8\"));c.ai_cloud_lock=false;const t=p+\".nano-tmp\";fs.writeFileSync(t,JSON.stringify(c,null,2),{mode:0o600});fs.renameSync(t,p);"
timeout 200 bun -e "$INPROC_JS" "$WORK/voice.wav" 2>&1 | sed -n "s/^INPROC /R {\"control\":/p" | sed "s/\$/}/" | tail -n 1
' "$RUNTIME" "$INPROC")

note "raw: $(printf '%s' "$RAW" | tail -n 30 | head -c 6000)"
if printf '%s\n' "$RAW" | grep -q 'CONFIG_UNREADABLE'; then
  not_ok "the board's settings could not be read ($(printf '%s\n' "$RAW" | grep -m1 'CONFIG_UNREADABLE')); nothing was changed"
  finish
fi
if ! printf '%s\n' "$RAW" | grep -qx 'LOCK_SET'; then
  not_ok "the local-only AI lock could not be put on in data/config.json"
  finish
fi
# The last R line that carries the expression's top-level key, read with it.
r() {
  local key=${1#.}
  key=${key%%[.| ]*}
  # `select(. != null)`, not `// empty`: a false is an answer, and `// empty` drops it.
  printf '%s\n' "$RAW" | sed -n 's/^R //p' | jq -rs --arg k "$key" "map(select(type == \"object\" and has(\$k))) | last | ($1) | select(. != null)" 2>/dev/null
}

# 1. Mic dictation through the owner's server.
if [ "$(r '.save.status')" = 200 ] && [ "$(r '.save.body.configured')" = true ]; then
  ok "the owner's speech server was saved through Settings' route ($(r '.save.body.baseUrl'), model $(r '.save.body.model'))"
else
  not_ok "the speech server could not be saved: $(r '.save | tojson')"
fi
if [ "$(r '.stt.localOnly')" = true ] && [ "$(r '.stt.primary')" = endpoint ] && [ "$(r '.stt.chain | tojson')" = '["endpoint"]' ]; then
  ok "under the lock the transcription chain is the owner's server alone ($(r '.stt | tojson'))"
else
  not_ok "the transcription settings under the lock: $(r '.stt | tojson')"
fi
if [ "$(r '.mic.status')" = 200 ] && [ "$(r '.mic.body.engine')" = endpoint ] && [ "$(r '.mic.mockRequests')" -ge 1 ] 2>/dev/null && [ "$(r '.mic.mockModel')" = mock-asr ]; then
  ok "mic dictation was transcribed by the owner's server: \"$(r '.mic.body.text')\" (engine endpoint, the server logged model $(r '.mic.mockModel'))"
else
  not_ok "mic dictation did not go through the owner's server: $(r '.mic | tojson')"
fi

# 2. Channel voice notes.
if [ "$RUNTIME" = openclaw ]; then
  CH=$(r '.channelConfig | tojson')
  if printf '%s' "$CH" | grep -q 'stt-endpoint-client.py' && ! printf '%s' "$CH" | grep -q 'clawbox.com' && [ "$(r '.channelConfig.models | length')" = 1 ]; then
    ok "channel voice notes are written to the owner's server alone: $CH"
  else
    not_ok "channel voice notes under the lock: $CH"
  fi
  if [ "$(r '.channel.mockRequests')" -ge 1 ] 2>/dev/null && [ "$(r '.channel.heard')" -ge 1 ] 2>/dev/null; then
    ok "a voice note through OpenClaw's media understanding (openclaw infer audio transcribe) was transcribed by the owner's server"
  else
    not_ok "OpenClaw's media understanding did not reach the owner's server: $(r '.channel | tojson')"
  fi
else
  skip "channel voice notes through tools.media are OpenClaw's; Hermes' chat microphone was checked above"
fi

# 3. The voice reply.
if printf '%s' "$(r '.speak.error')" | grep -q 'no_local_voice'; then
  skip "no voice is installed on this board (Kokoro): the spoken reply leg needs it"
elif [ "$(r '.speak.status')" = 200 ] && [ "$(r '.speak.bytes')" -gt 1024 ] 2>/dev/null && { [ "$RUNTIME" = hermes ] || [ "$(r '.speak.engine')" = local ]; }; then
  ok "a voice reply was spoken by the box's own voice under the lock ($(r '.speak.bytes') bytes of $(r '.speak.type')$([ -n "$(r '.speak.engine')" ] && printf ', engine %s' "$(r '.speak.engine')"))"
else
  not_ok "the voice reply under the lock: $(r '.speak | tojson')"
fi
if [ "$RUNTIME" = hermes ]; then
  if [ "$(r '.hermesBefore')" = edge ] && [ "$(r '.hermesAfter')" = clawbox-local ]; then
    ok "Hermes' factory edge voice (Microsoft's cloud) was replaced by Kokoro under the lock (edge → clawbox-local)"
  else
    not_ok "Hermes' voice selection under the lock: before $(r '.hermesBefore'), after $(r '.hermesAfter')"
  fi
else
  if [ "$(r '.ttsCloudEntry | length')" = 0 ]; then
    ok "no ClawBox AI cloud voice entry is written in openclaw.json under the lock"
  else
    not_ok "a cloud voice entry is still in openclaw.json under the lock: $(r '.ttsCloudEntry | tojson')"
  fi
fi

# 4. The server stopped.
if [ "$(r '.stopped.status')" != 200 ] && [ "$(r '.stopped.body.code')" = cloud_ai_locked ]; then
  ok "with the owner's server stopped the recording is refused with the reason: HTTP $(r '.stopped.status'), \"$(r '.stopped.body.error')\""
else
  not_ok "with the server stopped the recording was not refused with cloud_ai_locked: $(r '.stopped | tojson')"
fi
# shellcheck disable=SC2016
ELSEWHERE=$(printf '%s\n' "$RAW" | sed -n 's/^R //p' | jq -rs 'map(select(.inproc != null)) | last | .inproc.urls // ["missing"] | map(select(startswith("http://127.0.0.1:18931/") | not)) | length' 2>/dev/null)
if [ "$(r '.inproc.code')" = cloud_ai_locked ] && [ "$ELSEWHERE" = 0 ] && [ -z "$(r '.inproc.crash')" ]; then
  ok "in-process, every fetch recorded: refused with cloud_ai_locked and zero requests beyond the stopped server ($(r '.inproc.urls | length') to it, 0 to the cloud)"
else
  not_ok "in-process under the lock: $(r '.inproc | tojson')"
fi
if [ "$RUNTIME" = openclaw ]; then
  if [ "$(r '.channelStopped.heard')" = 0 ] && [ "$(r '.channelStopped.anyText')" = 0 ]; then
    ok "OpenClaw's media understanding hears nothing with the server stopped — no transcript from any engine (exit $(r '.channelStopped.rc'))"
  else
    not_ok "OpenClaw's media understanding still transcribed with the server stopped: $(r '.channelStopped | tojson')"
  fi
fi
CONTROL_CLOUD=$(printf '%s\n' "$RAW" | sed -n 's/^R //p' | jq -rs 'map(select(.control != null)) | last | .control.urls // [] | map(select(test("clawbox\\.com|openclawhardware"))) | length' 2>/dev/null)
note "control, lock lifted, server stopped: HTTP $(r '.control.status'), $CONTROL_CLOUD request(s) to ClawBox AI (a box with no ClawBox AI credential makes none either way)"

# Restored.
if [ "$(r '.keys')" = KEYS_SAME ]; then ok "every data/config.json key the test changed is back as it was"; else not_ok "data/config.json keys after the test: $(r '.keys')"; fi
if [ "$RUNTIME" = openclaw ]; then
  if [ "$(r '.restoredSame')" = true ] && [ "$(r '.heldLeft')" = false ] && [ "$(r '.audioMarkLeft')" = false ]; then
    ok "openclaw.json's speech blocks are back as they were, and no lock-time file is left behind"
  else
    not_ok "openclaw.json after the test: differs in [$(r '.differs')], held voices left $(r '.heldLeft'), audio mark left $(r '.audioMarkLeft')"
  fi
elif [ "$(r '.restoredProvider')" = true ]; then
  ok "Hermes' voice selection is back as it was"
else
  not_ok "Hermes' voice selection differs after the test"
fi
finish
