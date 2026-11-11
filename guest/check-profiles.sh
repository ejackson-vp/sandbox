#!/usr/bin/env bash
# Keep the published profile set and the pinned runtime images in sync.
#
# release-profiles.yml publishes exactly the profiles listed in
# profiles/runtime-images.conf, one image per line. A profile manifest with no
# pin would silently not ship; a pin with no manifest would publish an image the
# guest cannot select (`/runtimes/<name>/profile.json` would be missing). Both
# are release bugs, so fail here instead of at tag time.
#
# Deliberately no bash 4 features (associative arrays): this runs on a stock
# macOS bash as well as on the runner.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# `--print-runtime <profile>` prints the pinned image for one profile after the
# whole file checks out. The release workflow calls it that way, so the pin is
# parsed in exactly one place.
print_runtime=""
if [ "${1:-}" = "--print-runtime" ]; then
  print_runtime="${2:-}"
  if [ -z "$print_runtime" ]; then
    echo "--print-runtime needs a profile name" >&2
    exit 2
  fi
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--print-runtime <profile>]" >&2
  exit 2
fi

conf=profiles/runtime-images.conf
status=0
seen=""

note() {
  echo "$*" >&2
  status=1
}

while IFS= read -r line; do
  # Drop a trailing comment and any whitespace.
  line="${line%%#*}"
  line="$(printf '%s' "$line" | tr -d '[:space:]')"
  [ -n "$line" ] || continue

  case "$line" in
    *=*) ;;
    *) note "malformed line in $conf (expected profile=image): $line"; continue ;;
  esac

  profile="${line%%=*}"
  image="${line#*=}"

  if ! [[ "$profile" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
    note "bad profile name '$profile' in $conf (must match [a-z][a-z0-9-]{0,31})"
  fi
  case " $seen " in
    *" $profile "*) note "duplicate profile '$profile' in $conf" ;;
  esac
  seen="$seen $profile"

  if ! [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
    note "runtime image for '$profile' is not digest-pinned: $image"
  fi

  manifest="profiles/${profile}.json"
  if [ ! -f "$manifest" ]; then
    note "'$profile' is pinned in $conf but $manifest does not exist"
    continue
  fi
  declared="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n1)"
  if [ "$declared" != "$profile" ]; then
    note "$manifest declares name '$declared', expected '$profile'"
  fi
done < "$conf"

# The other direction: a manifest that no longer ships is dead weight in the
# guest image and hides a dropped profile.
for manifest in profiles/*.json; do
  [ -f "$manifest" ] || continue
  name="$(basename "$manifest" .json)"
  case " $seen " in
    *" $name "*) ;;
    *) note "$manifest has no pinned runtime image in $conf" ;;
  esac
done

if [ "$status" -ne 0 ]; then
  echo "profile set and pinned runtime images disagree" >&2
  exit 1
fi

if [ -n "$print_runtime" ]; then
  case " $seen " in
    *" $print_runtime "*) ;;
    *) echo "no pinned runtime image for '$print_runtime'" >&2; exit 1 ;;
  esac
  grep -E "^${print_runtime}=" "$conf" | head -n1 | cut -d= -f2-
  exit 0
fi

echo "profiles ok:${seen}"
