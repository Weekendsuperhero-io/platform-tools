#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Octokit } from "octokit";

const HELP_TEXT = `
Usage:
  pnpm run apply:baseline -- --config <file> --repo <owner/name> [--dry-run] [--force] [--concurrency <n>]
  pnpm run apply:baseline -- --config <file> --repos-file <file> [--dry-run] [--force] [--concurrency <n>]
  pnpm run apply:baseline -- --config <file> --org <org> [--match <regex>] [--dry-run] [--force] [--concurrency <n>]

Options:
  --config <file>      Path to the baseline JSON file
  --repo <owner/name>  Target repository; may be provided multiple times
  --repos-file <file>  File containing owner/name values, one per line
  --org <org>          Apply to all eligible repositories in the organization
  --match <regex>      Filter org repositories by nameWithOwner
  --concurrency <n>    Number of repositories to process at once (default: 4)
  --dry-run            Print planned API calls without executing them
  --force              Apply configured payloads even if current values match
  --help               Show this help text
`.trim();

const REPO_SETTING_KEYS = new Set([
  "allow_auto_merge",
  "allow_forking",
  "allow_merge_commit",
  "allow_rebase_merge",
  "allow_squash_merge",
  "allow_update_branch",
  "archived",
  "default_branch",
  "delete_branch_on_merge",
  "description",
  "has_discussions",
  "has_downloads",
  "has_issues",
  "has_projects",
  "has_wiki",
  "homepage",
  "is_template",
  "merge_commit_message",
  "merge_commit_title",
  "name",
  "private",
  "security_and_analysis",
  "squash_merge_commit_message",
  "squash_merge_commit_title",
  "visibility",
  "web_commit_signoff_required"
]);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

type RepositorySettingKey =
  | "allow_auto_merge"
  | "allow_forking"
  | "allow_merge_commit"
  | "allow_rebase_merge"
  | "allow_squash_merge"
  | "allow_update_branch"
  | "archived"
  | "default_branch"
  | "delete_branch_on_merge"
  | "description"
  | "has_discussions"
  | "has_downloads"
  | "has_issues"
  | "has_projects"
  | "has_wiki"
  | "homepage"
  | "is_template"
  | "merge_commit_message"
  | "merge_commit_title"
  | "name"
  | "private"
  | "security_and_analysis"
  | "squash_merge_commit_message"
  | "squash_merge_commit_title"
  | "visibility"
  | "web_commit_signoff_required";

type RepositorySettings = Partial<Record<RepositorySettingKey, JsonValue>>;

interface DefaultBranchConfig {
  name: string;
  rename_existing?: boolean;
}

interface CodeScanningDefaultSetupConfig {
  state: "configured" | "not-configured";
  query_suite?: "default" | "extended";
  mode?: "public-only" | "eligible";
}

interface SecurityConfig {
  advanced_security?: boolean;
  code_security?: boolean;
  secret_scanning?: boolean;
  secret_scanning_push_protection?: boolean;
  vulnerability_alerts?: boolean;
  dependabot_security_updates?: boolean;
  code_scanning_default_setup?: CodeScanningDefaultSetupConfig;
}

type EnabledRepositoriesPolicy = "all" | "none" | "selected";
type AllowedActionsPolicy = "all" | "local_only" | "selected";
type ForkPrApprovalPolicy =
  | "first_time_contributors_new_to_github"
  | "first_time_contributors"
  | "all_external_contributors";
type WorkflowPermissionsPolicy = "read" | "write";
type SelfHostedRunnerRepoPolicy = "all" | "selected" | "none";

interface OrgActionsPermissionsConfig {
  enabled_repositories: EnabledRepositoriesPolicy;
  allowed_actions?: AllowedActionsPolicy;
  sha_pinning_required?: boolean;
}

interface OrgSelectedActionsConfig {
  github_owned_allowed?: boolean;
  verified_allowed?: boolean;
  patterns_allowed?: string[];
}

interface OrgArtifactRetentionConfig {
  days: number;
}

interface OrgForkPrContributorApprovalConfig {
  approval_policy: ForkPrApprovalPolicy;
}

interface OrgForkPrPrivateReposConfig {
  run_workflows_from_fork_pull_requests: boolean;
  send_write_tokens_to_workflows?: boolean;
  send_secrets_and_variables?: boolean;
  require_approval_for_fork_pr_workflows?: boolean;
}

interface OrgSelfHostedRunnersConfig {
  enabled_repositories: SelfHostedRunnerRepoPolicy;
}

interface OrgWorkflowPermissionsConfig {
  default_workflow_permissions?: WorkflowPermissionsPolicy;
  can_approve_pull_request_reviews?: boolean;
}

interface OrgCacheLimitsConfig {
  max_cache_size_gb?: number;
  max_cache_retention_days?: number;
}

interface OrgRunnerGroupConfig {
  name: string;
  visibility?: "all" | "private" | "selected";
  selected_repository_ids?: number[];
  selected_repositories?: string[];
  allows_public_repositories?: boolean;
  restricted_to_workflows?: boolean;
  selected_workflows?: string[];
  network_configuration_id?: string | null;
}

interface OrgActionsConfig {
  permissions?: OrgActionsPermissionsConfig;
  selected_actions?: OrgSelectedActionsConfig;
  artifact_and_log_retention?: OrgArtifactRetentionConfig;
  fork_pr_contributor_approval?: OrgForkPrContributorApprovalConfig;
  fork_pr_private_repos?: OrgForkPrPrivateReposConfig;
  self_hosted_runners?: OrgSelfHostedRunnersConfig;
  workflow_permissions?: OrgWorkflowPermissionsConfig;
  cache?: OrgCacheLimitsConfig;
  runner_groups?: OrgRunnerGroupConfig[];
}

type PackageCreationVisibility = "public" | "private" | "internal";
type PackageInheritAccessSetting = "default" | "enabled" | "disabled";

interface OrgPackageCreationConfig {
  public?: boolean;
  private?: boolean;
  internal?: boolean;
}

interface OrgPackageDefaultSettingsConfig {
  inherit_access_from_source_repository?: PackageInheritAccessSetting;
}

interface OrgPackagesConfig {
  package_creation?: OrgPackageCreationConfig;
  default_settings?: OrgPackageDefaultSettingsConfig;
}

type OrgDefaultRepositoryPermission = "read" | "write" | "admin" | "none";
type OrgMembersAllowedRepositoryCreationType = "all" | "private" | "none";

interface OrgSettingsConfig {
  name?: string;
  description?: string;
  billing_email?: string;
  email?: string;
  blog?: string;
  company?: string;
  location?: string;
  twitter_username?: string;
  has_organization_projects?: boolean;
  has_repository_projects?: boolean;
  default_repository_permission?: OrgDefaultRepositoryPermission;
  members_can_create_repositories?: boolean;
  members_can_create_public_repositories?: boolean;
  members_can_create_private_repositories?: boolean;
  members_can_create_internal_repositories?: boolean;
  members_allowed_repository_creation_type?: OrgMembersAllowedRepositoryCreationType;
  members_can_create_pages?: boolean;
  members_can_create_public_pages?: boolean;
  members_can_create_private_pages?: boolean;
  members_can_fork_private_repositories?: boolean;
  web_commit_signoff_required?: boolean;
  default_repository_branch?: string;
  advanced_security_enabled_for_new_repositories?: boolean;
  dependabot_alerts_enabled_for_new_repositories?: boolean;
  dependabot_security_updates_enabled_for_new_repositories?: boolean;
  dependency_graph_enabled_for_new_repositories?: boolean;
  secret_scanning_enabled_for_new_repositories?: boolean;
  secret_scanning_push_protection_enabled_for_new_repositories?: boolean;
  secret_scanning_validity_checks_enabled?: boolean;
}

type SecurityConfigurationStatus = "enabled" | "disabled" | "not_set";
type AdvancedSecurityConfigurationStatus =
  | "enabled"
  | "disabled"
  | "code_security"
  | "secret_protection";
type CodeScanningRunnerType = "standard" | "labeled" | "not_set";
type SecurityBypassReviewerType = "TEAM" | "ROLE";
type SecurityBypassMode = "ALWAYS" | "EXEMPT";
type SecurityConfigurationEnforcement = "enforced" | "unenforced";
type SecurityConfigurationAttachScope =
  | "all"
  | "all_without_configurations"
  | "public"
  | "private_or_internal"
  | "selected";
type SecurityConfigurationDefaultScope = "all" | "none" | "public" | "private_and_internal";

interface SecurityConfigurationDependencyAutosubmitOptions {
  labeled_runners?: boolean;
}

interface SecurityConfigurationCodeScanningOptions {
  allow_advanced?: boolean | null;
}

interface SecurityConfigurationDefaultSetupOptions {
  runner_type?: CodeScanningRunnerType;
  runner_label?: string | null;
}

interface SecurityConfigurationDelegatedBypassReviewer {
  reviewer_id: number;
  reviewer_type: SecurityBypassReviewerType;
  mode?: SecurityBypassMode;
}

interface SecurityConfigurationDelegatedBypassOptions {
  reviewers?: SecurityConfigurationDelegatedBypassReviewer[];
}

interface SecurityConfigurationAttachConfig {
  scope: SecurityConfigurationAttachScope;
  selected_repository_ids?: number[];
  selected_repositories?: string[];
}

interface OrgSecurityConfigurationConfig {
  name: string;
  description: string;
  advanced_security?: AdvancedSecurityConfigurationStatus;
  code_security?: SecurityConfigurationStatus;
  secret_protection?: SecurityConfigurationStatus;
  dependency_graph?: SecurityConfigurationStatus;
  dependency_graph_autosubmit_action?: SecurityConfigurationStatus;
  dependency_graph_autosubmit_action_options?: SecurityConfigurationDependencyAutosubmitOptions;
  dependabot_alerts?: SecurityConfigurationStatus;
  dependabot_security_updates?: SecurityConfigurationStatus;
  dependabot_delegated_alert_dismissal?: SecurityConfigurationStatus;
  code_scanning_options?: SecurityConfigurationCodeScanningOptions;
  code_scanning_default_setup?: SecurityConfigurationStatus;
  code_scanning_default_setup_options?: SecurityConfigurationDefaultSetupOptions;
  code_scanning_delegated_alert_dismissal?: SecurityConfigurationStatus;
  secret_scanning?: SecurityConfigurationStatus;
  secret_scanning_push_protection?: SecurityConfigurationStatus;
  secret_scanning_delegated_bypass?: SecurityConfigurationStatus;
  secret_scanning_delegated_bypass_options?: SecurityConfigurationDelegatedBypassOptions;
  secret_scanning_validity_checks?: SecurityConfigurationStatus;
  secret_scanning_non_provider_patterns?: SecurityConfigurationStatus;
  secret_scanning_generic_secrets?: SecurityConfigurationStatus;
  secret_scanning_delegated_alert_dismissal?: SecurityConfigurationStatus;
  secret_scanning_extended_metadata?: SecurityConfigurationStatus;
  private_vulnerability_reporting?: SecurityConfigurationStatus;
  enforcement?: SecurityConfigurationEnforcement;
  attach?: SecurityConfigurationAttachConfig;
  default_for_new_repos?: SecurityConfigurationDefaultScope;
}

interface RepositoryConfig {
  settings?: RepositorySettings;
  topics?: string[];
  default_branch?: DefaultBranchConfig;
  security?: SecurityConfig;
}

interface RepoScopeConfig {
  repository?: RepositoryConfig;
  rulesets?: JsonObject[];
}

interface OrgScopeConfig {
  rulesets?: JsonObject[];
  settings?: OrgSettingsConfig;
  actions?: OrgActionsConfig;
  packages?: OrgPackagesConfig;
  security_configurations?: OrgSecurityConfigurationConfig[];
}

interface BaselineConfig {
  apiVersion: string;
  repo?: RepoScopeConfig;
  org?: OrgScopeConfig;

  // Legacy keys kept for backward compatibility.
  repository?: RepositoryConfig;
  orgRulesets?: JsonObject[];
  rulesets?: JsonObject[];
}

interface EffectiveConfig {
  apiVersion: string;
  repo: RepoScopeConfig;
  org: OrgScopeConfig;
}

interface CliArgs {
  configPath: string | null;
  repos: string[];
  reposFile: string | null;
  org: string | null;
  match: string | null;
  concurrency: number;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

interface OrgRepo {
  nameWithOwner: string;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  is_template?: boolean;
}

interface ExistingRuleset {
  id: number;
  name: string;
  target?: string;
  source_type?: string;
}

interface ExistingRunnerGroup {
  id: number;
  name: string;
}

interface ExistingSecurityConfiguration {
  id: number;
  name: string;
}

interface RepoMetadata {
  default_branch: string | undefined;
  visibility: "public" | "private" | "internal" | undefined;
  archived: boolean;
  disabled: boolean;
  is_empty: boolean;
}

interface RepoRunResult {
  repo: string;
  success: boolean;
  error?: string;
}

type LogFn = (message: string) => void;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (!args.configPath) {
    throw new Error("--config is required");
  }

  const configPath = resolve(args.configPath);
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const parsedConfig = parseJsonFile<BaselineConfig>(configPath, "config");
  validateConfig(parsedConfig, configPath);
  const config = normalizeConfig(parsedConfig);

  const octokit = createOctokit(args.dryRun, config.apiVersion);
  await runAuthPreflight({ args, config, octokit });
  if (hasOrgScopeWork(config) && !args.org) {
    throw new Error("Config contains org-level configuration but --org was not provided");
  }

  if (args.org && hasOrgScopeWork(config)) {
    await applyOrganizationScope({
      org: args.org,
      config,
      dryRun: args.dryRun,
      force: args.force,
      octokit
    });
  }

  if (!hasRepoScopeWork(config)) {
    console.log(`Using config: ${configPath}`);
    console.log("No repo-level configuration detected; skipped repository processing.");
    return;
  }

