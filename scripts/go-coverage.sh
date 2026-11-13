#!/usr/bin/env bash
# Coverage for the Go guest, which had no number at all. `go test ./...` ran in
# `integration (local guest)` and six fuzz targets ran in `fuzz`, so the suite
# was green and nothing said which statements it reached. The guest is where the
# security-critical parsing lives (envelope open, path resolution, transfer
# framing, chunk decode), so "the tests pass" is not the same claim as "these
# parsers are exercised".
#
# Runs every package under guest/ with -covermode=atomic, merges the profiles
# into one, prints a per-package table and a total, and exits non-zero when the
# total is under the floor.
#
# Two choices worth explaining:
#
# 1. -coverpkg=./... on every run. Package-local coverage throws away the hits
#    the root suite makes inside internal/files, internal/envelope and
#    internal/protocol, because those profiles only instrument the package under
#    test. Coverage is a union, the same rule scripts/coverage-merge.mjs applies
#    to the TypeScript reports: a block counts if any test binary reached it.
#
# 2. Packages without tests stay in the denominator. cmd/netprobe and
#    internal/hardening have no test files. Dropping them would raise the total
#    by pretending untested code does not exist, so they are marked `no tests`
#    in the table and count as 0% of their own statements.
#
# The merge is a max per block, not a sum. A block reached by two test binaries
# has no more coverage than one reached by either, and a sum would make the
# counts incomparable with `go tool cover`, which reads them as hit counters.
#
# Usage:
#   scripts/go-coverage.sh                  # floor from this file, below
#   scripts/go-coverage.sh --floor 30
#   scripts/go-coverage.sh --out DIR        # default: coverage-go/
#   scripts/go-coverage.sh --self-test      # exercise the merge and the floor
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guest="$root/guest"
out="$root/coverage-go"

# Measured 2026-11-13 at 29.0% (552/1905 statements, macOS arm64). Three points
# of headroom, so a real regression trips it but a package that gains or loses a
# helper function does not. Linux swaps two build-tagged files
# (internal/hardening, internal/runner) for their equivalents, so the
# denominator moves by a statement or two between the two platforms.
floor=26

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

