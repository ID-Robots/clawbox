#!/usr/bin/env python3
"""Describe a video for OpenClaw's media understanding, from its frames.

OpenClaw runs this as the `type: "cli"` row scripts/gateway-pre-start.sh writes
into tools.media.models (capabilities: ["video"]) and reads the description it
prints. No new provider is involved: a few frames are pulled out of the clip
with ffmpeg and sent, in one request, to the ClawBox AI vision model this box
already has, meaning the `deepseek` provider entry in openclaw.json with its
proxy address, its claw_ token and its image-capable model. The sound track is
not used.

    clawai-video-describe.py [--max-chars N] [--prompt TEXT] [--config PATH] VIDEO

Exit 0 with the description on stdout. Anything else is a failure OpenClaw
records before it tries the next model, with the reason on stderr. The token
is never printed.
"""
import argparse
import base64
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# The per-clip frame budget. A clip costs one vision request carrying at most
# this many images, however long it runs.
MAX_FRAMES = 8
# Longest frame side in pixels. Frames are scaled down to it, never up.
FRAME_EDGE = 768
# OpenClaw gives a video row 120 s by default (tools.media.video.timeoutSeconds).
# The helper finishes inside that so its own error, not the core's timeout, is
# what gets recorded.
DEADLINE_S = 110
FRAMES_BUDGET_S = 40
MAX_TOKENS = 1500
DEFAULT_PROMPT = "Describe the video."
DEFAULT_PROXY = "https://clawbox.com/api/ai"
PROVIDER_ID = "deepseek"


class Failure(Exception):
    """A reason this clip cannot be described, worded for the gateway log."""


def _arg(value):
    """A template OpenClaw left unresolved (`{{Prompt}}`) is no value at all."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or re.fullmatch(r"\{\{[A-Za-z]+\}\}", value):
        return None
    return value


def _config_path(explicit):
    if explicit:
        return os.path.expanduser(explicit)
    env_path = (os.environ.get("OPENCLAW_CONFIG_PATH") or "").strip()
    if env_path:
        return os.path.expanduser(env_path)
    state = (os.environ.get("OPENCLAW_STATE_DIR") or "").strip()
    if state:
        return os.path.join(os.path.expanduser(state), "openclaw.json")
    return os.path.join(os.path.expanduser("~"), ".openclaw", "openclaw.json")


def _route(config_path):
    """(proxy base URL, claw_ token, vision model id) for this box."""
    try:
        with open(config_path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception as err:
        raise Failure("cannot read the gateway config (%s)" % type(err).__name__)
    models = cfg.get("models") if isinstance(cfg, dict) else None
    providers = models.get("providers") if isinstance(models, dict) else None
    provider = providers.get(PROVIDER_ID) if isinstance(providers, dict) else None
    if not isinstance(provider, dict):
        raise Failure("this box is not paired to ClawBox AI")
    token = provider.get("apiKey")
    if not isinstance(token, str) or not token.startswith("claw_"):
        raise Failure("this box is not paired to ClawBox AI")

    capable = [
        m.get("id")
        for m in (provider.get("models") if isinstance(provider.get("models"), list) else [])
        if isinstance(m, dict)
        and isinstance(m.get("id"), str)
        and m.get("id").strip()
        and isinstance(m.get("input"), list)
        and "image" in m.get("input")
    ]
    if not capable:
        raise Failure("there is no ClawBox AI vision model to send the frames to")
    # The image model the box looks at pictures with, when it is one of these;
    # otherwise the first vision entry the provider defines.
    agents = cfg.get("agents") if isinstance(cfg.get("agents"), dict) else {}
    defaults = agents.get("defaults") if isinstance(agents.get("defaults"), dict) else {}
    image_model = defaults.get("imageModel")
    primary = image_model.get("primary") if isinstance(image_model, dict) else image_model
    model = capable[0]
    if isinstance(primary, str) and primary.strip().startswith(PROVIDER_ID + "/"):
        wanted = primary.strip()[len(PROVIDER_ID) + 1:]
        if wanted in capable:
            model = wanted

    base = provider.get("baseUrl")
    if not isinstance(base, str) or not base.strip():
        base = (os.environ.get("CLAWBOX_AI_PROXY_URL") or "").strip() or DEFAULT_PROXY
    return base.strip().rstrip("/"), token, model


def _duration(video, deadline):
    """Seconds of video, or None when nothing could say."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            out = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", video],
                capture_output=True, text=True, timeout=max(1.0, min(15.0, deadline - time.monotonic())),
            )
            value = float(out.stdout.strip().splitlines()[0])
            if math.isfinite(value) and value > 0:
                return value
        except Exception:
            pass
    return None