  const targets = await resolveTargets(args, octokit);
  if (targets.length === 0) {
    throw new Error("No target repositories resolved");
  }

  const totalTargets = targets.length;
  let completedTargets = 0;

  console.log(`Using config: ${configPath}`);
  console.log(`Target repositories: ${totalTargets}`);
  console.log(`Concurrency: ${args.concurrency}`);

  const results = await runWithConcurrency(targets, args.concurrency, async (repo, index) => {
    const startAt = Date.now();
    console.log(`[start ${index + 1}/${totalTargets}] ${repo}`);

    const logger = createRepoLogger(repo);

    try {
      await applyBaselineToRepo({ repo, config, dryRun: args.dryRun, octokit, log: logger.log });
      logger.flush();
      completedTargets += 1;
      const elapsedSec = ((Date.now() - startAt) / 1000).toFixed(1);
      console.log(`[done ${completedTargets}/${totalTargets}] ${repo} success (${elapsedSec}s)`);
      return { repo, success: true } satisfies RepoRunResult;
    } catch (error: unknown) {
      logger.log(`ERROR: ${getErrorMessage(error)}`);
      logger.flush();
      completedTargets += 1;
      const elapsedSec = ((Date.now() - startAt) / 1000).toFixed(1);
      console.log(`[done ${completedTargets}/${totalTargets}] ${repo} failed (${elapsedSec}s)`);
      return { repo, success: false, error: getErrorMessage(error) } satisfies RepoRunResult;
    }
  });

  const failures = results.filter((result) => !result.success);
  if (failures.length > 0) {
    throw new Error(
      `Baseline run finished with ${failures.length} failed repos: ${failures.map((result) => result.repo).join(", ")}`
    );
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: null,
    repos: [],
    reposFile: null,
    org: null,
    match: null,
    concurrency: 4,
    dryRun: false,
    force: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--config":
        args.configPath = requireValue(argv, ++index, "--config");
        break;
      case "--repo":
        args.repos.push(requireValue(argv, ++index, "--repo"));
        break;
      case "--repos-file":
        args.reposFile = requireValue(argv, ++index, "--repos-file");
        break;
      case "--org":
        args.org = requireValue(argv, ++index, "--org");
        break;
      case "--match":
        args.match = requireValue(argv, ++index, "--match");
        break;
      case "--concurrency":
        args.concurrency = parseConcurrency(requireValue(argv, ++index, "--concurrency"));
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid concurrency value: ${value}`);
  }
  return parsed;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseJsonFile<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} JSON at ${path}: ${message}`);
  }
}