usage() {
  sed -n '/^# Usage:/,/^#   scripts\/go-coverage.sh --self-test/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# Merge `mode: atomic` profiles into one, taking the maximum count per block.
# Arguments: <output file> <profile...>
merge_profiles() {
  local dest="$1"
  shift
  # The header is written by hand rather than sorted with the blocks: `sort`
  # puts "github.com/..." before "mode:" and `go tool cover` then rejects the
  # whole file with "bad mode line".
  {
    echo "mode: atomic"
    awk '
      # Every profile repeats the mode header; the merged file needs exactly one.
      FNR == 1 && /^mode:/ { next }
      # Blocks are "file:line.col,line.col statements count". Anything else in a
      # profile (a blank line, a future record type) is not a block and would
      # corrupt the totals, so drop it rather than guess.
      NF != 3 { next }
      {
        if (!($1 in statements)) statements[$1] = $2
        if (($3 + 0) > counts[$1]) counts[$1] = $3 + 0
      }
      END {
        for (block in statements) {
          printf "%s %d %d\n", block, statements[block], counts[block]
        }
      }
    ' "$@" | LC_ALL=C sort
  } >"$dest"
}

# Statements covered and total, from a merged profile. Arguments: <profile>
totals_of() {
  awk '
    FNR == 1 && /^mode:/ { next }
    NF != 3 { next }
    { total += $2; if (($3 + 0) > 0) covered += $2 }
    END { printf "%d %d\n", covered, total }
  ' "$1"
}

pct() {
  awk -v c="$1" -v t="$2" 'BEGIN { printf "%.1f%%", (t == 0 ? 100 : 100 * c / t) }'
}

# One "package covered total note" row per package, read from the merged profile
# so a row includes every test binary that reached the package, not just its
# own. `<tests>` is the `go list` test map: "<import path> <tests|no-tests>".
package_rows() {
  local profile="$1" module="$2" tests="$3"
  awk -v module="$module" '
    FNR == 1 && /^mode:/ { next }
    NF != 3 { next }
    {
      file = $1
      sub(/:[0-9]+\.[0-9]+,.*$/, "", file)
      # Module-relative package: internal/files, cmd/netprobe, or the module
      # root, which has no directory component at all.
      rel = file
      sub("^" module "/?", "", rel)
      if (rel ~ /\//) sub(/\/[^\/]+$/, "", rel)
      else rel = "(root)"
      if (!(rel in total)) order[++n] = rel
      total[rel] += $2
      if (($3 + 0) > 0) covered[rel] += $2
    }
    END {
      for (i = 1; i <= n; i++) printf "%s\t%d\t%d\n", order[i], covered[order[i]], total[order[i]]
    }
  ' "$profile" | LC_ALL=C sort | while IFS=$'\t' read -r pkg covered total; do
    # The root package is the module path itself; everything else is suffixed.
    local import_path="$module"
    [ "$pkg" = "(root)" ] || import_path="$module/$pkg"
    local note=""
    if ! grep -qx "$import_path no-tests" "$tests"; then
      note=""
    else
      note="no tests"
    fi
    printf "%s\t%d\t%d\t%s\t%s\n" "$pkg" "$covered" "$total" "$(pct "$covered" "$total")" "$note"
  done
}

# --- self-test -------------------------------------------------------------
#
# The merge and the floor are the two places a bug would silently produce a
# wrong number, and neither needs a Go toolchain to check.
self_test() {
  local dir status=0
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand $dir now: the trap outlives the variable
  trap "rm -rf '$dir'" EXIT

  # Two profiles that disagree on the same block (7 vs 3), one block only the
  # second reached, and one block neither reached. A union takes 7, covers the
  # second block, and leaves the third at zero: 5 of 9 statements.
  cat >"$dir/a.out" <<'EOF'
mode: atomic
example.com/m/a.go:1.1,2.2 2 7
example.com/m/a.go:4.1,5.2 3 0
example.com/m/a.go:7.1,8.2 2 0
EOF
  cat >"$dir/b.out" <<'EOF'
mode: atomic
example.com/m/a.go:1.1,2.2 2 3
example.com/m/a.go:4.1,5.2 3 1
example.com/m/sub/c.go:1.1,2.2 2 0
EOF

  merge_profiles "$dir/merged.out" "$dir/a.out" "$dir/b.out"
  expect() {
    if [ "$2" = "$3" ]; then
      echo "self-test: ok   $1"
    else
      echo "self-test: FAIL $1: got '$2', want '$3'" >&2
      status=1
    fi
  }
  expect "header appears once" "$(grep -c '^mode:' "$dir/merged.out")" "1"
  expect "header is the first line" "$(head -1 "$dir/merged.out")" "mode: atomic"
  expect "block count is the union" "$(grep -c '\.go:' "$dir/merged.out")" "4"
  expect "a block keeps the higher count" \
    "$(awk '$1 ~ /a.go:1.1/ {print $3}' "$dir/merged.out")" "7"
  expect "totals are statement-weighted" "$(totals_of "$dir/merged.out")" "5 9"
  expect "percent of a partial profile" "$(pct 5 9)" "55.6%"
  expect "empty profile is 100%" "$(pct 0 0)" "100.0%"
  expect "untested package reads 0%" "$(pct 0 61)" "0.0%"

  # Re-merging is idempotent: a second pass must not double a count or add a
  # block, which is what makes the profile safe to upload and re-read.
  merge_profiles "$dir/again.out" "$dir/merged.out"
  expect "merge is idempotent" "$(cat "$dir/merged.out")" "$(cat "$dir/again.out")"

  # Package attribution: a.go is the module root, sub/c.go is package "sub".
  printf 'example.com/m tests\nexample.com/m/sub no-tests\n' >"$dir/tests"
  expect "root and sub are separate rows" \
    "$(package_rows "$dir/merged.out" example.com/m "$dir/tests" | cut -f1 | tr '\n' ' ')" \
    "(root) sub "
  expect "the untested package is flagged" \
    "$(package_rows "$dir/merged.out" example.com/m "$dir/tests" | awk -F'\t' '$5 != "" {print $1}')" \
    "sub"
  expect "root row totals 5/7" \
    "$(package_rows "$dir/merged.out" example.com/m "$dir/tests" | awk -F'\t' '$1 == "(root)" {print $2"/"$3}')" \
    "5/7"

  # The floor comparison is the same expression the gate uses.
  under() { awk -v got="$1" -v floor="$2" 'BEGIN { exit !(got + 0 < floor + 0) }'; }
  if under 25.9 26; then
    expect "under the floor trips" tripped tripped
  else
    expect "under the floor trips" passed tripped
  fi
  if under 26.0 26; then
    expect "on the floor passes" tripped passed
  else
    expect "on the floor passes" passed passed
  fi

  if [ "$status" -ne 0 ]; then
    echo "self-test: failed" >&2
    return 1
  fi
  echo "self-test: all checks passed"
}

# --- argument parsing ------------------------------------------------------

run_self_test=0
while [ $# -gt 0 ]; do
  case "$1" in
    --floor)
      floor="${2:?--floor needs a number}"
      shift 2
      ;;
    --out)
      out="${2:?--out needs a directory}"
      shift 2
      ;;
    --self-test)
      run_self_test=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "go-coverage: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Sourcing the file (for the functions above) must not run the suite.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

