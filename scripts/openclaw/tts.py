#!/usr/bin/env python3
"""Generate speech from text using Kokoro TTS. Outputs WAV then converts to OGG/Opus."""
import os
import sys
import subprocess
import tempfile
import soundfile as sf
from kokoro import KPipeline
import numpy as np

def synthesize(text, output_path, voice="af_heart", lang="a"):
    pipeline = KPipeline(lang_code=lang)
    chunks = []
    for _, _, audio in pipeline(text, voice=voice):
        chunks.append(audio)
    if not chunks:
        raise RuntimeError("Kokoro produced no audio output")
    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

    # Write WAV first
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
    sf.write(wav_path, audio, 24000)

    # Convert to OGG Opus (Telegram voice format)
    subprocess.run([
        "ffmpeg", "-y", "-i", wav_path,
        "-c:a", "libopus", "-b:a", "64k", "-ar", "48000",
        "-application", "voip",
        output_path
    ], capture_output=True, check=True)

    os.unlink(wav_path)
    return output_path

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: tts.py <text> <output.ogg> [voice]", file=sys.stderr)
        sys.exit(1)
    voice = sys.argv[3] if len(sys.argv) > 3 else "af_heart"
    result = synthesize(sys.argv[1], sys.argv[2], voice)
    print(result)
