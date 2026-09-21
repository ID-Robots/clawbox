#!/usr/bin/env python3
"""Measure on-device speech-to-text on the box it will actually run on.

This is a BENCHMARK HARNESS. It is not part of the shipped device runtime,
nothing installs it, and no service calls it. Voice input on ClawBox still goes
to the cloud (gpt-4o-mini-transcribe); this file exists so that the decision to
change that is made against numbers taken on an Orin Nano 8GB rather than
against community figures from an x86 desktop. TASK-382 did the same thing for
TTS before TASK-383 picked an engine.

What it measures, for every variant = (whisper model size x ctranslate2 compute
type), on every sample:

  * real-time factor, wall / audio-seconds, so lower is faster and 0.25 means
    4x real time. Both RTF and x-realtime are printed, because the two
    conventions get mixed up constantly.
  * model LOAD time, separately from transcription. A resident whisper server
    loads once and then answers many recordings, so charging the load to every
    utterance would measure the loader.
  * the first transcription after the load is reported as the cold run and
    excluded from the median. A single run per case is how a benchmark ends up
    wrong and public.
  * peak memory is VmHWM (the kernel's own high-water mark) of the worker that
    holds the model, not RSS sampled at a lucky moment, plus the lowest
    MemAvailable seen during the run. The 8GB on this board is SHARED between
    CPU and GPU and the box also has to hold the agent and a TTS voice, so a
    model that transcribes fast and does not fit is not a candidate.
  * WER and CER against a ground-truth transcript, per language. Bulgarian is
    a first-class result, not a footnote: a small model can score WER near 1.0
    on Bulgarian while being nearly right character-for-character, and that
    difference is the whole recommendation.

Device handling: the device is auto-detected through
ctranslate2.get_supported_compute_types("cuda") and can be forced with
--device. The PyPI aarch64 ctranslate2 wheel may well be CPU-only on this
board — scripts/install-voice.sh builds a CUDA one from source precisely
because of that — so "CUDA not available on this wheel" is a RESULT here, not
a crash. The resolved device and the compute types ctranslate2 actually
supports are recorded in the report, every number is labelled with the device
that produced it, and a compute type the device cannot do is reported as a
skipped variant rather than quietly measured somewhere else.

Usage:
    python3 scripts/bench/stt-bench.py --setup             # deps, weights, samples
    python3 scripts/bench/stt-bench.py --samples ~/stt-bench/samples/manifest.json \
        --reps 3 --out results.json --markdown results.md
    python3 scripts/bench/stt-bench.py --score-only pairs.json   # just WER/CER

Exit code is non-zero when a requested variant could not run, unless
--skip-missing is given; a benchmark that silently drops a variant reads as
"we measured all of them" when it measured some.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from pathlib import Path

DEFAULT_MODELS = "tiny,base,small,distil-small.en"
DEFAULT_COMPUTE = "int8,float16"

# Pinned so a rerun measures the same software. These are the versions TASK-411
# was run with; note that --setup will NOT touch an already-installed
# ctranslate2, because on a device scripts/install-voice.sh builds that package
# from source WITH CUDA and a pip install would replace it with the CPU-only
# PyPI wheel — which is exactly the difference this benchmark is trying to
# measure.
PIP_PINS = {
    "faster_whisper": "faster-whisper==1.1.1",
    "ctranslate2": "ctranslate2==4.5.0",
}

# Reused verbatim from scripts/bench/tts-bench.py and scripts/install-voice.sh:
# --setup can synthesise its own corpus with the Piper the repo already
# installs, so the harness runs on a bare box with no audio on it.
PIPER_VERSION = "2023.11.14-2"
PIPER_TARBALL = f"https://github.com/rhasspy/piper/releases/download/{PIPER_VERSION}/piper_linux_aarch64.tar.gz"
PIPER_VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
PIPER_VOICES = {
    # lang -> (voice id, path under the voices repo)
    "en": ("en_US-lessac-medium", "en/en_US/lessac/medium"),
    "bg": ("bg_BG-dimitar-medium", "bg/bg_BG/dimitar/medium"),
}

# Every artifact is pinned. These are an executable and model weights fetched
# over the network onto a device; an unpinned download here is a supply-chain
# hole. Digests are the ones in scripts/install-voice.sh.
ARTIFACT_SHA256 = {
    "piper_linux_aarch64.tar.gz": "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
    "en_US-lessac-medium.onnx": "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
    "en_US-lessac-medium.onnx.json": "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
    "bg_BG-dimitar-medium.onnx": "4972fe764468e8501416407ad81662de94cc6c9cdc680fcf807daef04e319f13",
    "bg_BG-dimitar-medium.onnx.json": "ec9a9abdd17384d3db225e83085b2f68b790b112f058417c3a8a2ac58b79e7f0",
}

# The budget any candidate is read against. TASK-383 measured kokoro-torch on
# CUDA peaking at 2259-2636 MB on a board whose 7607 MB is shared between CPU
# and GPU, and clawbox-tts.sh refuses to start Kokoro below 3000 MB free for
# that reason. An STT model has to fit next to that and the agent.
BOARD_MEM_MB = 7607
KOKORO_PEAK_MB = (2259, 2636)

# A worker that never answers must fail the run, not hang the loop overnight.
# Loading `small` on a cold HF cache is slow, so the start budget is generous.
WORKER_START_TIMEOUT = float(os.environ.get("STT_BENCH_START_TIMEOUT", "900"))
WORKER_TRANSCRIBE_TIMEOUT = float(os.environ.get("STT_BENCH_TRANSCRIBE_TIMEOUT", "900"))
CLOUD_TIMEOUT = float(os.environ.get("STT_BENCH_CLOUD_TIMEOUT", "300"))

CLOUD_MODEL = "gpt-4o-mini-transcribe"
CLOUD_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")

# Models with no non-English training. Whisper marks these with a .en suffix;
# the distil-large releases are English-only without one, so they are named.
# Handing one of these a Bulgarian recording produces a number, and the number
# is meaningless — so the harness refuses to produce it.
ENGLISH_ONLY_EXTRA = {"distil-large-v2", "distil-large-v3"}

# Six paragraphs per language, joined for the long sample and used alone for
# the short one. They are about running a device on purpose: a benchmark corpus
# of nonsense sentences measures a language model that never sees this vocabulary
# in service.
SYNTH_PARAGRAPHS = {
    "en": [
        "Your ClawBox has finished the overnight update and every service came back on its own. "
        "The gateway is answering, the desktop is loaded, and the backup that runs at three in the "
        "morning copied four gigabytes to the external drive without a single error. Two files were "
        "skipped because they were open at the time, so I put them in tonight's queue. Nothing on "
        "the box needs your attention this morning, and the temperature never went above sixty degrees.",
        "The wireless network dropped for about ninety seconds just after midnight, which is when "
        "the router upgraded its own firmware. The box noticed, waited, and reconnected on its own, "
        "so no work was lost. If it happens again tonight I will keep a record of how long the "
        "outage lasted, because a pattern would tell us whether the problem is the router or the "
        "antenna on this side of the house.",
        "You asked me to keep an eye on the disk. The system partition is at sixty one percent, "
        "which is eight points higher than last week, and almost all of that growth is model "
        "weights in the cache. I can clear the ones you have not used in a month and get about "
        "three gigabytes back. Say the word and I will do it after tonight's backup, when nothing "
        "else is reading from the drive.",
        "There are four devices on the home network right now: your laptop, the phone in the "
        "kitchen, the printer, and this box. The printer has been asleep since Tuesday and it "
        "answers a ping but nothing else, which is normal for that model. If you want, I can wake "
        "it before you leave in the morning so the first page does not take two minutes to come out.",
        "The microphone test you recorded yesterday came through clearly, with a little hiss from "
        "the fan on the left channel. I can filter that out before anything is transcribed, though "
        "it costs a fraction of a second per recording. For a short note that is invisible. For a "
        "long meeting it adds up, so I would rather ask you than decide it quietly on your behalf.",
        "One last thing before you start. The calendar has a call at half past nine with the "
        "supplier about the delayed shipment, and the notes from the previous call are already open "
        "in the second window. I put the tracking number at the top because you asked for it twice "
        "last week. Everything else on today's list can wait until the afternoon.",
    ],
    "bg": [
        "Кутията ви завърши нощното обновяване и всички услуги се върнаха сами. Шлюзът отговаря, "
        "работният плот е зареден, а архивирането, което тръгва в три сутринта, копира четири "
        "гигабайта на външния диск без нито една грешка. Два файла бяха пропуснати, защото бяха "
        "отворени в този момент, затова ги оставих за довечера. Нищо на устройството не изисква "
        "вашето внимание тази сутрин.",
        "Безжичната мрежа прекъсна за около деветдесет секунди малко след полунощ, когато рутерът "
        "обновяваше собствения си фърмуер. Кутията забеляза, изчака и се свърза отново сама, така "
        "че нищо от работата не беше загубено. Ако се повтори и тази нощ, ще запиша колко дълго е "
        "продължило прекъсването, защото повторението би показало дали проблемът е в рутера или в "
        "антената от тази страна на къщата.",
        "Помолихте ме да следя диска. Системният дял е на шейсет и един процента, което е с осем "
        "пункта повече от миналата седмица, и почти целият растеж са модели в кеша. Мога да изтрия "
        "тези, които не сте използвали от месец, и да върна около три гигабайта. Кажете и ще го "
        "направя след довечерашното архивиране, когато нищо друго не чете от диска.",
        "В домашната мрежа в момента има четири устройства: вашият лаптоп, телефонът в кухнята, "
        "принтерът и тази кутия. Принтерът спи от вторник и отговаря на пинг, но нищо повече, което "
        "е нормално за този модел. Ако искате, мога да го събудя преди да тръгнете сутринта, за да "
        "не чакате две минути за първата страница.",
        "Записът от микрофона, който направихте вчера, се чува ясно, само с лек шум от вентилатора "
        "в левия канал. Мога да го премахна, преди каквото и да е да бъде преобразувано в текст, но "
        "това струва част от секундата на запис. За кратка бележка е незабележимо. За дълга среща се "
        "натрупва, затова предпочитам да ви попитам, вместо да решавам тихо вместо вас.",
        "И още нещо, преди да започнете. В календара има разговор в девет и половина с доставчика за "
        "забавената пратка, а бележките от предишния разговор вече са отворени във втория прозорец. "
        "Сложих номера за проследяване най-отгоре, защото го поискахте два пъти миналата седмица. "
        "Всичко останало от днешния списък може да изчака следобеда.",
    ],
}

# (sample suffix, nominal seconds, how many paragraphs) — the acceptance
# criteria asks for a short note and a long recording per language, because a
# dictated sentence and a three-minute voice memo do not cost the same and do
# not fail the same way.
SYNTH_LENGTHS = [("30s", 30, 1), ("3min", 180, 6)]


def log(msg: str) -> None:
    print(f"  [stt-bench] {msg}", flush=True)


def wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
    if rate <= 0:
        raise ValueError(f"{path}: sample rate {rate}")
    return frames / float(rate)


def mem_available_kb() -> int:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0


def vm_hwm_kb(pid: int) -> int:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return 0


class Sampler:
    """Watch a pid's peak memory and the box's free memory while it works.

    VmHWM disappears with the process, so a one-shot tool has to be sampled
    while it runs; a long-lived worker reports its own high-water mark and this
    only tracks the box.
    """

    def __init__(self, pid: int | None, interval: float = 0.005):
        self.pid = pid
        self.interval = interval
        self.peak_rss_kb = 0
        self.min_avail_kb = mem_available_kb()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            if self.pid is not None:
                self.peak_rss_kb = max(self.peak_rss_kb, vm_hwm_kb(self.pid))
            avail = mem_available_kb()
            if avail:
                self.min_avail_kb = min(self.min_avail_kb, avail)
            self._stop.wait(self.interval)

    def __enter__(self) -> "Sampler":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=1)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, dest: Path, expected_sha256: str | None = None) -> None:
    """Fetch `url` to `dest` once, and refuse anything that is not the pinned file.

    A cached file is verified too: a truncated or swapped artifact on disk is
    exactly as wrong as a bad download, and it would otherwise be trusted
    forever.
    """
    if dest.exists() and dest.stat().st_size > 0:
        if expected_sha256 is None or sha256_of(dest) == expected_sha256:
            return
        log(f"{dest.name}: cached copy does not match its pinned digest — refetching")
        dest.unlink()
    log(f"downloading {dest.name}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as r, tmp.open("wb") as f:
        shutil.copyfileobj(r, f)
    if expected_sha256 is not None:
        actual = sha256_of(tmp)
        if actual != expected_sha256:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(
                f"{dest.name}: sha256 {actual} does not match the pinned {expected_sha256}"
            )
    tmp.rename(dest)


def safe_extract(tarball: Path, dest: Path) -> None:
    """Extract without letting a member escape `dest`.

    Python 3.12 has `filter="data"` for this and 3.14 makes it the default; the
    box runs 3.10, where the argument does not exist, so the check is explicit
    rather than assumed. The filter is asked for as well when the interpreter
    has it, so a newer Python enforces its own rules instead of warning about
    the ones it is about to change.
    """
    dest = dest.resolve()
    with tarfile.open(tarball) as tar:
        for member in tar.getmembers():
            target = (dest / member.name).resolve()
            if not str(target).startswith(str(dest) + os.sep) and target != dest:
                raise RuntimeError(f"{tarball.name}: member escapes the target directory: {member.name}")
            if member.issym() or member.islnk():
                link_target = (target.parent / member.linkname).resolve()
                if not str(link_target).startswith(str(dest) + os.sep):
                    raise RuntimeError(f"{tarball.name}: link escapes the target directory: {member.name}")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise RuntimeError(f"{tarball.name}: refusing special member: {member.name}")
        if hasattr(tarfile, "data_filter"):
            tar.extractall(dest, filter="data")
        else:
            tar.extractall(dest)


# --- scoring -----------------------------------------------------------------
#
# One implementation, used by the benchmark and reachable on its own through
# --score-only, so what the tests check is what the report is made of.

# Apostrophes are deleted rather than turned into a space: "don't" and "dont"
# are the same word said the same way, and splitting one of them in two would
# invent an insertion the speaker never made. Everything else Unicode calls
# punctuation becomes a space, so "well-known" and "well known" agree. Nothing
# here is ASCII-specific — the categories are what make Bulgarian work.
APOSTROPHES = "'’‘ʼ´`"


def normalize_text(text: str) -> str:
    """Fold away everything that is not a difference in what was said."""
    # NFC first so precomposed and decomposed Cyrillic compare equal, and again
    # after casefold, which is allowed to leave the string denormalised.
    text = unicodedata.normalize("NFC", text)
    text = "".join("" if ch in APOSTROPHES else ch for ch in text)
    text = "".join(" " if unicodedata.category(ch).startswith("P") else ch for ch in text)
    text = unicodedata.normalize("NFC", text.casefold())
    return " ".join(text.split())


def _edit_distance(a, b) -> int:
    """Unit-cost Levenshtein over any two sequences.

    The shared head and tail are trimmed first. That is exact for unit costs
    and it is what keeps the character pass affordable on a three-minute
    transcript that is mostly right.
    """
    start = 0
    while start < len(a) and start < len(b) and a[start] == b[start]:
        start += 1
    a, b = a[start:], b[start:]
    end = 0
    while end < len(a) and end < len(b) and a[len(a) - 1 - end] == b[len(b) - 1 - end]:
        end += 1
    if end:
        a, b = a[: len(a) - end], b[: len(b) - end]
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(prev[j - 1] if ca == cb else 1 + min(prev[j - 1], prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def _align_counts(ref: list[str], hyp: list[str]) -> tuple[int, int, int, int]:
    """Return (substitutions, insertions, deletions, total edits) for words.

    The full matrix is kept rather than two rows because the breakdown is the
    point: 40% WER made of substitutions is a model mishearing words, and 40%
    made of insertions is a model hallucinating into silence, and those two
    lead to different decisions.
    """
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        d[i][0] = i
    for j in range(1, m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        ri, row, prev = ref[i - 1], d[i], d[i - 1]
        for j in range(1, m + 1):
            row[j] = prev[j - 1] if ri == hyp[j - 1] else 1 + min(prev[j - 1], prev[j], row[j - 1])
    sub = ins = dele = 0
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and ref[i - 1] == hyp[j - 1] and d[i][j] == d[i - 1][j - 1]:
            i, j = i - 1, j - 1
        elif i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + 1:
            sub += 1
            i, j = i - 1, j - 1
        elif j > 0 and d[i][j] == d[i][j - 1] + 1:
            ins += 1
            j -= 1
        else:
            dele += 1
            i -= 1
    return sub, ins, dele, d[n][m]


def score_transcript(reference: str, hypothesis: str) -> dict:
    """WER and CER for one pair, with the counts the rates were made from.

    CER is reported next to WER because on Bulgarian they disagree in a way
    that decides the recommendation: a model that gets every ending slightly
    wrong scores a WER near 1.0 and a CER near 0.1, and that model is usable
    while a WER of 1.0 alone says it is not.
    """
    ref_norm = normalize_text(reference)
    hyp_norm = normalize_text(hypothesis)
    ref_words = ref_norm.split()
    hyp_words = hyp_norm.split()
    sub, ins, dele, edits = _align_counts(ref_words, hyp_words)
    char_edits = _edit_distance(ref_norm, hyp_norm)
    return {
        "wer": round(edits / len(ref_words), 4) if ref_words else None,
        "cer": round(char_edits / len(ref_norm), 4) if ref_norm else None,
        "substitutions": sub,
        "insertions": ins,
        "deletions": dele,
        "word_edits": edits,
        "char_edits": char_edits,
        "reference_words": len(ref_words),
        "hypothesis_words": len(hyp_words),
        "normalized_reference": ref_norm,
        "normalized_hypothesis": hyp_norm,
    }


def load_json_document(raw: str, label: str):
    """Decode JSON, or say which file was not JSON instead of tracebacking.

    Everything else in this harness reports bad input as a SystemExit naming
    what was wrong; a hand-written pairs file or manifest is exactly the kind of
    input that arrives malformed, so it gets the same treatment.
    """
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label}: not valid JSON ({exc})") from exc


def describe_entry(entry) -> str:
    """Name an entry a human has to find again in their own file."""
    try:
        rendered = json.dumps(entry, ensure_ascii=False)
    except (TypeError, ValueError):
        rendered = repr(entry)
    return f"{type(entry).__name__} {rendered[:60]}"


def run_score_only(source: str) -> int:
    """Score pairs from a JSON file (or stdin with "-") and print JSON."""
    label = "<stdin>" if source == "-" else source
    raw = sys.stdin.read() if source == "-" else Path(source).expanduser().read_text(encoding="utf-8")
    payload = load_json_document(raw, label)
    pairs = payload if isinstance(payload, list) else [payload]
    scored = []
    for index, pair in enumerate(pairs):
        # A bare string in the list would otherwise index by character and
        # score whatever came out, which is a wrong number rather than an
        # error, and a missing key would surface as a bare KeyError.
        if not isinstance(pair, dict):
            raise SystemExit(f"{label}: pair {index} is not an object: {describe_entry(pair)}")
        # A non-string id cannot name the entry back to its author, so the
        # position does it instead.
        name = pair["id"] if isinstance(pair.get("id"), str) else f"#{index}"
        for field in ("reference", "hypothesis"):
            if field not in pair:
                raise SystemExit(f"{label}: pair {name} is missing '{field}'")
            # Present is not usable: null or a number reaches normalize_text and
            # comes back as a TypeError with no file and no field in it.
            if not isinstance(pair[field], str):
                raise SystemExit(
                    f"{label}: pair {name}: '{field}' must be a string, got {type(pair[field]).__name__}"
                )
        result = score_transcript(pair["reference"], pair["hypothesis"])
        result["id"] = pair.get("id", str(index))
        scored.append(result)
    print(json.dumps({"pairs": scored}, indent=2, ensure_ascii=False))
    return 0


# --- variants ----------------------------------------------------------------

# faster-whisper, ctranslate2 and huggingface_hub all write to stdout before the
# worker gets a word in, so every line the parent cares about is tagged.
# Anything untagged is somebody else's noise and is skipped rather than parsed
# and blamed.
WORKER_TAG = "__sttbench__ "

WORKER_SRC = r'''
import json, os, sys, time

TAG = "__sttbench__ "
def emit(payload):
    print(TAG + json.dumps(payload), flush=True)

def hwm_kb():
    try:
        for line in open("/proc/self/status"):
            if line.startswith("VmHWM:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0

model_size, device, compute_type = sys.argv[1], sys.argv[2], sys.argv[3]
download_root = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else ""

from faster_whisper import WhisperModel

kwargs = {"device": device, "compute_type": compute_type}
if download_root:
    kwargs["download_root"] = download_root
start = time.monotonic()
model = WhisperModel(model_size, **kwargs)
load_seconds = time.monotonic() - start

# The device and compute type are read back off the loaded CTranslate2 model
# rather than echoed from the request: what was asked for is not evidence of
# what ran.
inner = getattr(model, "model", None)
emit({"ready": True,
      "rss_kb": hwm_kb(),
      "model_load_seconds": load_seconds,
      "device": str(getattr(inner, "device", device)),
      "compute_type": str(getattr(inner, "compute_type", compute_type))})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    if req.get("quit"):
        break
    kw = {}
    if req.get("language"):
        kw["language"] = req["language"]
    start = time.monotonic()
    segments, _info = model.transcribe(req["audio"], **kw)
    # faster-whisper yields segments lazily: draining the generator IS the
    # transcription, so it has to happen inside the timed window or the work
    # would look free.
    text = " ".join(seg.text.strip() for seg in segments)
    wall = time.monotonic() - start
    emit({"wall": wall, "text": text, "rss_kb": hwm_kb()})
'''

PROBE_SRC = r'''
import json
TAG = "__sttbench__ "
out = {"cpu": [], "cuda": [], "ctranslate2_version": "", "faster_whisper_version": ""}
try:
    import ctranslate2
    out["ctranslate2_version"] = str(getattr(ctranslate2, "__version__", ""))
    for dev in ("cpu", "cuda"):
        try:
            out[dev] = sorted(ctranslate2.get_supported_compute_types(dev))
        except Exception as exc:
            out[dev + "_error"] = str(exc)[:200]
except Exception as exc:
    out["ctranslate2_error"] = str(exc)[:200]
try:
    import faster_whisper
    out["faster_whisper_version"] = str(getattr(faster_whisper, "__version__", ""))
except Exception as exc:
    out["faster_whisper_error"] = str(exc)[:200]
print(TAG + json.dumps(out), flush=True)
'''


def is_english_only(model: str) -> bool:
    return model.endswith(".en") or model in ENGLISH_ONLY_EXTRA


def read_tagged_line(proc: subprocess.Popen, name: str, what: str, timeout: float, stderr_tail) -> dict:
    """Return the next tagged line from `proc`, stepping over library banners.

    The deadline is enforced by killing the worker rather than by polling the
    pipe: `select` on a text-mode pipe reports "nothing to read" while a
    complete line is already sitting in Python's own buffer, which deadlocks on
    exactly the fast workers it is meant to protect. Killing the child turns
    any hang — no answer, or stdout closed while the process lives on — into an
    EOF this loop can report.
    """
    assert proc.stdout
    timed_out = threading.Event()

    def give_up() -> None:
        timed_out.set()
        proc.kill()

    watchdog = threading.Timer(timeout, give_up)
    watchdog.start()
    try:
        while True:
            line = proc.stdout.readline()
            if not line:
                if timed_out.is_set():
                    raise RuntimeError(f"{name} {what}: no answer within {timeout:.0f}s")
                raise RuntimeError(f"{name} {what}: {stderr_tail() or 'no output'}")
            if line.startswith(WORKER_TAG):
                return json.loads(line[len(WORKER_TAG):])
    finally:
        watchdog.cancel()


def probe_runtime(python_bin: str) -> dict:
    """Ask the interpreter that will hold the model what it can actually do.

    This runs out of process on purpose: the harness itself does not import
    faster-whisper, and --python-bin exists so the measurement can be pointed
    at the box's own interpreter rather than whatever is running this script.
    """
    proc = subprocess.Popen(
        [python_bin, "-c", PROBE_SRC],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        out, err = proc.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return {"probe_error": "ctranslate2 probe did not answer within 180s"}
    for line in out.splitlines():
        if line.startswith(WORKER_TAG):
            return json.loads(line[len(WORKER_TAG):])
    return {"probe_error": (err or out or "probe produced no output").strip()[:300]}


def resolve_device(requested: str, probe: dict) -> tuple[str, str]:
    """Return (device, note). The note is why, when it is not what was asked."""
    cuda_types = probe.get("cuda") or []
    if requested != "auto":
        if requested == "cuda" and not cuda_types:
            return "cuda", probe.get("cuda_error", "ctranslate2 reports no CUDA compute types")
        return requested, ""
    if cuda_types:
        return "cuda", ""
    reason = probe.get("cuda_error") or probe.get("ctranslate2_error") or "no CUDA compute types reported"
    return "cpu", f"CUDA not available on this wheel: {reason}"


class Variant:
    """One (model size, compute type) pair, held open in a worker process.

    Loading whisper costs seconds and a resident server pays it once, so the
    model is loaded once per variant and every sample is transcribed against
    that same loaded model.
    """

    def __init__(self, model: str, compute_type: str, device: str, python_bin: str, model_cache: str):
        self.model = model
        self.compute_type = compute_type
        self.requested_device = device
        self.python_bin = python_bin
        self.model_cache = model_cache
        self.name = f"{model}/{compute_type}"
        self.proc: subprocess.Popen | None = None
        self.startup_seconds = 0.0
        self.model_load_seconds = 0.0
        self.device = device
        self.actual_compute_type = compute_type
        self.peak_rss_kb = 0
        self.min_avail_kb = mem_available_kb()
        # stderr goes to a file, never a pipe nobody drains: ctranslate2 and the
        # CUDA runtime are chatty enough to fill a pipe buffer and deadlock
        # before the model has even loaded.
        self._stderr_file = None

    @property
    def english_only(self) -> bool:
        return is_english_only(self.model)

    def language_support(self, lang: str) -> str:
        if lang == "en":
            return "multilingual model" if not self.english_only else "English-only model"
        if self.english_only:
            return "ENGLISH-ONLY model — no result for this language"
        return "multilingual model"

    def _stderr_tail(self, limit: int = 500) -> str:
        if self._stderr_file is None:
            return ""
        try:
            data = Path(self._stderr_file.name).read_bytes()
        except OSError:
            return ""
        return data[-limit:].decode("utf-8", "replace").strip()

    def start(self) -> subprocess.Popen:
        if self.proc is not None:
            return self.proc
        started = time.monotonic()
        self._stderr_file = tempfile.NamedTemporaryFile(
            prefix=f"stt-bench-{self.model}-{self.compute_type}-", suffix=".err"
        )
        proc = subprocess.Popen(
            [
                self.python_bin,
                "-c",
                WORKER_SRC,
                self.model,
                self.requested_device,
                self.compute_type,
                self.model_cache,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_file,
            text=True,
        )
        try:
            # Sampled from the parent, because loading the weights is where the
            # box comes closest to running out of memory and the worker cannot
            # report a low-water mark it is in the middle of causing.
            with Sampler(proc.pid) as sampler:
                info = read_tagged_line(
                    proc, self.name, "worker did not start", WORKER_START_TIMEOUT, self._stderr_tail
                )
        except Exception:
            proc.kill()
            proc.wait(timeout=10)
            self._close_stderr()
            raise
        self.min_avail_kb = min(self.min_avail_kb, sampler.min_avail_kb)
        self.startup_seconds = time.monotonic() - started
        self.model_load_seconds = float(info.get("model_load_seconds", 0.0))
        self.device = str(info.get("device", self.requested_device))
        self.actual_compute_type = str(info.get("compute_type", self.compute_type))
        # The worker's own VmHWM is authoritative; the sampled one is a floor
        # under it, and it is all there is if a worker dies before reporting.
        self.peak_rss_kb = max(int(info.get("rss_kb", 0)), sampler.peak_rss_kb)
        self.proc = proc
        return proc

    def unavailable_reason(self) -> str | None:
        try:
            self.start()
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            return str(exc)[:300]
        return None

    def transcribe(self, audio: Path, language: str | None) -> tuple[float, str]:
        proc = self.start()
        assert proc.stdin and proc.stdout
        request = {"audio": str(audio)}
        if language:
            request["language"] = language
        with Sampler(proc.pid) as sampler:
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            res = read_tagged_line(
                proc, self.name, "worker died mid-run", WORKER_TRANSCRIBE_TIMEOUT, self._stderr_tail
            )
        self.peak_rss_kb = max(self.peak_rss_kb, int(res.get("rss_kb", 0)), sampler.peak_rss_kb)
        self.min_avail_kb = min(self.min_avail_kb, sampler.min_avail_kb)
        return float(res["wall"]), str(res.get("text", ""))

    def _close_stderr(self) -> None:
        if self._stderr_file is not None:
            try:
                self._stderr_file.close()
            except OSError:
                pass
            self._stderr_file = None

    def close(self) -> None:
        if self.proc and self.proc.stdin:
            try:
                self.proc.stdin.write(json.dumps({"quit": True}) + "\n")
                self.proc.stdin.flush()
                self.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001 - best effort teardown
                self.proc.kill()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        self.proc = None
        self._close_stderr()


# --- samples -----------------------------------------------------------------


def load_samples(manifest_path: Path) -> tuple[list[dict], dict]:
    """Read a sample manifest, accepting a bare list or an object with metadata.

    Audio paths are resolved against the manifest's own directory so a corpus
    can be moved without being rewritten.
    """
    payload = load_json_document(manifest_path.read_text(encoding="utf-8"), str(manifest_path))
    if isinstance(payload, list):
        samples, meta = payload, {}
    elif isinstance(payload, dict):
        samples, meta = payload.get("samples", []), {k: v for k, v in payload.items() if k != "samples"}
    else:
        raise SystemExit(
            f"{manifest_path}: expected a list of samples or an object with 'samples', "
            f"got {type(payload).__name__}"
        )
    if not isinstance(samples, list):
        raise SystemExit(f"{manifest_path}: 'samples' must be a list, got {type(samples).__name__}")
    if not samples:
        raise SystemExit(f"{manifest_path}: no samples in the manifest")
    base = manifest_path.parent
    resolved = []
    for index, sample in enumerate(samples):
        # Before the field test, not after: `"id" not in "some string"` is a
        # substring check that happens to pass, and the error message below
        # would then die reaching for .get on a str.
        if not isinstance(sample, dict):
            raise SystemExit(f"{manifest_path}: sample {index} is not an object: {describe_entry(sample)}")
        name = sample["id"] if isinstance(sample.get("id"), str) else f"#{index}"
        for field in ("id", "lang", "audio", "reference"):
            if field not in sample:
                raise SystemExit(f"{manifest_path}: sample {name} is missing '{field}'")
            # A null or numeric "audio" reaches Path() and tracebacks; a null
            # "reference" gets that far and dies in the scorer instead.
            if not isinstance(sample[field], str):
                raise SystemExit(
                    f"{manifest_path}: sample {name}: '{field}' must be a string, "
                    f"got {type(sample[field]).__name__}"
                )
        audio = Path(sample["audio"]).expanduser()
        if not audio.is_absolute():
            audio = base / audio
        if not audio.exists():
            raise SystemExit(f"{manifest_path}: sample {sample['id']}: audio not found at {audio}")
        entry = dict(sample)
        entry["audio"] = str(audio)
        try:
            entry["audio_seconds"] = round(wav_seconds(audio), 3)
        except (wave.Error, EOFError, ValueError, OSError) as exc:
            raise SystemExit(
                f"{manifest_path}: sample {sample['id']}: {audio} is not a WAV this harness can "
                f"measure ({exc}). Convert it first: "
                f"ffmpeg -i in.ext -ac 1 -ar 16000 -c:a pcm_s16le out.wav"
            ) from exc
        resolved.append(entry)
    return resolved, meta


def synthesise_samples(cache: Path, piper_bin: Path, voice_dir: Path) -> Path:
    """Speak the reference texts with Piper so a bare box has a corpus.

    Ground truth is then exactly the text that was handed to the synthesiser,
    which is the only way to get a reference without a human transcribing
    audio. The cost is that this is CLEAN speech: no room, no clipping, no
    accent, no crosstalk. WER measured on it is a FLOOR, not a field number,
    and both the manifest and the report say so where a reader will see it.
    """
    samples_dir = cache / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # An empty entry in LD_LIBRARY_PATH means "the current directory" to the
    # loader, which is not somewhere a benchmark should be resolving .so files.
    existing = env.get("LD_LIBRARY_PATH", "")
    env["LD_LIBRARY_PATH"] = f"{piper_bin.parent}:{existing}" if existing else str(piper_bin.parent)

    samples = []
    for lang, paragraphs in SYNTH_PARAGRAPHS.items():
        voice, _ = PIPER_VOICES[lang]
        for suffix, target_seconds, count in SYNTH_LENGTHS:
            sample_id = f"{lang}-{suffix}"
            # One line, because Piper's CLI treats each input line as its own
            # utterance and -f would leave only the last one on disk.
            text = " ".join(" ".join(paragraphs[:count]).split())
            out = samples_dir / f"{sample_id}.wav"
            proc = subprocess.run(
                [str(piper_bin), "-m", str(voice_dir / f"{voice}.onnx"), "-f", str(out)],
                input=text.encode("utf-8"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env=env,
                timeout=900,
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    f"piper exited {proc.returncode} on {sample_id}: "
                    f"{proc.stderr.decode('utf-8', 'replace')[:300]}"
                )
            seconds = wav_seconds(out)
            with wave.open(str(out), "rb") as w:
                rate = w.getframerate()
            log(f"{sample_id}: {seconds:.1f}s of audio at {rate} Hz (target ~{target_seconds}s)")
            samples.append(
                {
                    "id": sample_id,
                    "lang": lang,
                    "audio": out.name,
                    "reference": text,
                    "target_seconds": target_seconds,
                    "audio_seconds": round(seconds, 3),
                    "sample_rate": rate,
                }
            )

    manifest = samples_dir / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "synthetic": True,
                "generator": f"piper {PIPER_VERSION} ({', '.join(v for v, _ in PIPER_VOICES.values())})",
                # No "SYNTHETIC" lead-in here: render_markdown supplies its
                # own, and the two would read as a stutter in the report.
                "warning": (
                    "The reference is the exact text fed to Piper, so ground truth is perfect, "
                    "but the audio is cleaner than any real voice note: no room, no clipping, "
                    "no accent, no background. Treat the WER it produces as a floor, not a "
                    "field number."
                ),
                "samples": samples,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    log(f"wrote {manifest}")
    return manifest


# --- setup -------------------------------------------------------------------


def module_present(python_bin: str, module: str) -> str | None:
    """Return the installed version string, or None when the import fails."""
    probe = (
        f"import {module}\n"
        f"print(getattr({module}, '__version__', 'unknown'))\n"
    )
    try:
        result = subprocess.run([python_bin, "-c", probe], capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def do_setup(cache: Path, args: argparse.Namespace, models: list[str]) -> int:
    cache.mkdir(parents=True, exist_ok=True)
    installed: list[str] = []

    for module, requirement in PIP_PINS.items():
        version = module_present(args.python_bin, module)
        if version:
            # ctranslate2 especially: on a device scripts/install-voice.sh
            # builds it from source with CUDA, and pip would silently swap that
            # for the CPU-only PyPI wheel. Whether this box has a CUDA build is
            # one of the things the benchmark is here to report.
            log(f"{module} already installed ({version}) — left alone, not upgraded to {requirement}")
            continue
        log(f"installing {requirement}")
        result = subprocess.run(
            [args.python_bin, "-m", "pip", "install", "--user", requirement],
            capture_output=True,
            text=True,
            timeout=3600,
        )
        if result.returncode != 0:
            log(result.stderr.strip()[-800:])
            raise SystemExit(f"pip install {requirement} failed")
        installed.append(requirement)

    log(f"packages installed by this run: {', '.join(installed) if installed else 'none, all present'}")

    # Weights are fetched now so the timed run measures transcription and not
    # the network. int8 on the CPU is used for the fetch because it is the one
    # combination every wheel can construct.
    for model in models:
        log(f"pre-downloading weights for {model}")
        fetch_kwargs = {"device": "cpu", "compute_type": "int8"}
        if args.model_cache:
            fetch_kwargs["download_root"] = args.model_cache
        fetch = (
            "from faster_whisper import WhisperModel\n"
            f"WhisperModel({model!r}, **{fetch_kwargs!r})\n"
        )
        result = subprocess.run([args.python_bin, "-c", fetch], capture_output=True, text=True, timeout=3600)
        if result.returncode != 0:
            log(result.stderr.strip()[-800:])
            raise SystemExit(f"could not fetch weights for {model}")

    if not args.no_samples:
        piper_bin = find_piper_binary(cache, args.piper_bin)
        if piper_bin is None:
            piper_bin = cache / "piper" / "piper"
            tarball = cache / "piper_linux_aarch64.tar.gz"
            download(PIPER_TARBALL, tarball, ARTIFACT_SHA256["piper_linux_aarch64.tar.gz"])
            safe_extract(tarball, cache)
            tarball.unlink(missing_ok=True)
            piper_bin.chmod(0o755)
        if args.piper_voices:
            # An explicitly supplied directory is the operator's call and is
            # used as-is. Fetching over it would overwrite voices somebody
            # pointed us at on purpose, and the digests below only describe the
            # copies this harness downloads itself.
            voice_dir = Path(args.piper_voices).expanduser()
            log(f"using the voices in {voice_dir} as given — pinned digests NOT checked")
        else:
            # The benchmark's own cache, deliberately NOT the device's
            # ~/.local/share/piper/voices: scripts/install-voice.sh gates the
            # Bulgarian voice behind an opt-in, so downloading it there would
            # switch on Bulgarian TTS as a side effect of running a benchmark.
            voice_dir = cache / "voices"
            voice_dir.mkdir(parents=True, exist_ok=True)
            for voice, repo_path in PIPER_VOICES.values():
                for suffix in (".onnx", ".onnx.json"):
                    name = f"{voice}{suffix}"
                    download(f"{PIPER_VOICES_BASE}/{repo_path}/{name}", voice_dir / name, ARTIFACT_SHA256.get(name))
        missing = [v for v, _ in PIPER_VOICES.values() if not (voice_dir / f"{v}.onnx").exists()]
        if missing:
            raise SystemExit(f"{voice_dir}: missing Piper voices: {', '.join(missing)}")
        manifest = synthesise_samples(cache, piper_bin, voice_dir)
        log(f"run the benchmark with --samples {manifest}")

    log("setup complete")
    return 0


def find_piper_binary(cache: Path, override: str) -> Path | None:
    if override:
        path = Path(override).expanduser()
        return path if path.exists() else None
    for candidate in (cache / "piper" / "piper", Path.home() / ".local" / "share" / "piper" / "piper"):
        if candidate.exists():
            return candidate
    return None


# --- cloud comparator --------------------------------------------------------


def is_https(url: str) -> bool:
    return url.strip().lower().startswith("https://")


def redact_url(url: str) -> str:
    """The URL without its userinfo, query or fragment, so a key pasted into any
    of them stays out of the report.

    Userinfo is the textbook case; `?api_key=` and `?token=` are the common one.
    This string is written to the JSON report and to the markdown a human pastes
    into a ticket, so everything that could carry a secret comes off first.
    """
    url = url.partition("#")[0].partition("?")[0]
    scheme, sep, rest = url.partition("://")
    if not sep:
        return url
    location, _, path = rest.partition("/")
    if "@" in location:
        location = "***@" + location.rsplit("@", 1)[1]
    return f"{scheme}://{location}" + (f"/{path}" if path else "")


DEFAULT_PORTS = {"http": 80, "https": 443}


def origin_of(url: str) -> tuple[str, str, int]:
    """Scheme, host and effective port — what "same origin" has to mean here."""
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    try:
        port = parsed.port
    except ValueError:  # a port that is not a number is not an origin to match
        port = None
    return scheme, (parsed.hostname or "").lower(), port or DEFAULT_PORTS.get(scheme, -1)


class HTTPSOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse a redirect that would hand the bearer token to anyone else.

    urllib copies caller-supplied headers — including Authorization — onto the
    redirected request, so a 302 to an http:// Location puts the API key on the
    wire in cleartext before anything here gets a say. HTTPS does not fix that
    on its own: the same copying sends the key to whatever host the Location
    names, so a redirect to a different origin is a handover, encrypted or not.
    Raising instead of following turns either into one failed row.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_https(newurl):
            raise urllib.error.HTTPError(
                newurl, code, f"refusing a non-HTTPS redirect to {redact_url(newurl)}", headers, fp
            )
        if origin_of(newurl) != origin_of(req.full_url):
            raise urllib.error.HTTPError(
                newurl, code, f"refusing a cross-origin redirect to {redact_url(newurl)}", headers, fp
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


CLOUD_OPENER = urllib.request.build_opener(HTTPSOnlyRedirectHandler)


def cloud_transcribe(audio: Path, model: str, api_key: str, language: str | None) -> tuple[float, str]:
    """One multipart POST to the transcription endpoint.

    The key is read from the environment by the caller and is never written to
    the report, the manifest, or any log line here.
    """
    boundary = f"----stt-bench-{uuid.uuid4().hex}"
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )

    field("model", model)
    field("response_format", "json")
    if language:
        field("language", language)
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{audio.name}"\r\n'
        f"Content-Type: audio/wav\r\n\r\n".encode("utf-8")
    )
    parts.append(audio.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    request = urllib.request.Request(
        f"{CLOUD_BASE_URL}/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    start = time.monotonic()
    with CLOUD_OPENER.open(request, timeout=CLOUD_TIMEOUT) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return time.monotonic() - start, str(payload.get("text", ""))


def measure_cloud(samples: list[dict], model: str, language_hint: bool) -> dict:
    """Transcribe the same audio with the incumbent, or say why it did not.

    The key comes from OPENAI_API_KEY and from nowhere else — no flag, no file
    — so there is no path by which it reaches the report.
    """
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return {"model": model, "skipped": "OPENAI_API_KEY not set"}
    # A key goes on this request, so the endpoint has to be one that encrypts
    # it. OPENAI_BASE_URL is an override a user sets to point at a proxy, and
    # an http:// proxy hands the key to anything on the path. Recorded as a
    # skipped section like any other cloud failure: the on-device numbers are
    # already measured by the time this runs and must still reach the file.
    if not is_https(CLOUD_BASE_URL):
        return {
            "model": model,
            "skipped": f"refusing to send the API key over cleartext: OPENAI_BASE_URL is {redact_url(CLOUD_BASE_URL)}",
        }
    rows = []
    for sample in samples:
        try:
            wall, text = cloud_transcribe(
                Path(sample["audio"]), model, api_key, sample["lang"] if language_hint else None
            )
        # Deliberately broad: http.client raises exceptions that are neither
        # URLError nor OSError, and letting one through here would destroy a
        # finished benchmark on its way to the report file.
        except Exception as exc:  # noqa: BLE001 - a failed request is a row, not a dead run
            # No exception urllib raises today carries the Authorization header,
            # but this string is written to a file a human will paste into a
            # ticket, and "no library will ever repr my request" is not a
            # guarantee worth betting a key on.
            reason = f"{type(exc).__name__}: {exc}".replace(api_key, "***")
            rows.append({"sample": sample["id"], "lang": sample["lang"], "skipped": reason[:200]})
            continue
        scores = score_transcript(sample["reference"], text)
        rows.append(
            {
                "sample": sample["id"],
                "lang": sample["lang"],
                "audio_seconds": sample["audio_seconds"],
                "wall_seconds": round(wall, 3),
                "wer": scores["wer"],
                "cer": scores["cer"],
                "hypothesis": text,
            }
        )
        log(f"cloud {sample['id']}: {wall:.2f}s, WER {scores['wer']}")
    return {"model": model, "rows": rows}


# --- run ---------------------------------------------------------------------


def provenance() -> dict:
    def read(path: str) -> str:
        try:
            return Path(path).read_text().strip().splitlines()[0]
        except (OSError, IndexError):
            return ""

    def run(cmd: list[str]) -> str:
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=15).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""

    return {
        "uname": run(["uname", "-srm"]),
        "tegra_release": read("/etc/nv_tegra_release"),
        "model": read("/proc/device-tree/model").replace("\x00", ""),
        "power_mode": run(["nvpmodel", "-q"]).replace("\n", " "),
        "mem_total_kb": int(
            next(
                (l.split()[1] for l in Path("/proc/meminfo").read_text().splitlines() if l.startswith("MemTotal:")),
                "0",
            )
        ),
        "mem_available_kb_at_start": mem_available_kb(),
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def measure(variant: Variant, samples: list[dict], reps: int, language_hint: bool) -> list[dict]:
    rows = []
    for sample in samples:
        if variant.english_only and sample["lang"] != "en":
            # A number here would be a fabrication: the model has no Bulgarian
            # in it at all. The row stays in the table so the gap is visible.
            log(f"{variant.name} {sample['id']}: SKIPPED — English-only model")
            rows.append(
                {
                    "sample": sample["id"],
                    "lang": sample["lang"],
                    "audio_seconds": sample["audio_seconds"],
                    "skipped": "English-only model — no result for this language",
                    "cold_wall_seconds": None,
                    "median_wall_seconds": None,
                    "cold_excluded_from_median": False,
                    "median_rtf": None,
                    "median_x_realtime": None,
                    "wer": None,
                    "cer": None,
                    "reps": 0,
                }
            )
            continue

        audio = Path(sample["audio"])
        language = sample["lang"] if language_hint else None
        walls: list[float] = []
        text = ""
        for _ in range(reps):
            wall, text = variant.transcribe(audio, language)
            walls.append(wall)
        # With --reps 1 there is no warm run to take a median of, so the cold
        # one is all there is. Reporting that as "median, cold excluded" would
        # be a lie in the place a reader is least likely to check it, so the row
        # says which of the two the number is.
        warm = walls[1:] or walls
        median = statistics.median(warm)
        cold_excluded = len(walls) > 1
        audio_seconds = sample["audio_seconds"]
        scores = score_transcript(sample["reference"], text)
        rows.append(
            {
                "sample": sample["id"],
                "lang": sample["lang"],
                "audio_seconds": audio_seconds,
                "cold_wall_seconds": round(walls[0], 3),
                "median_wall_seconds": round(median, 3),
                "cold_excluded_from_median": cold_excluded,
                "median_rtf": round(median / audio_seconds, 4) if audio_seconds else None,
                "median_x_realtime": round(audio_seconds / median, 2) if median and audio_seconds else None,
                "wer": scores["wer"],
                "cer": scores["cer"],
                "substitutions": scores["substitutions"],
                "insertions": scores["insertions"],
                "deletions": scores["deletions"],
                "reference_words": scores["reference_words"],
                "hypothesis": text,
                "peak_rss_kb": variant.peak_rss_kb,
                "min_mem_available_kb": variant.min_avail_kb,
                "reps": reps,
                "language_support": variant.language_support(sample["lang"]),
            }
        )
        log(
            f"{variant.name} {sample['id']}: audio {audio_seconds:.1f}s, median {median:.2f}s, "
            f"RTF {median / audio_seconds:.3f}, WER {scores['wer']}, CER {scores['cer']}"
            if audio_seconds
            else f"{variant.name} {sample['id']}: sample has no audio"
        )
    return rows


def render_markdown(report: dict) -> str:
    prov = report["provenance"]
    device = report["device"]
    lines = ["# On-device STT benchmark — faster-whisper on Orin Nano", ""]
    lines.append(f"- device: {prov.get('model') or 'unknown'} · {prov.get('uname')}")
    if prov.get("tegra_release"):
        lines.append(f"- jetpack: {prov['tegra_release']}")
    if prov.get("power_mode"):
        lines.append(f"- power mode: {prov['power_mode']}")
    lines.append(
        f"- RAM: {prov['mem_total_kb'] // 1024} MB total, "
        f"{prov['mem_available_kb_at_start'] // 1024} MB available at start"
    )
    lines.append(
        f"- compute device: **{device['resolved']}** (requested `{device['requested']}`)"
        + (f" — {device['note']}" if device.get("note") else "")
    )
    lines.append(
        f"- ctranslate2 {device.get('ctranslate2_version') or '?'}, "
        f"faster-whisper {device.get('faster_whisper_version') or '?'}"
    )
    lines.append(
        "- compute types ctranslate2 supports here: "
        f"cpu={', '.join(device.get('cpu') or []) or '—'}; "
        f"cuda={', '.join(device.get('cuda') or []) or 'none'}"
    )
    lines.append(
        f"- reps per sample: {report['reps']} "
        + (
            "(the first is the cold run and is excluded from the median)"
            if report["reps"] > 1
            else "— WITH ONE REP THE COLD RUN *IS* THE MEDIAN. Use --reps 3 or more for a number to quote."
        )
    )
    lines.append(
        f"- language passed to the model: {'the sample language' if report['language_hint'] else 'auto-detected'}"
    )
    lines.append("")
    lines.append("RTF is wall/audio: lower is faster, 0.25 = 4x real time.")
    lines.append("")
    lines.append(
        "Peak MB and min avail MB are the worker's VmHWM and the lowest MemAvailable seen, both of "
        "which only ever move one way across a variant's whole run. Read them per variant, not per "
        "row: the last row of a variant carries its true peak."
    )
    lines.append("")
    lines.append(
        f"**Memory budget.** This board has {BOARD_MEM_MB} MB SHARED between CPU and GPU. TASK-383 "
        f"measured kokoro-torch on CUDA peaking at {KOKORO_PEAK_MB[0]}-{KOKORO_PEAK_MB[1]} MB, and "
        f"clawbox-tts.sh refuses to start Kokoro below 3000 MB free. Anything shipped here has to fit "
        f"alongside that and the resident agent, so read peak RSS and the lowest MemAvailable column "
        f"together with the RTF, never the RTF alone."
    )
    lines.append("")
    if report["samples_meta"].get("synthetic"):
        lines.append(
            "**These samples are SYNTHETIC speech.** "
            + str(
                report["samples_meta"].get("warning")
                or "The reference is the exact text fed to a TTS engine, so ground truth is perfect, but the "
                "audio is cleaner than any real voice note. The WER below is a floor, not a field number."
            )
        )
        lines.append("")
    lines.append(
        "WER also counts a spelled-out number in the reference against a digit in the hypothesis as an "
        "error, so compare variants against each other before reading any single WER as an absolute."
    )
    lines.append("")
    lines.append("## Samples")
    lines.append("")
    lines.append("| sample | lang | audio s | reference words |")
    lines.append("|---|---|---|---|")
    for sample in report["samples"]:
        lines.append(
            f"| {sample['id']} | {sample['lang']} | {sample['audio_seconds']:.1f} | {sample['reference_words']} |"
        )
    lines.append("")

    def num(value, fmt: str, suffix: str = "") -> str:
        # A row that could not be measured still has to appear in the table:
        # formatting None here would take a whole benchmark run down with it.
        return f"{value:{fmt}}{suffix}" if isinstance(value, (int, float)) else "—"

    def mb(kb) -> str:
        return num(kb / 1024, ".0f") if isinstance(kb, (int, float)) else "—"

    lines.append("## Results")
    lines.append("")
    lines.append(
        "| variant | device | compute | sample | lang | audio s | load s | cold s | median s | RTF | "
        "x real-time | peak MB | min avail MB | WER | CER |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for variant in report["variants"]:
        if variant.get("skipped"):
            continue
        for row in variant["rows"]:
            lines.append(
                f"| {variant['name']} | {variant['device']} | {variant['compute_type']} | {row['sample']} | "
                f"{row['lang']} | {num(row['audio_seconds'], '.1f')} | "
                f"{num(variant['model_load_seconds'], '.1f')} | {num(row['cold_wall_seconds'], '.2f')} | "
                f"{num(row['median_wall_seconds'], '.2f')} | {num(row['median_rtf'], '.3f')} | "
                f"{num(row['median_x_realtime'], '.1f', 'x')} | {mb(row.get('peak_rss_kb'))} | "
                f"{mb(row.get('min_mem_available_kb'))} | {num(row['wer'], '.3f')} | "
                f"{num(row['cer'], '.3f')} |"
            )
    lines.append("")
    lines.append("## Language coverage")
    lines.append("")
    lines.append("| variant | english | bulgarian |")
    lines.append("|---|---|---|")
    for variant in report["variants"]:
        languages = variant["languages"]
        lines.append(f"| {variant['name']} | {languages.get('en', '—')} | {languages.get('bg', '—')} |")

    not_measured = [
        (variant["name"], row["sample"], row["skipped"])
        for variant in report["variants"]
        for row in variant["rows"]
        if row.get("skipped")
    ]
    if not_measured:
        lines.append("")
        lines.append("## Rows not measured")
        lines.append("")
        for name, sample, reason in not_measured:
            lines.append(f"- **{name}** on `{sample}`: {reason}")

    skipped = [v for v in report["variants"] if v.get("skipped")]
    if skipped:
        lines.append("")
        lines.append("## Variants not measured")
        lines.append("")
        for variant in skipped:
            lines.append(f"- **{variant['name']}**: {variant['skipped']}")

    lines.append("")
    lines.append("## Cloud baseline")
    lines.append("")
    cloud = report["cloud"]
    if cloud.get("skipped"):
        lines.append(f"- not measured ({cloud['model']}): {cloud['skipped']}")
    else:
        lines.append(f"The incumbent, `{cloud['model']}`, on exactly the same audio.")
        lines.append("")
        lines.append("| sample | lang | audio s | wall s | WER | CER |")
        lines.append("|---|---|---|---|---|---|")
        cloud_failures: list[tuple[str, str]] = []
        for row in cloud.get("rows", []):
            if row.get("skipped"):
                lines.append(f"| {row['sample']} | {row['lang']} | — | — | — | — |")
                cloud_failures.append((row["sample"], row["skipped"]))
                continue
            lines.append(
                f"| {row['sample']} | {row['lang']} | {num(row['audio_seconds'], '.1f')} | "
                f"{num(row['wall_seconds'], '.2f')} | {num(row['wer'], '.3f')} | {num(row['cer'], '.3f')} |"
            )
        for sample, reason in cloud_failures:
            lines.append("")
            lines.append(f"- `{sample}` was not transcribed by the cloud model: {reason}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models", default=DEFAULT_MODELS, help="comma-separated whisper model sizes")
    parser.add_argument("--compute", default=DEFAULT_COMPUTE, help="comma-separated ctranslate2 compute types")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--reps", type=int, default=3, help="transcriptions per sample; the first is the cold run")
    parser.add_argument("--samples", default="", help="JSON manifest of {id, lang, audio, reference}")
    parser.add_argument("--cache", default="~/stt-bench", help="where samples, piper and weights live")
    parser.add_argument("--model-cache", default="", help="download_root for whisper weights (default: the HF cache)")
    parser.add_argument("--out", default="", help="write the JSON report here")
    parser.add_argument("--markdown", default="", help="write the Markdown report here")
    parser.add_argument("--python-bin", default=sys.executable, help="interpreter used for model workers")
    parser.add_argument("--piper-bin", default="", help="piper binary used by --setup to synthesise samples")
    parser.add_argument("--piper-voices", default="", help="directory of piper voices used by --setup")
    parser.add_argument("--setup", action="store_true", help="install what is missing, fetch weights and samples, then exit")
    parser.add_argument("--no-samples", action="store_true", help="with --setup: skip synthesising the sample corpus")
    parser.add_argument("--score-only", default="", help="score {reference, hypothesis} pairs from a JSON file (- for stdin) and exit")
    parser.add_argument("--cloud-baseline", action="store_true", help=f"also transcribe with {CLOUD_MODEL} (needs OPENAI_API_KEY)")
    parser.add_argument("--cloud-model", default=CLOUD_MODEL)
    parser.add_argument("--auto-detect-language", action="store_true", help="do not tell the model the sample's language")
    parser.add_argument("--skip-missing", action="store_true", help="report unavailable variants instead of failing")
    args = parser.parse_args(argv)

    models = list(dict.fromkeys(m.strip() for m in args.models.split(",") if m.strip()))
    computes = list(dict.fromkeys(c.strip() for c in args.compute.split(",") if c.strip()))
    cache = Path(args.cache).expanduser()

    if args.score_only:
        return run_score_only(args.score_only)

    if args.setup:
        return do_setup(cache, args, models)

    if args.reps < 1:
        raise SystemExit("--reps must be at least 1")

    manifest_path = Path(args.samples).expanduser() if args.samples else cache / "samples" / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"no sample manifest at {manifest_path} — pass --samples, or run --setup to synthesise one")
    samples, samples_meta = load_samples(manifest_path)
    language_hint = not args.auto_detect_language

    probe = probe_runtime(args.python_bin)
    device, note = resolve_device(args.device, probe)
    if note:
        log(note)
    supported = probe.get(device) or []

    report = {
        "provenance": provenance(),
        "reps": args.reps,
        "language_hint": language_hint,
        "device": {
            "requested": args.device,
            "resolved": device,
            "note": note,
            "cpu": probe.get("cpu") or [],
            "cuda": probe.get("cuda") or [],
            "cuda_error": probe.get("cuda_error", ""),
            "ctranslate2_version": probe.get("ctranslate2_version", ""),
            "faster_whisper_version": probe.get("faster_whisper_version", ""),
            "probe_error": probe.get("probe_error", "") or probe.get("ctranslate2_error", ""),
        },
        "samples_manifest": str(manifest_path),
        "samples_meta": samples_meta,
        "samples": [
            {
                "id": s["id"],
                "lang": s["lang"],
                "audio": s["audio"],
                "audio_seconds": s["audio_seconds"],
                "reference": s["reference"],
                "reference_words": len(normalize_text(s["reference"]).split()),
            }
            for s in samples
        ],
        "variants": [],
        "cloud": {"model": args.cloud_model, "skipped": "--cloud-baseline not given"},
    }
    failures = []

    for model in models:
        for compute_type in computes:
            variant = Variant(model, compute_type, device, args.python_bin, args.model_cache)
            languages = {lang: variant.language_support(lang) for lang in ("en", "bg")}
            entry = {
                "name": variant.name,
                "model": model,
                "compute_type": compute_type,
                "requested_device": device,
                "device": device,
                "english_only": variant.english_only,
                "languages": languages,
                "rows": [],
            }
            # A compute type the runtime does not have is a skipped variant, not
            # a number produced somewhere else. This is the usual outcome for
            # float16 on a CPU-only wheel and it is a result worth printing.
            if supported and compute_type not in supported:
                reason = f"compute type '{compute_type}' is not supported on {device} (supported: {', '.join(supported)})"
                log(f"{variant.name}: NOT MEASURED — {reason}")
                entry["skipped"] = reason
                report["variants"].append(entry)
                failures.append(variant.name)
                continue
            reason = variant.unavailable_reason()
            if reason:
                log(f"{variant.name}: NOT MEASURED — {reason}")
                entry["skipped"] = reason
                report["variants"].append(entry)
                failures.append(variant.name)
                variant.close()
                continue
            try:
                rows = measure(variant, samples, args.reps, language_hint)
            except Exception as exc:  # noqa: BLE001 - a broken variant is a result
                log(f"{variant.name}: FAILED — {exc}")
                entry["skipped"] = str(exc)[:300]
                report["variants"].append(entry)
                failures.append(variant.name)
                continue
            finally:
                variant.close()
            entry.update(
                {
                    # Read back off the loaded model, so no number is ever
                    # printed under a device label that did not produce it.
                    "device": variant.device,
                    "compute_type": variant.actual_compute_type,
                    "requested_compute_type": compute_type,
                    "model_load_seconds": round(variant.model_load_seconds, 3),
                    "worker_startup_seconds": round(variant.startup_seconds, 3),
                    "peak_rss_kb": variant.peak_rss_kb,
                    "min_mem_available_kb": variant.min_avail_kb,
                    "rows": rows,
                }
            )
            report["variants"].append(entry)

    if args.cloud_baseline:
        report["cloud"] = measure_cloud(samples, args.cloud_model, language_hint)
        if report["cloud"].get("skipped"):
            log(f"cloud baseline: {report['cloud']['skipped']}")

    # JSON first: rendering must never be able to destroy an hour of
    # measurements on the way to the screen.
    if args.out:
        Path(args.out).expanduser().write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        log(f"wrote {args.out}")
    markdown = render_markdown(report)
    print(markdown)
    if args.markdown:
        Path(args.markdown).expanduser().write_text(markdown, encoding="utf-8")
        log(f"wrote {args.markdown}")

    if failures and not args.skip_missing:
        log(f"variants that produced no numbers: {', '.join(failures)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
