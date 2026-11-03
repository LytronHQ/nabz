#!/usr/bin/env bash
# gates_test.sh — the CI gates against a stub GitHub API, and the badge check.
#
#   ./scripts/ci/gates_test.sh
#
# A gate that answers "already tested" when it is not skips a suite that should
# have run, and nothing goes red to say so. So every way to fall short of the
# proof is tested to answer "run it", and so is every API failure.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export GITHUB_REPOSITORY=o/r

# The stub answers `gh api <path> --jq <expr>` from $API/<path with / ? & = as _>.
# A missing file is an API error.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
[ "$1" = api ] || exit 2
f="$API/$(printf '%s' "$2" | tr '/?&=' '____')"
[ -f "$f" ] || { echo "stub: no $2" >&2; exit 1; }
if [ "${3:-}" = --jq ]; then jq -r "$4" "$f"; else cat "$f"; fi
GH
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

put() { # path json
  printf '%s' "$2" > "$API/$(printf '%s' "$1" | tr '/?&=' '____')"
}
reset() { API="$WORK/api-$1"; export API; mkdir -p "$API"; }
expect() { # want script sha
  local out; out="$("$HERE/$2" "$3")"
  head -1 <<<"$out" | grep -qx "$1" || fail "$2 $3: want $1, got: $out"
  echo "ok: $2 ($1) — $(sed -n 2p <<<"$out")"
}

# --- push-already-tested.sh ----------------------------------------------------
proven() { # a merge whose tree passed as a PR
  reset "$1"
  put repos/o/r/commits/M '{"parents":[{"sha":"P1"},{"sha":"P2"}]}'
  put repos/o/r/compare/P1...P2 '{"status":"ahead"}'
  put repos/o/r/git/commits/M '{"tree":{"sha":"T"}}'
  put repos/o/r/git/commits/P2 '{"tree":{"sha":"T"}}'
  put 'repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&head_sha=P2&status=success&per_page=1' \
    '{"workflow_runs":[{"html_url":"https://x/run/1"}]}'
}
proven ok;        expect tested=true  push-already-tested.sh M
proven squash;    put repos/o/r/commits/M '{"parents":[{"sha":"P1"}]}'
                  expect tested=false push-already-tested.sh M
proven stale;     put repos/o/r/compare/P1...P2 '{"status":"diverged"}'
                  expect tested=false push-already-tested.sh M
proven tree;      put repos/o/r/git/commits/P2 '{"tree":{"sha":"OTHER"}}'
                  expect tested=false push-already-tested.sh M
proven red;       put 'repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&head_sha=P2&status=success&per_page=1' '{"workflow_runs":[]}'
                  expect tested=false push-already-tested.sh M
proven apierr;    rm "$API/repos_o_r_compare_P1...P2"
                  expect tested=false push-already-tested.sh M
proven octopus;   put repos/o/r/commits/M '{"parents":[{"sha":"P1"},{"sha":"P2"},{"sha":"P3"}]}'
                  expect tested=false push-already-tested.sh M

# --- e2e-already-ran.sh --------------------------------------------------------
SINCE=$(date -u -d '6 days ago' +%F)
runs() { # json
  put "repos/o/r/actions/workflows/e2e.yml/runs?head_sha=S&status=completed&created=>=$SINCE&per_page=20" "$1"
}
job() { # run-id conclusion-of-the-e2e-job
  put "repos/o/r/actions/runs/$1/jobs?filter=all" \
    "{\"jobs\":[{\"name\":\"gate\",\"conclusion\":\"success\"},{\"name\":\"e2e\",\"conclusion\":\"$2\"}]}"
}
reset none;    runs '{"workflow_runs":[]}'
               expect result=none e2e-already-ran.sh S
reset green;   runs '{"workflow_runs":[{"id":1,"html_url":"u1"}]}'; job 1 success
               expect result=success e2e-already-ran.sh S
reset red;     runs '{"workflow_runs":[{"id":1,"html_url":"u1"}]}'; job 1 failure
               expect result=failure e2e-already-ran.sh S
# A run whose e2e job the gate skipped tested nothing: look past it.
reset skipped; runs '{"workflow_runs":[{"id":2,"html_url":"u2"},{"id":1,"html_url":"u1"}]}'
               job 2 skipped; job 1 failure
               expect result=failure e2e-already-ran.sh S
reset onlyskip; runs '{"workflow_runs":[{"id":2,"html_url":"u2"},{"id":3,"html_url":"u3"}]}'
               job 2 skipped; job 3 cancelled
               expect result=none e2e-already-ran.sh S
# Newest verdict wins: a later green run over an earlier red one.
reset fixed;   runs '{"workflow_runs":[{"id":5,"html_url":"u5"},{"id":4,"html_url":"u4"}]}'
               job 5 success; job 4 failure
               expect result=success e2e-already-ran.sh S
reset apierr;  expect result=none e2e-already-ran.sh S
reset joberr;  runs '{"workflow_runs":[{"id":1,"html_url":"u1"}]}'
               expect result=none e2e-already-ran.sh S

# --- coverage-badge-check.sh -----------------------------------------------------
cat > "$WORK/README.md" <<'MD'
<!-- coverage:start -->
![app coverage](https://img.shields.io/badge/app%20coverage-37%25-yellow?style=flat-square) ![worker](https://img.shields.io/badge/worker-63%25-green?style=flat-square)
<!-- coverage:end -->
MD
badge() { "$HERE/coverage-badge-check.sh" "$@" "$WORK/README.md"; }
badge "app coverage" 37 | grep -q 'is current' || fail "badge: a matching figure is not current"
badge worker 63 | grep -q 'is current' || fail "badge: worker 63 is not current"
badge worker 64 | grep -q '::warning.*worker is 64%, the README badge says 63%' || fail "badge: no warning on a stale figure"
if badge corelib 30 >/dev/null; then fail "badge: a missing badge passed"; fi
echo "ok: coverage-badge-check.sh (current, stale, missing)"

echo "all gate tests passed"
