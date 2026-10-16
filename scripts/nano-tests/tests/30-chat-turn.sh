#!/usr/bin/env bash
# timeout: 660
# select: always
# parallel: agent
# covers: config/clawbox-bootstrap.md config/clawbox-workspace-guide.md
#
# A real chat turn through the provider the box is configured with (ClawBox AI
# is connected on every lab board):
#
#   openclaw agent --agent main -m "Reply with exactly this text and nothing
#   else: NANO-CI-OK <serial>" --json
#
# must answer with NANO-CI-OK <serial> within 240 s, retried once after 60 s
# because the gateway restarts twice after a rebuild. See chat_turn in lib.sh
# (75-full-reboot runs the same turn again after a gateway restart and after
# a reboot).
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

chat_turn
finish
