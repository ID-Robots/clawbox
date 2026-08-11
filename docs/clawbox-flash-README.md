# ClawBox flash host — operator runbook

> **This file is staged content for a different repository.** It is the intended
> `README.md` of the private `clawbox-flash` repo, which lives on the flash host
> at `~/Projects/clawbox-flash/`. It is kept here only so it is under review and
> version control until it can be placed. Move it, do not link to it.

---

Flashing a Jetson Orin Nano into a ClawBox: what to run, what has to be true
before you run it, and how to tell a real success from a log that merely looks
like one.

## The command

Two wrappers around one script. The **only** difference between them is which
edition the device becomes.

```bash
# Hermes edition
cd ~/Projects/clawbox-flash \
  && git -C ~/Documents/clawbox fetch origin \
  && git -C ~/Documents/clawbox checkout beta \
  && git -C ~/Documents/clawbox pull \
  && CLAWBOX_VERSION=beta ./flash-hermes.sh

# OpenClaw edition — same line, different wrapper
cd ~/Projects/clawbox-flash \
  && git -C ~/Documents/clawbox fetch origin \
  && git -C ~/Documents/clawbox checkout beta \
  && git -C ~/Documents/clawbox pull \
  && CLAWBOX_VERSION=beta ./flash-default.sh
```

Substitute `main` for `beta` to build a release device. The git block is not
optional — see the next section for why.

Both wrappers pass every flag straight through to `flash.sh`, so
`./flash-hermes.sh --setup-only --ip=192.0.2.10` works exactly as it would on
`flash.sh` itself.

## The branch rule — read this once, properly

Two different things decide two different outcomes, and they are easy to
conflate:

| | Set by | Decides |
|---|---|---|
| What the device **RUNS** | the working copy at `~/Documents/clawbox` | Phase 3 rsyncs that directory onto the device and runs its `install.sh` |
| What the device **TRACKS** | `CLAWBOX_VERSION` | which branch `install.sh` follows for later updates |

**The repo is never cloned on the device.** Whatever is checked out on this host
is what ships — uncommitted edits included. `CLAWBOX_VERSION` only writes down
the branch name for the updater.

Getting these out of step means flashing one branch while believing you tested
another, so there is a pre-flight guard: if the checked-out branch does not
match `CLAWBOX_VERSION`, the script refuses to flash and prints the exact
`git` command that fixes it. That is why the one-liner above syncs the working
copy first.

```bash
ALLOW_BRANCH_MISMATCH=1 ./flash-hermes.sh    # deliberate mismatch, e.g. a test build
```

The pre-flight also prints the branch, the HEAD commit, and a warning if the
working copy is dirty. Read those three lines before you walk away.

## Before you start

Every one of these has cost a wasted flash at least once.

- **The board is in recovery mode.** Confirm, don't assume:
  `lsusb | grep -c 0955:7523` → `1`.
- **USB goes directly from the host to the board. Never through a hub.**
- **The board is on Ethernet, on the same LAN as the host.** Phase 3 finds the
  device by diffing an ARP scan of the local subnet; a device that comes up on a
  different network is never found.
- **The host is on mains power and on the network.** A flash is not a laptop-on-
  battery operation.
- **`usbfs_memory_mb` is raised.** NVIDIA's flashing tools need it; the kernel
  default of 16 is far too small:

  ```bash
  sudo sh -c 'echo 1000 > /sys/module/usbcore/parameters/usbfs_memory_mb'
  cat /sys/module/usbcore/parameters/usbfs_memory_mb    # expect 1000
  ```

  This resets to 16 on every reboot. Worth making permanent
  (`usbcore.usbfs_memory_mb=1000` on the kernel command line) rather than
  remembering it each time.
- **ModemManager is stopped.** It probes new USB serial devices and interferes
  with the flash:

  ```bash
  sudo systemctl stop ModemManager
  # afterwards: sudo systemctl start ModemManager
  ```

- **Tooling is present:** `arp-scan`, `sshpass`, `rsync`, `lsusb`.
- **The local portmapper answers.** The flash tool serves the image over NFS, so
  `rpcinfo -p 127.0.0.1` must succeed. A stale `rpcbind` makes the tool abort
  with *"another rpcbind is already running"*; killing it and stopping there is
  worse, because the tool then dies with *"NFS server is not running"* and the
  failure surfaces later as an empty device scan.

## What actually happens

