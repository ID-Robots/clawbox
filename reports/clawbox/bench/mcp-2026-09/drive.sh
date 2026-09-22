#!/bin/bash
# drive.sh <ip> <label>  — copy the bench to a box, run it, pull results back.
set -u
IP=$1; LABEL=$2
HERE=$(cd "$(dirname "$0")" && pwd)
ML=/home/nexus0/.openclaw/workspace/release/coding-agent-harness-loop/media-loop
export SSHPASS=$(cat "${BENCH_PASSWORD_FILE:?path to the bench box owner password file}")
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=30"
SCP="sshpass -e scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
RES=$HERE/results/$LABEL; mkdir -p "$RES"
$SSH clawbox@$IP 'mkdir -p /tmp/mcp-bench && rm -f /tmp/mcp-bench/DONE'
$SCP "$HERE/mcp-direct.ts" "$HERE/run-box.sh" clawbox@$IP:/tmp/mcp-bench/
$SSH clawbox@$IP "BENCH_SUDO_PW='$SSHPASS' bash /tmp/mcp-bench/run-box.sh /tmp/mcp-bench" > "$RES/drive.log" 2>&1
echo "run rc=$?" >> "$RES/drive.log"
$SCP -r clawbox@$IP:/tmp/mcp-bench/. "$RES/"
echo "collected $(date)" >> "$RES/drive.log"
