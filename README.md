# GitHub Repository Baseline

This repo contains a TypeScript CLI for applying GitHub baseline policy at two scopes:

- repo-level settings, topics, security defaults, and optional repo rulesets
- org-level settings, rulesets, Actions policy, and security product configurations

The tool uses Octokit and works with GitHub.com / GitHub Enterprise Cloud when the token has the required admin permissions.

This repo uses `pnpm` and explicitly rejects `npm`.

## Files

- `config/public-max*.json`: public repo max profile (`repo`, `org`, combined)
- `config/private-team-free*.json`: private repo Team-free profile (`repo`, `org`, combined)
- `config/private-team-paid*.json`: private repo Team paid profile (`repo`, `org`, combined)
- `config/private-team-requires-ghec*.json`: private repo enterprise-required profile (`repo`, `org`, combined)
- `config/baseline*.json` and `config/security-low-cost*.json`: compatibility aliases to `private-team-free*`
- `config/sources/repo.shared.json`: source-of-truth repo baseline fragment (shared across profiles)
- `config/sources/security-profiles.json`: source-of-truth per-profile security overrides
- `config/sources/org.default-rulesets.json`: source-of-truth org ruleset fragment
- `config/sources/org.settings.json`: source-of-truth org governance/security-default settings fragment
- `config/sources/org.actions.json`: source-of-truth org GitHub Actions policy fragment
- `config/sources/org.packages.json`: source-of-truth org package policy intent
- `config/sources/org.security-configurations.json`: source-of-truth org security configuration matrix per profile
- `scripts/generate-configs.mjs`: generates all config artifacts from `config/sources/*`
- `src/apply-github-baseline.ts`: typed CLI source
- `src/export-github-org-snapshot.ts`: export current org settings into editable baseline JSON shape
- `package.json`: build/run scripts

## Setup

Install dependencies:

```bash
pnpm install
```

Build:

```bash
pnpm run build
```

Generate config artifacts from sources:

```bash
pnpm run configs:generate
```

Check that generated config artifacts are up to date:

```bash
pnpm run configs:check
```

## Usage

Repo-only dry run (single repo):

```bash
pnpm run apply:baseline -- \
  --config config/private-team-free.repo.json \
  --repo your-org/your-repo \
  --dry-run
```

Repo-only apply to every eligible repo in an org:

```bash
pnpm run apply:baseline -- \
  --config config/private-team-free.repo.json \
  --org your-org
```

Org-ruleset-only apply:

```bash
pnpm run apply:baseline -- \
  --config config/private-team-free.org.json \
  --org your-org
```

Combined apply (`repo` + `org`):

```bash
pnpm run apply:baseline -- \
  --config config/private-team-free.json \
  --org your-org
```

Force apply (skip read-before-write optimization):

```bash
pnpm run apply:baseline -- \
  --config config/private-team-free.org.json \
  --org your-org \
  --force
```

Snapshot current org into editable config JSON:

```bash
pnpm run snapshot:org -- \
  --org your-org \
  --out config/your-org.snapshot.org.json
```

Profile helper scripts:

```bash
pnpm run apply:public-max:repo -- --org your-org
pnpm run apply:private-team-free:repo -- --org your-org
pnpm run apply:private-team-paid:repo -- --org your-org
pnpm run apply:private-team-requires-ghec:repo -- --org your-org

pnpm run apply:public-max:org -- --org your-org
pnpm run apply:private-team-free:org -- --org your-org
pnpm run apply:private-team-paid:org -- --org your-org
pnpm run apply:private-team-requires-ghec:org -- --org your-org

pnpm run apply:public-max:all -- --org your-org
pnpm run apply:private-team-free:all -- --org your-org
pnpm run apply:private-team-paid:all -- --org your-org
pnpm run apply:private-team-requires-ghec:all -- --org your-org
```

Control parallelism:

```bash
pnpm run apply:baseline -- \
  --config config/private-team-free.repo.json \
  --org your-org \
  --concurrency 6
```

Filter org runs with a regex:

```bash
pnpm run apply:baseline -- \
  --config config/private-team-free.repo.json \
  --org your-org \
  --match '^platform-|^service-'
```

By default the CLI processes 4 repos at a time and prints grouped repo logs plus live progress lines.
For org-level settings, the CLI reads current values first and only sends changed keys unless `--force` is set.

## Auth

