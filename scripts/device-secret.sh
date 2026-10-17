#!/usr/bin/env bash
# Per-device secret and the hotspot credentials derived from it.
#
# Every ClawBox carries a random 32-byte secret, written once by the factory
# station (scripts/provision-device.sh) and printed on the box's sticker as a
# standard Wi-Fi QR code. The hotspot's SSID suffix and WPA2 passphrase are
# derived from it, so no two boxes share a hotspot password and none ships with
# a universal one. The file lives in /etc, outside data/, so a factory reset
# (which wipes data/) leaves it — and the sticker keeps working.
#
# File: $CLAWBOX_ETC/device-secret (default /etc/clawbox), root:root 0600:
#   serial=<board serial>
#   secret=<64 lowercase hex>
# The serial binds the secret to the board: an image cloned from one box onto
# another must not make every clone share the first box's hotspot password.
#
# Derivation (byte-exact; the factory tooling implements the same):
#   mac(label) = HMAC-SHA256(key = secret bytes, message = ASCII label)
#   map every mac byte b to ALPHABET[b % 32]
#   PSK  = first 14 mapped chars of mac("clawbox-hotspot-psk-v1")
#   SSID = "ClawBox-" + uppercase(first 4 mapped chars of mac("clawbox-hotspot-ssid-v1"))
#
# HMAC is computed from two plain SHA-256 passes fed on stdin, so the secret
# never appears on a command line (/proc/<pid>/cmdline is world-readable).
# Nothing here logs the secret or the PSK; `load`, `derive` and `qr` print the
# credentials on stdout for their root caller only.
#
# Usage:
#   device-secret.sh derive    < secret-hex   -> SSID=... / PSK=...
#   device-secret.sh qr        < secret-hex   -> WIFI:T:WPA;S:<ssid>;P:<psk>;;
#   device-secret.sh install   < secret-hex   -> writes the file (root)
#   device-secret.sh load                     -> SSID=... / PSK=... from the file
# Exit codes: 0 ok, 2 bad input, 3 no secret file, 4 secret of another board,
# 64 usage.
set -euo pipefail

ETC_DIR="${CLAWBOX_ETC:-/etc/clawbox}"
SECRET_FILE="$ETC_DIR/device-secret"
SERIAL_SOURCE="${CLAWBOX_SERIAL_FILE:-/proc/device-tree/serial-number}"
ALPHABET="23456789abcdefghijkmnpqrstuvwxyz"
PSK_LABEL="clawbox-hotspot-psk-v1"
SSID_LABEL="clawbox-hotspot-ssid-v1"

die() { echo "device-secret: $2" >&2; exit "$1"; }

board_serial() {
  [ -r "$SERIAL_SOURCE" ] || return 0
  tr -d '\0\n\r' <"$SERIAL_SOURCE" 2>/dev/null || true
}

# The length in ${#}, not a {64} bound: bash's =~ bound handling is not
# portable (see src/tests/unit/shell-regex-hygiene.test.ts).
valid_secret() { [ "${#1}" -eq 64 ] && [[ "$1" =~ ^[0-9a-f]+$ ]]; }

# Read one secret from stdin, lowercased and trimmed; refuse anything else.
read_secret_stdin() {
  local s
  s="$(head -c 256 | tr -d ' \t\r\n' | tr 'A-F' 'a-f')"
  valid_secret "$s" || die 2 "expected 64 hex characters on stdin"
  printf '%s' "$s"
}

# Turn a hex string into printf escapes (\xHH...), for a builtin printf.
hex_escapes() {
  local hex="$1" out="" i
  for ((i = 0; i < ${#hex}; i += 2)); do out+="\\x${hex:i:2}"; done
  printf '%s' "$out"
}

# XOR a 64-byte (128-hex) block with a repeated pad byte.
xor_block() {
  local block="$1" pad="$2" out="" i
  for ((i = 0; i < 128; i += 2)); do
    out+="$(printf '%02x' $(( 16#${block:i:2} ^ pad )))"
  done
  printf '%s' "$out"
}

sha256_hex() { openssl dgst -sha256 -binary | od -An -v -tx1 | tr -d ' \n'; }

# hmac_hex <secret-hex> <label>
hmac_hex() {
  local key="$1" label="$2" block ipad opad inner
  block="$key"
  while [ "${#block}" -lt 128 ]; do block+="00"; done
  ipad="$(xor_block "$block" $((0x36)))"
  opad="$(xor_block "$block" $((0x5c)))"
  # shellcheck disable=SC2059  # the format IS the escaped key bytes
  inner="$({ printf "$(hex_escapes "$ipad")"; printf '%s' "$label"; } | sha256_hex)"
  # shellcheck disable=SC2059
  { printf "$(hex_escapes "$opad")"; printf "$(hex_escapes "$inner")"; } | sha256_hex
}

# mapped <secret-hex> <label> <count>
mapped() {
  local mac out="" i
  mac="$(hmac_hex "$1" "$2")"
  for ((i = 0; i < $3 * 2; i += 2)); do
    out+="${ALPHABET:$(( 16#${mac:i:2} % 32 )):1}"
  done
  printf '%s' "$out"
}

derive_pair() {
  local secret="$1" ssid psk
  ssid="ClawBox-$(mapped "$secret" "$SSID_LABEL" 4 | tr 'a-z' 'A-Z')"
  psk="$(mapped "$secret" "$PSK_LABEL" 14)"
  printf 'SSID=%s\nPSK=%s\n' "$ssid" "$psk"
}

cmd_load() {
  local line serial="" secret="" here
  [ -f "$SECRET_FILE" ] && [ ! -L "$SECRET_FILE" ] || exit 3
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      serial=*) serial="${line#serial=}" ;;
      secret=*) secret="${line#secret=}" ;;
    esac
  done <"$SECRET_FILE"
  valid_secret "$secret" || die 2 "device secret file is malformed — ignored"
  here="$(board_serial)"
  if [ -z "$serial" ] || [ "$serial" != "$here" ]; then
    die 4 "device secret belongs to another board (cloned image?) — ignored"
  fi
  derive_pair "$secret"
}

cmd_install() {
  local secret serial tmp
  secret="$(read_secret_stdin)"
  serial="$(board_serial)"
  [ -n "$serial" ] || die 2 "cannot read the board serial from $SERIAL_SOURCE"
  install -d -m 0755 "$ETC_DIR"
  tmp="$(mktemp "$ETC_DIR/.device-secret.XXXXXX")"
  chmod 0600 "$tmp"
  printf 'serial=%s\nsecret=%s\n' "$serial" "$secret" >"$tmp"
  if [ "$(id -u)" -eq 0 ]; then chown root:root "$tmp"; fi
  mv -f "$tmp" "$SECRET_FILE"
  echo "device-secret: installed for this board"
}

case "${1:-}" in
  # Assign first: a failed read inside an argument's $(...) would not stop us.
  derive) secret="$(read_secret_stdin)"; derive_pair "$secret" ;;
  qr)
    secret="$(read_secret_stdin)"
    pair="$(derive_pair "$secret")"
    ssid="$(printf '%s\n' "$pair" | sed -n 's/^SSID=//p')"
    psk="$(printf '%s\n' "$pair" | sed -n 's/^PSK=//p')"
    printf 'WIFI:T:WPA;S:%s;P:%s;;\n' "$ssid" "$psk"
    ;;
  install) cmd_install ;;
  load) cmd_load ;;
  *) echo "usage: device-secret.sh derive|qr|install|load" >&2; exit 64 ;;
esac
