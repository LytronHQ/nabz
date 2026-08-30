#!/usr/bin/env bash
#
# Test-coverage numbers for the README (#177, #228).
#
#   ./scripts/coverage.sh          # print the current numbers
#   ./scripts/coverage.sh --write  # rewrite the README's coverage badges in place
#
# CI runs `--write` on merge to main and commits the refreshed badges, so they
# stay current automatically; run it by hand for a local preview. Uses the repo's
# toolchains — vitest (@vitest/coverage-v8) + `go test -cover`. No extra deps.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
GO="${GO:-/snap/go/current/bin/go}"; command -v "$GO" >/dev/null 2>&1 || GO=go
REPO="LytronHQ/nabz"

echo "Running the test suites with coverage (this takes a moment)…" >&2

# --- app (vitest, scoped to src/ via vite.config.ts) ---
( cd app && npx vitest run --coverage >/dev/null 2>&1 )
APP=$(python3 -c 'import json;print(round(json.load(open("app/coverage/coverage-summary.json"))["total"]["lines"]["pct"]))' 2>/dev/null || echo 0)

# --- go modules (each package total) ---
declare -A GOP
for m in corelib worker evaluator; do
  ( cd "$m" && "$GO" test ./... -coverprofile="$ROOT/.cov.$m" >/dev/null 2>&1 )
  GOP[$m]=$("$GO" tool cover -func="$ROOT/.cov.$m" 2>/dev/null | awk '/^total:/{gsub("%","",$3);printf "%d",$3+0.5}')
  GOP[$m]=${GOP[$m]:-0}
  rm -f "$ROOT/.cov.$m"
done

if [ "${1:-}" != "--write" ]; then
  cat >&2 <<MSG

Coverage: app ${APP}% · corelib ${GOP[corelib]}% · worker ${GOP[worker]}% · evaluator ${GOP[evaluator]}%
(run with --write to update the README badges)
MSG
  exit 0
fi

# --- rewrite the README badge block between the coverage markers ---
APP=$APP CORELIB=${GOP[corelib]} WORKER=${GOP[worker]} EVALUATOR=${GOP[evaluator]} REPO=$REPO \
python3 - <<'PY'
import os, re
def color(p):
    p = int(p)
    return ("brightgreen" if p >= 80 else "green" if p >= 60 else "yellowgreen"
            if p >= 45 else "yellow" if p >= 30 else "orange" if p >= 15 else "red")
def badge(label, pct):
    lbl = label.replace(" ", "%20")
    return f"![{label}](https://img.shields.io/badge/{lbl}-{pct}%25-{color(pct)}?style=flat-square)"
repo = os.environ["REPO"]
badges = " ".join([
    badge("app coverage", os.environ["APP"]),
    badge("corelib", os.environ["CORELIB"]),
    badge("worker", os.environ["WORKER"]),
    badge("evaluator", os.environ["EVALUATOR"]),
])
block = f"<!-- coverage:start -->\n{badges}\n<!-- coverage:end -->"
readme = open("README.md").read()
new = re.sub(r"<!-- coverage:start -->.*?<!-- coverage:end -->", block, readme, flags=re.S)
open("README.md", "w").write(new)
print("README coverage badges updated.")
PY
