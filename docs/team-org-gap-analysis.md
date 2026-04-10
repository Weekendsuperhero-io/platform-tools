# Team Org Capability And Gap Matrix

Snapshot time: `2026-04-09` (America/Los_Angeles)
Org: `Weekendsuperhero-io`
Plan: `team`

Tooling update: org snapshots can now be exported with `pnpm run snapshot:org -- --org <org> --out <file>` to generate editable config JSON.

## Live Org Snapshot (Today)

### Core org settings

| Setting | Current value |
|---|---|
| Repositories | `public=8`, `private=2`, `internal=0` |
| Default repository permission | `read` |
| Members can create repositories | `true` |
| Members can create public repositories | `true` |
| Members can create private repositories | `true` |
| Members can create internal repositories | `false` |
| Members can create teams | `true` |
| Members can fork private repositories | `false` |
| Members can delete repositories | `true` |
| Members can change repository visibility | `true` |
| Members can invite outside collaborators | `true` |
| Two-factor requirement enabled | `false` |
| Default repository branch | `main` |
| Advanced Security enabled for new repos | `false` |
| Dependabot alerts enabled for new repos | `true` |
| Dependabot security updates enabled for new repos | `true` |
| Dependency graph enabled for new repos | `true` |
| Secret scanning enabled for new repos | `false` |
| Secret scanning push protection enabled for new repos | `false` |
| Secret scanning validity checks enabled for new repos | `false` |

### Actions, rulesets, and security config

| Setting | Current value |
|---|---|
| Actions permissions | `enabled_repositories=all`, `allowed_actions=all`, `sha_pinning_required=false` |
| Selected-actions policy endpoint | `409 Conflict` (inactive because `allowed_actions=all`) |
| Artifact/log retention | `90` days |
| Fork PR contributor approval | `all_external_contributors` |
| Fork PR workflows in private/internal repos | `run=false`, `write_token=false`, `secrets=false`, `require_approval=false` |
| Workflow token defaults | `default_workflow_permissions=read`, `can_approve_pull_request_reviews=true` |
| Self-hosted runners policy | `enabled_repositories=selected` |
| Self-hosted runner selected repos | 4 repos (`agent`, `agent-releases`, `agentmail`, `eventkit-rs`) |
| Org cache storage limit | `10 GB` |
| Org cache retention limit | `7` days |
| Runner groups | `Default`, `Warp Runners` (both `visibility=all`, `allows_public_repositories=true`) |
| Org rulesets | 1 active (`Default branch protection`) |
| Ruleset bypass actors | `OrganizationAdmin` + Integration `3173831` |
| Org code-security configurations | 1 (`GitHub recommended`, `enforcement=unenforced`) |

## Org-Level Capability Matrix (What We Can Configure)

| Area | In config shape | Auto-applied by TS tool | Team-plan constraint | Gap status |
|---|---|---|---|---|
| Org rulesets (`org.rulesets`) | Yes | Yes (upsert) | Available on Team | Supported; live drift exists (extra Integration bypass actor) |
| Actions policy (`enabled_repositories`, `allowed_actions`, `sha_pinning_required`) | Yes | Yes | Available on Team | Supported; live drift (`allowed_actions=all`) |
| Actions selected allowlist (`github_owned`, `verified`, patterns) | Yes | Yes | Available on Team | Supported; blocked until `allowed_actions=selected` |
| Artifact/log retention | Yes | Yes | Available on Team | Supported; live drift (`90` vs baseline `30`) |
| Fork PR contributor approval | Yes | Yes | Available on Team | Supported; matches baseline |
| Fork PR workflow policy for private/internal repos | Yes | Yes | Internal repo slice is no-op on Team | Supported; live drift (`require_approval=false` vs `true`) |
| Workflow token permissions | Yes | Yes | Available on Team | Supported; live drift (`can_approve_pull_request_reviews=true`) |
| Org cache size/retention | Yes | Yes | Available on Team | Supported; live drift on retention (`7` vs `30`) |
| Self-hosted runners policy (`all/selected/none`) | Yes | Yes | Available on Team | Partial: selected repository list is not modelled |
| Runner groups (visibility, repo selection, workflow restriction, public access, network config id) | Yes | Yes (create/update) | Team can use runner groups; network config is feature-dependent | Supported; no deletion semantics (intentional upsert-only) |
| Org package creation/default settings | Yes | No (logs manual instructions) | `internal` visibility not usable on Team (`internal repos disabled`) | Gap: modelled but not API-applied |
| Org code-security configurations (`org.security_configurations`) | Yes | Yes (create/update/attach/default) | Available on Team; private/internal features can incur GHAS billing | Supported; major live drift (not yet applied) |
| Core org settings (default repo permission, member creation controls, org security defaults for new repos, etc.) | Yes (`org.settings`) | Yes (`PATCH /orgs/{org}`, changed keys only unless `--force`) | Mostly available on Team | Supported by current TS baseline tool |
| Org-level repository security defaults (`*_enabled_for_new_repositories`) | No | No | Available on Team | Gap: currently unmanaged by this TS baseline tool |

