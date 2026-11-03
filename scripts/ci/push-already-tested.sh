#!/usr/bin/env bash
# push-already-tested.sh — did CI already pass on exactly this tree, as a PR?
#
#   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo ./scripts/ci/push-already-tested.sh <sha>
#
# Prints `tested=true` or `tested=false` (also to $GITHUB_OUTPUT when set) and
# why. Every merge to main in October 2026 re-ran the full suite on a tree its PR
# had already passed: 76 of 76 push runs, 551 billed minutes (#654).
#
# `true` needs all of it proven through the API:
#   - <sha> is a merge commit, parents p1 (main before) and p2 (the PR head);
#   - p1 is an ancestor of p2, and <sha>'s tree is p2's tree;
#   - a pull_request CI run on p2 succeeded.
# That PR run tested merge(p2, B) for the base B of its day. main only moves
# forward (no force-pushes), so B is an ancestor of p1 and so of p2, and
# merge(p2, B) is p2's tree: the very tree this push would test again.
# Anything not proven — a squash, a stale branch, a red or missing PR run, an API
# error — answers `false`, and the caller runs the suite.
set -uo pipefail

SHA="${1:?usage: $0 <sha>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

answer() { # tested reason
  echo "tested=$1"
  echo "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "tested=$1" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

parents=$(gh api "repos/$REPO/commits/$SHA" --jq '[.parents[].sha] | join(" ")') \
  || answer false "could not read $SHA; running the suite"
read -r p1 p2 extra <<<"$parents"
[ -n "${p2:-}" ] && [ -z "${extra:-}" ] || answer false "$SHA is not a two-parent merge; running the suite"

status=$(gh api "repos/$REPO/compare/$p1...$p2" --jq .status) \
  || answer false "could not compare $p1...$p2; running the suite"
case "$status" in
  ahead|identical) ;;
  *) answer false "the PR head $p2 did not contain main ($status); its PR run tested another tree" ;;
esac

tree_m=$(gh api "repos/$REPO/git/commits/$SHA" --jq .tree.sha) || answer false "could not read the tree of $SHA"
tree_h=$(gh api "repos/$REPO/git/commits/$p2" --jq .tree.sha) || answer false "could not read the tree of $p2"
[ "$tree_m" = "$tree_h" ] || answer false "the merge tree $tree_m differs from the PR head's $tree_h"

run=$(gh api "repos/$REPO/actions/workflows/ci.yml/runs?event=pull_request&head_sha=$p2&status=success&per_page=1" \
  --jq '.workflow_runs[0].html_url // empty') || answer false "could not list the CI runs for $p2"
[ -n "$run" ] || answer false "no successful pull_request CI run for $p2"

answer true "tree $tree_m already passed CI as PR head $p2: $run"
