# Muse PR Workflows

Three reusable, Jules-powered workflows that consuming repos call with thin
wrappers (`uses: weekendsuperhero-io/platform-tools/.github/workflows/<file>@main`
+ `secrets: inherit`). This document is the reference; the YAML headers only
point here.

| Workflow | Trigger in the consumer | What it does |
| --- | --- | --- |
| `reusable-pr-description.yml` | PR opened/edited containing a trigger phrase | Writes the PR title + description, with a deterministic Linear section |
| `reusable-changelog.yml` | manual dispatch (or cron) | Turns commits since the last update into changelog entries — optionally split user-facing vs internal |
| `reusable-pr-review.yml` | `muse:review` label | Runs a three-agent review round (code review · security · tests) with sticky comments and outcome labels |

Shared plumbing: the `jules-ai` composite action (prompt file → Jules session →
polled response), an optional GitHub App identity (`JULES_PR_CLIENT_ID` +
`JULES_PR_PRIVATE_KEY`; falls back to `github.token`), and the required
`JULES_API_KEY` secret.

---

## PR descriptions (`reusable-pr-description.yml`)

```yaml
name: Update PR Description
on:
  pull_request:
    types: [opened, edited]

jobs:
  update-pr:
    permissions:
      contents: read
      pull-requests: write
    uses: weekendsuperhero-io/platform-tools/.github/workflows/reusable-pr-description.yml@main
    with:
      trigger-phrase: "@agent pr-title"     # gate: must appear in the PR body
      commit-format: full                   # send full commit bodies to the LLM
      runs-on: warp-ubuntu-latest-x64-4x
    secrets: inherit
```

- **Trigger phrase as the gate**: nothing runs unless the PR body contains the
  phrase, and the generated body doesn't include it — so regeneration is
  always an explicit act (re-add the phrase, save).
- **Output contract**: the LLM returns `{title, body, linear[]}` JSON; the
  title is conventional-commit style, the body has Summary / Changes /
  Test plan sections.

### The Linear section

Identity is never delegated to the LLM:

1. A deterministic step regex-extracts issue IDs (default
   `[A-Za-z][A-Za-z0-9]+-[0-9]+`, case-insensitive) from the **branch name**
   (primary ticket), **commit messages**, and the **current PR body**;
   acronym false-positives (UTF-8, SHA-256, …) are blocklisted unless
   branch-derived.
2. The LLM only picks a **verb per extracted ID** — closing
   (`Closes`/`Fixes`/`Resolves`/`Completes`) when the PR finishes the work,
   linking (`Part of`/`Refs`) otherwise, `None` to drop a non-ticket. Linear's
   GitHub integration reads these magic words: closing verbs move the issue
   when the PR merges.
3. The workflow **renders the section itself**: hallucinated IDs dropped,
   dropped IDs restored with defaults (branch ticket → `Closes`, others →
   `Part of`), and a hidden `<!-- linear-managed: … -->` marker records what
   was written. If a human edits a verb (e.g. downgrades `Closes` →
   `Part of`), the next run preserves it. A no-op body diff skips the write.
4. Optional `LINEAR_API_KEY` secret enriches lines with issue titles and
   prunes definitive not-founds — cosmetic, non-fatal, skipped when absent.

Inputs: `linear-enabled` (default true), `linear-id-pattern`, plus the diff
shaping knobs (`diff-file-patterns`, `diff-exclude-patterns`,
`max-commit-messages`, `commit-format`, `custom-prompt`, `base-branch`).

---

## Changelog (`reusable-changelog.yml`)

```yaml
name: Update Changelog
on:
  workflow_dispatch:

jobs:
  changelog:
    permissions:
      contents: write
    uses: weekendsuperhero-io/platform-tools/.github/workflows/reusable-changelog.yml@main
    with:
      changelog-path: CHANGELOG.md
      internal-changelog-path: CHANGELOG_INTERNAL.md   # omit for single-file mode
      runs-on: warp-ubuntu-latest-x64-4x
      pr-branch-prefix: "chore/changelog-"
    secrets: inherit
```

Finds the commits since the last changelog-touching commit and opens a PR
with new entries inserted under `## [Unreleased]`.

- **Single-file mode** (default, `internal-changelog-path` unset): one
  markdown blob of Keep-a-Changelog sections — the original behavior.
- **Split mode**: one Jules call classifies every commit as **user-facing**
  (anything a user can perceive; ships verbatim as release notes / updater
  notes / TestFlight text) vs **internal** (refactors, CI, deps, plumbing,
  tests, docs), and both files are patched in one PR. User-facing bullets ban
  ticket IDs, crate names, and commit-speak; internal bullets keep full
  technical detail. Dual-face changes may appear in both with different
  wording; when unsure, entries go internal — the user changelog stays clean.
- Rotation of `[Unreleased]` on release is the **consumer's** job (e.g. the
  agent repo's `scripts/rotate-changelog.sh`, called for both files so
  version histories stay parallel).

---

## PR review loop (`reusable-pr-review.yml`)

```yaml
name: PR Review (Muse)
on:
  pull_request:
    types: [labeled, synchronize]

jobs:
  review:
    # Exact-match guard — NOT startsWith('muse:'): the loop writes
    # muse:reviewing / outcome labels itself, and those events must not
    # re-enter the concurrency group or they'd cancel the running round.
    if: >-
      github.event.action == 'synchronize'
      || github.event.label.name == 'muse:review'
      || github.event.label.name == 'muse:force'
    # Job-level (not workflow-level) so guard-skipped runs never claim the
    # group; a new press or a push cancels a stale in-flight round.
    concurrency:
      group: pr-review-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    permissions:
      contents: read
      issues: write
      pull-requests: write
    uses: weekendsuperhero-io/platform-tools/.github/workflows/reusable-pr-review.yml@main
    with:
      runs-on: warp-ubuntu-latest-x64-4x
      review-guidelines: "RULES.md"
      security-guidelines: "CREDENTIALS.md,acp-fs/SANDBOXING.md"
      tests-guidelines: "ARCHITECTURE.md"
    secrets: inherit
```

