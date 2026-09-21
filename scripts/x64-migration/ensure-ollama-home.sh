# Included verbatim in the package's postinst; never runs user-owned code.
ensure_ollama_home() {
  if ! ollama_account=$(/usr/bin/getent passwd ollama); then
    return 0
  fi
  ollama_home=$(printf '%s\n' "$ollama_account" | /usr/bin/cut -d: -f6)
  # A custom account home belongs to its operator. Repair only the vendor's
  # default directory, which the service cannot create under root-owned /usr.
  [ "$ollama_home" = /usr/share/ollama ] || return 0
  if [ -L "$ollama_home" ]; then
    echo 'Error: refusing symlink at /usr/share/ollama; no Ollama files changed.' >&2
    return 1
  fi
  if [ -e "$ollama_home" ]; then
    ollama_owner=$(/usr/bin/id -u ollama):$(/usr/bin/id -g ollama)
    if [ ! -d "$ollama_home" ] || [ "$(/usr/bin/stat -c '%u:%g' -- "$ollama_home")" != "$ollama_owner" ]; then
      echo 'Error: /usr/share/ollama is not an Ollama-owned directory; no Ollama files changed.' >&2
      return 1
    fi
    # Preserve contents, ownership and mode of an existing valid home.
    return 0
  fi
  /usr/bin/install -d -o ollama -g ollama -m 0755 "$ollama_home"
}
