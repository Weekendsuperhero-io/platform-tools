#!/usr/bin/env bash
# Sync the canonical label set (config/sources/repo.labels.json) to repos.
#
# Usage:
#   scripts/sync-repo-labels.sh owner/repo [owner/repo ...]
#   scripts/sync-repo-labels.sh --org <org>     # every non-archived repo
#
# Idempotent: `gh label create --force` creates or updates (color +
# description) in place; existing labels and their issue/PR assignments are
# never deleted.
#
# Note on "default" labels: GitHub's org-level default labels (Settings →
# Repository defaults → Labels) apply only to NEWLY created repos and have no
# API — mirror the manifest there once by hand if you want that, or just
# re-run this script (or press the muse:review label, which self-bootstraps)
# after creating a repo.
set -euo pipefail

MANIFEST="$(cd "$(dirname "$0")/.." && pwd)/config/sources/repo.labels.json"
[ -f "$MANIFEST" ] || { echo "Manifest not found: $MANIFEST" >&2; exit 1; }

repos=()
if [ "${1:-}" = "--org" ]; then
    ORG="${2:?usage: sync-repo-labels.sh --org <org>}"
    while IFS= read -r r; do repos+=("$r"); done \
        < <(gh repo list "$ORG" --no-archived --limit 200 --json nameWithOwner --jq '.[].nameWithOwner')
else
    repos=("$@")
fi
[ "${#repos[@]}" -gt 0 ] || { echo "No repos given. See usage in the header." >&2; exit 1; }

COUNT=$(jq '.labels | length' "$MANIFEST")
for repo in "${repos[@]}"; do
    echo "── ${repo} (${COUNT} labels)"
    while IFS=$'\t' read -r name color desc; do
        if gh label create "$name" --repo "$repo" --color "$color" --description "$desc" --force > /dev/null 2>&1; then
            echo "  ✓ $name"
        else
            echo "  ✗ $name (no access or issues disabled?)"
        fi
    done < <(jq -r '.labels[] | [.name, .color, .description] | @tsv' "$MANIFEST")
done
