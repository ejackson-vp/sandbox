#!/usr/bin/env bash
# What the six Go fuzz targets actually reach.
#
# The `fuzz` job runs each target for 20 s and asserts it does not crash. That
# proves the parsers survive arbitrary input, not that the fuzzer ever entered
# them: a target whose corpus never gets past the first length check passes in
# exactly the same way as one that walks every error path. The guest's parsers
# (envelope open, path resolution, transfer framing, chunk decode) are the
# security-critical code, so this prints a number per target and makes a target
# that only touches its happy path visible.
#
# Method, and why it is not simply `go test -fuzz=... -coverprofile`:
#
#   * Go 1.26 rejects `-coverprofile` together with `-fuzz`
#     ("cannot use -coverprofile flag with -fuzz flag"), so that combination
#     cannot be the mechanism.
#   * The coverage profile a live fuzz run does produce (via -test.gocoverdir)
#     is not a union. The fuzz engine resets the coverage counters around every
#     input, so the profile is a snapshot of whatever ran last per worker, not
#     of everything the corpus reached. Measured here it scored FuzzOpen below
#     its own seed corpus (13/24 statements against 14/24), which errs in the
#     safe direction and is useless as a signal.
#
# So the corpus is measured by replay instead:
#
#   1. seed:   `go test -run=^Target$ -coverprofile` replays the committed seed
#              corpus (F.Add values plus testdata/fuzz/<Target>/) as ordinary
#              tests, with accurate counters.
#   2. fuzz:   `go test -run=^$ -fuzz=Target -fuzztime=Ns` grows a corpus for a
#              short budget. New interesting inputs land in -test.fuzzcachedir,
#              which points inside this script's temp tree, never the repo.
#   3. replay: the discovered inputs are copied next to the committed seeds and
#              the seed step is repeated, so the union of seed and fuzz corpus is
#              measured with the same counters as step 1. The difference between
#              step 1 and step 3 is what fuzzing added.
#
# The whole thing runs in a copy of guest/, so a crasher or a new corpus entry
# cannot land in the worktree. Crashers are copied to <out>/crashers/ so a real
# finding is not thrown away with the temp tree.
#
# Usage:
#   scripts/go-fuzz-coverage.sh                # 10s per target
#   scripts/go-fuzz-coverage.sh --budget 20s
#   scripts/go-fuzz-coverage.sh --out DIR      # default: coverage-go-fuzz/
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guest="$root/guest"
out="$root/coverage-go-fuzz"
budget="10s"

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

usage() {
  sed -n '/^# Usage:/,/^#   scripts\/go-fuzz-coverage.sh --out DIR/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --budget)
      budget="${2:?--budget needs a duration, e.g. 10s}"
      shift 2
      ;;
    --out)
      out="${2:?--out needs a directory}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "go-fuzz-coverage: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$guest" || {
  echo "go-fuzz-coverage: no guest/ directory under $root" >&2
  exit 1
}

mkdir -p "$out"
work="$(mktemp -d)"
# shellcheck disable=SC2064 # expand $work now: the trap outlives the variable
trap "rm -rf '$work'" EXIT

# A copy, so fuzzing cannot write testdata/fuzz into the worktree. bin/ holds
# the built guest and is irrelevant to `go test`.
mkdir -p "$work/guest"
(cd "$guest" && tar -cf - --exclude=./bin .) | (cd "$work/guest" && tar -xf -) || {
  echo "go-fuzz-coverage: could not copy guest/ to $work" >&2
  exit 1
}

module="$(cd "$work/guest" && go list -m)"
cd "$work/guest" || exit 1

# Cover every package, not just the target's own: FuzzTransferFraming's framing
# checks live in internal/files and internal/protocol, and plain `go test -cover`
# would score those at zero.
cover_pkgs="./..."

pct() {
  awk -v c="$1" -v t="$2" 'BEGIN { printf "%.1f%%", (t == 0 ? 0 : 100 * c / t) }'
}

# Covered and total statements in one package directory of a profile. Block keys
# are import paths, so the directory is everything up to the last slash and the
# package is that string exactly (a prefix match would fold internal/files into
# internal/files/... and the root package into every subpackage).
stmts() {
  local profile="$1" pkgdir="$2"
  awk -v want="$pkgdir" '
    FNR == 1 && /^mode:/ { next }
    NF != 3 { next }
    {
      file = $1
      sub(/:[0-9]+\.[0-9]+,.*$/, "", file)
      # want="" means every package, for the guest-wide count.
      if (want != "") {
        dir = file
        if (dir !~ /\//) next
        sub(/\/[^\/]+$/, "", dir)
        if (dir != want) next
      }
      total += $2
      if (($3 + 0) > 0) covered += $2
    }
    END { printf "%d %d", covered, total }
  ' "$profile" 2>/dev/null
}

# Target discovery is `go test -list` rather than a hard-coded list, so a new
# fuzz target shows up here the moment it exists instead of being silently
# unmeasured. `go list ./...` yields import paths, which is what the profile
# keys use, so no path arithmetic is needed.
targets_file="$work/targets"
: >"$targets_file"
while read -r pkg; do
  while read -r name; do
    case "$name" in
      Fuzz*) printf '%s %s\n' "$pkg" "$name" >>"$targets_file" ;;
    esac
  done < <(go test -list='^Fuzz' "$pkg" 2>/dev/null | grep -E '^Fuzz')