function validateConfig(config: BaselineConfig, configPath: string): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Config at ${configPath} must be a JSON object`);
  }

  if (!config.apiVersion || typeof config.apiVersion !== "string") {
    throw new Error("Config must contain apiVersion");
  }

  if (config.repo !== undefined && (typeof config.repo !== "object" || Array.isArray(config.repo))) {
    throw new Error("repo must be an object");
  }

  if (config.org !== undefined && (typeof config.org !== "object" || Array.isArray(config.org))) {
    throw new Error("org must be an object");
  }

  if (config.repository && config.repo?.repository) {
    throw new Error("Use either repository or repo.repository, not both");
  }

  if (config.rulesets && config.repo?.rulesets) {
    throw new Error("Use either rulesets or repo.rulesets, not both");
  }

  if (config.orgRulesets && config.org?.rulesets) {
    throw new Error("Use either orgRulesets or org.rulesets, not both");
  }

  validateRepositoryConfig(config.repository, "repository");
  validateRepositoryConfig(config.repo?.repository, "repo.repository");
  validateRulesetList(config.rulesets, "rulesets");
  validateRulesetList(config.repo?.rulesets, "repo.rulesets");
  validateRulesetList(config.orgRulesets, "orgRulesets");
  validateRulesetList(config.org?.rulesets, "org.rulesets");
  validateOrgSettingsConfig(config.org?.settings, "org.settings");
  validateOrgActionsConfig(config.org?.actions, "org.actions");
  validateOrgPackagesConfig(config.org?.packages, "org.packages");
  validateOrgSecurityConfigurations(config.org?.security_configurations, "org.security_configurations");
}

function validateRepositoryConfig(repository: unknown, label: string): void {
  if (repository === undefined) {
    return;
  }

  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    throw new Error(`${label} must be an object`);
  }

  const config = repository as RepositoryConfig;

  if (config.settings) {
    for (const key of Object.keys(config.settings)) {
      if (!REPO_SETTING_KEYS.has(key)) {
        throw new Error(`Unsupported ${label}.settings key: ${key}`);
      }
    }
  }

  if (config.topics && !Array.isArray(config.topics)) {
    throw new Error(`${label}.topics must be an array of strings`);
  }

  if (config.default_branch) {
    if (typeof config.default_branch.name !== "string" || config.default_branch.name.length === 0) {
      throw new Error(`${label}.default_branch.name must be a non-empty string`);
    }
  }

  if (config.security !== undefined) {
    validateSecurityConfig(config.security, `${label}.security`);
  }
}

function validateSecurityConfig(security: unknown, label: string): void {
  if (typeof security !== "object" || security === null || Array.isArray(security)) {
    throw new Error(`${label} must be an object`);
  }

  const config = security as SecurityConfig;
  const booleanKeys: (keyof SecurityConfig)[] = [
    "advanced_security",
    "code_security",
    "secret_scanning",
    "secret_scanning_push_protection",
    "vulnerability_alerts",
    "dependabot_security_updates"
  ];

  for (const key of booleanKeys) {
    const value = config[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`${label}.${String(key)} must be a boolean`);
    }
  }

  if (
    typeof config.code_security === "boolean" &&
    typeof config.advanced_security === "boolean" &&
    config.code_security !== config.advanced_security
  ) {
    throw new Error(`${label}.code_security and ${label}.advanced_security must match when both are set`);
  }

  if (config.code_scanning_default_setup !== undefined) {
    const setup = config.code_scanning_default_setup;
    if (typeof setup !== "object" || setup === null || Array.isArray(setup)) {
      throw new Error(`${label}.code_scanning_default_setup must be an object`);
    }

    if (setup.state !== "configured" && setup.state !== "not-configured") {
      throw new Error(`${label}.code_scanning_default_setup.state must be "configured" or "not-configured"`);
    }

    if (setup.query_suite !== undefined && setup.query_suite !== "default" && setup.query_suite !== "extended") {
      throw new Error(`${label}.code_scanning_default_setup.query_suite must be "default" or "extended"`);
    }

    if (setup.mode !== undefined && setup.mode !== "public-only" && setup.mode !== "eligible") {
      throw new Error(`${label}.code_scanning_default_setup.mode must be "public-only" or "eligible"`);
    }
  }
}

const ORG_SETTINGS_BOOLEAN_KEYS: Array<keyof OrgSettingsConfig> = [
  "has_organization_projects",
  "has_repository_projects",
  "members_can_create_repositories",
  "members_can_create_public_repositories",
  "members_can_create_private_repositories",
  "members_can_create_internal_repositories",
  "members_can_create_pages",
  "members_can_create_public_pages",
  "members_can_create_private_pages",
  "members_can_fork_private_repositories",
  "web_commit_signoff_required",
  "advanced_security_enabled_for_new_repositories",
  "dependabot_alerts_enabled_for_new_repositories",
  "dependabot_security_updates_enabled_for_new_repositories",
  "dependency_graph_enabled_for_new_repositories",
  "secret_scanning_enabled_for_new_repositories",
  "secret_scanning_push_protection_enabled_for_new_repositories",
  "secret_scanning_validity_checks_enabled"
];

const ORG_SETTINGS_STRING_KEYS: Array<keyof OrgSettingsConfig> = [
  "name",
  "description",
  "billing_email",
  "email",
  "blog",
  "company",
  "location",
  "twitter_username",
  "default_repository_branch"
];

function validateOrgSettingsConfig(settings: unknown, label: string): void {
  if (settings === undefined) {
    return;
  }

  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error(`${label} must be an object`);
  }

  const config = settings as OrgSettingsConfig;

  for (const key of ORG_SETTINGS_BOOLEAN_KEYS) {
    const value = config[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`${label}.${String(key)} must be a boolean`);
    }
  }

  for (const key of ORG_SETTINGS_STRING_KEYS) {
    const value = config[key];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`${label}.${String(key)} must be a string`);
    }
  }

  if (
    config.default_repository_permission !== undefined &&
    !isOrgDefaultRepositoryPermission(config.default_repository_permission)
  ) {
    throw new Error(`${label}.default_repository_permission must be one of: read, write, admin, none`);
  }

  if (
    config.members_allowed_repository_creation_type !== undefined &&
    !isOrgMembersAllowedRepositoryCreationType(config.members_allowed_repository_creation_type)
  ) {
    throw new Error(`${label}.members_allowed_repository_creation_type must be one of: all, private, none`);
  }
}

function validateOrgActionsConfig(actions: unknown, label: string): void {
  if (actions === undefined) {
    return;
  }

  if (typeof actions !== "object" || actions === null || Array.isArray(actions)) {
    throw new Error(`${label} must be an object`);
  }

  const config = actions as OrgActionsConfig;

  if (config.permissions !== undefined) {
    if (typeof config.permissions !== "object" || config.permissions === null || Array.isArray(config.permissions)) {
      throw new Error(`${label}.permissions must be an object`);
    }

    if (!isEnabledRepositoriesPolicy(config.permissions.enabled_repositories)) {
      throw new Error(`${label}.permissions.enabled_repositories must be one of: all, none, selected`);
    }

    if (
      config.permissions.allowed_actions !== undefined &&
      !isAllowedActionsPolicy(config.permissions.allowed_actions)
    ) {
      throw new Error(`${label}.permissions.allowed_actions must be one of: all, local_only, selected`);
    }

    if (
      config.permissions.sha_pinning_required !== undefined &&
      typeof config.permissions.sha_pinning_required !== "boolean"
    ) {
      throw new Error(`${label}.permissions.sha_pinning_required must be a boolean`);
    }
  }

  if (config.selected_actions !== undefined) {
    if (
      typeof config.selected_actions !== "object" ||
      config.selected_actions === null ||
      Array.isArray(config.selected_actions)
    ) {
      throw new Error(`${label}.selected_actions must be an object`);
    }

    if (
      config.selected_actions.github_owned_allowed !== undefined &&
      typeof config.selected_actions.github_owned_allowed !== "boolean"
    ) {
      throw new Error(`${label}.selected_actions.github_owned_allowed must be a boolean`);
    }

    if (
      config.selected_actions.verified_allowed !== undefined &&
      typeof config.selected_actions.verified_allowed !== "boolean"
    ) {
      throw new Error(`${label}.selected_actions.verified_allowed must be a boolean`);
    }

    if (config.selected_actions.patterns_allowed !== undefined) {
      if (!Array.isArray(config.selected_actions.patterns_allowed)) {
        throw new Error(`${label}.selected_actions.patterns_allowed must be an array`);
      }

      for (const [index, pattern] of config.selected_actions.patterns_allowed.entries()) {
        if (typeof pattern !== "string" || pattern.trim().length === 0) {
          throw new Error(`${label}.selected_actions.patterns_allowed[${index}] must be a non-empty string`);
        }
      }
    }
  }

  if (config.artifact_and_log_retention !== undefined) {
    if (
      typeof config.artifact_and_log_retention !== "object" ||
      config.artifact_and_log_retention === null ||
      Array.isArray(config.artifact_and_log_retention)
    ) {
      throw new Error(`${label}.artifact_and_log_retention must be an object`);
    }

    if (!isPositiveInteger(config.artifact_and_log_retention.days)) {
      throw new Error(`${label}.artifact_and_log_retention.days must be a positive integer`);
    }
  }

  if (config.fork_pr_contributor_approval !== undefined) {
    if (
      typeof config.fork_pr_contributor_approval !== "object" ||
      config.fork_pr_contributor_approval === null ||
      Array.isArray(config.fork_pr_contributor_approval)
    ) {
      throw new Error(`${label}.fork_pr_contributor_approval must be an object`);
    }

    if (!isForkPrApprovalPolicy(config.fork_pr_contributor_approval.approval_policy)) {
      throw new Error(
        `${label}.fork_pr_contributor_approval.approval_policy must be one of: ` +
          "first_time_contributors_new_to_github, first_time_contributors, all_external_contributors"
      );
    }
  }

  if (config.fork_pr_private_repos !== undefined) {
    if (
      typeof config.fork_pr_private_repos !== "object" ||
      config.fork_pr_private_repos === null ||
      Array.isArray(config.fork_pr_private_repos)
    ) {
      throw new Error(`${label}.fork_pr_private_repos must be an object`);
    }

    if (typeof config.fork_pr_private_repos.run_workflows_from_fork_pull_requests !== "boolean") {
      throw new Error(`${label}.fork_pr_private_repos.run_workflows_from_fork_pull_requests must be a boolean`);
    }

    const privateForkBooleanFields: Array<keyof OrgForkPrPrivateReposConfig> = [
      "send_write_tokens_to_workflows",
      "send_secrets_and_variables",
      "require_approval_for_fork_pr_workflows"
    ];

    for (const field of privateForkBooleanFields) {
      const value = config.fork_pr_private_repos[field];
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`${label}.fork_pr_private_repos.${String(field)} must be a boolean`);
      }
    }
  }

  if (config.self_hosted_runners !== undefined) {
    if (
      typeof config.self_hosted_runners !== "object" ||
      config.self_hosted_runners === null ||
      Array.isArray(config.self_hosted_runners)
    ) {
      throw new Error(`${label}.self_hosted_runners must be an object`);
    }

    if (!isSelfHostedRunnerPolicy(config.self_hosted_runners.enabled_repositories)) {
      throw new Error(`${label}.self_hosted_runners.enabled_repositories must be one of: all, selected, none`);
    }
  }

  if (config.workflow_permissions !== undefined) {
    if (
      typeof config.workflow_permissions !== "object" ||
      config.workflow_permissions === null ||
      Array.isArray(config.workflow_permissions)
    ) {
      throw new Error(`${label}.workflow_permissions must be an object`);
    }

    const workflowPermissions = config.workflow_permissions;
    if (
      workflowPermissions.default_workflow_permissions !== undefined &&
      !isWorkflowPermissionsPolicy(workflowPermissions.default_workflow_permissions)
    ) {
      throw new Error(`${label}.workflow_permissions.default_workflow_permissions must be one of: read, write`);
    }

    if (
      workflowPermissions.can_approve_pull_request_reviews !== undefined &&
      typeof workflowPermissions.can_approve_pull_request_reviews !== "boolean"
    ) {
      throw new Error(`${label}.workflow_permissions.can_approve_pull_request_reviews must be a boolean`);
    }
  }

  if (config.cache !== undefined) {
    if (typeof config.cache !== "object" || config.cache === null || Array.isArray(config.cache)) {
      throw new Error(`${label}.cache must be an object`);
    }

    if (config.cache.max_cache_size_gb !== undefined && !isPositiveInteger(config.cache.max_cache_size_gb)) {
      throw new Error(`${label}.cache.max_cache_size_gb must be a positive integer`);
    }

    if (
      config.cache.max_cache_retention_days !== undefined &&
      !isPositiveInteger(config.cache.max_cache_retention_days)
    ) {
      throw new Error(`${label}.cache.max_cache_retention_days must be a positive integer`);
    }
  }

  if (config.runner_groups !== undefined) {
    if (!Array.isArray(config.runner_groups)) {
      throw new Error(`${label}.runner_groups must be an array`);
    }

    const names = new Set<string>();
    for (const [index, group] of config.runner_groups.entries()) {
      validateRunnerGroupConfig(group, `${label}.runner_groups[${index}]`);
      const normalizedName = group.name.trim().toLowerCase();
      if (names.has(normalizedName)) {
        throw new Error(`${label}.runner_groups contains duplicate name: "${group.name}"`);
      }
      names.add(normalizedName);
    }
  }

  if (config.selected_actions && config.permissions?.allowed_actions !== "selected") {
    throw new Error(
      `${label}.selected_actions requires ${label}.permissions.allowed_actions to be set to "selected"`
    );
  }
}

function validateRunnerGroupConfig(group: unknown, label: string): void {
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    throw new Error(`${label} must be an object`);
  }

  const config = group as OrgRunnerGroupConfig;

  if (typeof config.name !== "string" || config.name.trim().length === 0) {
    throw new Error(`${label}.name must be a non-empty string`);
  }

  if (config.visibility !== undefined && !isRunnerGroupVisibility(config.visibility)) {
    throw new Error(`${label}.visibility must be one of: all, private, selected`);
  }

  if (
    config.allows_public_repositories !== undefined &&
    typeof config.allows_public_repositories !== "boolean"
  ) {
    throw new Error(`${label}.allows_public_repositories must be a boolean`);
  }

  if (
    config.restricted_to_workflows !== undefined &&
    typeof config.restricted_to_workflows !== "boolean"
  ) {
    throw new Error(`${label}.restricted_to_workflows must be a boolean`);
  }

  if (config.selected_workflows !== undefined) {
    if (!Array.isArray(config.selected_workflows)) {
      throw new Error(`${label}.selected_workflows must be an array`);
    }

    for (const [index, workflow] of config.selected_workflows.entries()) {
      if (typeof workflow !== "string" || workflow.trim().length === 0) {
        throw new Error(`${label}.selected_workflows[${index}] must be a non-empty string`);
      }
    }
  }

  if (config.network_configuration_id !== undefined) {
    if (config.network_configuration_id !== null && typeof config.network_configuration_id !== "string") {
      throw new Error(`${label}.network_configuration_id must be a string or null`);
    }
  }

  if (config.selected_repository_ids !== undefined) {
    if (!Array.isArray(config.selected_repository_ids)) {
      throw new Error(`${label}.selected_repository_ids must be an array`);
    }

    for (const [index, repositoryId] of config.selected_repository_ids.entries()) {
      if (!isPositiveInteger(repositoryId)) {
        throw new Error(`${label}.selected_repository_ids[${index}] must be a positive integer`);
      }
    }
  }

  if (config.selected_repositories !== undefined) {
    if (!Array.isArray(config.selected_repositories)) {
      throw new Error(`${label}.selected_repositories must be an array`);
    }

    for (const [index, repository] of config.selected_repositories.entries()) {
      if (typeof repository !== "string" || repository.trim().length === 0) {
        throw new Error(`${label}.selected_repositories[${index}] must be a non-empty string`);
      }
    }
  }

  const visibility = config.visibility ?? "all";
  const hasSelectedRepositories =
    (config.selected_repository_ids?.length ?? 0) > 0 || (config.selected_repositories?.length ?? 0) > 0;

  if (visibility === "selected" && !hasSelectedRepositories) {
    throw new Error(`${label} requires selected repositories when visibility is "selected"`);
  }

  if (visibility !== "selected" && hasSelectedRepositories) {
    throw new Error(`${label} can only set selected repositories when visibility is "selected"`);
  }

  if (config.selected_workflows && config.restricted_to_workflows !== true) {
    throw new Error(`${label}.selected_workflows requires restricted_to_workflows=true`);
  }
}

function validateOrgPackagesConfig(packages: unknown, label: string): void {
  if (packages === undefined) {
    return;
  }

  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new Error(`${label} must be an object`);
  }

  const config = packages as OrgPackagesConfig;

  if (config.package_creation !== undefined) {
    if (
      typeof config.package_creation !== "object" ||
      config.package_creation === null ||
      Array.isArray(config.package_creation)
    ) {
      throw new Error(`${label}.package_creation must be an object`);
    }

    for (const visibility of PACKAGE_VISIBILITIES) {
      const enabled = config.package_creation[visibility];
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw new Error(`${label}.package_creation.${visibility} must be a boolean`);
      }
    }
  }

  if (config.default_settings !== undefined) {
    if (
      typeof config.default_settings !== "object" ||
      config.default_settings === null ||
      Array.isArray(config.default_settings)
    ) {
      throw new Error(`${label}.default_settings must be an object`);
    }

    const inherit = config.default_settings.inherit_access_from_source_repository;
    if (inherit !== undefined && !isPackageInheritAccessSetting(inherit)) {
      throw new Error(`${label}.default_settings.inherit_access_from_source_repository must be one of: default, enabled, disabled`);
    }
  }
}

const SECURITY_CONFIGURATION_STATUS_FIELDS = [
  "code_security",
  "secret_protection",
  "dependency_graph",
  "dependency_graph_autosubmit_action",
  "dependabot_alerts",
  "dependabot_security_updates",
  "dependabot_delegated_alert_dismissal",
  "code_scanning_default_setup",
  "code_scanning_delegated_alert_dismissal",
  "secret_scanning",
  "secret_scanning_push_protection",
  "secret_scanning_delegated_bypass",
  "secret_scanning_validity_checks",
  "secret_scanning_non_provider_patterns",
  "secret_scanning_generic_secrets",
  "secret_scanning_delegated_alert_dismissal",
  "secret_scanning_extended_metadata",
  "private_vulnerability_reporting"
] as const;

function validateOrgSecurityConfigurations(configurations: unknown, label: string): void {
  if (configurations === undefined) {
    return;
  }

  if (!Array.isArray(configurations)) {
    throw new Error(`${label} must be an array`);
  }

  const names = new Set<string>();
  for (const [index, configuration] of configurations.entries()) {
    const fieldLabel = `${label}[${index}]`;
    validateOrgSecurityConfiguration(configuration, fieldLabel);

    const normalizedName = (configuration as OrgSecurityConfigurationConfig).name.trim().toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`${label} contains duplicate configuration name: "${(configuration as OrgSecurityConfigurationConfig).name}"`);
    }
    names.add(normalizedName);
  }
}

function validateOrgSecurityConfiguration(configuration: unknown, label: string): void {
  if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) {
    throw new Error(`${label} must be an object`);
  }

  const config = configuration as OrgSecurityConfigurationConfig;

  if (typeof config.name !== "string" || config.name.trim().length === 0) {
    throw new Error(`${label}.name must be a non-empty string`);
  }

  if (typeof config.description !== "string" || config.description.trim().length === 0) {
    throw new Error(`${label}.description must be a non-empty string`);
  }

  if (config.advanced_security !== undefined && !isAdvancedSecurityConfigurationStatus(config.advanced_security)) {
    throw new Error(
      `${label}.advanced_security must be one of: enabled, disabled, code_security, secret_protection`
    );
  }

  for (const field of SECURITY_CONFIGURATION_STATUS_FIELDS) {
    const value = config[field];
    if (value !== undefined && !isSecurityConfigurationStatus(value)) {
      throw new Error(`${label}.${field} must be one of: enabled, disabled, not_set`);
    }
  }

  if (config.dependency_graph_autosubmit_action_options !== undefined) {
    if (
      typeof config.dependency_graph_autosubmit_action_options !== "object" ||
      config.dependency_graph_autosubmit_action_options === null ||
      Array.isArray(config.dependency_graph_autosubmit_action_options)
    ) {
      throw new Error(`${label}.dependency_graph_autosubmit_action_options must be an object`);
    }

    const autosubmitOptions = config.dependency_graph_autosubmit_action_options;
    if (
      autosubmitOptions.labeled_runners !== undefined &&
      typeof autosubmitOptions.labeled_runners !== "boolean"
    ) {
      throw new Error(`${label}.dependency_graph_autosubmit_action_options.labeled_runners must be a boolean`);
    }
  }

  if (config.code_scanning_options !== undefined) {
    if (
      typeof config.code_scanning_options !== "object" ||
      config.code_scanning_options === null ||
      Array.isArray(config.code_scanning_options)
    ) {
      throw new Error(`${label}.code_scanning_options must be an object`);
    }

    const codeScanningOptions = config.code_scanning_options;
    if (
      codeScanningOptions.allow_advanced !== undefined &&
      codeScanningOptions.allow_advanced !== null &&
      typeof codeScanningOptions.allow_advanced !== "boolean"
    ) {
      throw new Error(`${label}.code_scanning_options.allow_advanced must be a boolean or null`);
    }
  }

  if (config.code_scanning_default_setup_options !== undefined) {
    if (
      typeof config.code_scanning_default_setup_options !== "object" ||
      config.code_scanning_default_setup_options === null ||
      Array.isArray(config.code_scanning_default_setup_options)
    ) {
      throw new Error(`${label}.code_scanning_default_setup_options must be an object`);
    }

    const defaultSetupOptions = config.code_scanning_default_setup_options;

    if (
      defaultSetupOptions.runner_type !== undefined &&
      !isCodeScanningRunnerType(defaultSetupOptions.runner_type)
    ) {
      throw new Error(`${label}.code_scanning_default_setup_options.runner_type must be one of: standard, labeled, not_set`);
    }

    if (
      defaultSetupOptions.runner_label !== undefined &&
      defaultSetupOptions.runner_label !== null &&
      typeof defaultSetupOptions.runner_label !== "string"
    ) {
      throw new Error(`${label}.code_scanning_default_setup_options.runner_label must be a string or null`);
    }

    if (defaultSetupOptions.runner_type === "labeled") {
      if (typeof defaultSetupOptions.runner_label !== "string" || defaultSetupOptions.runner_label.trim().length === 0) {
        throw new Error(
          `${label}.code_scanning_default_setup_options.runner_label must be set when runner_type is "labeled"`
        );
      }
    } else if (
      defaultSetupOptions.runner_label !== undefined &&
      defaultSetupOptions.runner_label !== null &&
      defaultSetupOptions.runner_label.length > 0
    ) {
      throw new Error(
        `${label}.code_scanning_default_setup_options.runner_label can only be a non-empty string when runner_type is "labeled"`
      );
    }
  }

  if (config.secret_scanning_delegated_bypass_options !== undefined) {
    if (
      typeof config.secret_scanning_delegated_bypass_options !== "object" ||
      config.secret_scanning_delegated_bypass_options === null ||
      Array.isArray(config.secret_scanning_delegated_bypass_options)
    ) {
      throw new Error(`${label}.secret_scanning_delegated_bypass_options must be an object`);
    }

    const bypassOptions = config.secret_scanning_delegated_bypass_options;
    if (bypassOptions.reviewers !== undefined) {
      if (!Array.isArray(bypassOptions.reviewers)) {
        throw new Error(`${label}.secret_scanning_delegated_bypass_options.reviewers must be an array`);
      }

      for (const [index, reviewer] of bypassOptions.reviewers.entries()) {
        const reviewerLabel = `${label}.secret_scanning_delegated_bypass_options.reviewers[${index}]`;
        if (typeof reviewer !== "object" || reviewer === null || Array.isArray(reviewer)) {
          throw new Error(`${reviewerLabel} must be an object`);
        }

        if (!isPositiveInteger(reviewer.reviewer_id)) {
          throw new Error(`${reviewerLabel}.reviewer_id must be a positive integer`);
        }

        if (!isSecurityBypassReviewerType(reviewer.reviewer_type)) {
          throw new Error(`${reviewerLabel}.reviewer_type must be one of: TEAM, ROLE`);
        }

        if (reviewer.mode !== undefined && !isSecurityBypassMode(reviewer.mode)) {
          throw new Error(`${reviewerLabel}.mode must be one of: ALWAYS, EXEMPT`);
        }
      }
    }
  }

  if (config.enforcement !== undefined && !isSecurityConfigurationEnforcement(config.enforcement)) {
    throw new Error(`${label}.enforcement must be one of: enforced, unenforced`);
  }

  if (config.attach !== undefined) {
    validateSecurityConfigurationAttach(config.attach, `${label}.attach`);
  }

  if (config.default_for_new_repos !== undefined && !isSecurityConfigurationDefaultScope(config.default_for_new_repos)) {
    throw new Error(`${label}.default_for_new_repos must be one of: all, none, public, private_and_internal`);
  }
}

function validateSecurityConfigurationAttach(attach: unknown, label: string): void {
  if (typeof attach !== "object" || attach === null || Array.isArray(attach)) {
    throw new Error(`${label} must be an object`);
  }

  const config = attach as SecurityConfigurationAttachConfig;
  if (!isSecurityConfigurationAttachScope(config.scope)) {
    throw new Error(
      `${label}.scope must be one of: all, all_without_configurations, public, private_or_internal, selected`
    );
  }

  if (config.selected_repository_ids !== undefined) {
    if (!Array.isArray(config.selected_repository_ids)) {
      throw new Error(`${label}.selected_repository_ids must be an array`);
    }

    for (const [index, repositoryId] of config.selected_repository_ids.entries()) {
      if (!isPositiveInteger(repositoryId)) {
        throw new Error(`${label}.selected_repository_ids[${index}] must be a positive integer`);
      }
    }
  }

  if (config.selected_repositories !== undefined) {
    if (!Array.isArray(config.selected_repositories)) {
      throw new Error(`${label}.selected_repositories must be an array`);
    }

    for (const [index, repository] of config.selected_repositories.entries()) {
      if (typeof repository !== "string" || repository.trim().length === 0) {
        throw new Error(`${label}.selected_repositories[${index}] must be a non-empty string`);
      }
    }
  }

  const hasSelectedRepositories =
    (config.selected_repository_ids?.length ?? 0) > 0 || (config.selected_repositories?.length ?? 0) > 0;

  if (config.scope === "selected" && !hasSelectedRepositories) {
    throw new Error(`${label} requires selected repositories when scope is "selected"`);
  }

  if (config.scope !== "selected" && hasSelectedRepositories) {
    throw new Error(`${label} can only set selected repositories when scope is "selected"`);
  }
}

function isEnabledRepositoriesPolicy(value: unknown): value is EnabledRepositoriesPolicy {
  return value === "all" || value === "none" || value === "selected";
}

function isAllowedActionsPolicy(value: unknown): value is AllowedActionsPolicy {
  return value === "all" || value === "local_only" || value === "selected";
}

function isForkPrApprovalPolicy(value: unknown): value is ForkPrApprovalPolicy {
  return (
    value === "first_time_contributors_new_to_github" ||
    value === "first_time_contributors" ||
    value === "all_external_contributors"
  );
}

function isWorkflowPermissionsPolicy(value: unknown): value is WorkflowPermissionsPolicy {
  return value === "read" || value === "write";
}

function isSelfHostedRunnerPolicy(value: unknown): value is SelfHostedRunnerRepoPolicy {
  return value === "all" || value === "selected" || value === "none";
}

function isRunnerGroupVisibility(value: unknown): value is "all" | "private" | "selected" {
  return value === "all" || value === "private" || value === "selected";
}

function isSecurityConfigurationStatus(value: unknown): value is SecurityConfigurationStatus {
  return value === "enabled" || value === "disabled" || value === "not_set";
}

function isAdvancedSecurityConfigurationStatus(value: unknown): value is AdvancedSecurityConfigurationStatus {
  return (
    value === "enabled" ||
    value === "disabled" ||
    value === "code_security" ||
    value === "secret_protection"
  );
}

function isCodeScanningRunnerType(value: unknown): value is CodeScanningRunnerType {
  return value === "standard" || value === "labeled" || value === "not_set";
}

function isSecurityBypassReviewerType(value: unknown): value is SecurityBypassReviewerType {
  return value === "TEAM" || value === "ROLE";
}

function isSecurityBypassMode(value: unknown): value is SecurityBypassMode {
  return value === "ALWAYS" || value === "EXEMPT";
}

function isSecurityConfigurationEnforcement(value: unknown): value is SecurityConfigurationEnforcement {
  return value === "enforced" || value === "unenforced";
}

function isSecurityConfigurationAttachScope(value: unknown): value is SecurityConfigurationAttachScope {
  return (
    value === "all" ||
    value === "all_without_configurations" ||
    value === "public" ||
    value === "private_or_internal" ||
    value === "selected"
  );
}

function isSecurityConfigurationDefaultScope(value: unknown): value is SecurityConfigurationDefaultScope {
  return value === "all" || value === "none" || value === "public" || value === "private_and_internal";
}

const PACKAGE_VISIBILITIES: PackageCreationVisibility[] = ["public", "private", "internal"];

function isPackageInheritAccessSetting(value: unknown): value is PackageInheritAccessSetting {
  return value === "default" || value === "enabled" || value === "disabled";
}

function isOrgDefaultRepositoryPermission(value: unknown): value is OrgDefaultRepositoryPermission {
  return value === "read" || value === "write" || value === "admin" || value === "none";
}

function isOrgMembersAllowedRepositoryCreationType(
  value: unknown
): value is OrgMembersAllowedRepositoryCreationType {
  return value === "all" || value === "private" || value === "none";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateRulesetList(rulesets: unknown, label: string): void {
  if (rulesets !== undefined && !Array.isArray(rulesets)) {
    throw new Error(`${label} must be an array`);
  }
}

function normalizeConfig(config: BaselineConfig): EffectiveConfig {
  const repository = config.repo?.repository ?? config.repository;
  const repoRulesets = config.repo?.rulesets ?? config.rulesets;
  const orgRulesets = config.org?.rulesets ?? config.orgRulesets;
  const orgSettings = config.org?.settings;
  const orgActions = config.org?.actions;
  const orgPackages = config.org?.packages;
  const orgSecurityConfigurations = config.org?.security_configurations;

  const repo: RepoScopeConfig = {};
  if (repository) {
    repo.repository = repository;
  }
  if (repoRulesets) {
    repo.rulesets = repoRulesets;
  }

  const org: OrgScopeConfig = {};
  if (orgRulesets) {
    org.rulesets = orgRulesets;
  }
  if (orgSettings) {
    org.settings = orgSettings;
  }
  if (orgActions) {
    org.actions = orgActions;
  }
  if (orgPackages) {
    org.packages = orgPackages;
  }
  if (orgSecurityConfigurations) {
    org.security_configurations = orgSecurityConfigurations;
  }

  return {
    apiVersion: config.apiVersion,
    repo,
    org
  };
}

function hasRepositoryActions(repository: RepositoryConfig | undefined): boolean {
  if (!repository) {
    return false;
  }

  if (repository.default_branch || repository.security || Array.isArray(repository.topics)) {
    return true;
  }

  if (repository.settings && Object.keys(repository.settings).length > 0) {
    return true;
  }

  return false;
}

function hasRepoScopeWork(config: EffectiveConfig): boolean {
  if (hasRepositoryActions(config.repo.repository)) {
    return true;
  }

  return Array.isArray(config.repo.rulesets) && config.repo.rulesets.length > 0;
}

function hasOrganizationActionsWork(actions: OrgActionsConfig | undefined): boolean {
  if (!actions) {
    return false;
  }

  return (
    actions.permissions !== undefined ||
    actions.selected_actions !== undefined ||
    actions.artifact_and_log_retention !== undefined ||
    actions.fork_pr_contributor_approval !== undefined ||
    actions.fork_pr_private_repos !== undefined ||
    actions.self_hosted_runners !== undefined ||
    actions.workflow_permissions !== undefined ||
    actions.cache !== undefined ||
    (Array.isArray(actions.runner_groups) && actions.runner_groups.length > 0)
  );
}

function hasOrganizationSettingsWork(settings: OrgSettingsConfig | undefined): boolean {
  if (!settings) {
    return false;
  }

  return Object.keys(settings).length > 0;
}

function hasOrganizationPackagesWork(packages: OrgPackagesConfig | undefined): boolean {
  if (!packages) {
    return false;
  }

  return packages.package_creation !== undefined || packages.default_settings !== undefined;
}

function hasOrganizationSecurityConfigurationsWork(
  securityConfigurations: OrgSecurityConfigurationConfig[] | undefined
): boolean {
  return Array.isArray(securityConfigurations) && securityConfigurations.length > 0;
}

function hasOrgScopeWork(config: EffectiveConfig): boolean {
  if (Array.isArray(config.org.rulesets) && config.org.rulesets.length > 0) {
    return true;
  }

  if (hasOrganizationSettingsWork(config.org.settings)) {
    return true;
  }

  if (hasOrganizationActionsWork(config.org.actions)) {
    return true;
  }

  if (hasOrganizationPackagesWork(config.org.packages)) {
    return true;
  }

  return hasOrganizationSecurityConfigurationsWork(config.org.security_configurations);
}

async function applyOrganizationScope(options: {
  org: string;
  config: EffectiveConfig;
  dryRun: boolean;
  force: boolean;
  octokit: Octokit | null;
}): Promise<void> {
  if (hasOrganizationSettingsWork(options.config.org.settings)) {
    await applyOrganizationSettings(options);
  }

  if (Array.isArray(options.config.org.rulesets) && options.config.org.rulesets.length > 0) {
    await applyOrganizationRulesets(options);
  }

  if (hasOrganizationActionsWork(options.config.org.actions)) {
    await applyOrganizationActions(options);
  }

  if (hasOrganizationPackagesWork(options.config.org.packages)) {
    await applyOrganizationPackages(options);
  }

  if (hasOrganizationSecurityConfigurationsWork(options.config.org.security_configurations)) {
    await applyOrganizationSecurityConfigurations(options);
  }
}

const ORG_SETTINGS_MUTABLE_KEYS: Array<keyof OrgSettingsConfig> = [
  ...ORG_SETTINGS_STRING_KEYS,
  ...ORG_SETTINGS_BOOLEAN_KEYS,
  "default_repository_permission",
  "members_allowed_repository_creation_type"
];

function buildOrgSettingsPayload(settings: OrgSettingsConfig): JsonObject {
  const payload: JsonObject = {};
  for (const key of ORG_SETTINGS_MUTABLE_KEYS) {
    const value = settings[key];
    if (value !== undefined) {
      payload[String(key)] = value as JsonValue;
    }
  }

  return payload;
}

async function applyOrganizationSettings(options: {
  org: string;
  config: EffectiveConfig;
  dryRun: boolean;
  force: boolean;
  octokit: Octokit | null;
}): Promise<void> {
  const { org, config, dryRun, force, octokit } = options;
  const settings = config.org.settings;
  if (!settings) {
    return;
  }

  const logger = createSectionLogger(`Organization settings (${org})`);
  const desiredPayload = buildOrgSettingsPayload(settings);

  if (Object.keys(desiredPayload).length === 0) {
    logger.log("Skip org settings update: no org.settings fields set");
    logger.flush();
    return;
  }

  let payloadToApply = desiredPayload;
  if (!force && !dryRun && octokit) {
    const currentSettings = await callApi({
      method: "GET",
      endpoint: "GET /orgs/{org}",
      routeParams: { org },
      payload: null,
      apiVersion: config.apiVersion,
      dryRun,
      label: "Read current org settings",
      octokit,
      log: logger.log,
      quiet: true
    });
    payloadToApply = buildChangedPayload(desiredPayload, asJsonObject(currentSettings));

    if (Object.keys(payloadToApply).length === 0) {
      logger.log("Skip org settings update: already aligned");
      logger.flush();
      return;
    }
  }

  await callApi({
    method: "PATCH",
    endpoint: "PATCH /orgs/{org}",
    routeParams: { org },
    payload: payloadToApply,
    apiVersion: config.apiVersion,
    dryRun,
    label: "Update organization settings",
    octokit,
    log: logger.log
  });

  logger.flush();
}

async function applyOrganizationRulesets(options: {
  org: string;
  config: EffectiveConfig;
  dryRun: boolean;
  octokit: Octokit | null;
}): Promise<void> {
  const { org, config, dryRun, octokit } = options;
  const logger = createSectionLogger(`Organization rulesets (${org})`);
  const desiredRulesets = config.org.rulesets ?? [];

  const existingRulesets: ExistingRuleset[] = dryRun || !octokit
    ? []
    : await getOrganizationRulesets({ org, apiVersion: config.apiVersion, octokit });

  try {
    await upsertRulesets({
      desiredRulesets,
      existingRulesets,
      expectedSourceType: "Organization",
      rulesetNameLabel: "org.rulesets[].name",
      updateEndpoint: "PUT /orgs/{org}/rulesets/{ruleset_id}",
      createEndpoint: "POST /orgs/{org}/rulesets",
      baseRouteParams: { org },
      updateLabelPrefix: "Update org ruleset",
      createLabelPrefix: "Create org ruleset",
      apiVersion: config.apiVersion,
      dryRun,
      octokit,
      log: logger.log
    });
  } catch (error: unknown) {
    throw orgRulesetErrorWithContext(org, error);
  }

  logger.flush();
}

async function prepareOrgPayloadUpdate(options: {
  force: boolean;
  dryRun: boolean;
  octokit: Octokit | null;
  apiVersion: string;
  routeParams: Record<string, string | number>;
  getEndpoint: string;
  desiredPayload: JsonObject;
  log: LogFn;
  comparisonLabel: string;
}): Promise<JsonObject | null> {
  const {
    force,
    dryRun,
    octokit,
    apiVersion,
    routeParams,
    getEndpoint,
    desiredPayload,
    log,
    comparisonLabel
  } = options;

  if (force || dryRun || !octokit) {
    return desiredPayload;
  }

  try {
    const current = await callApi({
      method: "GET",
      endpoint: getEndpoint,
      routeParams,
      payload: null,
      apiVersion,
      dryRun,
      label: `Read current ${comparisonLabel}`,
      octokit,
      log,
      quiet: true
    });
    const changedPayload = buildChangedPayload(desiredPayload, asJsonObject(current));
    if (Object.keys(changedPayload).length === 0) {
      return null;
    }

    return changedPayload;
  } catch (error: unknown) {
    if (isHttpError(error, 409)) {
      return desiredPayload;
    }

    throw error;
  }
}

async function applyOrganizationActions(options: {
  org: string;
  config: EffectiveConfig;
  dryRun: boolean;
  force: boolean;
  octokit: Octokit | null;
}): Promise<void> {
  const { org, config, dryRun, force, octokit } = options;
  const actions = config.org.actions;
  if (!actions) {
    return;
  }

  const logger = createSectionLogger(`Organization actions (${org})`);
  let cacheOrgRouteParam: string | number = org;
  if (actions.cache && !dryRun && octokit) {
    const orgResponse = await callApi({
      method: "GET",
      endpoint: "GET /orgs/{org}",
      routeParams: { org },
      payload: null,
      apiVersion: config.apiVersion,
      dryRun,
      label: "Read organization id for cache endpoints",
      octokit,
      log: logger.log,
      quiet: true
    });
    const orgObject = asJsonObject(orgResponse);
    if (isPositiveInteger(orgObject.id)) {
      cacheOrgRouteParam = orgObject.id;
    }
  }

  if (actions.permissions) {
    const permissionsPayload: JsonObject = {
      enabled_repositories: actions.permissions.enabled_repositories
    };

    if (actions.permissions.allowed_actions !== undefined) {
      permissionsPayload.allowed_actions = actions.permissions.allowed_actions;
    }

    if (actions.permissions.sha_pinning_required !== undefined) {
      permissionsPayload.sha_pinning_required = actions.permissions.sha_pinning_required;
    }

    const permissionsPayloadToApply = await prepareOrgPayloadUpdate({
      force,
      dryRun,
      octokit,
      apiVersion: config.apiVersion,
      routeParams: { org },
      getEndpoint: "GET /orgs/{org}/actions/permissions",
      desiredPayload: permissionsPayload,
      log: logger.log,
      comparisonLabel: "org Actions permissions"
    });

    if (!permissionsPayloadToApply) {
      logger.log("Skip org Actions permissions update: already aligned");
    } else {
      await callApi({
        method: "PUT",
        endpoint: "PUT /orgs/{org}/actions/permissions",
        routeParams: { org },
        payload: permissionsPayloadToApply,
        apiVersion: config.apiVersion,
        dryRun,
        label: "Set org GitHub Actions permissions",
        octokit,
        log: logger.log
      });
    }
  }

  if (actions.selected_actions) {
    const selectedActionsPayload = buildSelectedActionsPayload(actions.selected_actions);
    if (Object.keys(selectedActionsPayload).length > 0) {
      const selectedActionsPayloadToApply = await prepareOrgPayloadUpdate({
        force,
        dryRun,
        octokit,
        apiVersion: config.apiVersion,
        routeParams: { org },
        getEndpoint: "GET /orgs/{org}/actions/permissions/selected-actions",
        desiredPayload: selectedActionsPayload,
        log: logger.log,
        comparisonLabel: "org selected-actions policy"
      });

      if (!selectedActionsPayloadToApply) {
        logger.log("Skip org selected-actions update: already aligned");
      } else {
        await callApi({
          method: "PUT",
          endpoint: "PUT /orgs/{org}/actions/permissions/selected-actions",
          routeParams: { org },
          payload: selectedActionsPayloadToApply,
          apiVersion: config.apiVersion,
          dryRun,
          label: "Set org allowed actions/reusable workflows (selected-actions)",
          octokit,
          log: logger.log
        });
      }
    } else {
      logger.log("Skip org selected-actions update: no selected_actions fields set");
    }
  }

  if (actions.artifact_and_log_retention) {
    const retentionPayload: JsonObject = {
      days: actions.artifact_and_log_retention.days
    };

    const retentionPayloadToApply = await prepareOrgPayloadUpdate({
      force,
      dryRun,
      octokit,
      apiVersion: config.apiVersion,
      routeParams: { org },
      getEndpoint: "GET /orgs/{org}/actions/permissions/artifact-and-log-retention",
      desiredPayload: retentionPayload,
      log: logger.log,
      comparisonLabel: "org artifact/log retention"
    });

    if (!retentionPayloadToApply) {
      logger.log("Skip org artifact/log retention update: already aligned");
    } else {
      await callApi({
        method: "PUT",
        endpoint: "PUT /orgs/{org}/actions/permissions/artifact-and-log-retention",
        routeParams: { org },
        payload: retentionPayloadToApply,
        apiVersion: config.apiVersion,
        dryRun,
        label: `Set org artifact/log retention to ${actions.artifact_and_log_retention.days} days`,
        octokit,
        log: logger.log
      });
    }
  }

  if (actions.fork_pr_contributor_approval) {
    const approvalPayload: JsonObject = {
      approval_policy: actions.fork_pr_contributor_approval.approval_policy
    };

    const approvalPayloadToApply = await prepareOrgPayloadUpdate({
      force,
      dryRun,
      octokit,
      apiVersion: config.apiVersion,
      routeParams: { org },
      getEndpoint: "GET /orgs/{org}/actions/permissions/fork-pr-contributor-approval",
      desiredPayload: approvalPayload,
      log: logger.log,
      comparisonLabel: "fork PR contributor approval policy"
    });

    if (!approvalPayloadToApply) {
      logger.log("Skip fork PR contributor approval update: already aligned");
    } else {
      await callApi({
        method: "PUT",
        endpoint: "PUT /orgs/{org}/actions/permissions/fork-pr-contributor-approval",
        routeParams: { org },
        payload: approvalPayloadToApply,
        apiVersion: config.apiVersion,
        dryRun,
        label: `Set fork PR contributor approval policy to "${actions.fork_pr_contributor_approval.approval_policy}"`,
        octokit,
        log: logger.log
      });
    }
  }

  if (actions.fork_pr_private_repos) {
    const forkPrivatePayload: JsonObject = {
      run_workflows_from_fork_pull_requests: actions.fork_pr_private_repos.run_workflows_from_fork_pull_requests
    };

    if (actions.fork_pr_private_repos.send_write_tokens_to_workflows !== undefined) {
      forkPrivatePayload.send_write_tokens_to_workflows =
        actions.fork_pr_private_repos.send_write_tokens_to_workflows;
    }

    if (actions.fork_pr_private_repos.send_secrets_and_variables !== undefined) {
      forkPrivatePayload.send_secrets_and_variables = actions.fork_pr_private_repos.send_secrets_and_variables;
    }

    if (actions.fork_pr_private_repos.require_approval_for_fork_pr_workflows !== undefined) {
      forkPrivatePayload.require_approval_for_fork_pr_workflows =
        actions.fork_pr_private_repos.require_approval_for_fork_pr_workflows;
    }

    try {
      const forkPrivatePayloadToApply = await prepareOrgPayloadUpdate({
        force,
        dryRun,
        octokit,
        apiVersion: config.apiVersion,
        routeParams: { org },
        getEndpoint: "GET /orgs/{org}/actions/permissions/fork-pr-workflows-private-repos",
        desiredPayload: forkPrivatePayload,
        log: logger.log,
        comparisonLabel: "private/internal fork PR workflow policy"
      });

      if (!forkPrivatePayloadToApply) {
        logger.log("Skip private/internal fork PR workflow policy update: already aligned");
      } else {
        await callApi({
          method: "PUT",
          endpoint: "PUT /orgs/{org}/actions/permissions/fork-pr-workflows-private-repos",
          routeParams: { org },
          payload: forkPrivatePayloadToApply,
          apiVersion: config.apiVersion,
          dryRun,
          label: "Set private/internal fork PR workflow policy",
          octokit,
          log: logger.log
        });
      }
    } catch (error: unknown) {
      if (isHttpError(error, 403)) {
        logger.log(
          `Skip private/internal fork PR workflow policy: ${getErrorMessage(error)}`
        );
      } else {
        throw error;
      }
    }
  }

  if (actions.self_hosted_runners) {
    const selfHostedPayload: JsonObject = {
      enabled_repositories: actions.self_hosted_runners.enabled_repositories
    };

    const selfHostedPayloadToApply = await prepareOrgPayloadUpdate({
      force,
      dryRun,
      octokit,
      apiVersion: config.apiVersion,
      routeParams: { org },
      getEndpoint: "GET /orgs/{org}/actions/permissions/self-hosted-runners",
      desiredPayload: selfHostedPayload,
      log: logger.log,
      comparisonLabel: "org self-hosted runners policy"
    });

    if (!selfHostedPayloadToApply) {
      logger.log("Skip self-hosted runner policy update: already aligned");
    } else {
      await callApi({
        method: "PUT",
        endpoint: "PUT /orgs/{org}/actions/permissions/self-hosted-runners",
        routeParams: { org },
        payload: selfHostedPayloadToApply,
        apiVersion: config.apiVersion,
        dryRun,
        label: `Set org self-hosted runner repo access to "${actions.self_hosted_runners.enabled_repositories}"`,
        octokit,
        log: logger.log
      });
    }
  }

  if (actions.workflow_permissions) {
    const workflowPermissionsPayload: JsonObject = {};
    if (actions.workflow_permissions.default_workflow_permissions !== undefined) {
      workflowPermissionsPayload.default_workflow_permissions =
        actions.workflow_permissions.default_workflow_permissions;
    }

    if (actions.workflow_permissions.can_approve_pull_request_reviews !== undefined) {
      workflowPermissionsPayload.can_approve_pull_request_reviews =
        actions.workflow_permissions.can_approve_pull_request_reviews;
    }

    if (Object.keys(workflowPermissionsPayload).length > 0) {
      const workflowPermissionsPayloadToApply = await prepareOrgPayloadUpdate({
        force,
        dryRun,
        octokit,
        apiVersion: config.apiVersion,
        routeParams: { org },
        getEndpoint: "GET /orgs/{org}/actions/permissions/workflow",
        desiredPayload: workflowPermissionsPayload,
        log: logger.log,
        comparisonLabel: "org workflow token permissions"
      });

      if (!workflowPermissionsPayloadToApply) {
        logger.log("Skip workflow permissions update: already aligned");
      } else {
        await callApi({
          method: "PUT",
          endpoint: "PUT /orgs/{org}/actions/permissions/workflow",
          routeParams: { org },
          payload: workflowPermissionsPayloadToApply,
          apiVersion: config.apiVersion,
          dryRun,
          label: "Set org default workflow token permissions",
          octokit,
          log: logger.log
        });
      }
    } else {
      logger.log("Skip workflow permissions update: no workflow_permissions fields set");
    }
  }

  if (actions.cache?.max_cache_size_gb !== undefined) {
    try {
      const cacheSizePayload: JsonObject = {
        max_cache_size_gb: actions.cache.max_cache_size_gb
      };

      const cacheSizePayloadToApply = await prepareOrgPayloadUpdate({
        force,
        dryRun,
        octokit,
        apiVersion: config.apiVersion,
        routeParams: { org: cacheOrgRouteParam },
        getEndpoint: "GET /organizations/{org}/actions/cache/storage-limit",
        desiredPayload: cacheSizePayload,
        log: logger.log,
        comparisonLabel: "org Actions cache storage limit"
      });

      if (!cacheSizePayloadToApply) {
        logger.log("Skip Actions cache storage limit update: already aligned");
      } else {
        await callApi({
          method: "PUT",
          endpoint: "PUT /organizations/{org}/actions/cache/storage-limit",
          routeParams: { org: cacheOrgRouteParam },
          payload: cacheSizePayloadToApply,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Set org Actions cache storage limit to ${actions.cache.max_cache_size_gb}GB`,
          octokit,
          log: logger.log
        });
      }
    } catch (error: unknown) {
      if (isHttpError(error, 403) || isHttpError(error, 404)) {
        throw new Error(
          [
            "Failed to set org Actions cache storage limit.",
            "Ensure token has organization administration permissions (classic scope: admin:organization).",
            `Original error: ${getErrorMessage(error)}`
          ].join("\n")
        );
      }
      throw error;
    }
  }

  if (actions.cache?.max_cache_retention_days !== undefined) {
    try {
      const cacheRetentionPayload: JsonObject = {
        max_cache_retention_days: actions.cache.max_cache_retention_days
      };

      const cacheRetentionPayloadToApply = await prepareOrgPayloadUpdate({
        force,
        dryRun,
        octokit,
        apiVersion: config.apiVersion,
        routeParams: { org: cacheOrgRouteParam },
        getEndpoint: "GET /organizations/{org}/actions/cache/retention-limit",
        desiredPayload: cacheRetentionPayload,
        log: logger.log,
        comparisonLabel: "org Actions cache retention limit"
      });

      if (!cacheRetentionPayloadToApply) {
        logger.log("Skip Actions cache retention update: already aligned");
      } else {
        await callApi({
          method: "PUT",
          endpoint: "PUT /organizations/{org}/actions/cache/retention-limit",
          routeParams: { org: cacheOrgRouteParam },
          payload: cacheRetentionPayloadToApply,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Set org Actions cache retention to ${actions.cache.max_cache_retention_days} days`,
          octokit,
          log: logger.log
        });
      }
    } catch (error: unknown) {
      if (isHttpError(error, 403) || isHttpError(error, 404)) {
        throw new Error(
          [
            "Failed to set org Actions cache retention limit.",
            "Ensure token has organization administration permissions (classic scope: admin:organization).",
            `Original error: ${getErrorMessage(error)}`
          ].join("\n")
        );
      }
      throw error;
    }
  }

  if (Array.isArray(actions.runner_groups) && actions.runner_groups.length > 0) {
    await upsertOrganizationRunnerGroups({
      org,
      actions,
      apiVersion: config.apiVersion,
      dryRun,
      octokit,
      log: logger.log
    });
  }

  logger.flush();
}

function buildSelectedActionsPayload(config: OrgSelectedActionsConfig): JsonObject {
  const payload: JsonObject = {};

  if (config.github_owned_allowed !== undefined) {
    payload.github_owned_allowed = config.github_owned_allowed;
  }

  if (config.verified_allowed !== undefined) {
    payload.verified_allowed = config.verified_allowed;
  }

  if (config.patterns_allowed !== undefined) {
    payload.patterns_allowed = config.patterns_allowed;
  }

  return payload;
}

async function upsertOrganizationRunnerGroups(options: {
  org: string;
  actions: OrgActionsConfig;
  apiVersion: string;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const { org, actions, apiVersion, dryRun, octokit, log } = options;
  const desiredRunnerGroups = actions.runner_groups ?? [];
  if (desiredRunnerGroups.length === 0) {
    return;
  }

  const existingRunnerGroups: ExistingRunnerGroup[] = dryRun || !octokit
    ? []
    : await getOrganizationRunnerGroups({ org, apiVersion, octokit });

  for (const desiredGroup of desiredRunnerGroups) {
    const visibility = desiredGroup.visibility ?? "all";
    const selectedRepositoryIds = await resolveRunnerGroupRepositoryIds({
      org,
      group: desiredGroup,
      dryRun,
      octokit,
      log
    });

    const runnerGroupPayload = buildRunnerGroupPayload({
      group: desiredGroup,
      visibility,
      selectedRepositoryIds
    });

    const existing = existingRunnerGroups.find(
      (group) => group.name.trim().toLowerCase() === desiredGroup.name.trim().toLowerCase()
    );

    if (existing) {
      await callApi({
        method: "PATCH",
        endpoint: "PATCH /orgs/{org}/actions/runner-groups/{runner_group_id}",
        routeParams: { org, runner_group_id: existing.id },
        payload: runnerGroupPayload,
        apiVersion,
        dryRun,
        label: `Update org runner group "${desiredGroup.name}"`,
        octokit,
        log
      });

      if (visibility === "selected" && selectedRepositoryIds.length > 0) {
        await callApi({
          method: "PUT",
          endpoint: "PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
          routeParams: { org, runner_group_id: existing.id },
          payload: {
            selected_repository_ids: selectedRepositoryIds
          },
          apiVersion,
          dryRun,
          label: `Set runner group repository access for "${desiredGroup.name}"`,
          octokit,
          log
        });
      }

      continue;
    }

    const createResponse = await callApi({
      method: "POST",
      endpoint: "POST /orgs/{org}/actions/runner-groups",
      routeParams: { org },
      payload: runnerGroupPayload,
      apiVersion,
      dryRun,
      label: `Create org runner group "${desiredGroup.name}"`,
      octokit,
      log
    });

    if (!dryRun && visibility === "selected" && selectedRepositoryIds.length > 0) {
      const runnerGroupId = getRunnerGroupIdFromResponse(createResponse, desiredGroup.name);
      await callApi({
        method: "PUT",
        endpoint: "PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
        routeParams: { org, runner_group_id: runnerGroupId },
        payload: {
          selected_repository_ids: selectedRepositoryIds
        },
        apiVersion,
        dryRun,
        label: `Set runner group repository access for "${desiredGroup.name}"`,
        octokit,
        log
      });
    }
  }
}

function buildRunnerGroupPayload(options: {
  group: OrgRunnerGroupConfig;
  visibility: "all" | "private" | "selected";
  selectedRepositoryIds: number[];
}): JsonObject {
  const { group, visibility, selectedRepositoryIds } = options;
  const payload: JsonObject = {
    name: group.name,
    visibility
  };

  if (group.allows_public_repositories !== undefined) {
    payload.allows_public_repositories = group.allows_public_repositories;
  }

  if (group.restricted_to_workflows !== undefined) {
    payload.restricted_to_workflows = group.restricted_to_workflows;
  }

  if (group.selected_workflows !== undefined) {
    payload.selected_workflows = group.selected_workflows;
  }

  if (group.network_configuration_id !== undefined) {
    payload.network_configuration_id = group.network_configuration_id;
  }

  if (visibility === "selected" && selectedRepositoryIds.length > 0) {
    payload.selected_repository_ids = selectedRepositoryIds;
  }

  return payload;
}

async function resolveRunnerGroupRepositoryIds(options: {
  org: string;
  group: OrgRunnerGroupConfig;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<number[]> {
  return resolveSelectedRepositoryIds({
    org: options.org,
    selectedRepositoryIds: options.group.selected_repository_ids,
    selectedRepositories: options.group.selected_repositories,
    dryRun: options.dryRun,
    octokit: options.octokit,
    contextLabel: `runner group "${options.group.name}"`,
    log: options.log
  });
}

async function resolveSelectedRepositoryIds(options: {
  org: string;
  selectedRepositoryIds: number[] | undefined;
  selectedRepositories: string[] | undefined;
  dryRun: boolean;
  octokit: Octokit | null;
  contextLabel: string;
  log: LogFn;
}): Promise<number[]> {
  const ids = new Set<number>(options.selectedRepositoryIds ?? []);
  const selectedRepositories = options.selectedRepositories ?? [];

  if (selectedRepositories.length === 0) {
    return [...ids];
  }

  if (!options.octokit) {
    if (options.dryRun) {
      options.log(
        `Skip repository ID resolution for ${options.contextLabel} in dry-run without auth. ` +
          "Provide selected_repository_ids or set GH_TOKEN/GITHUB_TOKEN."
      );
      return [...ids];
    }

    throw new Error(`Cannot resolve selected repositories for ${options.contextLabel} without GitHub auth`);
  }

  for (const repositorySelector of selectedRepositories) {
    const [owner, repo] = normalizeRepositorySelector(repositorySelector, options.org, options.contextLabel);
    const repository = await options.octokit.rest.repos.get({
      owner,
      repo
    });
    if (!isPositiveInteger(repository.data.id)) {
      throw new Error(`Failed to resolve repository id for ${owner}/${repo}`);
    }
    ids.add(repository.data.id);
  }

  return [...ids];
}

function normalizeRepositorySelector(repositorySelector: string, org: string, contextLabel: string): [string, string] {
  const value = repositorySelector.trim();
  if (value.length === 0) {
    throw new Error(`${contextLabel} selected_repositories entries must be non-empty`);
  }

  if (value.includes("/")) {
    const parts = value.split("/");
    if (parts.length !== 2) {
      throw new Error(`Invalid repository selector in ${contextLabel}: ${repositorySelector}`);
    }
    const [owner, repo] = parts;
    if (!owner || !repo) {
      throw new Error(`Invalid repository selector in ${contextLabel}: ${repositorySelector}`);
    }
    return [owner, repo];
  }

  return [org, value];
}

async function getOrganizationRunnerGroups(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<ExistingRunnerGroup[]> {
  const allRunnerGroups: ExistingRunnerGroup[] = [];
  let page = 1;

  while (true) {
    const response = await options.octokit.request("GET /orgs/{org}/actions/runner-groups", {
      org: options.org,
      per_page: 100,
      page,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });

    const data = response.data as { runner_groups?: ExistingRunnerGroup[] };
    const runnerGroups = Array.isArray(data.runner_groups) ? data.runner_groups : [];
    allRunnerGroups.push(...runnerGroups);

    if (runnerGroups.length < 100) {
      break;
    }

    page += 1;
  }

  return allRunnerGroups;
}

function getRunnerGroupIdFromResponse(response: unknown, groupName: string): number {
  if (!response || typeof response !== "object") {
    throw new Error(`Unexpected create runner group response for "${groupName}"`);
  }

  const idValue = (response as { id?: unknown }).id;
  if (!isPositiveInteger(idValue)) {
    throw new Error(`Create runner group response missing numeric id for "${groupName}"`);
  }

  return idValue;
}

async function applyOrganizationSecurityConfigurations(options: {
  org: string;
  config: EffectiveConfig;
  dryRun: boolean;
  force: boolean;
  octokit: Octokit | null;
}): Promise<void> {
  const { org, config, dryRun, force, octokit } = options;
  const desiredConfigurations = config.org.security_configurations ?? [];
  if (desiredConfigurations.length === 0) {
    return;
  }

  const logger = createSectionLogger(`Organization security configurations (${org})`);
  if (!dryRun && octokit) {
    const orgSettings = await callApi({
      method: "GET",
      endpoint: "GET /orgs/{org}",
      routeParams: { org },
      payload: null,
      apiVersion: config.apiVersion,
      dryRun,
      label: "Read org settings for security scope checks",
      octokit,
      log: logger.log,
      quiet: true
    });

    const orgSettingsObject = asJsonObject(orgSettings);
    if (orgSettingsObject.members_can_create_internal_repositories === false) {
      const usesInternalScope = desiredConfigurations.some(
        (configuration) =>
          configuration.attach?.scope === "private_or_internal" ||
          configuration.default_for_new_repos === "private_and_internal"
      );

      if (usesInternalScope) {
        logger.log(
          "Note: internal repository settings in security configurations are currently a no-op for this org " +
            "(members_can_create_internal_repositories=false)."
        );
      }
    }
  }

  const existingConfigurations: ExistingSecurityConfiguration[] = dryRun || !octokit
    ? []
    : await getOrganizationSecurityConfigurations({ org, apiVersion: config.apiVersion, octokit });

  for (const desiredConfiguration of desiredConfigurations) {
    const payload = buildOrganizationSecurityConfigurationPayload(desiredConfiguration);
    const existing = existingConfigurations.find(
      (configuration) => configuration.name.trim().toLowerCase() === desiredConfiguration.name.trim().toLowerCase()
    );

    let configurationId: number | string = "<new-configuration-id>";
    if (existing) {
      configurationId = existing.id;
      let configurationPayloadToApply = payload;
      if (!force && !dryRun && octokit) {
        const currentConfiguration = await callApi({
          method: "GET",
          endpoint: "GET /orgs/{org}/code-security/configurations/{configuration_id}",
          routeParams: { org, configuration_id: configurationId },
          payload: null,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Read current org security configuration "${desiredConfiguration.name}"`,
          octokit,
          log: logger.log,
          quiet: true
        });
        configurationPayloadToApply = buildChangedPayload(payload, asJsonObject(currentConfiguration));
      }

      if (Object.keys(configurationPayloadToApply).length === 0) {
        logger.log(`Skip org security configuration "${desiredConfiguration.name}" update: already aligned`);
      } else {
        await callApi({
          method: "PATCH",
          endpoint: "PATCH /orgs/{org}/code-security/configurations/{configuration_id}",
          routeParams: { org, configuration_id: configurationId },
          payload: configurationPayloadToApply,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Update org security configuration "${desiredConfiguration.name}"`,
          octokit,
          log: logger.log
        });
      }
    } else {
      const createResponse = await callApi({
        method: "POST",
        endpoint: "POST /orgs/{org}/code-security/configurations",
        routeParams: { org },
        payload,
        apiVersion: config.apiVersion,
        dryRun,
        label: `Create org security configuration "${desiredConfiguration.name}"`,
        octokit,
        log: logger.log
      });

      if (!dryRun) {
        configurationId = getSecurityConfigurationIdFromResponse(createResponse, desiredConfiguration.name);
      }
    }

    if (desiredConfiguration.attach) {
      const selectedRepositoryIds = await resolveSelectedRepositoryIds({
        org,
        selectedRepositoryIds: desiredConfiguration.attach.selected_repository_ids,
        selectedRepositories: desiredConfiguration.attach.selected_repositories,
        dryRun,
        octokit,
        contextLabel: `security configuration "${desiredConfiguration.name}"`,
        log: logger.log
      });

      await callApi({
        method: "POST",
        endpoint: "POST /orgs/{org}/code-security/configurations/{configuration_id}/attach",
        routeParams: { org, configuration_id: configurationId },
        payload: buildSecurityConfigurationAttachPayload({
          attach: desiredConfiguration.attach,
          selectedRepositoryIds
        }),
        apiVersion: config.apiVersion,
        dryRun,
        label: `Attach org security configuration "${desiredConfiguration.name}"`,
        octokit,
        log: logger.log
      });
    }

    if (desiredConfiguration.default_for_new_repos !== undefined) {
      await callApi({
        method: "PUT",
        endpoint: "PUT /orgs/{org}/code-security/configurations/{configuration_id}/defaults",
        routeParams: { org, configuration_id: configurationId },
        payload: {
          default_for_new_repos: desiredConfiguration.default_for_new_repos
        },
        apiVersion: config.apiVersion,
        dryRun,
        label:
          `Set "${desiredConfiguration.name}" as default for new repos (` +
          `${desiredConfiguration.default_for_new_repos})`,
        octokit,
        log: logger.log
      });
    }
  }

  logger.flush();
}

function buildOrganizationSecurityConfigurationPayload(
  configuration: OrgSecurityConfigurationConfig
): JsonObject {
  const payload: JsonObject = {
    name: configuration.name,
    description: configuration.description
  };

  if (configuration.advanced_security !== undefined) {
    payload.advanced_security = configuration.advanced_security;
  }

  for (const field of SECURITY_CONFIGURATION_STATUS_FIELDS) {
    const value = configuration[field];
    if (value !== undefined) {
      payload[field] = value;
    }
  }

  if (configuration.dependency_graph_autosubmit_action_options !== undefined) {
    payload.dependency_graph_autosubmit_action_options =
      configuration.dependency_graph_autosubmit_action_options as unknown as JsonValue;
  }

  if (configuration.code_scanning_options !== undefined) {
    payload.code_scanning_options = configuration.code_scanning_options as unknown as JsonValue;
  }

  if (configuration.code_scanning_default_setup_options !== undefined) {
    payload.code_scanning_default_setup_options =
      configuration.code_scanning_default_setup_options as unknown as JsonValue;
  }

  if (configuration.secret_scanning_delegated_bypass_options !== undefined) {
    payload.secret_scanning_delegated_bypass_options =
      configuration.secret_scanning_delegated_bypass_options as unknown as JsonValue;
  }

  if (configuration.enforcement !== undefined) {
    payload.enforcement = configuration.enforcement;
  }

  return payload;
}

function buildSecurityConfigurationAttachPayload(options: {
  attach: SecurityConfigurationAttachConfig;
  selectedRepositoryIds: number[];
}): JsonObject {
  const payload: JsonObject = {
    scope: options.attach.scope
  };

  if (options.attach.scope === "selected") {
    payload.selected_repository_ids = options.selectedRepositoryIds;
  }

  return payload;
}

async function getOrganizationSecurityConfigurations(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<ExistingSecurityConfiguration[]> {
  const allConfigurations: ExistingSecurityConfiguration[] = [];
  let page = 1;

  while (true) {
    const response = await options.octokit.request("GET /orgs/{org}/code-security/configurations", {
      org: options.org,
      per_page: 100,
      page,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`Expected code security configuration list for org "${options.org}"`);
    }

    const pageConfigurations = response.data.map((configuration, index) => {
      if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) {
        throw new Error(`Invalid code security configuration payload on page ${page} at index ${index}`);
      }

      const id = (configuration as { id?: unknown }).id;
      const name = (configuration as { name?: unknown }).name;

      if (!isPositiveInteger(id)) {
        throw new Error(`Missing numeric id for code security configuration on page ${page} at index ${index}`);
      }

      if (typeof name !== "string" || name.length === 0) {
        throw new Error(`Missing name for code security configuration id ${id}`);
      }

      return {
        id,
        name
      } satisfies ExistingSecurityConfiguration;
    });

    allConfigurations.push(...pageConfigurations);

    if (response.data.length < 100) {
      break;
    }

    page += 1;
  }

  return allConfigurations;
}

function getSecurityConfigurationIdFromResponse(response: unknown, configurationName: string): number {
  if (!response || typeof response !== "object") {
    throw new Error(`Unexpected create security configuration response for "${configurationName}"`);
  }

  const idValue = (response as { id?: unknown }).id;
  if (!isPositiveInteger(idValue)) {
    throw new Error(`Create security configuration response missing numeric id for "${configurationName}"`);
  }

  return idValue;
}

async function applyOrganizationPackages(options: {
  org: string;
  config: EffectiveConfig;
  dryRun: boolean;
  octokit: Octokit | null;
}): Promise<void> {
  void options.octokit;
  const packagesConfig = options.config.org.packages;
  if (!packagesConfig) {
    return;
  }

  const logger = createSectionLogger(`Organization packages (${options.org})`);
  logger.log(
    "GitHub does not currently expose a public REST endpoint for org package creation/default visibility settings."
  );

  if (packagesConfig.package_creation) {
    logger.log(
      `Desired package creation visibility: ${JSON.stringify(packagesConfig.package_creation)}`
    );
  }

  if (packagesConfig.default_settings) {
    logger.log(
      `Desired package default settings: ${JSON.stringify(packagesConfig.default_settings)}`
    );
  }

  logger.log("Apply these in Org Settings -> Packages until a public API endpoint is available.");
  logger.flush();
}

function createOctokit(dryRun: boolean, apiVersion: string): Octokit | null {
  const token = resolveAuthToken();
  if (!token) {
    if (dryRun) {
      return null;
    }
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN or GH_TOKEN, or authenticate gh so `gh auth token` works."
    );
  }

  return new Octokit({
    auth: token,
    request: {
      headers: {
        "X-GitHub-Api-Version": apiVersion
      }
    }
  });
}

async function runAuthPreflight(options: {
  args: CliArgs;
  config: EffectiveConfig;
  octokit: Octokit | null;
}): Promise<void> {
  const { args, config, octokit } = options;
  if (args.dryRun) {
    return;
  }

  if (!octokit) {
    throw new Error("GitHub API client is not initialized");
  }

  const ghExecutable = resolveGhExecutable();
  if (ghExecutable) {
    const status = spawnSync(ghExecutable, ["auth", "status"], {
      encoding: "utf8"
    });

    if (status.status !== 0 && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
      throw new Error(
        [
          "gh auth status failed and no GITHUB_TOKEN/GH_TOKEN is set.",
          "Run one of:",
          "- gh auth login -h github.com",
          "- gh auth refresh -h github.com -s repo,read:org,admin:org,admin:organization"
        ].join("\n")
      );
    }
  } else if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    throw new Error(
      [
        "No gh executable found and no GITHUB_TOKEN/GH_TOKEN is set.",
        "Set GITHUB_TOKEN or GH_TOKEN, or install/authenticate GitHub CLI."
      ].join("\n")
    );
  }

  if (args.org && Array.isArray(config.org.rulesets) && config.org.rulesets.length > 0) {
    await assertOrgRulesetAccess({
      org: args.org,
      apiVersion: config.apiVersion,
      octokit
    });
  }

  if (args.org && hasOrganizationSettingsWork(config.org.settings)) {
    await assertOrgSettingsAccess({
      org: args.org,
      apiVersion: config.apiVersion,
      octokit
    });
  }

  if (args.org && hasOrganizationActionsWork(config.org.actions)) {
    await assertOrgActionsAccess({
      org: args.org,
      apiVersion: config.apiVersion,
      octokit
    });
  }

  if (args.org && hasOrganizationSecurityConfigurationsWork(config.org.security_configurations)) {
    await assertOrgSecurityConfigurationsAccess({
      org: args.org,
      apiVersion: config.apiVersion,
      octokit
    });
  }
}

async function assertOrgRulesetAccess(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<void> {
  try {
    await options.octokit.request("GET /orgs/{org}/rulesets", {
      org: options.org,
      per_page: 1,
      page: 1,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });
  } catch (error: unknown) {
    if (isHttpError(error, 403) || isHttpError(error, 404)) {
      throw new Error(
        [
          `Token cannot access organization rulesets for "${options.org}".`,
          "Ensure the auth principal is an org admin/owner and refresh scopes/permissions.",
          "For GitHub CLI classic scopes:",
          "- gh auth refresh -h github.com -s repo,read:org,admin:org,admin:organization",
          `Original error: ${getErrorMessage(error)}`
        ].join("\n")
      );
    }
    throw error;
  }
}

async function assertOrgActionsAccess(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<void> {
  try {
    await options.octokit.request("GET /orgs/{org}/actions/permissions", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });
  } catch (error: unknown) {
    if (isHttpError(error, 403) || isHttpError(error, 404)) {
      throw new Error(
        [
          `Token cannot access organization Actions settings for "${options.org}".`,
          "Ensure the auth principal is an org admin/owner and refresh scopes/permissions.",
          "For GitHub CLI classic scopes:",
          "- gh auth refresh -h github.com -s repo,read:org,admin:org,admin:organization",
          `Original error: ${getErrorMessage(error)}`
        ].join("\n")
      );
    }
    throw error;
  }
}

async function assertOrgSettingsAccess(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<void> {
  try {
    await options.octokit.request("GET /orgs/{org}", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });
  } catch (error: unknown) {
    if (isHttpError(error, 403) || isHttpError(error, 404)) {
      throw new Error(
        [
          `Token cannot access organization settings for "${options.org}".`,
          "Ensure the auth principal is an org admin/owner and refresh scopes/permissions.",
          "For GitHub CLI classic scopes:",
          "- gh auth refresh -h github.com -s repo,read:org,admin:org,admin:organization",
          `Original error: ${getErrorMessage(error)}`
        ].join("\n")
      );
    }
    throw error;
  }
}

async function assertOrgSecurityConfigurationsAccess(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<void> {
  try {
    await options.octokit.request("GET /orgs/{org}/code-security/configurations", {
      org: options.org,
      per_page: 1,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });
  } catch (error: unknown) {
    if (isHttpError(error, 403) || isHttpError(error, 404)) {
      throw new Error(
        [
          `Token cannot access organization security configurations for "${options.org}".`,
          "Ensure the auth principal is an org admin/security manager and refresh scopes/permissions.",
          "For GitHub CLI classic scopes:",
          "- gh auth refresh -h github.com -s repo,read:org,admin:org,admin:organization",
          `Original error: ${getErrorMessage(error)}`
        ].join("\n")
      );
    }
    throw error;
  }
}

function resolveAuthToken(): string | null {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    return envToken;
  }

  const ghExecutable = resolveGhExecutable();
  if (!ghExecutable) {
    return null;
  }

  const result = spawnSync(ghExecutable, ["auth", "token"], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return null;
  }

  const token = result.stdout.trim();
  return token ? token : null;
}

function resolveGhExecutable(): string | null {
  const explicitPath = process.env.GH_PATH;
  if (explicitPath) {
    return canExecuteGh(explicitPath) ? explicitPath : null;
  }

  if (canExecuteGh("gh")) {
    return "gh";
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);

  const commonInstallPaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\GitHub CLI\\gh.exe",
        "C:\\Program Files (x86)\\GitHub CLI\\gh.exe"
      ]
    : [
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        "/usr/bin/gh"
      ];

  const candidates = [...pathEntries.map((entry) => `${entry}${process.platform === "win32" ? "\\gh.exe" : "/gh"}`), ...commonInstallPaths];
  for (const candidate of candidates) {
    if (canExecuteGh(candidate)) {
      return candidate;
    }
  }

  return null;
}

function canExecuteGh(candidate: string): boolean {
  if (candidate !== "gh" && !existsSync(candidate)) {
    return false;
  }

  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8"
  });

  return result.status === 0;
}

async function resolveTargets(args: CliArgs, octokit: Octokit | null): Promise<string[]> {
  const targets = new Set<string>();

  for (const repo of args.repos) {
    validateRepoSlug(repo);
    targets.add(repo);
  }

  if (args.reposFile) {
    const reposFilePath = resolve(args.reposFile);
    if (!existsSync(reposFilePath)) {
      throw new Error(`Repos file not found: ${reposFilePath}`);
    }

    const lines = readFileSync(reposFilePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    for (const repo of lines) {
      validateRepoSlug(repo);
      targets.add(repo);
    }
  }

  if (args.org) {
    if (!octokit) {
      throw new Error("--org requires GitHub authentication even in dry-run mode");
    }

    const matcher = args.match ? new RegExp(args.match) : null;
    const repos = await listOrgRepos(octokit, args.org);
    for (const repo of repos) {
      if (repo.archived || repo.disabled || repo.fork || repo.is_template) {
        continue;
      }
      if (matcher && !matcher.test(repo.nameWithOwner)) {
        continue;
      }
      targets.add(repo.nameWithOwner);
    }
  }

  return [...targets].sort();
}

function validateRepoSlug(repo: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`Invalid repository slug: ${repo}`);
  }
}

async function listOrgRepos(octokit: Octokit, org: string): Promise<OrgRepo[]> {
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: "all"
  });

  return repos.map((repo) => ({
    nameWithOwner: repo.full_name,
    archived: repo.archived ?? false,
    disabled: repo.disabled ?? false,
    fork: repo.fork,
    is_template: repo.is_template ?? false
  }));
}

async function applyBaselineToRepo(options: {
  repo: string;
  config: EffectiveConfig;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const { repo, config, dryRun, octokit, log } = options;
  const [owner, name] = repo.split("/");

  if (!owner || !name) {
    throw new Error(`Invalid repository slug: ${repo}`);
  }

  const metadata = !octokit
    ? null
    : await getRepositoryMetadata({ owner, repo: name, octokit });

  if (config.repo.repository?.default_branch) {
    await ensureDefaultBranch({
      owner,
      repo: name,
      desired: config.repo.repository.default_branch,
      metadata,
      apiVersion: config.apiVersion,
      dryRun,
      octokit,
      log
    });
  }

  const repositorySettings = { ...(config.repo.repository?.settings ?? {}) };

  if (Object.keys(repositorySettings).length > 0) {
    await callApi({
      method: "PATCH",
      endpoint: "PATCH /repos/{owner}/{repo}",
      routeParams: { owner, repo: name },
      payload: repositorySettings,
      apiVersion: config.apiVersion,
      dryRun,
      label: "Update repository settings",
      octokit,
      log
    });
  }

  if (Array.isArray(config.repo.repository?.topics)) {
    await callApi({
      method: "PUT",
      endpoint: "PUT /repos/{owner}/{repo}/topics",
      routeParams: { owner, repo: name },
      payload: { names: config.repo.repository.topics },
      apiVersion: config.apiVersion,
      dryRun,
      label: "Replace repository topics",
      octokit,
      log
    });
  }

  if (config.repo.repository?.security) {
    await applyRepositorySecurity({
      owner,
      repo: name,
      security: config.repo.repository.security,
      metadata,
      apiVersion: config.apiVersion,
      dryRun,
      octokit,
      log
    });
  }

  if (Array.isArray(config.repo.rulesets) && config.repo.rulesets.length > 0) {
    const existingRulesets: ExistingRuleset[] = dryRun || !octokit
      ? []
      : await getRepositoryRulesets({ owner, name, apiVersion: config.apiVersion, octokit });

    await upsertRulesets({
      desiredRulesets: config.repo.rulesets,
      existingRulesets,
      expectedSourceType: "Repository",
      rulesetNameLabel: "repo.rulesets[].name",
      updateEndpoint: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      createEndpoint: "POST /repos/{owner}/{repo}/rulesets",
      baseRouteParams: { owner, repo: name },
      updateLabelPrefix: "Update ruleset",
      createLabelPrefix: "Create ruleset",
      apiVersion: config.apiVersion,
      dryRun,
      octokit,
      log
    });
  }
}

async function getRepositoryMetadata(options: {
  owner: string;
  repo: string;
  octokit: Octokit;
}): Promise<RepoMetadata> {
  const response = await options.octokit.rest.repos.get({
    owner: options.owner,
    repo: options.repo
  });

  return {
    default_branch: response.data.default_branch ?? undefined,
    visibility: (response.data.visibility as RepoMetadata["visibility"]) ?? undefined,
    archived: response.data.archived ?? false,
    disabled: response.data.disabled ?? false,
    is_empty: response.data.pushed_at === null || (response.data.size ?? 0) === 0
  };
}

async function ensureDefaultBranch(options: {
  owner: string;
  repo: string;
  desired: DefaultBranchConfig;
  metadata: RepoMetadata | null;
  apiVersion: string;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const { owner, repo, desired, metadata, apiVersion, dryRun, octokit, log } = options;
  const desiredName = desired.name;
  const currentDefaultBranch = metadata?.default_branch;

  if (metadata?.is_empty) {
    log(`Skip default branch normalization: ${owner}/${repo} is empty`);
    return;
  }

  if (!currentDefaultBranch || currentDefaultBranch === desiredName) {
    return;
  }

  const targetBranchExists = !octokit
    ? false
    : await branchExists({ owner, repo, branch: desiredName, octokit });

  if (targetBranchExists) {
    await callApi({
      method: "PATCH",
      endpoint: "PATCH /repos/{owner}/{repo}",
      routeParams: { owner, repo },
      payload: { default_branch: desiredName },
      apiVersion,
      dryRun,
      label: `Switch default branch to "${desiredName}"`,
      octokit,
      log
    });
    return;
  }

  if (!desired.rename_existing) {
    throw new Error(
      `Repository ${owner}/${repo} does not have a "${desiredName}" branch and rename_existing is false`
    );
  }

  await callApi({
    method: "POST",
    endpoint: "POST /repos/{owner}/{repo}/branches/{branch}/rename",
    routeParams: { owner, repo, branch: currentDefaultBranch },
    payload: { new_name: desiredName },
    apiVersion,
    dryRun,
    label: `Rename default branch "${currentDefaultBranch}" to "${desiredName}"`,
    octokit,
    log
  });
}

async function branchExists(options: {
  owner: string;
  repo: string;
  branch: string;
  octokit: Octokit;
}): Promise<boolean> {
  try {
    await options.octokit.rest.repos.getBranch({
      owner: options.owner,
      repo: options.repo,
      branch: options.branch
    });
    return true;
  } catch (error: unknown) {
    if (isHttpError(error, 404)) {
      return false;
    }
    throw error;
  }
}

async function applyRepositorySecurity(options: {
  owner: string;
  repo: string;
  security: SecurityConfig;
  metadata: RepoMetadata | null;
  apiVersion: string;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const { owner, repo, security, metadata, apiVersion, dryRun, octokit, log } = options;

  const requestedCodeSecurity = resolveCodeSecuritySetting(security);
  const securityAndAnalysisSettings: Array<{
    key: "code_security" | "secret_scanning" | "secret_scanning_push_protection";
    enabled: boolean;
  }> = [];

  if (typeof requestedCodeSecurity === "boolean") {
    securityAndAnalysisSettings.push({
      key: "code_security",
      enabled: requestedCodeSecurity
    });
  }

  if (typeof security.secret_scanning === "boolean") {
    securityAndAnalysisSettings.push({
      key: "secret_scanning",
      enabled: security.secret_scanning
    });
  }

  if (typeof security.secret_scanning_push_protection === "boolean") {
    securityAndAnalysisSettings.push({
      key: "secret_scanning_push_protection",
      enabled: security.secret_scanning_push_protection
    });
  }

  for (const setting of securityAndAnalysisSettings) {
    try {
      await callApi({
        method: "PATCH",
        endpoint: "PATCH /repos/{owner}/{repo}",
        routeParams: { owner, repo },
        payload: {
          security_and_analysis: {
            [setting.key]: {
              status: setting.enabled ? "enabled" : "disabled"
            }
          }
        },
        apiVersion,
        dryRun,
        label: `Set ${setting.key} to ${setting.enabled ? "enabled" : "disabled"}`,
        octokit,
        log
      });
    } catch (error: unknown) {
      if (isHttpError(error, 403) || isHttpError(error, 422)) {
        log(`Skip ${setting.key} update: ${getErrorMessage(error)}`);
      } else {
        throw error;
      }
    }
  }

  if (typeof security.vulnerability_alerts === "boolean") {
    await callApi({
      method: security.vulnerability_alerts ? "PUT" : "DELETE",
      endpoint: security.vulnerability_alerts
        ? "PUT /repos/{owner}/{repo}/vulnerability-alerts"
        : "DELETE /repos/{owner}/{repo}/vulnerability-alerts",
      routeParams: { owner, repo },
      payload: security.vulnerability_alerts ? {} : null,
      apiVersion,
      dryRun,
      label: security.vulnerability_alerts
        ? "Enable vulnerability alerts and dependency graph"
        : "Disable vulnerability alerts and dependency graph",
      octokit,
      log
    });
  }

  if (typeof security.dependabot_security_updates === "boolean") {
    await callApi({
      method: security.dependabot_security_updates ? "PUT" : "DELETE",
      endpoint: security.dependabot_security_updates
        ? "PUT /repos/{owner}/{repo}/automated-security-fixes"
        : "DELETE /repos/{owner}/{repo}/automated-security-fixes",
      routeParams: { owner, repo },
      payload: security.dependabot_security_updates ? {} : null,
      apiVersion,
      dryRun,
      label: security.dependabot_security_updates
        ? "Enable Dependabot security updates"
        : "Disable Dependabot security updates",
      octokit,
      log
    });
  }

  if (security.code_scanning_default_setup) {
    const desiredState = security.code_scanning_default_setup.state;
    const mode = security.code_scanning_default_setup.mode ?? "eligible";
    const visibility = metadata?.visibility;

    // Low-cost profile: when code security is explicitly disabled, default setup is implicitly off.
    // Skip this API call to avoid GitHub's "Code Security must be enabled" error noise.
    if (desiredState === "not-configured" && requestedCodeSecurity === false) {
      log("Skip code scanning default setup: code security is disabled by policy");
      return;
    }

    if (desiredState === "configured" && mode === "public-only" && visibility && visibility !== "public") {
      log("Skip code scanning default setup: repository is not public");
      return;
    }

    try {
      await callApi({
        method: "PATCH",
        endpoint: "PATCH /repos/{owner}/{repo}/code-scanning/default-setup",
        routeParams: { owner, repo },
        payload: {
          state: desiredState,
          ...(desiredState === "configured" && security.code_scanning_default_setup.query_suite
            ? { query_suite: security.code_scanning_default_setup.query_suite }
            : {})
        },
        apiVersion,
        dryRun,
        label:
          desiredState === "configured"
            ? "Configure code scanning default setup"
            : "Disable code scanning default setup",
        octokit,
        log
      });
    } catch (error: unknown) {
      if (isHttpError(error, 403) || isHttpError(error, 422)) {
        log(`Skip code scanning default setup: ${getErrorMessage(error)}`);
        return;
      }
      throw error;
    }
  }
}

function resolveCodeSecuritySetting(security: SecurityConfig): boolean | undefined {
  if (
    typeof security.code_security === "boolean" &&
    typeof security.advanced_security === "boolean" &&
    security.code_security !== security.advanced_security
  ) {
    throw new Error(
      "security.code_security and security.advanced_security must match when both are provided"
    );
  }

  if (typeof security.code_security === "boolean") {
    return security.code_security;
  }

  return security.advanced_security;
}

async function getRepositoryRulesets(options: {
  owner: string;
  name: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<ExistingRuleset[]> {
  const allRulesets: ExistingRuleset[] = [];
  let page = 1;

  while (true) {
    const response = await options.octokit.request("GET /repos/{owner}/{repo}/rulesets", {
      owner: options.owner,
      repo: options.name,
      per_page: 100,
      page,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`Expected rulesets array for ${options.owner}/${options.name}`);
    }

    allRulesets.push(...(response.data as ExistingRuleset[]));
    if (response.data.length < 100) {
      break;
    }

    page += 1;
  }

  return allRulesets;
}

async function getOrganizationRulesets(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<ExistingRuleset[]> {
  const allRulesets: ExistingRuleset[] = [];
  let page = 1;

  try {
    while (true) {
      const response = await options.octokit.request("GET /orgs/{org}/rulesets", {
        org: options.org,
        per_page: 100,
        page,
        headers: {
          "X-GitHub-Api-Version": options.apiVersion
        }
      });

      if (!Array.isArray(response.data)) {
        throw new Error(`Expected organization rulesets array for ${options.org}`);
      }

      allRulesets.push(...(response.data as ExistingRuleset[]));
      if (response.data.length < 100) {
        break;
      }

      page += 1;
    }
  } catch (error: unknown) {
    throw orgRulesetErrorWithContext(options.org, error);
  }

  return allRulesets;
}

function validateRuleset(ruleset: JsonObject): void {
  if (!ruleset || typeof ruleset !== "object" || Array.isArray(ruleset)) {
    throw new Error("Each ruleset must be an object");
  }

  const name = getString(ruleset.name);
  if (!name) {
    throw new Error("Each ruleset must have a name");
  }

  if (!Array.isArray(ruleset.rules) || ruleset.rules.length === 0) {
    throw new Error(`Ruleset "${name}" must define at least one rule`);
  }
}

async function upsertRulesets(options: {
  desiredRulesets: JsonObject[];
  existingRulesets: ExistingRuleset[];
  expectedSourceType: "Organization" | "Repository";
  rulesetNameLabel: string;
  updateEndpoint: string;
  createEndpoint: string;
  baseRouteParams: Record<string, string | number>;
  updateLabelPrefix: string;
  createLabelPrefix: string;
  apiVersion: string;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const {
    desiredRulesets,
    existingRulesets,
    expectedSourceType,
    rulesetNameLabel,
    updateEndpoint,
    createEndpoint,
    baseRouteParams,
    updateLabelPrefix,
    createLabelPrefix,
    apiVersion,
    dryRun,
    octokit,
    log
  } = options;

  for (const desiredRuleset of desiredRulesets) {
    validateRuleset(desiredRuleset);

    const desiredTarget = getString(desiredRuleset.target) ?? "branch";
    const rulesetName = getRequiredString(desiredRuleset.name, rulesetNameLabel);
    const existing = existingRulesets.find(
      (ruleset) =>
        ruleset.name === rulesetName &&
        (ruleset.target ?? "branch") === desiredTarget &&
        (ruleset.source_type === undefined || ruleset.source_type === expectedSourceType)
    );

    if (existing) {
      await callApi({
        method: "PUT",
        endpoint: updateEndpoint,
        routeParams: { ...baseRouteParams, ruleset_id: existing.id },
        payload: desiredRuleset,
        apiVersion,
        dryRun,
        label: `${updateLabelPrefix} "${rulesetName}"`,
        octokit,
        log
      });
      continue;
    }

    await callApi({
      method: "POST",
      endpoint: createEndpoint,
      routeParams: baseRouteParams,
      payload: desiredRuleset,
      apiVersion,
      dryRun,
      label: `${createLabelPrefix} "${rulesetName}"`,
      octokit,
      log
    });
  }
}

async function callApi(options: {
  method: string;
  endpoint: string;
  routeParams: Record<string, string | number>;
  payload: JsonObject | null | undefined;
  apiVersion: string;
  dryRun: boolean;
  label: string;
  octokit: Octokit | null;
  log: LogFn;
  quiet?: boolean;
}): Promise<unknown> {
  const { method, endpoint, routeParams, payload, apiVersion, dryRun, label, octokit, log, quiet = false } = options;

  if (dryRun) {
    if (!quiet) {
      log(`[dry-run] ${label}`);
      log(`  ${method} ${renderEndpoint(endpoint, routeParams)}`);
      if (payload) {
        log(indentJson(payload, 2));
      }
    }
    return null;
  }

  if (!octokit) {
    throw new Error("GitHub client is not initialized");
  }

  if (!quiet) {
    log(label);
  }

  const response = await octokit.request(endpoint, {
    ...routeParams,
    ...(payload ?? {}),
    headers: {
      "X-GitHub-Api-Version": apiVersion
    }
  });

  return response.data;
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as JsonObject;
}

function buildChangedPayload(desired: JsonObject, current: JsonObject): JsonObject {
  const changed: JsonObject = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!jsonValuesEqual(value, current[key])) {
      changed[key] = value;
    }
  }

  return changed;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function renderEndpoint(endpoint: string, routeParams: Record<string, string | number>): string {
  return endpoint
    .replace(/^[A-Z]+\s+/, "")
    .replace(/\{([^}]+)\}/g, (_, key: string) => String(routeParams[key] ?? `{${key}}`));
}

function indentJson(value: JsonObject, spaces: number): string {
  return JSON.stringify(value, null, spaces)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function getString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getRequiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isHttpError(error: unknown, status: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithStatus = error as Error & { status?: number };
  return errorWithStatus.status === status;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orgRulesetErrorWithContext(org: string, error: unknown): Error {
  if (isHttpError(error, 404) || isHttpError(error, 403)) {
    return new Error(
      [
        `Organization rulesets API is not accessible for "${org}".`,
        "Common causes:",
        "- token/user is not an organization admin or owner",
        "- token lacks org administration permission/scope",
        "- organization rulesets are not available for this org plan",
        `Original error: ${getErrorMessage(error)}`
      ].join("\n")
    );
  }

  return new Error(getErrorMessage(error));
}

function createRepoLogger(repo: string): { log: LogFn; flush: () => void } {
  const lines: string[] = [];

  return {
    log: (message: string) => {
      lines.push(message);
    },
    flush: () => {
      console.log(`\n==> ${repo}`);
      for (const line of lines) {
        console.log(line);
      }
    }
  };
}

function createSectionLogger(title: string): { log: LogFn; flush: () => void } {
  const lines: string[] = [];

  return {
    log: (message: string) => {
      lines.push(message);
    },
    flush: () => {
      console.log(`\n==> ${title}`);
      for (const line of lines) {
        console.log(line);
      }
    }
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
