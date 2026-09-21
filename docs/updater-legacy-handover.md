# Legacy updater handover (TASK-789)

## Why a beta-only runtime change was insufficient

A 3.9 dashboard keeps its compiled updater in memory after bootstrap fetches
beta's installer. It still launches raw `systemctl`, stops waiting after its
old budgets, and may proceed while root work is unfinished. If a later rebuild
fails after beta installs the new authorization rules, the restored old app
can no longer Retry.

## Transition

For a deployed 3.x app targeting a 4.x checkout, bootstrap first:

1. Provisions and verifies disk swap on a low-memory appliance.
2. Gates/stops the system gateway and stops the old dashboard for the build.
3. Builds and verifies the new app while retaining the old app's authorization.
4. Only after successful build, installs the new service/launcher policy.
5. Writes an atomic `data/updater-handover.json` record and restarts the app.
6. The new updater requires a changed BUILD_ID and an inactive bootstrap unit,
   then starts the **full** update. It does not treat the OS/core as upgraded.

A failed build uses the existing build rollback and does not revoke the old
app's authorization. Swap preflight failure leaves the dashboard running.
Containers and development hosts with at least ~12 GB RAM skip the swap gate.
On smaller hosts, at least 4 GiB active non-zram swap is required; the installer
normally provisions 8 GiB, retaining its existing free-disk reserve.

Core migration is required, not advisory. Both the system and legacy user
OpenClaw gateways are stopped, doctor uses the device user's explicit config
and state directory, and a nonzero result or known incomplete-migration notice
stops the upgrade before dependent steps.

## Verification status

Draft implementation. Do not infer deployment or release approval from this
file. Hardware evidence and remaining gates are tracked in TASK-789 and PR #818.
In particular, a clean-image test does not cover the customer's populated
historical session state. Verify preserved history, successful readiness and
chat, restart stability, disk swap persistence, and failed-build Retry before
closing the task.

## Real-device maintenance guard finding

On the clean-main Nano, `/run/systemd/system/clawbox-gateway.service -> /dev/null`
coexisted with `LoadState=loaded` and `FragmentPath=/etc/systemd/system/clawbox-gateway.service`.
The `/etc` unit wins: a successful `systemctl --runtime mask` was not a stopped-writer guarantee.
The fixed-scope root helper installs a runtime drop-in condition, without changing
operator masks or persistent unit files. It is installed root-owned before the
new updater runs. Reboot clears it. A live start attempt under the guard returned
`ActiveState=inactive`, `ConditionResult=no`; removal permits startup again.
Post-update recovery/reachability probes defer to the final `gateway_verify`
while the guard is held, so they neither restart a writer nor report intentional
downtime as a failure.
