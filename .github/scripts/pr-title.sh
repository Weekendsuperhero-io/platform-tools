#!/usr/bin/env bash
# Generate a PR title and description from the current branch's diff using Jules.
#
# Usage:
#   JULES_API_KEY=... .github/scripts/pr-title.sh [base-branch]
#
# base-branch defaults to origin/main.
# Outputs the title and description to stdout.

set -euo pipefail

BASE="${1:-origin/main}"
API="https://jules.googleapis.com/v1alpha/sessions"

if [ -z "${JULES_API_KEY:-}" ]; then
  echo "Error: JULES_API_KEY is not set" >&2
  exit 1
fi

# Get the diff and JSON-escape it
echo "Generating PR title from diff against ${BASE}..." >&2
diff_data=$(git diff "$BASE" | jq -Rs .)

if [ "$diff_data" = '""' ] || [ "$diff_data" = 'null' ]; then
  echo "Error: No diff found against ${BASE}" >&2
  exit 1
fi

# Create a Jules session with the diff
# Write prompt to file to avoid "argument list too long" for large diffs
echo "Generate a pull request title and description for this diff. Return ONLY the title on the first line, then a blank line, then the description in markdown. No other text." > /tmp/pr_prompt.txt
echo "" >> /tmp/pr_prompt.txt
git diff "$BASE" >> /tmp/pr_prompt.txt

jq -Rs '{prompt: ., title: "PR Title and Description"}' /tmp/pr_prompt.txt > /tmp/pr_payload.json

echo "Creating Jules session..." >&2
session_response=$(curl -s "$API" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -d @/tmp/pr_payload.json)

session_name=$(echo "$session_response" | jq -r '.name // empty')
if [ -z "$session_name" ]; then
  echo "Error: Failed to create session" >&2
  echo "$session_response" | jq . >&2
  exit 1
fi

# Extract session ID from name (format: "sessions/12345")
session_id=$(echo "$session_name" | sed 's|sessions/||')
echo "Session created: $session_id" >&2

# Poll for an agent activity (max 360 seconds)
max_wait=360
waited=0
interval=5

while [ $waited -lt $max_wait ]; do
  activities=$(curl -s -H "x-goog-api-key: $JULES_API_KEY" \
    "$API/$session_id/activities")

  message=$(echo "$activities" | jq -r '
    [(.activities // [])[]
      | select(.originator == "agent")
      | select(.agentMessaged != null)
      | .agentMessaged.agentMessage
    ] | first // empty
  ')

  if [ -n "$message" ]; then
    echo "Agent responded" >&2
    break
  fi

  echo "  Waiting for agent response... (${waited}s)" >&2
  sleep $interval
  waited=$((waited + interval))
done

if [ $waited -ge $max_wait ]; then
  echo "Error: Timed out waiting for Jules agent response (${max_wait}s)" >&2
  exit 1
fi

if [ -z "$message" ] || [ "$message" = "null" ]; then
  echo "Error: No response from Jules" >&2
  echo "$activities" | jq . >&2
  exit 1
fi

echo "$message"
