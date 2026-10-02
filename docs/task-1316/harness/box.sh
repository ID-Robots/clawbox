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
#
# The board's password never leaves the lab station: it is read there from
# T1316_PWFILE and handed to ssh (sshpass -f) and to sudo -S on stdin. Root
# scripts are first copied to the board, then run with
# `sudo -k -S -p '' bash <file>`; the file starts with `exec </dev/null`, so if
# sudo ever did not read the password, nothing else can read or echo it.
# Every call checks the lease first. Output goes to $EVIDENCE/<NAME>.log.
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
HERE=$(cd "$(dirname "$0")" && pwd)
EVIDENCE=${EVIDENCE:-$HERE/../evidence}
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
	line=$("$NANO_LEASE" list </dev/null | awk -v s="$BOX_SERIAL" '$2 == s')
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
	[ "${PIPESTATUS[0]}" = 0 ] || exit 3
}

cmd=${1:-}; name=${2:-}
case "$cmd" in
lease)
	check_lease
	;;
user)
	[ -n "$name" ] || { echo "usage: box.sh user NAME < script" >&2; exit 2; }
	lease_or_stop "$name"
	{
		echo "##### $(stamp) [user] $name"
		{ echo "BOX_SERIAL=$BOX_SERIAL"; cat; } | station "$BOXSSH 'bash -s'" 2>&1 && rc=0 || rc=$?
		echo "##### rc=$rc"
	} | tee -a "$EVIDENCE/$name.log"
	;;
root)
	[ -n "$name" ] || { echo "usage: box.sh root NAME < script" >&2; exit 2; }
	lease_or_stop "$name"
	remote=/home/$BOX_USER/t1316-acceptance/$name.sh
	script=$(cat)
	[ -n "$script" ] || { echo "empty root script — refusing" >&2; exit 4; }
	lines=$(printf '%s\n' 'exec </dev/null' "BOX_SERIAL=$BOX_SERIAL" "$script" | wc -l)
	got=$(printf '%s\n' 'exec </dev/null' "BOX_SERIAL=$BOX_SERIAL" "$script" | station "$BOXSSH 'mkdir -p ~/t1316-acceptance && cat > $remote && chmod 600 $remote && wc -l < $remote'") || exit 4
	[ "$got" = "$lines" ] || { echo "uploaded $got of $lines lines — refusing" >&2; exit 4; }
	{
		echo "##### $(stamp) [root] $name"
		station "$BOXSSH \"sudo -k -S -p '' bash $remote\" < $PWFILE" 2>&1 && rc=0 || rc=$?
		echo "##### rc=$rc"
	} | tee -a "$EVIDENCE/$name.log"
	;;
api)
	[ -n "$name" ] || { echo "usage: box.sh api NAME < script" >&2; exit 2; }
	# Runs on the station with BOX_URL and PWFILE exported. Scripts send the
	# password straight from PWFILE into the request body and never echo it.
	lease_or_stop "$name"
	{
		echo "##### $(stamp) [api] $name"
		{ echo "export BOX_URL=http://$BOX_IP PWFILE=$PWFILE"; cat; } | station 'bash -s' 2>&1 && rc=0 || rc=$?
		echo "##### rc=$rc"
	} | tee -a "$EVIDENCE/$name.log"
	;;
*)
	sed -n '2,8p' "$0" >&2
	exit 2
	;;
esac
