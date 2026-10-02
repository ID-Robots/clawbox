#!/usr/bin/env bash
# TASK-1316 hardware acceptance — transport to the ONE reserved lab board.
#
#   box.sh lease                     # assert the lease is still ours and unexpired
#   box.sh user  NAME < script.sh    # run script.sh on the board as clawbox
#   box.sh root  NAME < script.sh    # run script.sh on the board as root (sudo, password via stdin)
#   box.sh api   NAME < script.sh    # run script.sh ON THE STATION (curl against the board's web API)
#
# Configuration (environment; nothing lab-specific is kept in this file):
#   T1316_STATION      user@host of the lab station that can reach the board
#   T1316_KEY          SSH key for the station
#   T1316_BOX_IP       the board's address, as seen from the station
#   T1316_BOX_SERIAL   the board's serial; every board script refuses any other
#   T1316_PWFILE       station-side file holding the board's clawbox password
#   T1316_LEASE_OWNER  nano-lease owner that must hold the board
#   T1316_LEASE_TAG    text the lease purpose must contain (default TASK-1316)
#   NANO_LEASE         the nano-lease command (default: nano-lease)
#   EVIDENCE           directory for the logs — outside this repository: they
#                      carry lab addresses and lease details
#
# Exit status: the remote script's own, so `box.sh root X < s && next` stops
# on a failed step; 3 = lease changed/expired or unreadable, 4 = upload
# refused, 5 = evidence log not writable, 2 = usage.
#
# The board's password never leaves the lab station: it is read there from
# T1316_PWFILE and handed to ssh (sshpass -f) and to sudo -S on stdin. A root
# script is uploaded as clawbox, and its sha256 is taken here from the bytes
# sent. Root never runs that clawbox-writable upload: under sudo, a fixed runner
# copies it into a fresh root-only directory, refuses the copy unless its
# sha256 is the one sent, and runs only that copy (so nothing running as
# clawbox can swap the script between upload and run). The runner and the
# script start with `exec </dev/null`, so if sudo ever did not read the
# password, nothing else can read or echo it.
# Every call checks the lease and the evidence log first; output goes to
# $EVIDENCE/<NAME>.log.
set -uo pipefail

STATION=${T1316_STATION:?user@host of the lab station}
KEY=${T1316_KEY:?ssh key for the station}
BOX_IP=${T1316_BOX_IP:?board address}
BOX_SERIAL=${T1316_BOX_SERIAL:?board serial}
PWFILE=${T1316_PWFILE:?station-side password file}
LEASE_OWNER=${T1316_LEASE_OWNER:?nano-lease owner}
LEASE_TAG=${T1316_LEASE_TAG:-TASK-1316}
BOX_USER=clawbox
NANO_LEASE=${NANO_LEASE:-nano-lease}
EVIDENCE=${EVIDENCE:?directory for the logs, outside this repository}
mkdir -p "$EVIDENCE"

station() {
	ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
		-o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$STATION" "$@"
}

# Station-side prefix that reaches the board as clawbox (password auth only).
BOXSSH="sshpass -f $PWFILE ssh -o StrictHostKeyChecking=yes -o PubkeyAuthentication=no -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 $BOX_USER@$BOX_IP"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

check_lease() {
	local line owner until now
	# </dev/null: nano-lease must not eat the script waiting on our stdin.
	# pipefail: a failed `nano-lease list` fails this even if it printed our row.
	line=$("$NANO_LEASE" list </dev/null | awk -v s="$BOX_SERIAL" '$2 == s') \
		|| { echo "LEASE: '$NANO_LEASE list' failed — STOP" >&2; return 1; }
	[ -n "$line" ] || { echo "LEASE: board $BOX_SERIAL not listed — STOP" >&2; return 1; }
	owner=$(awk '{print $4}' <<<"$line")
	until=$(awk '{print $NF}' <<<"$line")
	now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
	if [ "$owner" != "$LEASE_OWNER" ] || ! grep -q "$LEASE_TAG" <<<"$line" \
		|| ! [[ "$until" =~ ^20[0-9-]+T ]] || [[ ! "$until" > "$now" ]]; then
		echo "LEASE CHANGED OR EXPIRED — STOP: $line" >&2
		return 1
	fi
	echo "lease ok $(stamp): $line"
}

