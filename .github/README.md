# Reusable GitHub Workflows

This directory contains reusable workflows that can be called from other repositories as thin shims.

## Available Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| PR Description | `reusable-pr-description.yml` | Auto-generates PR titles and descriptions using Jules AI |
| Changelog | `reusable-changelog.yml` | Auto-generates changelog entries and creates a PR |

## Quick Start

### 1. PR Description Generator

Add this to your consuming repo at `.github/workflows/pr-description.yml`:

```yaml
name: Update PR Description

on:
  pull_request:
    types: [opened, edited]

jobs:
  update-pr:
    uses: <owner>/<repo>/.github/workflows/reusable-pr-description.yml@main
    with:
      trigger-phrase: "@agent pr-title"  # optional — only runs if this phrase is in the PR body
    secrets:
      JULES_API_KEY: ${{ secrets.JULES_API_KEY }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**How it works:**
- When a PR is opened/edited with `@agent pr-title` in the body, the workflow:
  1. Diffs the PR against its base branch
  2. Sends the diff + commit messages to Jules AI
  3. Updates the PR with a structured title and description
- If the PR body doesn't contain the trigger phrase, the workflow skips

### 2. Changelog Generator

Add this to your consuming repo at `.github/workflows/changelog.yml`:

```yaml
name: Update Changelog

on:
  workflow_dispatch:  # manual trigger
  # schedule:
  #   - cron: "0 0 * * 1"  # every Monday (optional)

jobs:
  changelog:
    uses: <owner>/<repo>/.github/workflows/reusable-changelog.yml@main
    with:
      changelog-path: CHANGELOG.md
      pr-branch-prefix: "chore/changelog-"
    secrets:
      JULES_API_KEY: ${{ secrets.JULES_API_KEY }}
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**How it works:**
- Finds the last commit that touched `CHANGELOG.md`
- Collects all commits since then
- Sends commits + diff to Jules AI to generate changelog entries
- Inserts entries under `## [Unreleased]` (Keep a Changelog format)
- Creates a PR with the updated changelog

## Configuration Options

### PR Description Workflow

| Input | Default | Description |
|-------|---------|-------------|
| `trigger-phrase` | `@agent pr-title` | Phrase required in PR body to trigger the workflow |
| `base-branch` | *(auto-detect)* | Branch to diff against |
| `diff-file-patterns` | `*.rs *.ts *.tsx *.toml *.sql *.yml *.sh *.css` | File patterns to include in diff |
| `diff-exclude-patterns` | `:!pnpm-lock.yaml :!Cargo.lock :!**/bindings/*.ts` | Patterns to exclude |
| `max-diff-lines` | `4000` | Max lines of code diff to send |
| `max-commit-messages` | `30` | Max commit messages to include |
| `custom-prompt` | *(built-in)* | Override the Jules prompt entirely |

### Changelog Workflow

| Input | Default | Description |
|-------|---------|-------------|
| `changelog-path` | `CHANGELOG.md` | Path to your changelog file |
| `pr-branch-prefix` | `chore/update-changelog` | Prefix for the generated PR branch |
| `diff-file-patterns` | *(same as PR)* | File patterns to include |
| `diff-exclude-patterns` | *(same as PR)* | Patterns to exclude |
| `max-diff-lines` | `4000` | Max lines of code diff |
| `max-commit-messages` | `50` | Max commit messages |
| `fallback-commit-count` | `20` | Commits to use when no previous changelog entry |
| `unreleased-heading` | `## [Unreleased]` | The heading to insert entries under |
| `custom-prompt` | *(built-in)* | Override the Jules prompt |
| `pr-title` | `docs: update CHANGELOG.md` | Title for the generated PR |
| `pr-body-template` | *(auto)* | Body template (`{commit_count}` is interpolated) |

## Required Secrets

Both workflows require:

| Secret | Required | Description |
|--------|----------|-------------|
| `JULES_API_KEY` | Yes | API key for Jules AI |
| `GITHUB_TOKEN` | Yes | GitHub token (provided automatically by GitHub Actions) |

Add `JULES_API_KEY` to your repo's **Settings → Secrets and variables → Actions**.

## Architecture

```
┌──────────────────────────────┐
│   Consuming Repository       │
│                              │
│  .github/workflows/          │
│    pr-description.yml ───────┼──┐
│    changelog.yml ────────────┼──┐
└──────────────────────────────┘  │
                                  │ workflow_call
                                  ▼
┌──────────────────────────────┐
│   Source Repository          │
│                              │
│  .github/workflows/          │
│    reusable-pr-description.yml│
│    reusable-changelog.yml    │
│                              │
│  .github/actions/            │
│    jules-ai/action.yml ──────┼──┐ (composite action)
└──────────────────────────────┘
```

## Troubleshooting

**Workflow doesn't trigger:**
- For PR description: ensure the trigger phrase appears in the PR body
- For changelog: ensure you're triggering `workflow_dispatch` or the schedule

**Jules returns plain text instead of JSON (PR workflow):**
- The workflow falls back to using the raw text as the description — this is expected

**"No output from Jules" error:**
- Check that `JULES_API_KEY` is set correctly
- Check Jules API status / rate limits

**Changelog entries appear in wrong place:**
- Ensure your changelog has the exact `## [Unreleased]` heading (or configure `unreleased-heading`)
