#!/usr/bin/env python3
"""Measure on-device text-to-speech on the box it will actually run on.

TASK-382 is a gate: before ClawBox ships a voice, somebody has to know what
Piper and Kokoro really cost on an Orin Nano 8GB, in Bulgarian as well as in
English. Every number in circulation for these two engines is a community
benchmark on x86 or Apple silicon, and the 8GB on this board is shared between
CPU and GPU, so a memory figure from a desktop means nothing here.

The rule this harness exists to enforce: measure, then decide. It does not pick
an engine. It produces the table TASK-383 needs, including the numbers that
make an engine unshippable.

Engines are adapters, so the set can grow (a new voice, a new runtime) without
touching the measurement code:

  piper         one process per utterance, which is how a notification voice
                would really be invoked; the process start is part of the cost
  kokoro-onnx   kokoro-onnx + onnxruntime on the CPU, model loaded once
  kokoro-torch  the runtime scripts/install-voice.sh already installs (kokoro
                + PyTorch, CUDA when the board has it), model loaded once

Method:
  * every utterance is synthesised REPS times; the first run is reported
    separately as the cold run and excluded from the median. A single run per
    case is how the August agentic benchmark ended up wrong and public.
  * real-time factor is wall / audio-seconds, so lower is faster and 0.25
    means 4x real time. Both are printed, because the two conventions get
    mixed up constantly.
  * peak memory is VmHWM (the kernel's own high-water mark) of the process
    that does the synthesis, not RSS sampled at a lucky moment.
  * the lowest MemAvailable seen during a run is recorded, so "it fits" can be
    checked against a box that also has an agent resident.

Bulgarian is a first-class result, not a footnote: an engine with no Bulgarian
voice is reported as such, and its Bulgarian audio is still written out so a
human can listen to what it does with Cyrillic instead of guessing.

Usage:
    python3 scripts/bench/tts-bench.py --setup            # fetch engines/voices
    python3 scripts/bench/tts-bench.py --reps 5 --out results.json

Exit code is non-zero when a requested engine could not run, unless
--skip-missing is given; a benchmark that silently drops an engine reads as
"we measured both" when it measured one.
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
import urllib.request
import wave
from pathlib import Path

PIPER_VERSION = "2023.11.14-2"
PIPER_TARBALL = f"https://github.com/rhasspy/piper/releases/download/{PIPER_VERSION}/piper_linux_aarch64.tar.gz"
PIPER_VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
PIPER_VOICES = {
    # lang -> (voice id, path under the voices repo)
    "en": ("en_US-lessac-medium", "en/en_US/lessac/medium"),
    "bg": ("bg_BG-dimitar-medium", "bg/bg_BG/dimitar/medium"),
}
KOKORO_ONNX_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
KOKORO_ONNX_FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")

# Every artifact is pinned. A benchmark whose engine can change under it is not
# a benchmark, and these are executables and model weights fetched over the
# network onto a device. Digests taken from the files the numbers on TASK-382
# were produced with (Orin Nano, 2026-08-19).
ARTIFACT_SHA256 = {
    "piper_linux_aarch64.tar.gz": "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    "en_US-lessac-medium.onnx": "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
    "en_US-lessac-medium.onnx.json": "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
    "bg_BG-dimitar-medium.onnx": "4972fe764468e8501416407ad81662de94cc6c9cdc680fcf807daef04e319f13",
    "bg_BG-dimitar-medium.onnx.json": "ec9a9abdd17384d3db225e83085b2f68b790b112f058417c3a8a2ac58b79e7f0",
}

# A worker that never answers must fail the run, not hang the loop overnight.
WORKER_START_TIMEOUT = float(os.environ.get("TTS_BENCH_START_TIMEOUT", "600"))
WORKER_SYNTH_TIMEOUT = float(os.environ.get("TTS_BENCH_SYNTH_TIMEOUT", "300"))

# Two sentences a ClawBox actually says, in both languages, plus a long one:
# a notification voice and a "read this answer to me" voice have different
# cost profiles and TASK-383 wants to use a different engine for each.
DEFAULT_UTTERANCES = [
    {"id": "en-short", "lang": "en", "text": "Your ClawBox is ready."},
    {
        "id": "en-medium",
        "lang": "en",
        "text": "I finished the update and restarted the gateway. Everything is running normally again.",
    },
    {
        "id": "en-long",
        "lang": "en",
        "text": (
            "Here is what I found. The backup ran at three in the morning and copied four gigabytes "
            "to the external drive. Two files were skipped because they were open at the time, and I "
            "will retry those tonight. Nothing else needs your attention right now."
        ),
    },
    {"id": "bg-short", "lang": "bg", "text": "Кутията ви е готова."},
    {
        "id": "bg-medium",
        "lang": "bg",
        "text": "Обновяването приключи и рестартирах шлюза. Всичко работи нормално отново.",
    },
]


def log(msg: str) -> None:
    print(f"  [tts-bench] {msg}", flush=True)


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

    VmHWM disappears with the process, so a one-shot engine has to be sampled
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

    Python 3.12 has `filter="data"` for this; the box runs 3.10, so the check
    is explicit rather than assumed.
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
        tar.extractall(dest)


# --- engines -----------------------------------------------------------------


class Engine:
    name = "engine"
    # Whether the engine has a real voice for the language, or is being handed
    # text its phonemiser was never built for.
    languages: dict[str, str] = {}

    def unavailable_reason(self) -> str | None:
        raise NotImplementedError

    def synth(self, text: str, lang: str, out: Path) -> tuple[float, float, int]:
        """Return (wall_seconds, audio_seconds, peak_rss_kb)."""
        raise NotImplementedError

    def close(self) -> None:
        pass

    def language_support(self, lang: str) -> str:
        return self.languages.get(lang, "no voice for this language")


class PiperEngine(Engine):
    name = "piper"
    languages = {
        "en": "native voice (en_US-lessac-medium)",
        "bg": "native voice (bg_BG-dimitar-medium)",
    }

    def __init__(self, binary: Path, voice_dir: Path):
        self.binary = binary
        self.voice_dir = voice_dir

    def unavailable_reason(self) -> str | None:
        if not self.binary.exists():
            return f"piper binary not found at {self.binary} (run --setup)"
        missing = [
            v
            for v, _ in PIPER_VOICES.values()
            if not (self.voice_dir / f"{v}.onnx").exists()
        ]
        if missing:
            return f"missing voice models: {', '.join(missing)} (run --setup)"
        return None

    def synth(self, text: str, lang: str, out: Path) -> tuple[float, float, int]:
        voice, _ = PIPER_VOICES[lang]
        env = dict(os.environ)
        # The release tarball ships its own onnxruntime and espeak-ng data next
        # to the binary.
        # An empty entry in LD_LIBRARY_PATH means "the current directory" to the
        # loader, which is not somewhere a benchmark should be resolving .so files.
        existing = env.get("LD_LIBRARY_PATH", "")
        env["LD_LIBRARY_PATH"] = f"{self.binary.parent}:{existing}" if existing else str(self.binary.parent)
        cmd = [
            str(self.binary),
            "-m",
            str(self.voice_dir / f"{voice}.onnx"),
            "-f",
            str(out),
        ]
        start = time.monotonic()
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env=env,
        )
        with Sampler(proc.pid) as sampler:
            try:
                _, err = proc.communicate(text.encode("utf-8"), timeout=WORKER_SYNTH_TIMEOUT)
            except subprocess.TimeoutExpired:
                # Left alive, it would keep writing into the output file while
                # the next rep is being timed.
                proc.kill()
                proc.communicate()
                raise RuntimeError(f"piper did not finish within {WORKER_SYNTH_TIMEOUT:.0f}s")
        wall = time.monotonic() - start
        if proc.returncode != 0:
            raise RuntimeError(f"piper exited {proc.returncode}: {err.decode('utf-8', 'replace')[:300]}")
        self.min_avail_kb = sampler.min_avail_kb
        return wall, wav_seconds(out), sampler.peak_rss_kb


# Kokoro, torch and spaCy all write banners to stdout before the worker gets a
# word in, so every line the parent cares about is tagged. Anything untagged is
# somebody else's noise and is skipped rather than parsed and blamed.
WORKER_TAG = "__ttsbench__ "

WORKER_SRC = r'''
import json, os, sys, time, wave

TAG = "__ttsbench__ "
def emit(payload):
    print(TAG + json.dumps(payload), flush=True)

MODE = sys.argv[1]
model_dir = sys.argv[2] if len(sys.argv) > 2 else ""

def hwm_kb():
    try:
        for line in open("/proc/self/status"):
            if line.startswith("VmHWM:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0

def write_wav(path, samples, rate):
    import numpy as np
    data = np.asarray(samples, dtype="float32")
    clipped = np.clip(data, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm.tobytes())

if MODE == "kokoro-onnx":
    from kokoro_onnx import Kokoro
    engine = Kokoro(os.path.join(model_dir, "kokoro-v1.0.onnx"),
                    os.path.join(model_dir, "voices-v1.0.bin"))
    def speak(text, lang):
        samples, rate = engine.create(text, voice="af_heart", speed=1.0, lang="en-us")
        return samples, rate
elif MODE == "kokoro-torch":
    from kokoro import KPipeline
    import numpy as np
    pipeline = KPipeline(lang_code="a")
    device = str(next(pipeline.model.parameters()).device)
    def speak(text, lang):
        chunks = [audio for _, _, audio in pipeline(text, voice="af_heart")]
        if not chunks:
            return np.zeros(0, dtype="float32"), 24000
        joined = np.concatenate([np.asarray(c, dtype="float32") for c in chunks])
        return joined, 24000
else:
    raise SystemExit("unknown worker mode: " + MODE)

# The model is loaded; the parent times synthesis only from here on.
emit({"ready": True, "rss_kb": hwm_kb(),
      "device": device if MODE == "kokoro-torch" else "cpu"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    if req.get("quit"):
        break
    start = time.monotonic()
    samples, rate = speak(req["text"], req.get("lang", "en"))
    wall = time.monotonic() - start
    write_wav(req["out"], samples, rate)
    emit({"wall": wall, "audio": len(samples) / float(rate), "rss_kb": hwm_kb()})
'''


class WorkerEngine(Engine):
    """An engine that keeps its model loaded in a child process.

    Loading Kokoro costs seconds; charging that to every utterance would
    measure the loader, not the synthesiser. The worker also reports its own
    VmHWM, which is the only honest peak for a process that outlives one call.
    """

    def __init__(self, name: str, mode: str, python_bin: str, model_dir: Path):
        self.name = name
        self.mode = mode
        self.python_bin = python_bin
        self.model_dir = model_dir
        self.proc: subprocess.Popen | None = None
        self.load_seconds = 0.0
        self.device = "unknown"
        self.peak_rss_kb = 0
        # stderr goes to a file, never a pipe nobody drains: torch on this board
        # is chatty enough to fill a pipe buffer and deadlock before the model
        # has even loaded.
        self._stderr_file = None

    def _stderr_tail(self, limit: int = 500) -> str:
        if self._stderr_file is None:
            return ""
        try:
            path = Path(self._stderr_file.name)
            data = path.read_bytes()
        except OSError:
            return ""
        return data[-limit:].decode("utf-8", "replace").strip()

    def _start(self) -> subprocess.Popen:
        if self.proc is not None:
            return self.proc
        start = time.monotonic()
        self._stderr_file = tempfile.NamedTemporaryFile(prefix=f"tts-bench-{self.name}-", suffix=".err")
        proc = subprocess.Popen(
            [self.python_bin, "-c", WORKER_SRC, self.mode, str(self.model_dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_file,
            text=True,
        )
        try:
            info = self._read_tagged(proc, "worker did not start", WORKER_START_TIMEOUT)
        except Exception:
            proc.kill()
            proc.wait(timeout=10)
            self._close_stderr()
            raise
        self.load_seconds = time.monotonic() - start
        self.device = info.get("device", "unknown")
        self.peak_rss_kb = int(info.get("rss_kb", 0))
        self.proc = proc
        return proc

    def _close_stderr(self) -> None:
        if self._stderr_file is not None:
            try:
                self._stderr_file.close()
            except OSError:
                pass
            self._stderr_file = None

    def _read_tagged(self, proc: subprocess.Popen, what: str, timeout: float) -> dict:
        """Return the next tagged line, stepping over library banners.

        The deadline is enforced by killing the worker rather than by polling
        the pipe: `select` on a text-mode pipe reports "nothing to read" while
        a complete line is already sitting in Python's own buffer, which
        deadlocks on exactly the fast workers it is meant to protect. Killing
        the child turns any hang — no answer, or stdout closed while the
        process lives on — into an EOF this loop can report.
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
                        raise RuntimeError(f"{self.name} {what}: no answer within {timeout:.0f}s")
                    raise RuntimeError(f"{self.name} {what}: {self._stderr_tail() or 'no output'}")
                if line.startswith(WORKER_TAG):
                    return json.loads(line[len(WORKER_TAG):])
        finally:
            watchdog.cancel()

    def unavailable_reason(self) -> str | None:
        try:
            self._start()
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            return str(exc)[:300]
        return None

    def synth(self, text: str, lang: str, out: Path) -> tuple[float, float, int]:
        proc = self._start()
        assert proc.stdin and proc.stdout
        with Sampler(None) as sampler:
            proc.stdin.write(json.dumps({"text": text, "lang": lang, "out": str(out)}) + "\n")
            proc.stdin.flush()
            res = self._read_tagged(proc, "worker died mid-run", WORKER_SYNTH_TIMEOUT)
        self.peak_rss_kb = max(self.peak_rss_kb, int(res.get("rss_kb", 0)))
        self.min_avail_kb = sampler.min_avail_kb
        return float(res["wall"]), float(res["audio"]), self.peak_rss_kb

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


