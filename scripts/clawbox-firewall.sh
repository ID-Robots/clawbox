#!/usr/bin/env bash
# ClawBox default-deny inbound firewall.
#
# Until this landed a ClawBox had NO host firewall at all — `iptables -S` showed
# `-P INPUT ACCEPT` with nothing but NetworkManager's shared-AP chains, so every
# port any process happened to bind on 0.0.0.0 was reachable from the whole LAN.
# On a real device that included CUPS (631) and rpcbind (111), neither of which
# ClawBox uses, and — depending on what the owner had enabled — the xterm.js PTY
# on 3006, which is an UNAUTHENTICATED root shell when reached directly instead
# of through the session-gated `/terminal-ws` proxy. Reported by a customer
# security review on 2026-07-28.
#
# The policy is therefore an allowlist, not a blocklist: deny inbound by
# default, then open only the ports ClawBox actually serves. Ports nobody
# thought about — today's 631/111, tomorrow's whatever — are closed because
# they were never opened, which is the only property that survives the next
# package that decides to listen on 0.0.0.0.
#
# ── Why the service ports are scoped to private source ranges ────────────────
# 22 / 80 / 18789 / 8090 are opened only FROM RFC1918, CGNAT and link-local
# sources rather than from anywhere. A ClawBox is an appliance on someone's home
# or office LAN, so a non-private source address means the box has been put
# somewhere it was never designed to be — directly on a public address, a hotel
# network, a mobile hotspot with a routable prefix. Scoping costs nothing in the
# intended deployment and removes the whole class of "the box was briefly on a
# public IP" exposure. Verified against every flow that has to keep working:
#
#   * Shared AP / captive portal — clients live on 10.42.0.0/24 (or 10.43.0.0/24
#     when start-ap.sh detects a collision), both inside 10.0.0.0/8.
#   * Cloudflare quick tunnel — cloudflared runs ON the box and delivers to
#     http://localhost:80, so it arrives over `lo`, which ufw's stock
#     before.rules already accepts. Source-scoping :80 does not touch it.
#   * Tailscale — the tailnet uses 100.64.0.0/10, which is why CGNAT is in the
#     list; without it, enabling the firewall would silently kill `.ts.net`
#     access, a documented ClawBox feature.
#
# ── Why FORWARD policy stays ACCEPT ──────────────────────────────────────────
# ufw defaults DEFAULT_FORWARD_POLICY to DROP. That would break the hotspot's
# internet sharing: scripts/start-ap.sh APPENDS its `-A FORWARD ... -j ACCEPT`
# rules, so once ufw owns the head of FORWARD they would sit behind ufw's chain
# and never be reached. This firewall is about INBOUND exposure — forwarding is
# already constrained by NetworkManager's nm-sh-fw-* chains exactly as before —
# so we pin FORWARD to ACCEPT and leave routing behaviour bit-for-bit unchanged.
#
# ── Why we never `ufw reset` ─────────────────────────────────────────────────
# NetworkManager builds the shared-AP nm-sh-in-*/nm-sh-fw-* chains once, when
# the connection activates, and nothing in this repo re-adds them. A flush would
# destroy them until the next reboot or connection re-activation — i.e. it would
# take the captive portal down mid-setup. So convergence is done by deleting
# only the rules WE own (every one carries the `clawbox` comment) and re-adding
# the current set. `ufw enable` itself is safe: ufw-init loads with
# `iptables-restore -n` (--noflush), which leaves foreign chains alone.
set -euo pipefail

# Every rule this script owns carries a VERSIONED comment: `clawbox-v<N>`.
#
# The version is what makes convergence safe. A run adds the whole current rule
# set first (ufw skips a rule it already has, so a re-run of the same version is
# a no-op) and only afterwards deletes rules carrying a DIFFERENT clawbox
# version. That means there is never a moment where the policy is DROP and our
# allow rules are missing — which the delete-first shape did have, and which
# would have taken the box off the network if a later `ufw allow` failed.
#
# Bump RULE_VERSION whenever the rule set below changes; the next run then
# retires the old generation. Do not reuse a version with different contents.
readonly RULE_TAG_PREFIX="clawbox"
readonly RULE_VERSION="1"
readonly RULE_TAG="${RULE_TAG_PREFIX}-v${RULE_VERSION}"

IFACE="${NETWORK_INTERFACE:-wlP1p1s0}"
if [ -f /etc/clawbox/network.env ]; then
  # shellcheck disable=SC1091
  . /etc/clawbox/network.env
  IFACE="${NETWORK_INTERFACE:-$IFACE}"
fi

# Private source ranges the service ports are reachable from. See the header for
# why each one is here; 169.254/16 is link-local (a directly-attached laptop
# with no DHCP), 100.64/10 is CGNAT and therefore Tailscale.
readonly PRIVATE_V4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10"

