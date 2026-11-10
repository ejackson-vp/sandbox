#!/usr/bin/env bash
#
# Model-check the sandbox control-plane state machines with TLC.
#
#   ./verification/run-tlc.sh              # good spec + every broken variant
#   ./verification/run-tlc.sh --good-only   # only the spec that must pass
#   ./verification/run-tlc.sh --broken-only # only the variants that must fail
#
# The tool is pinned: TLC 2.19 ships in tla2tools.jar v1.7.4 and the download
# is verified against its SHA-256. Either let this script fetch it into
# verification/.cache/, or point TLA2TOOLS_JAR at an existing copy (air-gapped
# or CI-cached) and no network access is needed.
set -euo pipefail

TLA2TOOLS_VERSION="1.7.4"
TLA2TOOLS_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
TLA2TOOLS_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA2TOOLS_VERSION}/tla2tools.jar"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="${TLA2TOOLS_CACHE:-${ROOT}/.cache}"
JAR="${TLA2TOOLS_JAR:-${CACHE_DIR}/tla2tools-${TLA2TOOLS_VERSION}.jar}"
WORKERS="${TLC_WORKERS:-4}"
JAVA_OPTS="${TLC_JAVA_OPTS:--XX:+UseParallelGC}"

MODE="all"
for arg in "$@"; do
  case "${arg}" in
    --good-only) MODE="good" ;;
    --broken-only) MODE="broken" ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: ${arg}" >&2
      echo "usage: $0 [--good-only|--broken-only]" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "error: $*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "no sha256sum or shasum on PATH; cannot verify tla2tools.jar"
  fi
}

resolve_jar() {
  if [[ -f "${JAR}" ]]; then
    local actual
    actual="$(sha256_of "${JAR}")"
    if [[ "${actual}" != "${TLA2TOOLS_SHA256}" ]]; then
      fail "checksum mismatch for ${JAR}
  expected ${TLA2TOOLS_SHA256} (tla2tools v${TLA2TOOLS_VERSION})
  actual   ${actual}
Delete the file and re-run, or point TLA2TOOLS_JAR at a verified copy."
    fi
    return
  fi

  command -v curl >/dev/null 2>&1 ||
    fail "tla2tools.jar is not cached at ${JAR} and curl is not on PATH.
Install curl, or download tla2tools.jar v${TLA2TOOLS_VERSION} yourself and set
TLA2TOOLS_JAR=/path/to/tla2tools.jar"

  mkdir -p "${CACHE_DIR}"
  local tmp="${JAR}.download.$$"
  echo "==> fetching tla2tools v${TLA2TOOLS_VERSION} (pinned, sha256 verified)"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "${tmp}" "${TLA2TOOLS_URL}"; then
    rm -f "${tmp}"
    fail "could not download ${TLA2TOOLS_URL}
Set TLA2TOOLS_JAR to an existing tla2tools.jar to run offline."
  fi
  local actual
  actual="$(sha256_of "${tmp}")"
  if [[ "${actual}" != "${TLA2TOOLS_SHA256}" ]]; then
    rm -f "${tmp}"
    fail "downloaded tla2tools.jar has the wrong checksum
  expected ${TLA2TOOLS_SHA256}
  actual   ${actual}"
  fi
  mv "${tmp}" "${JAR}"
}

check_java() {
  command -v java >/dev/null 2>&1 ||
    fail "java is not on PATH. TLC needs a JDK 11 or newer.
Install one (for example: brew install --cask temurin) or run the good spec by
hand; see verification/README.md for the exact command."
  if ! java -version >/dev/null 2>&1; then
    fail "'java -version' failed; TLC needs a working JDK 11 or newer."
  fi
}

tlc() {
  # Run TLC from a directory; the module is looked up on the classpath, which is
  # also how the broken variants find ../SandboxSession.tla.
  local dir="$1"
  shift
  ( cd "${dir}" && java ${JAVA_OPTS} -cp "${JAR}:${ROOT}" tlc2.TLC -workers "${WORKERS}" "$@" )
}

run_good() {
  echo "==> good: SandboxSession.cfg (lifecycle, intent, slot, reservation)"
  if ! tlc "${ROOT}" -config SandboxSession.cfg SandboxSession.tla; then
    fail "the good specification is violated; no broken variant was run"
  fi
  echo
  echo "==> good: SandboxSessionTight.cfg (one-slot node, capacity pressure, safety)"
  if ! tlc "${ROOT}" -config SandboxSessionTight.cfg SandboxSession.tla; then
    fail "the good specification is violated under capacity pressure"
  fi
}

# Each broken variant must be rejected, and for the expected reason: a variant
# that fails for an unrelated reason would prove nothing.
#
# TLC prints the invariant name but not the temporal property name, so liveness
# variants are identified by their config declaring exactly one property and by
# TLC reporting a temporal violation.
expect_violation() {
  local module="$1" expected="$2" property="${3:-}" log
  log="$(mktemp "${TMPDIR:-/tmp}/tlc-${module}.XXXXXX")"
  echo
  echo "==> broken: ${module} (must violate ${property:-${expected}})"
  if tlc "${ROOT}/broken" -config "${module}.cfg" "${module}.tla" >"${log}" 2>&1; then
    tail -n 40 "${log}" >&2
    rm -f "${log}"
    fail "${module} completed without a counterexample: the injected bug is not modelled"
  fi
  if [[ -n "${property}" ]]; then
    if ! grep -q "Temporal properties were violated" "${log}"; then
      tail -n 40 "${log}" >&2
      rm -f "${log}"
      fail "${module} was rejected, but not by a temporal property"
    fi
    local declared
    declared="$(awk '/^PROPERTIES/{f=1;next} f&&/^[A-Za-z]/{f=0} f&&NF{gsub(/^[ \t]+|[ \t]+$/,"");print}' "${ROOT}/broken/${module}.cfg")"
    if [[ "${declared}" != "${property}" ]]; then
      rm -f "${log}"
      fail "${module}.cfg must declare ${property} as its only property (found: ${declared:-none})"
    fi
    echo "    rejected: temporal property ${property} (the config declares no other)"
  else
    if ! grep -q "${expected}" "${log}"; then
      tail -n 40 "${log}" >&2
      rm -f "${log}"
      fail "${module} was rejected, but not by ${expected}"
    fi
    echo "    rejected: $(grep -m1 "${expected}" "${log}")"
  fi
  rm -f "${log}"
}

run_broken() {
  expect_violation SlotRace "Invariant SingleActiveOperation is violated"
  expect_violation DoubleCharge "Invariant NoDoubleCharge is violated"
  expect_violation CapacityRace "Invariant NoCapacityOverReservation is violated"
  expect_violation OrphanPod "Invariant NoOrphanedWorkloadAfterTerminal is violated"
  expect_violation NoRefund "" PaidSessionProgress
  expect_violation NoRelease "" TerminalReleasesCapacity
}

resolve_jar
check_java

case "${MODE}" in
  good) run_good ;;
  broken) run_broken ;;
  all)
    echo "TLC ${TLA2TOOLS_VERSION} (tla2tools.jar sha256 ${TLA2TOOLS_SHA256})"
    echo
    run_good
    run_broken
    echo
    echo "==> all good models hold their invariants; all broken variants were rejected"
    ;;
esac
