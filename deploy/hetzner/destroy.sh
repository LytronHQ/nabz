#!/usr/bin/env bash
#
# destroy.sh — delete the nabz production fleet on Hetzner Cloud. The teardown
# counterpart to provision.sh (mirrors deploy/vm/destroy-vm.virt-manager.sh).
#
#   HCLOUD_TOKEN=… ./deploy/hetzner/destroy.sh          # prompts before deleting
#   HCLOUD_TOKEN=… ./deploy/hetzner/destroy.sh --yes    # no prompt (scripts/CI)
#
# Deletes every server AND every volume whose name starts with SERVER_PREFIX
# (default nabz-) AND is not labelled for a different environment.
#
# BOTH conditions matter. Production's prefix "nabz-" is a prefix of staging's
# names ("nabz-staging-pocketbase"), so prefix alone means a production teardown
# deletes the staging fleet and staging's pb_data volume with it. provision.sh
# already guards its firewall cleanup this exact way and says why; servers and
# volumes had no such guard, with far worse consequences.
#
# Deleting a server is irreversible and takes its local disk
# with it; deleting the PocketBase data volume takes pb_data — that is all your
# data, so make sure a backup/restore has been verified
# before running this on prod — restore a backup into a throwaway container first.
#
# The volume outlives the server it was attached to (#331), so a server-only
# teardown would leave a detached 20 GB volume billing quietly and would collide
# by name on the next provision.sh run. KEEP_VOLUMES=1 keeps them deliberately —
# e.g. rebuilding the PocketBase host around its existing data.
set -euo pipefail

API="https://api.hetzner.cloud/v1"
SERVER_PREFIX="${SERVER_PREFIX:-nabz-}"
# Which environment's resources may be deleted. Unlabelled resources are in scope
# (hand-made leftovers carry no labels) — only ones labelled for a DIFFERENT
# environment are excluded, which is what makes the prefix collision safe.
: "${ENVIRONMENT:?set ENVIRONMENT (production|staging) — it scopes the teardown by label, so a production run cannot delete staging}"
ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

die() { echo "error: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "missing 'curl'"
command -v jq   >/dev/null 2>&1 || die "missing 'jq'"
: "${HCLOUD_TOKEN:?set HCLOUD_TOKEN}"

# Status-checked. The old form ignored the HTTP code entirely, so a read-only
# token (403), a delete-protected server (423) or a rate limit (429) all produced
# an empty body, an exit 0, and a final "Done." with the fleet still running and
# still billing.
api() { # METHOD PATH
  local out code
  out="$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $HCLOUD_TOKEN" -w $'\n%{http_code}')"
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  case "$code" in
    2*) printf '%s' "$out" ;;
    404) printf '%s' "$out" ;;   # already gone — callers treat absence as success
    *)   echo "error: $1 $2 returned HTTP $code: $out" >&2; return 1 ;;
  esac
}

# Hetzner has no server-side name-prefix filter, so list all and match locally.
#
# Fetched into variables FIRST, and only then parsed. `mapfile < <(api …)` looks
# equivalent but swallows the exit status of a process substitution: with an
# invalid token the listing printed its error, produced zero rows, and the script
# went on to announce "nothing to do" and exit 0 — a teardown that deleted nothing
# reporting success, which is the failure this guards.
SERVERS_JSON="$(api GET "/servers?per_page=50")" || die "could not list servers — nothing was deleted"
VOLUMES_JSON="$(api GET "/volumes?per_page=50")" || die "could not list volumes — nothing was deleted"