# IPv6 is deliberately NOT source-scoped, and that asymmetry is the point.
#
# There is no RFC1918 on IPv6. A normal dual-stack home LAN hands every device a
# GLOBAL address out of the ISP's prefix, and avahi publishes exactly that as the
# AAAA for `clawbox.local` — so an "fe80::/10 + fc00::/7 only" rule set would
# drop SSH and the web UI over the very address the box advertises. That was
# tried and reproduced on a dual-stack network before this comment was written.
#
# The v4 scoping is the one that earns its keep: a routable IPv4 address means
# the box has been plugged somewhere it was never designed to be. On v6 the
# site's own router is the boundary, which is how every other consumer device on
# that LAN already behaves. Inbound is still default-deny; only these ports are
# reachable, and 18789 is still token-gated by the gateway itself.
readonly V6_SOURCE_SCOPED="no"

# TCP services ClawBox actually serves on the LAN.
#   22    SSH — the owner's and support's only way in.
#   80    the ClawBox web OS: login, desktop, setup wizard, /setup-api/*, and
#         the WebSocket upgrade proxy that fronts the gateway, the PTY and noVNC.
#   443   the same web OS over TLS. production-server.js binds this on 0.0.0.0
#         (startHttpsServer, `httpsServer.listen(HTTPS_PORT, "0.0.0.0")`) as soon
#         as a cert pair exists in data/certs/, and it carries its own WSS
#         upgrade proxy. Leaving it out would have taken HTTPS away from every
#         box that has certs installed the moment this firewall landed — the
#         rule is harmless on the majority of boxes, where nothing binds it.
#   18789 the OpenClaw gateway. gateway.bind is "lan" by design (see
#         scripts/gateway-pre-start.sh) so an OpenClaw client on the LAN can
#         pair with the box; such a client still has to present the gateway
#         token, which the gateway enforces itself.
#   8090  the Hermes dashboard auth proxy. Edition-scoped and gated on a ClawBox
#         session, documented as LAN-reachable in docs-site/technical/networking.mdx.
#         Nothing binds it on an OpenClaw-edition box, where the rule is inert.
readonly LAN_TCP_PORTS="22 80 443 18789 8090"

log() { echo "[firewall] $*"; }

# ─────────────────────────────────────────────────────────────────────────────

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[firewall] must run as root" >&2
    exit 1
  fi
}

ufw_available() {
  command -v ufw >/dev/null 2>&1
}

# LC_ALL=C, and a POSITIVE test for "active" rather than a match on "inactive".
# ufw's status line is translated (backend_iptables.py returns `_("Status: …")`),
# so on a box with a German or French language pack a grep for the English word
# "inactive" finds nothing — and a fail-open check would then decide the
# firewall was already up and never enable it, while logging success.
ufw_is_active() {
  LC_ALL=C ufw status 2>/dev/null | head -1 | grep -q "^Status: active"
}

enable_if_inactive() {
  if ufw_is_active; then
    # Already on: reload so rewritten defaults take effect.
    ufw --force reload >/dev/null 2>&1 || true
    return 0
  fi
  ufw --force enable >/dev/null
}

# Retire rules left by an EARLIER generation of this script — `clawbox-v*` with a
# version that is not ours. Runs only after the current set is in place, so the
# box is never left with a DROP policy and no way in.
#
# The match is anchored at end of line because ufw prints the comment last: an
# unanchored `clawbox` would also swallow an owner's own `# clawbox-extra` rule.
# Highest number first, so the renumbering after each delete cannot skip one.
drop_superseded_rules() {
  local nums num
  nums=$(LC_ALL=C ufw status numbered 2>/dev/null \
    | grep -E "#[[:space:]]+${RULE_TAG_PREFIX}-v[0-9]+[[:space:]]*$" \
    | grep -v -E "#[[:space:]]+${RULE_TAG}[[:space:]]*$" \
    | sed -n 's/^\[[[:space:]]*\([0-9]\{1,\}\)\].*/\1/p' \
    | sort -rn) || true
  for num in $nums; do
    ufw --force delete "$num" >/dev/null 2>&1 || true
  done
}

