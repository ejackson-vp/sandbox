#!/usr/bin/env bash
# Build the guest language profile images locally.
#
# The runtime base image for each profile is pinned in
# profiles/runtime-images.conf, which the release workflow reads too, so a local
# build matches the image the release scans and attests. Building alone does not
# publish anything: release-profiles.yml owns the release tags.
#
# Usage: ./build-profiles.sh [profile ...]    (default: every pinned profile)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

conf=profiles/runtime-images.conf
tag_prefix="${PROFILE_TAG_PREFIX:-x402-sandbox/profile}"

pinned() {
  local profile=$1 line image
  line=$(grep -E "^${profile}=" "$conf" || true)
  if [ -z "$line" ]; then
    echo "no pinned runtime image for profile '${profile}' in ${conf}" >&2
    return 1
  fi
  image="${line#*=}"
  if ! [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
    echo "runtime image for '${profile}' is not digest-pinned: ${image}" >&2
    return 1
  fi
  printf '%s' "$image"
}

profiles=("$@")
if [ "${#profiles[@]}" -eq 0 ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] || continue
    profiles+=("${line%%=*}")
  done < "$conf"
fi

for profile in "${profiles[@]}"; do
  runtime_image="$(pinned "$profile")"
  echo "building ${tag_prefix}-${profile}:dev from ${runtime_image}"
  docker build -f Dockerfile.profile \
    --build-arg PROFILE="$profile" \
    --build-arg RUNTIME_IMAGE="$runtime_image" \
    -t "${tag_prefix}-${profile}:dev" .
done
