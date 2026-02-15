#!/usr/bin/env python3
"""Transcribe an audio file using faster-whisper. Outputs text to stdout."""
import sys
from faster_whisper import WhisperModel

import os
os.environ.setdefault("LD_LIBRARY_PATH", "/home/clawbox/.local/lib/python3.10/site-packages/nvidia/cusparselt/lib:/usr/local/cuda/lib64")


def transcribe(audio_path, model_size="base", device=None):
    if device is None:
        try:
            import ctranslate2
            ctranslate2.get_supported_compute_types("cuda")
            device = "cuda"
        except Exception:
            device = "cpu"
    compute = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_size, device=device, compute_type=compute)
    segments, _info = model.transcribe(audio_path)
    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: stt.py <audio_file> [model_size]", file=sys.stderr)
        sys.exit(1)
    model = sys.argv[2] if len(sys.argv) > 2 else "base"
    print(transcribe(sys.argv[1], model))