lease_or_stop() {
	check_lease 2>&1 | tee -a "$EVIDENCE/$1.log"
	local st=("${PIPESTATUS[@]}")
	[ "${st[0]}" = 0 ] || exit 3
	# No step runs without its evidence record.
	[ "${st[1]}" = 0 ] || { echo "cannot write $EVIDENCE/$1.log — STOP" >&2; exit 5; }
}

# The root-side runner (see the header). Only the path and the hash are
# substituted, both from a fixed character set; it travels base64-encoded, so
# no shell on the way (station, board login) expands anything in it.
root_runner() {
	cat <<RUNNER
exec </dev/null
src='$1'; want='$2'
d=\$(mktemp -d) || exit 4
install -m 0600 "\$src" "\$d/step.sh" || { rm -rf "\$d"; exit 4; }
got=\$(sha256sum < "\$d/step.sh" | cut -d' ' -f1)
if [ "\$got" != "\$want" ]; then
	echo "root copy of \$src is not the script that was uploaded — refusing" >&2
	rm -rf "\$d"; exit 4
fi
bash "\$d/step.sh"; rc=\$?
rm -rf "\$d"
exit "\$rc"
RUNNER
}

cmd=${1:-}; name=${2:-}
# NAME becomes a log file here and a path inside the remote shell commands
# below, unquoted: keep it to a plain file name.
case "$cmd" in user|root|api)
	[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
		|| { echo "usage: box.sh $cmd NAME < script   (NAME: letters, digits, . _ -)" >&2; exit 2; } ;;
esac
case "$cmd" in
lease)
	check_lease || exit 3
	;;
user)
	lease_or_stop "$name"
	{
		echo "##### $(stamp) [user] $name"
		{ echo "BOX_SERIAL=$BOX_SERIAL"; cat; } | station "$BOXSSH 'bash -s'" 2>&1 && rc=0 || rc=$?
		echo "##### rc=$rc"
		exit "$rc"   # pipefail carries it past tee: box.sh exits with the remote status
	} | tee -a "$EVIDENCE/$name.log"
	;;
root)
	lease_or_stop "$name"
	remote=/home/$BOX_USER/t1316-acceptance/$name.sh
	script=$(cat)
	[ -n "$script" ] || { echo "empty root script — refusing" >&2; exit 4; }
	want=$(printf '%s\n' 'exec </dev/null' "BOX_SERIAL=$BOX_SERIAL" "$script" | sha256sum | cut -d' ' -f1)
	got=$(printf '%s\n' 'exec </dev/null' "BOX_SERIAL=$BOX_SERIAL" "$script" | station "$BOXSSH 'mkdir -p ~/t1316-acceptance && cat > $remote && chmod 600 $remote && sha256sum < $remote'" | cut -d' ' -f1) || exit 4
	[ "$got" = "$want" ] || { echo "upload does not match what was sent — refusing" >&2; exit 4; }
	runner=$(root_runner "$remote" "$want" | base64 -w0)
	{
		echo "##### $(stamp) [root] $name"
		station "$BOXSSH \"sudo -k -S -p '' bash -c \\\"\\\$(echo $runner | base64 -d)\\\"\" < $PWFILE" 2>&1 && rc=0 || rc=$?
		echo "##### rc=$rc"
		exit "$rc"   # pipefail carries it past tee: box.sh exits with the remote status
	} | tee -a "$EVIDENCE/$name.log"
	;;
api)
	# Runs on the station with BOX_URL and PWFILE exported. Scripts send the
	# password straight from PWFILE into the request body and never echo it.
	lease_or_stop "$name"
	{
		echo "##### $(stamp) [api] $name"
		{ echo "export BOX_URL=http://$BOX_IP PWFILE=$PWFILE"; cat; } | station 'bash -s' 2>&1 && rc=0 || rc=$?
		echo "##### rc=$rc"
		exit "$rc"   # pipefail carries it past tee: box.sh exits with the remote status
	} | tee -a "$EVIDENCE/$name.log"
	;;
*)
	sed -n '2,8p' "$0" >&2
	exit 2
	;;
esac