class KokoroOnnxEngine(WorkerEngine):
    languages = {
        "en": "native voice (af_heart)",
        "bg": "NO Bulgarian voice — Cyrillic is phonemised with the English G2P",
    }


class KokoroTorchEngine(WorkerEngine):
    languages = {
        "en": "native voice (af_heart)",
        "bg": "NO Bulgarian voice — Cyrillic is phonemised with the English G2P",
    }


# --- setup -------------------------------------------------------------------


def do_setup(cache: Path, engines: list[str]) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    if "piper" in engines:
        piper_dir = cache / "piper"
        if not (piper_dir / "piper").exists():
            tarball = cache / "piper_linux_aarch64.tar.gz"
            download(PIPER_TARBALL, tarball, ARTIFACT_SHA256["piper_linux_aarch64.tar.gz"])
            safe_extract(tarball, cache)
            tarball.unlink(missing_ok=True)
        voices = cache / "voices"
        voices.mkdir(exist_ok=True)
        for voice, path in PIPER_VOICES.values():
            for suffix in (".onnx", ".onnx.json"):
                name = f"{voice}{suffix}"
                download(f"{PIPER_VOICES_BASE}/{path}/{name}", voices / name, ARTIFACT_SHA256.get(name))
    if "kokoro-onnx" in engines:
        for name in KOKORO_ONNX_FILES:
            download(f"{KOKORO_ONNX_BASE}/{name}", cache / name, ARTIFACT_SHA256.get(name))
    log("setup complete")


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


