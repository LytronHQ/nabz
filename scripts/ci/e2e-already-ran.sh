#!/usr/bin/env bash
# e2e-already-ran.sh — has the e2e suite already finished on this exact commit?
#
#   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo ./scripts/ci/e2e-already-ran.sh <sha>
#
# Prints `result=success|failure|none` (also to $GITHUB_OUTPUT when set) and the
# run it found. The nightly re-ran an unchanged main 8 times in 20 days, 218 billed
# minutes, five of them repeating a known failure on the same code (#654).
#
# Only a run whose `e2e` job itself finished counts: a run the nightly gate
# skipped concludes "success" without testing anything, and a cancelled one tested
# nothing either. Runs older than six days do not count, so an unchanged main is
# still tested once a week against images and services that move under it.
set -uo pipefail

SHA="${1:?usage: $0 <sha>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
SINCE=$(date -u -d '6 days ago' +%F)

answer() { # result reason
  echo "result=$1"
  echo "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "result=$1" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

runs=$(gh api "repos/$REPO/actions/workflows/e2e.yml/runs?head_sha=$SHA&status=completed&created=>=$SINCE&per_page=20" \
  --jq '.workflow_runs[] | "\(.id) \(.html_url)"') || answer none "could not list the e2e runs; running the suite"

# Newest first, as the API lists them: the latest finished verdict wins.
while read -r id url; do
  [ -n "$id" ] || continue
  c=$(gh api "repos/$REPO/actions/runs/$id/jobs?filter=all" --jq '[.jobs[] | select(.name == "e2e") | .conclusion] | first // empty') \
    || answer none "could not read the jobs of $url; running the suite"
  case "$c" in
    success|failure) answer "$c" "e2e already finished on $SHA ($c): $url" ;;
  esac
done <<<"$runs"

answer none "no finished e2e run on $SHA since $SINCE"
