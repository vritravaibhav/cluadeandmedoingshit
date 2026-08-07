#!/usr/bin/env bash
# run-letters.sh — scan every letter folder that has a company list but no results yet.
#
#   ./weekendplan/run-letters.sh            # scan all pending letters
#   ./weekendplan/run-letters.sh a b c      # scan just these
#   FORCE=1 ./weekendplan/run-letters.sh w  # rescan even if results.json exists
#
# Letters run PARALLEL_LETTERS at a time; inside a letter the scanner runs its
# own connection pool, so the real ceiling is PARALLEL_LETTERS * CONCURRENCY
# sockets. Keep the product under ~40 or the slower boards start timing out and
# you lose companies that would otherwise have been read.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$ROOT/w/test.js"
LOGDIR="$ROOT/weekendplan/logs"
PARALLEL_LETTERS="${PARALLEL_LETTERS:-4}"
CONCURRENCY="${CONCURRENCY:-8}"
COMPANY_MS="${COMPANY_MS:-120000}"
ENRICH="${ENRICH:-12}"

mkdir -p "$LOGDIR"

if [[ ! -f "$ENGINE" ]]; then
  echo "!! scanner not found at $ENGINE" >&2
  exit 1
fi

if [[ $# -gt 0 ]]; then
  LETTERS=("$@")
else
  LETTERS=(a b c d e f g h i j k l m n o p q r s t u v w x y z)
fi

pending=()
for L in "${LETTERS[@]}"; do
  d="$ROOT/$L"
  [[ -f "$d/companies.js" ]] || continue
  if [[ -z "${FORCE:-}" && ( -f "$d/results.json" || -f "$d/careerv1.results.json" ) ]]; then
    echo "  skip $L (already scanned; FORCE=1 to redo)"
    continue
  fi
  pending+=("$L")
done

if [[ ${#pending[@]} -eq 0 ]]; then
  echo "Nothing to scan."
  exit 0
fi

echo "Scanning ${#pending[@]} letter(s): ${pending[*]}"
echo "  $PARALLEL_LETTERS letters in parallel, concurrency $CONCURRENCY each"
echo

scan_one() {
  local L="$1"
  local d="$ROOT/$L"
  local n
  n=$(node -e "try{console.log(require('$d/companies.js').length)}catch(e){console.log(0)}")
  if [[ "$n" == "0" ]]; then
    echo "  !! $L: companies.js is empty or unparseable — skipped"
    return 1
  fi
  # Each letter gets its own copy of the engine so a later tweak to one
  # letter can never silently change what another already produced.
  cp "$ENGINE" "$d/test.js"
  echo "  -> $L: $n companies, starting"
  ( cd "$d" && node test.js \
      --concurrency="$CONCURRENCY" \
      --enrich="$ENRICH" \
      --companyms="$COMPANY_MS" ) > "$LOGDIR/$L.log" 2>&1
  local rc=$?
  if [[ -f "$d/results.json" ]]; then
    local got
    got=$(node -e "const r=require('$d/results.json');console.log(r.filter(x=>(x.jobs||[]).length).length+'/'+r.length)")
    echo "  == $L: done, boards read $got"
  else
    echo "  !! $L: exited $rc with no results.json (see logs/$L.log)"
  fi
  return 0
}
export -f scan_one
export ROOT ENGINE LOGDIR CONCURRENCY COMPANY_MS ENRICH

printf '%s\n' "${pending[@]}" \
  | xargs -P "$PARALLEL_LETTERS" -I{} bash -c 'scan_one "$@"' _ {}

echo
echo "All scans finished. Building the four weekend folders..."
node "$ROOT/weekendplan/build.js"