Set `GITHUB_TOKEN` or `GH_TOKEN` before real runs. As a fallback, the CLI also tries `gh auth token`.

If your non-interactive shell does not see the same `PATH` as your login shell, set `GH_PATH`:

```bash
export GH_PATH="$(command -v gh)"
```

`gh` resolution order:

- `GH_PATH`
- `gh` from `PATH`
- common install locations (`/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, etc.)

For org-level settings, the CLI preflights:

- `gh auth status` (when `gh` is available)
- `GET /orgs/{org}/rulesets` using your configured API version
- `GET /orgs/{org}/actions/permissions` when `org.actions` is present
- `GET /orgs/{org}/code-security/configurations` when `org.security_configurations` is present

If needed:

```bash
gh auth refresh -h github.com -s repo,read:org,admin:org,admin:organization
```

## Config Shape

The canonical config shape is split by scope:

```json
{
  "apiVersion": "2026-03-10",
  "repo": {
    "repository": {
      "settings": {
        "allow_squash_merge": true,
        "allow_merge_commit": false
      },
      "topics": ["managed", "baseline"]
    },
    "rulesets": []
  },
  "org": {
    "rulesets": [],
    "settings": {
      "default_repository_permission": "read",
      "members_can_create_repositories": true
    },
    "actions": {
      "permissions": {
        "enabled_repositories": "all",
        "allowed_actions": "selected"
      }
    },
    "packages": {
      "package_creation": {
        "public": true,
        "private": true,
        "internal": true
      }
    },
    "security_configurations": []
  }
}
```

Notes:

- `org.rulesets` requires `--org`
- org-only configs now apply org rulesets without traversing repos
- legacy top-level keys (`repository`, `rulesets`, `orgRulesets`) are still accepted for backward compatibility
- edit `config/sources/*` and regenerate; treat `config/*.json` under `config/` as generated artifacts

### `repo.repository.settings`

Passed to `PATCH /repos/{owner}/{repo}`. Keep keys supported by GitHub's update-repo endpoint.

### `repo.repository.default_branch`

Default-branch normalization behavior:

- if target branch exists, switch default branch
- if target branch does not exist and `rename_existing=true`, rename current default branch
- if target branch does not exist and `rename_existing=false`, fail
- empty repos are skipped for branch normalization

### `repo.repository.topics`

If present, topics are replaced via `PUT /repos/{owner}/{repo}/topics`.

### `repo.rulesets`

Per-repo rulesets, upserted by `(name, target)`.

### `org.rulesets`

Organization rulesets, upserted by `(name, target)`.

If you want admin bypass, include `bypass_actors` with `actor_type: "OrganizationAdmin"`.

### `org.settings`

Supported org governance/security-default settings via `PATCH /orgs/{org}`.

Common fields:

- org profile fields (`name`, `description`, `company`, `location`, `email`, `blog`, etc.)
- repository creation/permission defaults (`default_repository_permission`, `members_can_create_*`)

Apply behavior:

- default: reads current org settings and only PATCHes changed keys
- `--force`: PATCHes all configured `org.settings` keys regardless of current value
- deprecated org API fields are ignored with a warning (including `members_allowed_repository_creation_type` and org-level new-repo security product toggles); use `org.security_configurations` defaults instead
- `members_can_create_internal_repositories` is automatically skipped on Team orgs where internal repositories are unsupported

### `org.actions`

Supported org-level Actions controls:

- `permissions` (`enabled_repositories`, `allowed_actions`, optional `sha_pinning_required`)
- `selected_actions` (`github_owned_allowed`, `verified_allowed`, `patterns_allowed`)
- `artifact_and_log_retention` (`days`)
- `fork_pr_contributor_approval` (`approval_policy`)
- `fork_pr_private_repos` (`run_workflows_from_fork_pull_requests`, optional related toggles)
- `workflow_permissions` (`default_workflow_permissions`, `can_approve_pull_request_reviews`)
- `self_hosted_runners` (`enabled_repositories`)
- `cache` (`max_cache_size_gb`, `max_cache_retention_days`)
- `runner_groups` (`name`, `visibility`, repository selection, public repo access, workflow access, network configuration)

For `selected_actions`, the API expects `patterns_allowed` as a string array.
In the GitHub UI this is shown as a comma-separated list.

Runner group example:

```json
{
  "name": "Linux Prod",
  "visibility": "selected",
  "selected_repositories": [
    "your-org/api",
    "web"
  ],
  "allows_public_repositories": false,
  "restricted_to_workflows": true,
  "selected_workflows": [
    "api/.github/workflows/deploy.yml"
  ],
  "network_configuration_id": "ncfg_123"
}
```

Current default org Actions policy in `config/sources/org.actions.json`:

- enable Actions for `all` repositories
- allow `selected` actions: GitHub-owned + Marketplace verified creators + explicit `patterns_allowed`
- artifact/log retention: `30` days
- fork PR contributor approval policy: `all_external_contributors`
- private/internal fork PR workflows: disabled (`run_workflows_from_fork_pull_requests=false`)
- default workflow token permissions: `read`
- workflow PR approval by Actions: disabled (`can_approve_pull_request_reviews=false`)
- cache limits: `10GB` max size and `30` max retention days
- runner groups: none managed by default (`runner_groups: []`)

### `org.packages`

Supported as typed config intent:

- `package_creation` (`public`, `private`, `internal`)
- `default_settings.inherit_access_from_source_repository` (`default`, `enabled`, `disabled`)

Current status:

- GitHub does not currently expose a public REST endpoint for applying these organization package defaults.
- The CLI validates and reports the desired settings, and you apply them manually in Org Settings -> Packages.
- Keep this section in JSON as source-of-truth intent and track manual drift in docs/reviews.
- On Team orgs with `members_can_create_internal_repositories=false`, `package_creation.internal` is future-facing and currently a no-op.

### `org.security_configurations`

Supported org security product configuration management:

- create/update custom org security configurations (`POST/PATCH /orgs/{org}/code-security/configurations`)
- attach configurations to repo scopes (`POST /orgs/{org}/code-security/configurations/{configuration_id}/attach`)
- set defaults for new repos (`PUT /orgs/{org}/code-security/configurations/{configuration_id}/defaults`)

Supported config fields include:

- advanced security status (`advanced_security`) plus granular status toggles (`code_security`, `secret_protection`, `dependency_graph`, `dependabot_*`, `code_scanning_*`, `secret_scanning_*`, `private_vulnerability_reporting`)
- code scanning options (`code_scanning_options`, `code_scanning_default_setup_options`)
- secret scanning delegated bypass reviewers (`secret_scanning_delegated_bypass_options.reviewers`)
- policy controls (`enforcement`, `attach`, `default_for_new_repos`)

When `code_security` or `secret_protection` is set, the CLI omits `advanced_security` in API payloads to match current REST API validation rules.
When `secret_scanning` is not `enabled`, the CLI normalizes secret-scanning sub-controls (`*_validity_checks`, `*_non_provider_patterns`, `*_generic_secrets`, delegated alert dismissal, extended metadata) from `not_set` to `disabled` in API payloads to satisfy current REST validation.
`dependabot_delegated_alert_dismissal` can only be `enabled` when both `dependabot_alerts` and code security are enabled.

Note: some UI-only toggles (for example malware alerts) are not currently exposed in this REST endpoint and are not managed by the CLI.
On Team orgs with internal repositories disabled, `private_or_internal` / `private_and_internal` semantics apply to private repositories only in practice.

Current defaults in `config/sources/org.security-configurations.json`:

- `public-max` always targets public repositories
- private profiles target private/internal repos with profile-specific settings:
  - `private-team-free`
  - `private-team-paid`
  - `private-team-requires-ghec`
- DRY source format uses reusable `templates` plus per-profile template lists under `profiles`

### `repo.repository.security`

Supported toggles:

- `advanced_security` (alias of `code_security` for compatibility)
- `code_security`
- `secret_scanning`
- `secret_scanning_push_protection`
- `vulnerability_alerts`
- `dependabot_security_updates`
- `code_scanning_default_setup`

## Security Profiles

- `public-max`: intended for public repos; enables all supported toggles and configures default setup in `public-only` mode.
- `private-team-free`: Team-friendly low-cost baseline; keeps dependency/security hygiene but disables paid security products.
- `private-team-paid`: enables paid security products for private repos.
- `private-team-requires-ghec`: enterprise-oriented profile, currently same as paid plus `extended` query suite for default setup.

All profiles share the same org Actions policy from `config/sources/org.actions.json`.

The default `pnpm run apply` command maps to `private-team-free.repo.json`.

## Notes

- This tool does not delete unmanaged rulesets.
- This tool does not create repositories.
- This tool does not yet manage labels, collaborators, teams, environments, or workflow files.