done < <(go list ./...)

if [ ! -s "$targets_file" ]; then
  echo "go-fuzz-coverage: no fuzz targets found" >&2
  exit 1
fi

target_count="$(wc -l <"$targets_file" | tr -d ' ')"
echo "go-fuzz-coverage: $(go version), $target_count targets, ${budget} each"
echo

rows="$work/rows"
: >"$rows"
combined="$work/combined" # guest-wide union across every target
: >"$combined"
failures=()

while read -r pkg name; do
  pkg_dir="$(go list -f '{{.Dir}}' "$pkg")"
  if [ "$pkg" = "$module" ]; then
    pkg_prefix="$module"
    pkg_label="(root)"
  else
    pkg_prefix="$pkg"
    pkg_label="${pkg#"$module"/}"
  fi
  corpus_dir="$work/fuzzcache/$name"
  mkdir -p "$corpus_dir"

  # 1. Seed corpus, as a normal test run. This is what the committed seeds alone
  #    reach, and the baseline the fuzz run has to beat.
  seed_profile="$work/$name.seed.out"
  if ! go test -count=1 -run="^${name}\$" -covermode=atomic -coverpkg="$cover_pkgs" \
    -coverprofile="$seed_profile" "$pkg" >"$work/$name.seed.log" 2>&1; then
    echo "go-fuzz-coverage: $name seed replay failed" >&2
    cat "$work/$name.seed.log" >&2
    failures+=("$name seed replay")
    continue
  fi

  # 2. Fuzz, for the corpus only. Plain `go test -fuzz` still instruments the
  #    binary for the engine's own guidance; what it writes here is new
  #    interesting inputs into -test.fuzzcachedir, deliberately outside the repo.
  fuzz_log="$work/$name.fuzz.log"
  go test -count=1 -run='^$' -fuzz="$name" -fuzztime="$budget" "$pkg" \
    -args -test.fuzzcachedir="$corpus_dir" >"$fuzz_log" 2>&1
  fuzz_status=$?

  discovered=0
  if [ -d "$corpus_dir/$name" ]; then
    discovered="$(find "$corpus_dir/$name" -type f | wc -l | tr -d ' ')"
  fi

  # A crasher, a failing seed replay or a panic is a real result: keep the input
  # so it is not lost with the temp tree, and fail. The bare
  # `context deadline exceeded` shutdown race (#130) is not, and the corpus it
  # produced is still usable.
  if [ "$fuzz_status" -ne 0 ]; then
    if grep -Eq '(Failing input written to|panic:|^--- FAIL: Fuzz[A-Za-z0-9_]+/)' "$fuzz_log"; then
      # Failing inputs go to <pkg>/testdata/fuzz/<Target>/, not the fuzz cache
      # directory, so that is what has to be rescued.
      mkdir -p "$out/crashers"
      cp "$pkg_dir/testdata/fuzz/$name"/* "$out/crashers/" 2>/dev/null
      echo "go-fuzz-coverage: $name found a failing input (kept in $out/crashers)" >&2
      tail -20 "$fuzz_log" >&2
      failures+=("$name crasher")
      continue
    fi
    echo "go-fuzz-coverage: $name fuzz run exited $fuzz_status without a crasher (shutdown race, #130); corpus kept" >&2
  fi

  # 3. Replay seed plus discovered corpus, so both are counted the same way.
  replay_profile="$work/$name.replay.out"
  if [ "$discovered" -gt 0 ]; then
    mkdir -p "$pkg_dir/testdata/fuzz/$name"
    cp "$corpus_dir/$name"/* "$pkg_dir/testdata/fuzz/$name"/
  fi
  if ! go test -count=1 -run="^${name}\$" -covermode=atomic -coverpkg="$cover_pkgs" \
    -coverprofile="$replay_profile" "$pkg" >"$work/$name.replay.log" 2>&1; then
    echo "go-fuzz-coverage: $name corpus replay failed, so the corpus itself is bad" >&2
    tail -20 "$work/$name.replay.log" >&2
    failures+=("$name corpus replay")
    continue
  fi

  read -r seed_cov seed_total < <(stmts "$seed_profile" "$pkg_prefix")
  read -r replay_cov replay_total < <(stmts "$replay_profile" "$pkg_prefix")
  gain=$((replay_cov - seed_cov))
  # Guest-wide statements the corpus reaches, across every package. The
  # own-package column understates a target that lives in the root package but
  # exercises a subpackage (FuzzSupervisorDecrypt drives internal/envelope), and
  # an absolute count keeps that visible next to the percentage.
  read -r guest_cov _ < <(stmts "$replay_profile" "")

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$pkg_label" "$seed_cov" "$seed_total" "$replay_cov" "$replay_total" "$gain" "$guest_cov" "$discovered" >>"$rows"
  grep -v '^mode:' "$replay_profile" >>"$combined"
  echo "go-fuzz-coverage: $name ${seed_cov}/${seed_total} seed -> ${replay_cov}/${replay_total} with corpus (+${gain}, ${discovered} inputs)"
done <"$targets_file"

# --- report ----------------------------------------------------------------

echo
echo "go-fuzz-coverage: coverage of the target's own package, seed corpus vs seed + fuzz"
echo "  target                     package               seed       with corpus    gain  guest  inputs"
while IFS=$'\t' read -r name pkg seed_cov seed_total replay_cov replay_total gain guest_cov discovered; do
  printf "  %-26s %-20s %10s  %13s  %+5d  %5d  %6d\n" \
    "$name" "$pkg" \
    "$(pct "$seed_cov" "$seed_total")" "$(pct "$replay_cov" "$replay_total")" \
    "$gain" "$guest_cov" "$discovered"
done < <(sort -k1 "$rows")

# A package no test binary links (cmd/netprobe) never appears in a -coverpkg
# profile, so the union would be quoted against a smaller denominator than part 1
# uses and the two numbers would not be comparable. Run it once so its statements
# are counted, uncovered, the same way part 1 counts them.
awk '
  FNR == 1 && /^mode:/ { next }
  NF != 3 { next }
  { file = $1; sub(/:[0-9]+\.[0-9]+,.*$/, "", file); sub(/\/[^\/]+$/, "", file); print file }
' "$combined" | LC_ALL=C sort -u >"$work/measured"
while read -r pkg; do
  if ! grep -qx "$pkg" "$work/measured"; then
    if go test -count=1 -run='^$' -covermode=atomic -coverpkg=./... \
      -coverprofile="$work/unlinked.out" "$pkg" >/dev/null 2>&1 && [ -s "$work/unlinked.out" ]; then
      grep -v '^mode:' "$work/unlinked.out" >>"$combined"
      echo "go-fuzz-coverage: $pkg is linked by no test binary; counted as uncovered"
    fi
  fi
done < <(go list ./...)

# Guest-wide union: everything the corpora reach between them. This is the number
# to hold next to part 1 (scripts/go-coverage.sh), which measures the same
# denominator without fuzzing.
read -r any_cov any_total < <(awk '
  FNR == 1 && /^mode:/ { next }
  NF != 3 { next }
  {
    if (!($1 in st)) st[$1] = $2
    if (($3 + 0) > c[$1]) c[$1] = $3 + 0
  }
  END {
    for (b in st) { total += st[b]; if (c[b] > 0) covered += st[b] }
    printf "%d %d", covered, total
  }
' "$combined")

echo
echo "go-fuzz-coverage: all targets together reach $any_cov/$any_total guest statements ($(pct "$any_cov" "$any_total"))"

summary "### Go fuzz corpus coverage"
summary ""
summary "Seed corpus vs seed + ${budget} of fuzzing, per target, over the target's own package."
summary ""
summary "| target | package | seed | with corpus | gain | guest statements | inputs found |"
summary "| --- | --- | --- | --- | --- | --- | --- |"
while IFS=$'\t' read -r name pkg seed_cov seed_total replay_cov replay_total gain guest_cov discovered; do
  summary "| \`$name\` | \`$pkg\` | $seed_cov/$seed_total ($(pct "$seed_cov" "$seed_total")) | $replay_cov/$replay_total ($(pct "$replay_cov" "$replay_total")) | $gain | $guest_cov | $discovered |"
done < <(sort -k1 "$rows")
summary ""
summary "All targets together reach $any_cov/$any_total guest statements ($(pct "$any_cov" "$any_total"))."

if [ "${#failures[@]}" -gt 0 ]; then
  echo "go-fuzz-coverage: ${#failures[@]} target(s) did not measure cleanly: ${failures[*]}" >&2
  exit 1
fi
