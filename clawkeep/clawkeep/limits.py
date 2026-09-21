"""The one bound on any subprocess this daemon runs.

Declared on its own so `openclaw.py` and `crypto.py` cannot answer the
question differently — they are steps of the same run, and a run has one
bound.

It is the daemon's own number: `clawkeep/systemd/clawkeepd.service` declares
`TimeoutStartSec=4h` for one whole run, and no single step inside that run may
be given less than the run itself. A per-step cap tighter than the run cap
turns "this step is slow" into "this backup failed" for precisely the step
that is slow.

They WERE tighter, and all of them were written when a ClawBox backup was
~1 GB: 30 minutes for `openclaw backup create` ("tarballing ~1GB on Jetson
takes minutes"), 5 minutes for `openclaw backup verify`, and 30 minutes for
each of `openssl enc` and `openssl enc -d`. TASK-675 made 10 GB+ archives the
supported case — `backup create --verify` tars and gzips the whole tree off
eMMC and then reads it back, `openssl` streams the whole archive twice more,
and the validated 12 GiB run took ~86 minutes end to end. Those defaults, not
the TS bridge's kill timer, were the first walls a large backup hit.

The encrypt and decrypt steps run OUTSIDE any edition branch
(`runner.py`, `restore.py`), so this bound applies on the Hermes edition too.
The archive and verify steps are the ones that differ between the backends:
`hermes.py` shells out for neither — it tars with `tarfile` and verifies the
manifest in process — so on that edition these two subprocesses are all there
is to cap.
"""

from __future__ import annotations

#: Seconds. See the module docstring; kept in step with
#: `clawkeep/systemd/clawkeepd.service`'s `TimeoutStartSec` by
#: `src/tests/unit/clawkeep-backup-run-cap.test.ts`.
SUBPROCESS_TIMEOUT_S = 4 * 60 * 60
