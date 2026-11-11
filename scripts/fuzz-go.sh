#!/usr/bin/env bash
# Run one Go fuzz target for a fixed budget, retrying once only when the run
# fails with `context deadline exceeded`.
#
# That error is the fuzz engine losing its shutdown race at the end of
# `-fuzztime`: it reports ~170k execs/sec, a healthy corpus, no crasher and no
# written input, and a re-run of the same commit passes (#130, runs 42904507088
# and 42882089539). Every other nonzero exit is fatal and is not retried, so a
# real crasher, a found input or a build failure stays red.
#
# One step per target, because the retry is scoped to a single target: a target
# that hits the race costs another 20 s, not another full matrix.
#
# Usage: scripts/fuzz-go.sh <package> <target> [budget]
#   scripts/fuzz-go.sh ./internal/envelope FuzzOpen 20s
set -uo pipefail

pkg="${1:?package required}"
target="${2:?fuzz target required}"
budget="${3:-20s}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# `go test` output goes to the log and to the terminal, so the job log is the
# same whether or not the retry path is taken.
# The script runs without `set -e` on purpose: a failing attempt is data the
# classifier below acts on, not an abort.
run_once() {
  go test "$pkg" -run='^$' -fuzz="$target" -fuzztime="$budget" >"$log" 2>&1
  local code=$?
  cat "$log"
  return "$code"
}

echo "=== $target in $pkg, ${budget} budget, $(go version)"

# No `set -e` here, so capture the status explicitly. `$?` after an `if` is the
# status of the `if`, not of the command it tested.
run_once
first=$?
if [ "$first" -eq 0 ]; then
  exit 0
fi

if ! grep -q "context deadline exceeded" "$log"; then
  summary "**$target**: failed (exit $first) without the budget shutdown error; not retried."
  exit "$first"
fi

# Anything that found an input is a real result even when the deadline line is
# also present: a crasher, a failing seed replay or a written corpus entry. The
# bare `--- FAIL: FuzzOpen (20.1s)` line is the budget shutdown itself, so only
# a subtest failure (a corpus entry) or a panic counts as a real failure.
if grep -Eq '(Failing input written to|panic:|^--- FAIL: Fuzz[A-Za-z0-9_]+/)' "$log"; then
  summary "**$target**: failed (exit $first) with the budget shutdown error and a real failure; not retried."
  exit "$first"
fi

summary "**$target**: \`context deadline exceeded\` at the ${budget} budget on the first attempt (exit $first); retried once."

run_once
second=$?
if [ "$second" -eq 0 ]; then
  summary "**$target**: passed on the retry. The first attempt is the fuzz engine's shutdown race (#130), not a found input."
  exit 0
fi
summary "**$target**: failed again on the retry (exit $second). Not a one-off shutdown race; treat as a real failure."
exit "$second"