| Phase | What it does |
|---|---|
| **0** | Prepares the source rootfs so the device does not stop at NVIDIA's first-boot wizard, and masks the apt auto-update timers that otherwise grab the apt lock and break the Node install |
| **1** | Builds the massflash package, if one does not already exist. Slow, and only needed once per JetPack level — `--regen` forces a rebuild |
| **2** | Flashes every board currently in recovery, using that package |
| **3** | Waits for the flashed device to appear on the LAN, rsyncs `~/Documents/clawbox` to it, and runs `install.sh` over SSH with `CLAWBOX_BRANCH` and `CLAWBOX_EDITION` set |

Phase 3 is where the edition is actually applied: `install.sh` reads
`CLAWBOX_EDITION` ahead of every other source and bakes it into the root-owned
`/etc/clawbox/edition.env` on the device.

### Flags

| Flag | Use it when |
|---|---|
| `--regen` | The massflash package is stale or the JetPack level changed. Deletes and rebuilds it, then exits |
| `--setup-only` | The board is already flashed and on the LAN — skip phases 0–2 and just re-run the rsync + install |
| `--ip=X.X.X.X` | LAN discovery failed, or you know the address. Repeatable for several devices |

`--setup-only --ip=...` is the standard recovery from *"the flash worked but
Phase 3 timed out"*.

### Speeding it up

If `llamacpp-prebuilt.tar.gz` is present in the repo directory, it is copied to
each device and used instead of compiling llama.cpp there — roughly 19 minutes
saved per device. The script prints which path it is taking on startup. Build
one from a Jetson at the same JetPack level:

```bash
tar -czf llamacpp-prebuilt.tar.gz -C ~/llama.cpp/build/bin .
```

## Did it work?

### The one check that matters

```bash
lsusb | grep -c 0955:7523
```

- **`0`** — the board took the image and rebooted out of recovery. This is the
  pass condition.
- **`1`** — the board was **never written**, whatever else the log says.

Check this before you read anything else. A log full of reassuring output and a
board still sitting in recovery means a failed flash, every time.

### The flash log

A real flash writes a log under `<massflash package>/initrdlog/`, around 57 KB.
An aborted one leaves a stub of about 4.5 KB. Two things to verify:

```bash
ls -lt <massflash package>/initrdlog/ | head -3
```

- the newest log is **from today**, not from the last successful run;
- it is the full size, not the stub.

### The summary line is not enough

`flash.sh` ends with a results block:

```
=== Results ===
  Flashed:     1/1 devices
  Setup:       1/1 succeeded
```

`Setup: 1/1 succeeded` only means `install.sh` exited zero. On a Hermes device
the Hermes provisioning step is deliberately non-fatal, so scroll back and check
for:

```
[hermes-edition] FINISHED WITH n ERROR(S) — Hermes is not fully provisioned.
```

If you see it, repair it on the device — the step is idempotent:

```bash
sudo bash /home/clawbox/clawbox/install.sh --step hermes_edition
```

## When a board will not flash

There is one failure signature that is the **board**, not your cable, your host
or your software:

```
BR_CID: 0x…                     ← reads fine
Sending bct_br
ERROR: might be timeout in USB write.      ← ~9 ms later
```

and the device never leaves recovery. The controller answers the identity read
and then dies the instant a real transfer starts.

**Swap the Nano.** Do not keep retrying, and do not go looking for a host
problem. Verified the hard way: one board failed four times across two different
cables and two different ports; a replacement board flashed first try on the
same host, same cable, same command.

Everything else is worth one retry before you conclude anything — reseat the
recovery jumper, re-enter recovery, confirm `usbfs_memory_mb`, confirm
ModemManager is stopped.

### Other things that go wrong

| Symptom | Cause |
|---|---|
| *"another rpcbind is already running"* / *"NFS server is not running"* | Stale portmapper. Restart `rpcbind` and `nfs-kernel-server`, then confirm `rpcinfo -p 127.0.0.1` |
| No device found on the LAN within the timeout | Board not on Ethernet, or on a different subnet. Retry with `--setup-only --ip=` |
| Stale `flash_ns_*` network namespaces left behind | Run `./wipe_ns.sh` |
| `install.sh` picks up the wrong Node and dies later on a parse error | An apt auto-update service grabbed the apt lock. Phase 0 masks these; if you built the package before that change, `--regen` |

## Credentials

The host's sudo password is set at the top of `flash.sh` (`SUDO_PASS`) and is
reused for the freshly flashed devices, which also receive this host's SSH
public key. None of those values belong in this file or anywhere else outside
the flash host. Change them at the source.

## Requirements

- **JetPack 6.2** (Ubuntu 22.04 / L4T R36.x). **JetPack 7.x is not supported** —
  the installer fails on Ubuntu 24.04's externally-managed-environment policy,
  among other differences.
- The L4T tree and the massflash package paths are set at the top of `flash.sh`.
  If you move or reinstall the SDK, update them there.
