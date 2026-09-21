#!/usr/bin/env python3
"""Fetch one faster-whisper size into the Hugging Face cache.

Settings -> Local AI -> Speech to text -> a size the box does not have yet.
The route (src/app/setup-api/whisper/route.ts) spawns this with the size as
its one argument and watches the cache directory grow for the progress bar, so
everything this needs to do is download and say plainly whether it worked.

A FILE rather than `python3 -c`: the size is argv here, never text spliced into
a program. The list below is the same four sizes src/lib/local-install.ts
offers, repeated on purpose - this script is also runnable by hand, and a
downloader that trusts its caller's word for what is safe to fetch is one
mistake away from pulling a 3 GB model onto an 8 GB board.

Exit codes: 0 fetched, 1 the download failed, 2 not a size we offer,
3 faster-whisper is not installed on this box.
"""
import sys

SIZES = ("tiny", "base", "small", "medium")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fetch-whisper-model.py <%s>" % "|".join(SIZES), file=sys.stderr)
        return 2
    size = sys.argv[1]
    if size not in SIZES:
        print("Unknown Whisper size: %s" % size, file=sys.stderr)
        return 2

    try:
        from faster_whisper.utils import download_model
    except Exception as exc:  # noqa: BLE001 - any import failure is the same answer
        print("faster-whisper is not installed on this box (%s)" % exc, file=sys.stderr)
        return 3

    print("Fetching the %s model..." % size, flush=True)
    try:
        path = download_model(size)
    except Exception as exc:  # noqa: BLE001 - the reason is for a person to read
        print("Download failed: %s" % exc, file=sys.stderr)
        return 1
    print("Fetched into %s" % path, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
