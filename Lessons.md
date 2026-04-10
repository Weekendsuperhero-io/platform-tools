# Lessons Learned: Reusable Workflow Migration

## 1) Caller vs. Called Responsibilities
- `secrets: inherit` is configured in the **caller** job, not in the called workflow.
- `permissions` must also be set deliberately in the **caller** job when org defaults are restrictive.
- A reusable workflow cannot elevate beyond caller token permissions.

## 2) Do Not Use Local Action Paths in Cross-Repo Reusable Workflows
- `uses: ./.github/actions/...` resolves in the **caller repository** when called cross-repo.
- For reusable workflows intended for other repos, use fully-qualified references:
  - `owner/repo/path@ref`

## 3) `secrets.*` in `if:` Can Break Parsing
- Direct `if: secrets.X != ''` caused parse errors in called workflows.
- Safe pattern:
  1. Read secrets in a shell step `env`
  2. Validate pair completeness
  3. Write `enabled=true/false` to `$GITHUB_OUTPUT`
  4. Gate later steps with `if: steps.<id>.outputs.enabled == 'true'`

## 4) Git Pathspec Excludes Need Care
- Exclude pathspecs like `:!pnpm-lock.yaml` require `--` before pathspec arguments.
- Inputs containing literal shell quote characters can become invalid pathspecs.
- Normalize/strip quote characters before building arrays.

## 5) GitHub App Auth Requirements
- Client secret alone is not enough.
- Required for app-token auth:
  - App ID / client ID
  - App private key (PEM)
- For this setup, workflows use:
  - `JULES_PR_CLIENT_ID`
  - `JULES_PR_PRIVATE_KEY`

## 6) Bot Identity for Commits/PRs
- For changelog PRs with App auth, derive bot identity from app slug + bot user id:
  - `<app-slug>[bot] <id+app-slug[bot]@users.noreply.github.com>`
- Pass identity to both `author` and `committer`.

## 7) Least-Privilege Defaults
- Explicitly define workflow/job `permissions` instead of relying on org/repo defaults.
- Current hardening:
  - Reusable Rust CI: `contents: read`
  - Reusable Rust Release: default `contents: read`, with `create-release` job overriding to `contents: write`

## 8) Versioning/Consumption
- Callers pinned to older SHAs keep old behavior/bugs.
- After fixes land, callers should update reference (`@main` or a new pinned SHA/tag).