if [ "$run_self_test" -eq 1 ]; then
  self_test
  exit $?
fi

# --- measure ---------------------------------------------------------------

cd "$guest" || {
  echo "go-coverage: no guest/ directory under $root" >&2
  exit 1
}

tmp="$(mktemp -d)"
# shellcheck disable=SC2064 # expand $tmp now: the trap outlives the variable
trap "rm -rf '$tmp'" EXIT
mkdir -p "$out"

go_list="$(go list -f '{{.ImportPath}} {{if or .TestGoFiles .XTestGoFiles}}tests{{else}}no-tests{{end}}' ./...)" || {
  echo "go-coverage: go list failed" >&2
  exit 1
}
module="$(go list -m)"

echo "go-coverage: $(go version), $(echo "$go_list" | wc -l | tr -d ' ') packages in $module"

# One profile per package, every one instrumenting every package
# (-coverpkg=./...) so the merge is a union rather than eleven disjoint views.
# -count=1 because a cached test result writes no profile.
profiles=()
failed=()
index=0
while IFS=' ' read -r pkg _; do
  [ -n "$pkg" ] || continue
  index=$((index + 1))
  profile="$tmp/$index.out"
  if go test -count=1 -covermode=atomic -coverpkg=./... -coverprofile="$profile" "$pkg" >"$tmp/$index.log" 2>&1; then
    if [ -s "$profile" ]; then
      profiles+=("$profile")
    else
      echo "go-coverage: $pkg wrote no profile" >&2
      failed+=("$pkg")
    fi
  else
    echo "go-coverage: $pkg failed:" >&2
    cat "$tmp/$index.log" >&2
    failed+=("$pkg")
  fi
done <<<"$go_list"

if [ "${#profiles[@]}" -eq 0 ]; then
  echo "go-coverage: no profiles to merge" >&2
  exit 1
fi

merged="$out/go-coverage.out"
merge_profiles "$merged" "${profiles[@]}"
printf '%s\n' "$go_list" >"$tmp/tests"

read -r covered total < <(totals_of "$merged")
total_pct="$(pct "$covered" "$total")"

echo
echo "go-coverage: statements reached by any test binary"
echo "  package                covered / total      %"
package_rows "$merged" "$module" "$tmp/tests" | while IFS=$'\t' read -r pkg cov tot p note; do
  printf "  %-22s %5s / %-5s %7s  %s\n" "$pkg" "$cov" "$tot" "$p" "$note"
done
echo
echo "go-coverage: total $covered/$total statements, $total_pct"

# The profile is the artifact; `go tool cover -func` must be able to read it, or
# it is not a coverage report. This also cross-checks the statement weighting the
# table above was built from. A profile that sorts its mode header below the
# blocks still sums correctly here but is rejected by every Go tool, so an
# unreadable profile is a failure, not a skipped check.
tool_pct="$(go tool cover -func="$merged" 2>"$tmp/cover.err" | awk '/^total:/ { print $NF }')"
if [ -z "$tool_pct" ]; then
  echo "go-coverage: go tool cover cannot read $merged:" >&2
  cat "$tmp/cover.err" >&2
  failed+=("profile is not readable by go tool cover")
elif [ "$tool_pct" != "$total_pct" ]; then
  echo "go-coverage: go tool cover reports $tool_pct, the merge says $total_pct" >&2
  failed+=("statement totals disagree")
fi

summary "### Go guest coverage"
summary ""
summary "\`$covered / $total\` statements, **$total_pct** (floor ${floor}%)."
summary ""
summary "| package | covered / total | % | note |"
summary "| --- | --- | --- | --- |"
package_rows "$merged" "$module" "$tmp/tests" | while IFS=$'\t' read -r pkg cov tot p note; do
  summary "| \`$pkg\` | $cov / $tot | $p | $note |"
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "go-coverage: did not measure cleanly: ${failed[*]}" >&2
  exit 1
fi

if awk -v got="$covered" -v tot="$total" -v floor="$floor" 'BEGIN { exit !(tot > 0 && 100 * got / tot < floor) }'; then
  echo "go-coverage: $total_pct is under the floor of ${floor}%" >&2
  exit 1
fi

echo "go-coverage: at or above the floor of ${floor}%"