mapfile -t ROWS < <(jq -r --arg p "$SERVER_PREFIX" --arg e "$ENVIRONMENT" \
  '.servers[]
   | select(.name | startswith($p))
   | select((.labels.env // $e) == $e)
   | "\(.id)\t\(.name)"' <<<"$SERVERS_JSON")

VOLS=()
SKIPPED_VOLS=()
if [ "${KEEP_VOLUMES:-0}" != "1" ]; then
  # Volumes require an EXPLICIT env-label match — no `// $e` default as with
  # servers. A volume is the database, and volumes created before they were
  # labelled carry no env at all, so treating unlabelled as in-scope is exactly
  # how a production teardown deletes staging's pb_data: "nabz-staging-pb-data"
  # starts with production's "nabz-" prefix. Erring the other way only leaves a
  # volume billing, which is loud and reversible.
  mapfile -t VOLS < <(jq -r --arg p "$SERVER_PREFIX" --arg e "$ENVIRONMENT" \
    '.volumes[]
     | select(.name | startswith($p))
     | select(.labels.env == $e)
     | "\(.id)\t\(.name)\t\(.size)"' <<<"$VOLUMES_JSON")

  # Anything matching the prefix that we are NOT deleting gets named, so an
  # unlabelled volume cannot quietly keep billing after a teardown.
  mapfile -t SKIPPED_VOLS < <(jq -r --arg p "$SERVER_PREFIX" --arg e "$ENVIRONMENT" \
    '.volumes[]
     | select(.name | startswith($p))
     | select(.labels.env != $e)
     | "\(.name)\t\(.size)\t\(.labels.env // "unlabelled")"' <<<"$VOLUMES_JSON")
fi
if [ "${#SKIPPED_VOLS[@]}" -gt 0 ]; then
  echo "NOT deleting these volumes — they are not labelled env=${ENVIRONMENT}:"
  printf '  %s\n' "${SKIPPED_VOLS[@]}" | awk -F'\t' '{print "  "$1" ("$2"GB, env="$3")"}'
  echo "  They keep billing. Delete by hand if they are genuinely yours to remove."
fi

if [ "${#ROWS[@]}" -eq 0 ] && [ "${#VOLS[@]}" -eq 0 ]; then
  echo "Nothing matching '${SERVER_PREFIX}*' for env=${ENVIRONMENT} — nothing to do."; exit 0
fi

if [ "${#ROWS[@]}" -gt 0 ]; then
  echo "Will DELETE these servers (and their disks):"
  printf '  %s\n' "${ROWS[@]}" | cut -f2
fi
if [ "${#VOLS[@]}" -gt 0 ]; then
  echo "Will DELETE these volumes (pb_data lives here — this is the DATABASE):"
  printf '  %s\n' "${VOLS[@]}" | awk -F'\t' '{print $2" ("$3"GB)"}'
elif [ "${KEEP_VOLUMES:-0}" = "1" ]; then
  echo "Keeping volumes (KEEP_VOLUMES=1) — they stay detached and keep billing."
fi
if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "Type 'delete' to confirm: " ans
  [ "$ans" = "delete" ] || die "aborted"
fi

for row in "${ROWS[@]}"; do
  id="${row%%$'\t'*}"; name="${row#*$'\t'}"
  echo "==> deleting server $name (id $id)"
  api DELETE "/servers/$id" >/dev/null
done

# Volumes after servers: Hetzner refuses to delete an attached volume, and
# deleting the server is what detaches it. Retry briefly — the detach is async,
# so the volume can still report attached for a moment after the server is gone.
for row in "${VOLS[@]}"; do
  IFS=$'\t' read -r id name _size <<<"$row"
  echo "==> deleting volume $name (id $id)"
  # DELETE returns an empty body, so success is confirmed by the volume no longer
  # being there — never by parsing the response.
  for _attempt in 1 2 3 4 5 6; do
    cur="$(api GET "/volumes/$id")"
    jq -e '.volume' >/dev/null 2>&1 <<<"$cur" || break   # gone
    if [ -n "$(jq -r '.volume.server // empty' <<<"$cur")" ]; then
      api POST "/volumes/$id/actions/detach" >/dev/null || true   # async
      sleep 5
      continue
    fi
    api DELETE "/volumes/$id" >/dev/null || true
    sleep 2
  done
  jq -e '.volume' >/dev/null 2>&1 <<<"$(api GET "/volumes/$id")" \
    && die "volume $name (id $id) is still there — detach and delete it by hand; it bills while it exists"
done
echo "Done."