def measure(engine: Engine, utterances: list[dict], reps: int, audio_dir: Path) -> list[dict]:
    rows = []
    for utt in utterances:
        walls: list[float] = []
        audio_seconds = 0.0
        peak_rss_kb = 0
        min_avail_kb = mem_available_kb()
        for rep in range(reps):
            out = audio_dir / f"{engine.name}_{utt['id']}_{rep}.wav"
            wall, audio, rss = engine.synth(utt["text"], utt["lang"], out)
            walls.append(wall)
            audio_seconds = audio
            peak_rss_kb = max(peak_rss_kb, rss)
            min_avail_kb = min(min_avail_kb, getattr(engine, "min_avail_kb", min_avail_kb))
            # Only the last rep's audio is kept, so a human has one file per
            # case to listen to instead of REPS copies.
            if rep < reps - 1:
                out.unlink(missing_ok=True)
        warm = walls[1:] or walls
        rows.append(
            {
                "utterance": utt["id"],
                "lang": utt["lang"],
                "audio_seconds": round(audio_seconds, 3),
                "cold_wall_seconds": round(walls[0], 3),
                "median_wall_seconds": round(statistics.median(warm), 3),
                "median_rtf": round(statistics.median(warm) / audio_seconds, 4) if audio_seconds else None,
                "median_x_realtime": round(audio_seconds / statistics.median(warm), 2) if statistics.median(warm) else None,
                "peak_rss_kb": peak_rss_kb,
                "min_mem_available_kb": min_avail_kb,
                "reps": reps,
                "audio_sample": str(audio_dir / f"{engine.name}_{utt['id']}_{reps - 1}.wav"),
                "language_support": engine.language_support(utt["lang"]),
            }
        )
        log(
            f"{engine.name} {utt['id']}: audio {audio_seconds:.2f}s, "
            f"median {statistics.median(warm):.2f}s, RTF {statistics.median(warm) / audio_seconds:.3f}"
            if audio_seconds
            else f"{engine.name} {utt['id']}: produced no audio"
        )
    return rows