def _frame_times(duration):
    if duration is None:
        # Unknown length: one frame a second from the start, up to the budget.
        return [float(i) for i in range(MAX_FRAMES)]
    count = MAX_FRAMES if duration >= MAX_FRAMES else max(1, int(duration))
    # Mid-slot times: never the very first black frame, never past the end.
    return [round((i + 0.5) * duration / count, 3) for i in range(count)]


def _frames(video, times, workdir, deadline):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise Failure("ffmpeg is not installed")
    scale = (
        "scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease"
        % (FRAME_EDGE, FRAME_EDGE)
    )
    frames = []
    budget_end = min(deadline, time.monotonic() + FRAMES_BUDGET_S)
    for index, at in enumerate(times):
        remaining = budget_end - time.monotonic()
        if remaining <= 1:
            break
        out = os.path.join(workdir, "frame-%02d.jpg" % index)
        try:
            subprocess.run(
                [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                 "-ss", "%.3f" % at, "-i", video, "-frames:v", "1", "-an",
                 "-vf", scale, "-q:v", "5", "-y", out],
                capture_output=True, timeout=remaining,
            )
        except subprocess.TimeoutExpired:
            break
        if os.path.isfile(out) and os.path.getsize(out) > 0:
            with open(out, "rb") as fh:
                frames.append((at, base64.b64encode(fh.read()).decode("ascii")))
    if not frames:
        raise Failure("could not read any frame from the video")
    return frames


def _instruction(frames, duration, prompt, max_chars):
    stamps = ", ".join("%gs" % at for at, _ in frames)
    length = " of about %d s" % round(duration) if duration else ""
    text = (
        "The %d images are frames taken in order from one video%s, at %s. "
        "There is no sound track. Treat them as the video itself and describe what happens "
        "across it, not each picture separately.\n\n%s"
        % (len(frames), length, stamps, prompt)
    )
    if max_chars:
        text += "\n\nAnswer in at most %d characters." % max_chars
    return text


def _describe(base, token, model, text, frames, deadline):
    content = [{"type": "text", "text": text}] + [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + data}}
        for _, data in frames
    ]
    body = json.dumps({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [{"role": "user", "content": content}],
    }).encode("utf-8")
    req = urllib.request.Request(
        base + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    timeout = max(5.0, deadline - time.monotonic())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read(300).decode("utf-8", "replace").replace(token, "[token]").strip()
        except Exception:
            pass
        raise Failure("the ClawBox AI vision request failed: HTTP %d %s" % (err.code, detail))
    except Exception as err:
        raise Failure("the ClawBox AI vision request failed: %s" % type(err).__name__)

    choices = payload.get("choices") if isinstance(payload, dict) else None
    message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    answer = message.get("content") if isinstance(message, dict) else None
    if isinstance(answer, list):
        answer = "".join(
            part.get("text", "") for part in answer if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    if not isinstance(answer, str) or not answer.strip():
        raise Failure("the ClawBox AI vision model returned no description")
    return answer.strip()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Describe a video from its frames with the ClawBox AI vision model.")
    parser.add_argument("video")
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--max-chars", default=None)
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    deadline = time.monotonic() + DEADLINE_S
    prompt = _arg(args.prompt) or DEFAULT_PROMPT
    max_chars_raw = _arg(args.max_chars)
    max_chars = int(max_chars_raw) if max_chars_raw and max_chars_raw.isdigit() and int(max_chars_raw) > 0 else None

    try:
        if not os.path.isfile(args.video):
            raise Failure("the video file is missing")
        base, token, model = _route(_config_path(args.config))
        workdir = tempfile.mkdtemp(prefix="clawai-video-")
        try:
            duration = _duration(args.video, deadline)
            frames = _frames(args.video, _frame_times(duration), workdir, deadline)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        answer = _describe(base, token, model, _instruction(frames, duration, prompt, max_chars), frames, deadline)
    except Failure as err:
        print("clawai-video-describe: %s" % err, file=sys.stderr)
        return 1
    if max_chars and len(answer) > max_chars:
        answer = answer[:max_chars].rstrip()
    print(answer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
