#!/usr/bin/env bash
# Fail when a doc references a local image that is not in the tree.
#
# GitHub renders README.md and the release notes straight from the repo, and
# Mintlify serves docs-site/ with /images/... rooted at docs-site/ — so a path
# that is merely wrong is a broken image for every reader, and nothing in CI
# noticed. TASK-1023: three 4.0 screenshots in the README pointed at names that
# never existed in any branch.
#
# Scans README.md, RELEASE-NOTES-*.md and docs-site/**/*.mdx for
#   <img src="...">, <source srcset="...">, and markdown ![alt](path)
# and reports every reference whose file is missing. Remote URLs, data: URIs
# and JSX expressions (src={...}) are not ours to check and are skipped.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

# Only these are image references; a src= on some other element is not.
image_re='\.(png|jpe?g|gif|webp|svg|avif|apng|bmp|ico)$'

# Emits "<line>\t<raw attribute value>" for every candidate reference.
extract_refs() {
  local file=$1
  {
    grep -noE '(src|srcset)[[:space:]]*=[[:space:]]*"[^"]*"' "$file" || true
    grep -noE "(src|srcset)[[:space:]]*=[[:space:]]*'[^']*'" "$file" || true
    grep -noE '!\[[^]]*\]\([^)]*\)' "$file" || true
  } | sed -E \
      -e 's/^([0-9]+):(src|srcset)[[:space:]]*=[[:space:]]*.(.*).$/\1'$'\t''\3/' \
      -e 's/^([0-9]+):!\[[^]]*\]\((.*)\)$/\1'$'\t''\2/'
}

# A docs-site page is served with docs-site/ as the web root; a repo-root
# markdown file is served with the repo root as its base.
resolve_ref() {
  local file=$1 ref=$2 base=.
  case $file in docs-site/*) base=docs-site ;; esac
  case $ref in
    /*) printf '%s%s\n' "$base" "$ref" ;;
    *)  printf '%s/%s\n' "$(dirname "$file")" "$ref" ;;
  esac
}

files=()
[ -f README.md ] && files+=(README.md)
for f in RELEASE-NOTES-*.md; do
  [ -f "$f" ] && files+=("$f")
done
if [ -d docs-site ]; then
  while IFS= read -r f; do
    files+=("$f")
  done < <(find docs-site -type f -name '*.mdx' | sort)
fi

checked=0
missing=()

for file in "${files[@]}"; do
  while IFS=$'\t' read -r lineno raw; do
    [ -n "${raw:-}" ] || continue
    # srcset is a comma-separated candidate list, each with an optional
    # "2x"/"640w" descriptor after the URL.
    IFS=',' read -ra candidates <<<"$raw"
    for candidate in "${candidates[@]}"; do
      # Leading whitespace FIRST — a srcset list is "a.png 2x, b.png 1x", so
      # every candidate after the comma starts with a space and taking the
      # first token off it would yield the empty string. Then the first token,
      # which drops a srcset descriptor and a ![alt](path "title") title.
      candidate=${candidate#"${candidate%%[![:space:]]*}"}
      ref=${candidate%%[[:space:]]*}
      ref=${ref#<}
      ref=${ref%>}
      ref=${ref%%\?*}   # query string
      ref=${ref%%\#*}   # fragment
      ref=${ref//%20/ } # the only escape our paths have ever used
      [ -n "$ref" ] || continue
      case $ref in
        http://*|https://*|//*|data:*|mailto:*|\{*|\$*) continue ;;
      esac
      [[ $ref =~ $image_re ]] || continue

      checked=$((checked + 1))
      path=$(resolve_ref "$file" "$ref")
      if [ ! -f "$path" ]; then
        missing+=("$file:$lineno: $ref -> $path")
      fi
    done
  done < <(extract_refs "$file")
done

if [ ${#missing[@]} -gt 0 ]; then
  printf 'Broken doc image references (%d):\n\n' "${#missing[@]}" >&2
  printf '  %s\n' "${missing[@]}" >&2
  printf '\nEach path above is referenced by a doc but is not in the tree.\n' >&2
  printf 'Fix the path, or add the image. Checked %d references in %d files.\n' \
    "$checked" "${#files[@]}" >&2
  exit 1
fi

printf 'All %d doc image references resolve (%d files checked).\n' \
  "$checked" "${#files[@]}"
