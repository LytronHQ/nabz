#!/usr/bin/env bash
#
# vapid-keys.sh — mint a VAPID key pair for Web Push (#602) and print it as
#
#   VAPID_PUBLIC_KEY=<base64url, 65-byte uncompressed P-256 point>
#   VAPID_PRIVATE_KEY=<base64url, 32-byte scalar>
#
# the raw form browsers (applicationServerKey) and webpush-go expect. Only
# openssl, so it runs on a stock CI runner. The caller decides where the values
# go; nothing is written to disk outside a temp dir removed on exit.
#
# A new pair invalidates every existing subscription: browsers bind each one to
# the public key it was made with. Mint once per environment, never rotate
# casually.
set -euo pipefail
command -v openssl >/dev/null || { echo "vapid-keys: openssl is required" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key.pem" 2>/dev/null
# The DER private key is a fixed SEC1 layout for P-256: the 32-byte scalar
# starts at offset 7; the SPKI public key ends with the 65-byte point.
openssl ec -in "$tmp/key.pem" -outform DER 2>/dev/null | tail -c +8 | head -c 32 > "$tmp/priv"
openssl ec -in "$tmp/key.pem" -pubout -outform DER 2>/dev/null | tail -c 65 > "$tmp/pub"

[ "$(wc -c < "$tmp/priv")" -eq 32 ] || { echo "vapid-keys: private key is not 32 bytes" >&2; exit 1; }
[ "$(head -c 1 "$tmp/pub" | od -An -tx1 | tr -d ' ')" = "04" ] || { echo "vapid-keys: public key is not an uncompressed point" >&2; exit 1; }

echo "VAPID_PUBLIC_KEY=$(b64url < "$tmp/pub")"
echo "VAPID_PRIVATE_KEY=$(b64url < "$tmp/priv")"
