# GitHub Repository Baseline

This repo contains a small TypeScript CLI for applying a default GitHub repository baseline:

- default branch normalization to `main`
- repository settings such as merge strategy, branch cleanup, wiki/projects/issues
- repository topics
- free repository security defaults such as Dependabot and public-repo code scanning
- repository rulesets
- organization-wide repo selection for bulk rollout

The tool uses Octokit, GitHub's official Node client. It works with GitHub.com and GitHub Enterprise Cloud as long as your token has the required admin permissions.

This repo uses `pnpm` and explicitly rejects `npm`.

## Files

- `config/baseline.example.json`: sample baseline definition
- `src/apply-github-baseline.ts`: typed CLI source
- `package.json`: build and run scripts

## Setup

Install dependencies:

```bash
pnpm install
```

Build:

```bash
pnpm run build
```

## Usage

Dry run a single repo:

```bash
pnpm run apply:baseline -- \
  --config config/baseline.example.json \
  --repo your-org/your-repo \
  --dry-run
```

Apply to a single repo:

```bash
pnpm run apply:baseline -- \
  --config config/baseline.example.json \
  --repo your-org/your-repo
```

Apply to a list of repos:

```bash
pnpm run apply:baseline -- \
  --config config/baseline.example.json \
  --repos-file repos.txt
```

Apply to every non-archived, non-disabled, non-fork, non-template repo in an org:

```bash
pnpm run apply:baseline -- \
  --config config/baseline.example.json \
  --org your-org
```

Control parallelism explicitly:

```bash
pnpm run apply:baseline -- \
  --config config/baseline.example.json \
  --org your-org \
  --concurrency 6
```

Filter the org run with a regex:

```bash
pnpm run apply:baseline -- \
  --config config/baseline.example.json \
  --org your-org \
  --match '^platform-|^service-'
```

By default, the CLI processes up to 4 repositories at a time and prints each repo's logs as a grouped block when that repo finishes.

## Auth

Set `GITHUB_TOKEN` or `GH_TOKEN` before applying for real. As a local fallback, the CLI also tries `gh auth token`.

If your non-interactive shell does not see the same `PATH` as your login shell, set `GH_PATH` explicitly:

```bash
export GH_PATH="$(command -v gh)"
```

The CLI checks for `gh` in this order:

- `GH_PATH`
- `gh` from `PATH`
- common install locations such as `/opt/homebrew/bin/gh` and `/usr/local/bin/gh`

If you are managing organization-owned repositories, use an account or token that can edit repository settings and rulesets.

## Baseline Format

The JSON file has three top-level sections:

```json
{
  "apiVersion": "2026-03-10",
  "repository": {
    "settings": {
      "allow_squash_merge": true,
      "allow_merge_commit": false
    },
    "topics": ["managed", "baseline"]
  },
  "rulesets": []
}
```

### `repository.settings`

This object is passed to `PATCH /repos/{owner}/{repo}`. Keep it to fields supported by GitHub's "Update a repository" endpoint, such as:

- `allow_squash_merge`
- `allow_merge_commit`
- `allow_rebase_merge`
- `allow_auto_merge`
- `allow_update_branch`
- `delete_branch_on_merge`
- `has_issues`
- `has_projects`
- `has_wiki`
- `squash_merge_commit_title`
- `squash_merge_commit_message`

Avoid setting `default_branch` unless you know the target branch already exists on every repo you will touch.

### `repository.default_branch`

Use this when you want the CLI to normalize every repository to the same default branch name.

Example:

```json
{
  "default_branch": {
    "name": "main",
    "rename_existing": true
  }
}
```

Behavior:

- if the repository already has `main`, the CLI switches the default branch to `main`
- if the repository does not have `main` and `rename_existing` is `true`, the CLI renames the current default branch to `main`
- if the repository does not have `main` and `rename_existing` is `false`, the CLI stops with an error
- if the repository is empty, the CLI skips default-branch normalization until the first push exists

### `repository.topics`

If present, topics are replaced via `PUT /repos/{owner}/{repo}/topics`.

### `rulesets`

Each entry is sent directly to GitHub's repository rulesets API. The CLI upserts by `(name, target)`:

- if a matching ruleset exists, it updates it
- otherwise it creates it

That means you can keep the GitHub-native ruleset payload shape in JSON without inventing another DSL.

If you want admins to be able to bypass a ruleset, include `bypass_actors`. The sample config now grants organization admins an always-on bypass:

```json
{
  "bypass_actors": [
    {
      "actor_id": null,
      "actor_type": "OrganizationAdmin",
      "bypass_mode": "always"
    }
  ]
}
```

On organization-owned repositories, GitHub's ruleset docs list repository admins, organization owners, and enterprise owners as eligible bypass actors, and the REST rules API exposes `OrganizationAdmin` as a supported `actor_type`. If you want admins to bypass only through pull requests, use `bypass_mode: "pull_request"` instead. Sources: [rulesets UI docs](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization), [repo rules REST API](https://docs.github.com/rest/repos/rules).

### `repository.security`

The CLI can also enable a few repository security features directly:

- `code_security`
- `vulnerability_alerts`
- `dependabot_security_updates`
- `code_scanning_default_setup`

The sample config enables `code_security` before `code_scanning_default_setup`, because GitHub's current prerequisite for default setup is that GitHub Actions are enabled and the repository is either public or has GitHub Code Security enabled. If GitHub rejects `code_security` or default setup for licensing or availability reasons, the CLI logs a skip and continues.

## Recommended First Pass

Start with one baseline ruleset on `~DEFAULT_BRANCH` and a small repository settings block. Once that is stable, add:

- required status checks
- required workflows
- code scanning gates
- repo-specific topics or labels in a second tool

## Notes

- This tool does not delete unmanaged rulesets.
- This tool does not create repositories.
- This tool does not yet manage labels, collaborators, teams, branch environments, or workflow files.

Those are reasonable next steps once the baseline shape is stable.
