#!/usr/bin/env bash
set -u

CLAWBOX_BG_PRIMARY="${CLAWBOX_BG_PRIMARY:-#0a0f1a}"
CLAWBOX_BG_SECONDARY="${CLAWBOX_BG_SECONDARY:-#111827}"

apply_gnome_theme() {
  command -v gsettings >/dev/null 2>&1 || return 0

  gsettings set org.gnome.desktop.background picture-uri "" >/dev/null 2>&1 || true
  gsettings set org.gnome.desktop.background picture-uri-dark "" >/dev/null 2>&1 || true
  gsettings set org.gnome.desktop.background picture-options "none" >/dev/null 2>&1 || true
  gsettings set org.gnome.desktop.background color-shading-type "solid" >/dev/null 2>&1 || true
  gsettings set org.gnome.desktop.background primary-color "$CLAWBOX_BG_PRIMARY" >/dev/null 2>&1 || true
  gsettings set org.gnome.desktop.background secondary-color "$CLAWBOX_BG_SECONDARY" >/dev/null 2>&1 || true
}

apply_x_root_theme() {
  command -v xsetroot >/dev/null 2>&1 || return 0
  [ -n "${DISPLAY:-}" ] || return 0
  xsetroot -solid "$CLAWBOX_BG_PRIMARY" >/dev/null 2>&1 || true
}

apply_gnome_theme
apply_x_root_theme
