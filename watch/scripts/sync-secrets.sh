#!/usr/bin/env bash
# Read watch/.env (or the file given as $1) and push secrets to
# Cloudflare (wrangler) and the GitHub org (gh).
# Works on macOS /bin/bash 3.2 (no associative arrays).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE — copy .env.example to .env and fill it in" >&2
  exit 1
fi

command -v wrangler >/dev/null || { echo "wrangler not on PATH" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not on PATH" >&2; exit 1; }

env_get() {
  local key="$1"
  local line val
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)
  [ -z "$line" ] && return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

resolve() {
  local raw="$1"
  # trim
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  [ -z "$raw" ] && return 0
  case "$raw" in
    op://*)
      command -v op >/dev/null || { echo "op not on PATH (needed for $raw)" >&2; exit 1; }
      op read "$raw"
      ;;
    *)
      printf '%s' "$raw"
      ;;
  esac
}

need() {
  local key="$1" val
  val="$(env_get "$key")"
  if [ -z "$val" ]; then
    echo "missing $key in $ENV_FILE" >&2
    exit 1
  fi
}

need GITHUB_ORG
need MUSE_WATCH_URL
need MUSE_WATCH_HMAC
need JULES_API_KEY
need GITHUB_DISPATCH_TOKEN

ORG="$(resolve "$(env_get GITHUB_ORG)")"
URL="$(resolve "$(env_get MUSE_WATCH_URL)")"
HMAC="$(resolve "$(env_get MUSE_WATCH_HMAC)" | tr -d '\r\n')"
JULES="$(resolve "$(env_get JULES_API_KEY)" | tr -d '\r\n')"
PAT="$(resolve "$(env_get GITHUB_DISPATCH_TOKEN)" | tr -d '\r\n')"
URL="${URL%/}"

if [ -z "$HMAC" ] || [ -z "$JULES" ] || [ -z "$PAT" ] || [ -z "$URL" ] || [ -z "$ORG" ]; then
  echo "a required value resolved empty (check op:// paths)" >&2
  exit 1
fi

cd "$ROOT"

echo "wrangler secret put MUSE_WATCH_HMAC"
printf '%s' "$HMAC" | wrangler secret put MUSE_WATCH_HMAC
echo "wrangler secret put JULES_API_KEY"
printf '%s' "$JULES" | wrangler secret put JULES_API_KEY
echo "wrangler secret put GITHUB_DISPATCH_TOKEN"
printf '%s' "$PAT" | wrangler secret put GITHUB_DISPATCH_TOKEN

echo "gh variable set MUSE_WATCH_URL --org $ORG --visibility all"
gh variable set MUSE_WATCH_URL --org "$ORG" --visibility all --body "$URL"

echo "gh secret set MUSE_WATCH_HMAC --org $ORG --visibility all"
printf '%s' "$HMAC" | gh secret set MUSE_WATCH_HMAC --org "$ORG" --visibility all

echo "gh secret set JULES_API_KEY --org $ORG --visibility all"
printf '%s' "$JULES" | gh secret set JULES_API_KEY --org "$ORG" --visibility all

LINEAR_REF="$(env_get LINEAR_API_KEY || true)"
if [ -n "$LINEAR_REF" ]; then
  LINEAR="$(resolve "$LINEAR_REF" | tr -d '\r\n')"
  if [ -n "$LINEAR" ]; then
    echo "gh secret set LINEAR_API_KEY --org $ORG --visibility all"
    printf '%s' "$LINEAR" | gh secret set LINEAR_API_KEY --org "$ORG" --visibility all
  fi
fi

echo "done — Worker secrets + org var/secrets updated (values not printed)"
