#!/usr/bin/env bash
#
# Install the cluster tools the `isolation` CI job needs: kind, kubectl and the
# Cilium CLI.
#
# Pinned and verified against upstream checksums rather than tracking latest.
# This job gates the claim that nothing can dial into a sandbox, so a silent
# tool upgrade should not be able to change what that claim means. Bump the
# version and its digest together, in the same commit.
#
# Linux amd64 only, because that is the only platform the job runs on. Locally
# these come from Homebrew (`brew install kind kubectl cilium-cli`); see
# CONTRIBUTING.md. Failing loudly here is better than a half-installed
# toolchain that makes the suite skip itself.
set -euo pipefail

KIND_VERSION="v0.33.0"
KIND_SHA256="aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d"

KUBECTL_VERSION="v1.37.2"
KUBECTL_SHA256="c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4"

CILIUM_CLI_VERSION="v0.20.3"
CILIUM_CLI_SHA256="b987ad0d195310d3fc96553aa7bcd41d1e97b64713ecdfee3eb48dd27e1ec7d7"

BIN_DIR="${BIN_DIR:-${HOME}/.local/bin}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "error: this installer only has digests for Linux amd64 (found $(uname -s)/$(uname -m))" >&2
  echo "       on macOS use: brew install kind kubectl cilium-cli" >&2
  exit 1
fi

verify() {
  local file="$1" expected="$2"
  if ! printf '%s  %s\n' "${expected}" "${file}" | sha256sum --check --status -; then
    echo "error: checksum mismatch for ${file}" >&2
    echo "       expected ${expected}" >&2
    echo "       got      $(sha256sum "${file}" | cut -d' ' -f1)" >&2
    exit 1
  fi
}

mkdir -p "${BIN_DIR}"

echo "==> kind ${KIND_VERSION}"
curl -fsSL --retry 3 -o "${WORK_DIR}/kind" \
  "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64"
verify "${WORK_DIR}/kind" "${KIND_SHA256}"
install -m 0755 "${WORK_DIR}/kind" "${BIN_DIR}/kind"

echo "==> kubectl ${KUBECTL_VERSION}"
curl -fsSL --retry 3 -o "${WORK_DIR}/kubectl" \
  "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
verify "${WORK_DIR}/kubectl" "${KUBECTL_SHA256}"
install -m 0755 "${WORK_DIR}/kubectl" "${BIN_DIR}/kubectl"

echo "==> cilium-cli ${CILIUM_CLI_VERSION}"
curl -fsSL --retry 3 -o "${WORK_DIR}/cilium.tar.gz" \
  "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz"
verify "${WORK_DIR}/cilium.tar.gz" "${CILIUM_CLI_SHA256}"
tar -xzf "${WORK_DIR}/cilium.tar.gz" -C "${WORK_DIR}" cilium
install -m 0755 "${WORK_DIR}/cilium" "${BIN_DIR}/cilium"

# GitHub reads this file after the step and prepends each line to PATH for the
# rest of the job. Outside CI the caller is expected to have BIN_DIR on PATH.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "${BIN_DIR}" >> "${GITHUB_PATH}"
fi

kind version
kubectl version --client
cilium version --client