Both comments in that snippet are **load-bearing** — copy them with the code.

### The loop

1. **`muse:review` is a button.** Adding it starts a round; the workflow
   removes it immediately (re-arming it) and adds `muse:reviewing`.
2. **One round = one context gather + three parallel Jules sessions** —
   code review, security, test coverage — each with its own lens prompt and
   the caller's guidelines files appended.
3. **Each agent owns exactly one sticky comment**, PATCHed in place (max
   three review comments per PR, ever). Findings are severity-sorted; the
   resolved ones collapse into `<details>`.
4. **Verdicts land as labels** (see taxonomy below) plus `muse:approved`
   (everything positive) or `muse:error` (an agent failed).
5. **New commits** (`synchronize`) strip the stale outcome labels and cancel
   an in-flight round. Re-pressing `muse:review` runs a **delta round**.
6. **Same-SHA presses are no-ops** — `muse:force` overrides.

### Delta rounds (why turns aren't wasted)

Each sticky comment carries hidden markers:

```
<!-- muse:security sha:<head-sha> round:3 -->
<!-- muse:security:state <base64 of the open findings JSON> -->
```

The next round hands the agent its previous open findings plus the diff since
that SHA, with instructions to verify each finding (`resolved`/`unresolved`
with evidence) and review only what changed. Carry-forward is computed by the
workflow, not the model: unresolved findings persist automatically, resolved
ones drop, new ones append.

### Verdict → labels is deterministic

Labels derive from the **open findings**: any critical/high ⇒ fail, any
medium ⇒ warn, else pass. The model's own verdict can only make the result
stricter — an agent cannot green-light findings it left open.

### The lenses

| Agent | Prefix | Hunts for | Guidelines input |
| --- | --- | --- | --- |
| Code review | `REV` | logic errors, error-handling gaps, races, API misuse, breaking contracts, missed reuse | `review-guidelines` |
| Security | `SEC` | injection, secrets in code/logs, trust-boundary validation, sandbox/entitlement changes, SSRF, crypto misuse, risky deps | `security-guidelines` |
| Test coverage | `TST` | diff behaviors mapped to tests; names the concrete missing test cases (bug fix without regression test = high) | `tests-guidelines` |

Guidelines inputs are comma-separated repo paths whose contents are appended
to the prompt (capped per file).

The prompt texts themselves are markdown templates in
[`.github/actions/muse-prompts/prompts/`](../.github/actions/muse-prompts/prompts/) —
[`contract.md`](../.github/actions/muse-prompts/prompts/contract.md) (the
shared JSON output contract) plus one lens file per agent
([`review.md`](../.github/actions/muse-prompts/prompts/review.md),
[`security.md`](../.github/actions/muse-prompts/prompts/security.md),
[`tests.md`](../.github/actions/muse-prompts/prompts/tests.md)). Edit those
files to tune the reviewers; `{{AGENT}}`, `{{PREFIX}}`, `{{ROUND}}`, and
`{{MAX_FINDINGS}}` are substituted at runtime. They ship to the runner via the
tiny `muse-prompts` composite action (reusable workflows never check out their
own repo; referencing a remote action is what materializes the files).

### Label taxonomy

| Label | Meaning |
| --- | --- |
| `muse:review` | the button — request a round (self-removes on pickup) |
| `muse:force` | re-review an already-reviewed SHA |
| `muse:reviewing` | round in progress |
| `muse:approved` / `muse:error` | rollups: all agents positive / an agent failed |
| `review:approved` / `review:needs-changes` | code-review outcome |
| `security:clear` / `security:flagged` | security outcome |
| `tests:sufficient` / `tests:needs-work` | test-coverage outcome |

The taxonomy self-bootstraps in any repo on first press. The canonical set is
versioned in [`config/sources/repo.labels.json`](../config/sources/repo.labels.json);
[`scripts/sync-repo-labels.sh`](../scripts/sync-repo-labels.sh) syncs it to
given repos or a whole org (`--org <org>`). GitHub's org-level "default labels
for new repositories" has no API — mirror the manifest there by hand once if
wanted (Settings → Repository defaults → Labels).

### Failure modes

- An agent job fails (Jules timeout, unparseable output) → `muse:error`, the
  other agents' results still land, `muse:reviewing` is cleared. Re-press to
  retry.
- Pressing before the reusable workflow exists on `@main` → workflow-not-found
  startup failure; merge platform-tools first.
- Human discussion on the PR (minus the sticky comments) is included in the
  agents' context, so pushback and decisions are visible to the next round.

### Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `runs-on` | `ubuntu-latest` | runner for all jobs |
| `agents` | `review,security,tests` | subset to run |
| `trigger-label` / `force-label` | `muse:review` / `muse:force` | the buttons |
| `review-guidelines` / `security-guidelines` / `tests-guidelines` | `""` | comma-separated repo paths per lens |
| `max-findings` | `12` | cap on new findings per agent per round |
| `max-wait-seconds` | `600` | per-Jules-session timeout |
| `diff-file-patterns` / `diff-exclude-patterns` / `max-commit-messages` | — | context shaping, same semantics as the other workflows |

Secrets: `JULES_API_KEY` (required), `JULES_PR_CLIENT_ID` +
`JULES_PR_PRIVATE_KEY` (optional app identity for label re-arm/bootstrap).
Comment and label writes intentionally use `github.token`, which never
triggers other workflows.