apply_rules() {
  local net port

  # Service ports. IPv4 is scoped to private sources; IPv6 is not — see the
  # V6_SOURCE_SCOPED comment above for why that asymmetry is deliberate.
  for port in $LAN_TCP_PORTS; do
    for net in $PRIVATE_V4; do
      ufw allow from "$net" to any port "$port" proto tcp comment "$RULE_TAG" >/dev/null
    done
    # `from ::/0` and NOT a bare `ufw allow <port>`: an unscoped allow would
    # create the v4 rule as well and quietly undo the private-source scoping
    # above. Naming a v6 source pins the rule to the v6 family.
    ufw allow from ::/0 to any port "$port" proto tcp comment "$RULE_TAG" >/dev/null
  done

  # mDNS. avahi answers unsolicited multicast queries, so conntrack's
  # ESTABLISHED allowance does not cover it — without this rule `clawbox.local`
  # stops resolving, which is the documented way owners reach the box.
  ufw allow to any port 5353 proto udp comment "$RULE_TAG" >/dev/null

  # Hotspot DHCP. A DHCPDISCOVER is sent from 0.0.0.0, so it can only be matched
  # by interface, never by source range.
  ufw allow in on "$IFACE" to any port 67 proto udp comment "$RULE_TAG" >/dev/null

  # Hotspot DNS — dnsmasq serves the captive portal on the AP address. Both
  # subnets, because start-ap.sh moves the AP to 10.43.0.0/24 when the upstream
  # network already occupies 10.42.0.0/24.
  for net in 10.42.0.0/24 10.43.0.0/24; do
    ufw allow from "$net" to any port 53 proto udp comment "$RULE_TAG" >/dev/null
    ufw allow from "$net" to any port 53 proto tcp comment "$RULE_TAG" >/dev/null
  done
}

# Pin the two defaults we depend on. `ufw default` is idempotent and rewrites
# /etc/default/ufw, so this also repairs a box where someone changed them.
apply_defaults() {
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  # See the header: DROP here would break hotspot internet sharing.
  ufw --force default allow routed >/dev/null 2>&1 || true
}

# rpcbind is the one service we turn off rather than merely firewall. Nothing in
# ClawBox speaks NFS, NIS or any other Sun-RPC protocol, and rpcbind is a plain
# apt package whose units we can mask without fighting another package manager.
#
# CUPS is deliberately NOT disabled even though it is just as unused by ClawBox:
# on the shipped Jetson image it is a SNAP (snap.cups.cupsd.service), so masking
# it means fighting snapd — which re-enables its units on refresh — and would
# also take away an owner's local desktop printing. Closing 631 at the firewall
# removes the LAN exposure, survives `snap refresh`, and leaves printing over
# loopback working. Same reasoning for anything else that shows up on 0.0.0.0:
# the default-deny policy already covers it.
disable_unused_rpcbind() {
  # Refuse to touch it if anything that actually needs RPC is installed.
  #
  # The query is NOT run inside the `if` condition, because it is a pipeline and
  # this script uses `set -o pipefail`: real dpkg-query exits 1 as soon as ONE of
  # the four names is unknown to the dpkg database, which is the normal case on a
  # Jetson image (autofs and ypbind are never installed). Under pipefail that
  # non-zero wins over grep's match and the whole condition reads false — so the
  # guard would never fire and a box mounting NFS would have rpcbind masked out
  # from under it. Capture first, then test the captured text.
  local rpc_status
  rpc_status=$(dpkg-query -W -f='${Status}\n' nfs-common nfs-kernel-server autofs ypbind 2>/dev/null || true)
  if printf '%s\n' "$rpc_status" | grep -q "^install ok installed"; then
    log "rpcbind left alone — an NFS/NIS package is installed"
    return 0
  fi
  if ! systemctl list-unit-files rpcbind.service >/dev/null 2>&1; then
    return 0
  fi
  systemctl disable --now rpcbind.socket >/dev/null 2>&1 || true
  systemctl disable --now rpcbind.service >/dev/null 2>&1 || true
  systemctl mask rpcbind.socket >/dev/null 2>&1 || true
  systemctl mask rpcbind.service >/dev/null 2>&1 || true
  log "rpcbind disabled and masked (no NFS/NIS package present)"
}

main() {
  require_root

  if ! ufw_available; then
    log "ufw not installed — skipping (install.sh installs it)"
    return 0
  fi

  # Order is load-bearing, and it is add-then-retire, never delete-then-add:
  #
  #   1. defaults   — deny incoming, allow outgoing, allow routed.
  #   2. apply      — put the CURRENT rule set in place. ufw skips a rule it
  #                   already has, so a re-run of the same version is a no-op and
  #                   an in-app update no longer churns the whole ruleset.
  #   3. enable     — only now, with SSH already allowed, is it safe to turn a
  #                   default-DROP policy on.
  #   4. retire     — drop rules from an older clawbox generation. Last, because
  #                   until step 3 an inactive ufw reports no rules at all, and
  #                   because deleting before adding is what could leave the box
  #                   with a DROP policy and no way in.
  apply_defaults
  apply_rules
  enable_if_inactive
  drop_superseded_rules

  disable_unused_rpcbind

  # Say what is true, not what was attempted. Parsing ufw's own status is the
  # only way to know, and it has to be done under LC_ALL=C: the "Status: active"
  # string is gettext-marked, and on a box with a localised language pack a
  # match on the English word silently reads false.
  if ufw_is_active; then
    log "default-deny inbound active; open from private ranges: ${LAN_TCP_PORTS}"
  else
    log "WARNING: ufw did not come up active — inbound is NOT filtered" >&2
    return 1
  fi
}

main "$@"
