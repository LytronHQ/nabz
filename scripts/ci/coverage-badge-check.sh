#!/usr/bin/env bash
# coverage-badge-check.sh — does the README badge still show this coverage?
#
#   ./scripts/ci/coverage-badge-check.sh "app coverage" 37 [README.md]
#
# The app and go jobs call it with the figure they have just measured. It used to
# be a job of its own on every merge to main, re-running both suites (~3 billed
# minutes) to compare four numbers the suites had just printed (#654). Here it is
# free, and it warns on the PR, before the merge.
#
# A stale badge is a warning, never a failure: refresh it with
# `./scripts/coverage.sh --write` in a PR. A badge that cannot be found is an
# error, so a renamed label cannot silently turn the check off.
set -euo pipefail

LABEL="${1:?usage: $0 <badge label> <percent> [readme]}"
PCT="${2:?usage: $0 <badge label> <percent> [readme]}"
README="${3:-$(cd "$(dirname "$0")/../.." && pwd)/README.md}"

shown=$(sed -n '/<!-- coverage:start -->/,/<!-- coverage:end -->/p' "$README" \
  | grep -o "!\[$LABEL\]([^)]*)" | sed -E 's/.*-([0-9]+)%25-.*/\1/' || true)
if [ -z "$shown" ]; then
  echo "::error title=No coverage badge::README.md has no '$LABEL' badge between the coverage markers."
  exit 1
fi
if [ "$shown" = "$PCT" ]; then
  echo "$LABEL: badge ${shown}% is current"
else
  echo "::warning title=Coverage badge is stale::$LABEL is ${PCT}%, the README badge says ${shown}%. Run ./scripts/coverage.sh --write and commit README.md."
fi