def render_markdown(report: dict) -> str:
    lines = ["# On-device TTS benchmark — Orin Nano", ""]
    prov = report["provenance"]
    lines.append(f"- device: {prov.get('model') or 'unknown'} · {prov.get('uname')}")
    if prov.get("tegra_release"):
        lines.append(f"- jetpack: {prov['tegra_release']}")
    if prov.get("power_mode"):
        lines.append(f"- power mode: {prov['power_mode']}")
    lines.append(f"- RAM: {prov['mem_total_kb'] // 1024} MB total, {prov['mem_available_kb_at_start'] // 1024} MB available at start")
    lines.append(f"- reps per utterance: {report['reps']} (first excluded from the median)")
    lines.append("")
    lines.append("RTF is wall/audio: lower is faster, 0.25 = 4x real time.")
    lines.append("")
    lines.append("| engine | utterance | lang | audio s | cold s | median s | RTF | x real-time | peak RSS MB |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    def num(value, fmt: str, suffix: str = "") -> str:
        # An engine that produced no audio still has to appear in the table:
        # formatting None here would take a whole benchmark run down with it.
        return f"{value:{fmt}}{suffix}" if isinstance(value, (int, float)) else "—"

    for engine in report["engines"]:
        if engine.get("skipped"):
            continue
        for row in engine["rows"]:
            lines.append(
                f"| {engine['name']} | {row['utterance']} | {row['lang']} | {num(row['audio_seconds'], '.2f')} | "
                f"{num(row['cold_wall_seconds'], '.2f')} | {num(row['median_wall_seconds'], '.2f')} | "
                f"{num(row['median_rtf'], '.3f')} | {num(row['median_x_realtime'], '.1f', 'x')} | "
                f"{num(row['peak_rss_kb'] / 1024, '.0f')} |"
            )
    lines.append("")
    lines.append("## Language support")
    lines.append("")
    lines.append("| engine | english | bulgarian |")
    lines.append("|---|---|---|")
    for engine in report["engines"]:
        lines.append(f"| {engine['name']} | {engine['languages'].get('en', '—')} | {engine['languages'].get('bg', '—')} |")
    skipped = [e for e in report["engines"] if e.get("skipped")]
    if skipped:
        lines.append("")
        lines.append("## Not measured")
        lines.append("")
        for engine in skipped:
            lines.append(f"- **{engine['name']}**: {engine['skipped']}")
    return "\n".join(lines) + "\n"


def build_engines(args: argparse.Namespace) -> list[Engine]:
    cache = Path(args.cache).expanduser()
    built: list[Engine] = []
    for name in args.engines:
        if name == "piper":
            built.append(
                PiperEngine(
                    Path(args.piper_bin).expanduser() if args.piper_bin else cache / "piper" / "piper",
                    Path(args.piper_voices).expanduser() if args.piper_voices else cache / "voices",
                )
            )
        elif name == "kokoro-onnx":
            built.append(KokoroOnnxEngine(name, "kokoro-onnx", args.python_bin, cache))
        elif name == "kokoro-torch":
            built.append(KokoroTorchEngine(name, "kokoro-torch", args.python_bin, cache))
        else:
            raise SystemExit(f"unknown engine: {name}")
    return built


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engines", default="piper,kokoro-onnx,kokoro-torch", help="comma-separated engine list")
    parser.add_argument("--reps", type=int, default=5)
    parser.add_argument("--cache", default="~/tts-bench", help="where engines, voices and models live")
    parser.add_argument("--audio-dir", default="", help="where sample WAVs are written (default: <cache>/audio)")
    parser.add_argument("--out", default="", help="write the JSON report here")
    parser.add_argument("--markdown", default="", help="write the Markdown report here")
    parser.add_argument("--utterances", default="", help="JSON file overriding the default utterance set")
    parser.add_argument("--python-bin", default=sys.executable, help="interpreter used for model workers")
    parser.add_argument("--piper-bin", default="")
    parser.add_argument("--piper-voices", default="")
    parser.add_argument("--setup", action="store_true", help="download engines and voices, then exit")
    parser.add_argument("--skip-missing", action="store_true", help="report unavailable engines instead of failing")
    args = parser.parse_args(argv)

    args.engines = [e.strip() for e in args.engines.split(",") if e.strip()]
    cache = Path(args.cache).expanduser()

    if args.setup:
        do_setup(cache, args.engines)
        return 0

    utterances = DEFAULT_UTTERANCES
    if args.utterances:
        utterances = json.loads(Path(args.utterances).read_text())
    if args.reps < 1:
        raise SystemExit("--reps must be at least 1")

    audio_dir = Path(args.audio_dir).expanduser() if args.audio_dir else cache / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    report = {"provenance": provenance(), "reps": args.reps, "engines": []}
    failures = []

    for engine in build_engines(args):
        reason = engine.unavailable_reason()
        if reason:
            log(f"{engine.name}: NOT MEASURED — {reason}")
            report["engines"].append(
                {"name": engine.name, "languages": engine.languages, "skipped": reason, "rows": []}
            )
            failures.append(engine.name)
            continue
        try:
            rows = measure(engine, utterances, args.reps, audio_dir)
        except Exception as exc:  # noqa: BLE001 - a broken engine is a result
            log(f"{engine.name}: FAILED — {exc}")
            report["engines"].append(
                {"name": engine.name, "languages": engine.languages, "skipped": str(exc)[:300], "rows": []}
            )
            failures.append(engine.name)
            continue
        finally:
            engine.close()
        report["engines"].append(
            {
                "name": engine.name,
                "languages": engine.languages,
                "device": getattr(engine, "device", "cpu"),
                "model_load_seconds": round(getattr(engine, "load_seconds", 0.0), 3),
                "rows": rows,
            }
        )

    # JSON first: rendering must never be able to destroy an hour of
    # measurements on the way to the screen.
    if args.out:
        Path(args.out).expanduser().write_text(json.dumps(report, indent=2, ensure_ascii=False))
        log(f"wrote {args.out}")
    markdown = render_markdown(report)
    print(markdown)
    if args.markdown:
        Path(args.markdown).expanduser().write_text(markdown)
        log(f"wrote {args.markdown}")

    if failures and not args.skip_missing:
        log(f"engines that produced no numbers: {', '.join(failures)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