## Team-Plan Specific Gaps

| Gap type | Impact | Recommendation |
|---|---|---|
| Internal repository semantics in config (`private_or_internal`, `private_and_internal`, package `internal=true`) | Internal portion is a no-op today | Keep for future-proofing or create Team-only profile values that are private-only |
| Packages org defaults lack public REST endpoint support in current tool | Cannot enforce package settings via apply command | Keep source-of-truth in JSON, apply manually in UI, and track drift in docs |
| Core org governance settings were previously out of scope | Important controls can drift unnoticed | Implemented: `org.settings` now maps to `/orgs/{org}` and applies only changed keys by default |
| Self-hosted runner selected repo list not modelled | Incomplete control when `enabled_repositories=selected` | Add explicit `org.actions.self_hosted_runners.selected_repositories` support |

## Terraform Value (Eventually)

## What Terraform can already own well

| Area | Terraform resource (provider source) |
|---|---|
| Core org settings | `resource_github_organization_settings.go` |
| Actions org permissions and selected actions | `resource_github_actions_organization_permissions.go` |
| Actions workflow token permissions | `resource_github_actions_organization_workflow_permissions.go` |
| Runner groups | `resource_github_actions_runner_group.go` |
| Org rulesets | `resource_github_organization_ruleset.go` |

## What Terraform currently appears to miss (from provider source search)

| Area | Evidence |
|---|---|
| Artifact/log retention | no matches for `artifact-and-log-retention` |
| Fork PR contributor approval | no matches for `fork-pr-contributor-approval` |
| Fork PR private/internal workflow policy | no matches for `fork-pr-workflows-private-repos` |
| Org Actions cache storage/retention limits | no matches for `actions/cache/storage-limit` |
| Org code-security configurations | no matches for `code-security/configurations` |
| Org package creation/default settings | no matches for `package_creation` |
| Org self-hosted runner access policy endpoint | no matches for `self-hosted-runners` |

## Recommendation

Use a hybrid model:

1. Keep this TypeScript tool as first-class for org Actions advanced settings, org code-security configurations, and package-setting intent.
2. Add Terraform for stable org governance/settings/rulesets/runner-groups to get stateful drift detection.
3. Keep generated JSON profiles as the single policy source, and render both TS apply payloads and Terraform vars from that same source over time.

## Repro Commands

```bash
/opt/homebrew/bin/gh auth status
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/permissions
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/permissions/artifact-and-log-retention
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/permissions/fork-pr-contributor-approval
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/permissions/fork-pr-workflows-private-repos
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/permissions/workflow
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/permissions/self-hosted-runners
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/permissions/self-hosted-runners/repositories
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/actions/runner-groups
/opt/homebrew/bin/gh api /organizations/268715889/actions/cache/storage-limit
/opt/homebrew/bin/gh api /organizations/268715889/actions/cache/retention-limit
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/rulesets
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/rulesets/14099945
/opt/homebrew/bin/gh api orgs/Weekendsuperhero-io/code-security/configurations
```
